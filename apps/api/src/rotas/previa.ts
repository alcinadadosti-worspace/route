import {
  aguardandoEscolhaDeModo,
  precisaMapearEmCampo,
  type EnderecoFiscal,
  type ItemPedido,
  type GeoPonto,
  type ParadaPrevia,
  type PreviaRota,
} from '@rota/shared';
import { ordemRotaAberta } from './rota-aberta.js';
import { refinarOrdem } from './refinar-ordem.js';
import { agruparMesmoLugar, mesmoPercurso } from './mesmo-lugar.js';
import type { Repositorio } from '../db/repositorio.js';
import type { ClienteOsrm, ResultadoTrip } from './osrm.js';

/**
 * Endereço em uma linha para a parada e para o roteiro em PDF. Sem número, não
 * escreve a vírgula: no endereço rural o número quase nunca existe, e
 * "SÍTIO BOA VISTA,  — ZONA RURAL" no papel do motorista parece campo quebrado.
 */
export function enderecoEmLinha(e: EnderecoFiscal): string {
  const rua = e.numero ? `${e.logradouro}, ${e.numero}` : e.logradouro;
  // Mesma razão para o bairro, que a planilha também traz vazio.
  const lugar = e.bairro ? `${e.bairro}, ${e.municipio}/${e.uf}` : `${e.municipio}/${e.uf}`;
  return `${rua} — ${lugar}`;
}

/**
 * Prévia de rota (RF-11/RF-12): seleção de pedidos + CD de partida → ordem das
 * paradas (otimizada via /trip e refinada, ou fixa via /route quando o operador ajustou
 * manualmente), traçado e estimativas. A publicação (RF-13) usa a mesma coleta.
 */

export interface EntradaPrevia {
  pedidoIds: string[];
  cdId: string;
  /** Retorno ao CD de origem por padrão (seção 18, decisão 1). */
  retornaAoCd?: boolean;
  /** true = respeitar a ordem de pedidoIds (ajuste manual do operador, RF-12). */
  ordemManual?: boolean;
}

/** Parada candidata com tudo que a publicação denormaliza (seção 13). */
export interface CandidataParada {
  pedidoId: string;
  clienteId: string;
  nome: string;
  endereco: string;
  telefone: string | null;
  /** Para o recibo ao cliente: a revendedora confere pelo nº do PEDIDO. */
  numeroNota: number;
  serie: number;
  numeroPedido: string | null;
  itens: ItemPedido[];
  volumes: number;
  pesoBrutoKg: number;
  /** Pedido vindo da planilha não tem lista de itens — este número responde
   * "quantos produtos" para o motorista e para o romaneio. */
  quantidadeMateriais?: number;
  coordenada: GeoPonto;
  /** Denormalizado para a ParadaRota: liga o "navegar e mapear" no app do
   * motorista sem depender do doc do cliente estar no cache offline. */
  precisaMapear: boolean;
  /** CD de origem do pedido, deduzido do emitente da nota (seção 8.5). */
  cdId: string | null;
}

export type FalhaColeta = {
  ok: false;
  status: number;
  erro: string;
  pendentes?: Array<{ pedidoId: string; nome: string }>;
};

export type ResultadoPrevia = { ok: true; previa: PreviaRota } | FalhaColeta;

export async function coletarParadas(
  pedidoIds: string[],
  repo: Repositorio,
): Promise<{ ok: true; candidatas: CandidataParada[] } | FalhaColeta> {
  const candidatas: CandidataParada[] = [];
  const pendentes: Array<{ pedidoId: string; nome: string }> = [];

  for (const pedidoId of pedidoIds) {
    const pedido = await repo.obterPedido(pedidoId);
    if (!pedido) return { ok: false, status: 404, erro: `Pedido ${pedidoId} não encontrado` };

    const cliente = await repo.obterCliente(pedido.clienteId);
    if (!cliente) {
      return { ok: false, status: 404, erro: `Cliente do pedido ${pedidoId} não encontrado` };
    }

    /**
     * Pedido que JÁ está numa rota, ou já foi executado, não entra em outra.
     * O painel só oferece os `pronto_para_rota`, mas a checagem tem de estar
     * AQUI: uma prévia montada antes de a seleção mudar (rota publicada por
     * outro operador, pedido apagado, rota desfeita) mandaria estes ids do
     * mesmo jeito. Publicar reescreveria o `rotaId` do pedido para a rota nova
     * e a rota antiga ficaria com uma parada de um pedido que já não é dela —
     * inconsistência que ninguém percebe até a conferência do dia.
     */
    if (pedido.status === 'em_rota' || pedido.status === 'entregue' || pedido.status === 'insucesso') {
      const onde =
        pedido.status === 'em_rota'
          ? `já está na rota ${pedido.rotaId ?? '(publicada)'}`
          : `já foi ${pedido.status === 'entregue' ? 'entregue' : 'registrado como insucesso'}`;
      return {
        ok: false,
        status: 409,
        erro: `Pedido ${pedido.numeroNota} ${onde} — atualize a tela e monte de novo`,
      };
    }

    // Decisão de endereço pendente trava a rota: entrega em local diverso
    // (8.4) roteirizaria o endereço fiscal no palpite, e cadastro que mudou de
    // lugar (8.3) roteirizaria o ponto do endereço antigo.
    if (pedido.status === 'pendente_de_decisao') {
      const pergunta = aguardandoEscolhaDeModo(pedido)
        ? 'a escolha entre rota e retirada'
        : pedido.enderecoEntrega
          ? 'escolha de endereço de entrega'
          : 'confirmação do ponto após mudança de endereço';
      return {
        ok: false,
        status: 422,
        erro: `Pedido ${pedido.numeroNota} aguarda ${pergunta} (aba Decisões)`,
      };
    }

    // Retirada no balcão: o Admin Estoque já respondeu que esta nota não sai no
    // caminhão. Não é erro de quem montou a rota — é um pedido que foi
    // deliberadamente tirado da fila e pode voltar pela aba Decisões.
    if (pedido.status === 'retirada' || pedido.status === 'entregue_no_erp') {
      const oQue = pedido.status === 'retirada' ? 'é retirada na central' : 'o ERP dá como entregue';
      return {
        ok: false,
        status: 422,
        erro: `Pedido ${pedido.numeroNota} está fora da montagem (${oQue}) — libere em Rotas > Fora da montagem`,
      };
    }

    // Override: quando o Admin Estoque escolheu o endereço de entrega, a rota usa a
    // coordenada/endereço do pedido; senão, os do cliente.
    const usaEntrega = pedido.usarEnderecoEntrega === true;
    const coordenada = usaEntrega ? pedido.coordenadaEntrega ?? null : cliente.coordenada;
    const e = usaEntrega && pedido.enderecoEntrega ? pedido.enderecoEntrega : cliente.enderecoFiscal;
    if (!coordenada) {
      pendentes.push({ pedidoId, nome: cliente.nome });
      continue;
    }

    candidatas.push({
      pedidoId,
      clienteId: pedido.clienteId,
      nome: cliente.nome,
      endereco: enderecoEmLinha(e),
      telefone: cliente.telefone,
      numeroNota: pedido.numeroNota,
      serie: pedido.serie,
      numeroPedido: pedido.numeroPedido,
      itens: pedido.itens,
      volumes: pedido.volumes,
      pesoBrutoKg: pedido.pesoBrutoKg,
      ...(pedido.quantidadeMateriais !== undefined
        ? { quantidadeMateriais: pedido.quantidadeMateriais }
        : {}),
      coordenada,
      // Entrega em local diverso já é um ponto escolhido pelo Admin Estoque; senão,
      // reflete a situação de mapeamento do cliente (aproximado → mapear em campo).
      precisaMapear: usaEntrega ? false : precisaMapearEmCampo(cliente.statusMapeamento),
      cdId: pedido.cdId ?? null,
    });
  }

  if (pendentes.length > 0) {
    return {
      ok: false,
      status: 422,
      erro: 'Há pedidos com destino sem coordenada — resolva o mapeamento antes de montar a rota',
      pendentes,
    };
  }

  // Pedidos de CDs DIFERENTES na mesma rota (seção 8.5): a mercadoria está em
  // dois galpões e o motorista sai de um só. Erro de seleção, não de desenho —
  // e barato de barrar aqui, caro de descobrir com o caminhão carregado.
  // Compara só o que se sabe: pedido sem CD reconhecido não entra na conta.
  const cdsDosPedidos = [...new Set(candidatas.map((c) => c.cdId).filter(Boolean))];
  if (cdsDosPedidos.length > 1) {
    return {
      ok: false,
      status: 422,
      erro: `Seleção mistura pedidos de CDs diferentes (${cdsDosPedidos.join(', ')}) — monte uma rota por CD`,
    };
  }

  return { ok: true, candidatas };
}

/**
 * Teto para tudo o que a prévia faz DEPOIS do `/trip` (refinar e juntar o
 * mesmo lugar). O cliente OSRM insiste ~24 s num 502/503 antes de desistir, e
 * sem resposta nenhuma espera para sempre; aqui o `/trip` já respondeu, então
 * esperar isso por um ganho opcional só trava a tela de quem está montando.
 */
const PRAZO_DO_REFINO_MS = 10_000;

/** O trabalho, ou `seEsgotar()` se ele não terminar em `prazoMs`. */
async function comPrazo<T>(trabalho: Promise<T>, prazoMs: number, seEsgotar: () => T): Promise<T> {
  let relogio: ReturnType<typeof setTimeout> | undefined;
  const esgotou = new Promise<T>((resolver) => {
    relogio = setTimeout(() => resolver(seEsgotar()), Math.max(0, prazoMs));
  });
  try {
    return await Promise.race([trabalho, esgotou]);
  } finally {
    clearTimeout(relogio);
  }
}

/**
 * A ordem do `/trip` passada pela busca local (refinar-ordem.ts), com o
 * traçado refeito pelo `/route` quando ela muda. É esta ordem que a publicação
 * grava e que sai no PDF.
 *
 * O `/trip` já devolveu uma rota válida: o refinamento é ganho, não requisito.
 * Se o `/table` ou o `/route` falharem aqui (o serviço caindo no meio da
 * prévia), ou passarem do prazo, fica a do `/trip` em vez de a prévia virar
 * erro ou demora.
 */
export async function refinarViagem(
  cd: GeoPonto,
  pontos: GeoPonto[],
  viagem: ResultadoTrip,
  osrm: ClienteOsrm,
  prazoMs = PRAZO_DO_REFINO_MS,
): Promise<ResultadoTrip> {
  return comPrazo(tentarRefinar(cd, pontos, viagem, osrm), prazoMs, () => viagem);
}

async function tentarRefinar(
  cd: GeoPonto,
  pontos: GeoPonto[],
  viagem: ResultadoTrip,
  osrm: ClienteOsrm,
): Promise<ResultadoTrip> {
  try {
    const duracoes = await osrm.table([cd, ...pontos]);
    const ordem = refinarOrdem(duracoes, viagem.ordem, { fechada: true });
    if (ordem.every((indice, i) => indice === viagem.ordem[i])) return viagem;
    const tracado = await osrm.route([cd, ...ordem.map((indice) => pontos[indice]!), cd]);
    // A busca mede TEMPO na matriz do /table, que não é exatamente o caminho
    // do /route — e o motorista sente também os km. A ordem nova só fica se,
    // no traçado de verdade, não perde em nada para a do /trip e ganha em
    // alguma coisa. (As duas medidas deixam dar meia-volta na parada: ver o
    // continue_straight em osrm.ts.)
    const naoPerde =
      tracado.duracaoMin <= viagem.duracaoMin && tracado.distanciaKm <= viagem.distanciaKm;
    const ganha =
      tracado.duracaoMin < viagem.duracaoMin || tracado.distanciaKm < viagem.distanciaKm;
    if (!naoPerde || !ganha) return viagem;
    return {
      ordem,
      polyline: tracado.polyline,
      distanciaKm: tracado.distanciaKm,
      duracaoMin: tracado.duracaoMin,
    };
  } catch {
    return viagem;
  }
}

/**
 * Paradas do mesmo ponto em sequência (mesmo-lugar.ts), sobre a ordem já
 * otimizada da rota fechada. Quando só trocaram de lugar paradas de um mesmo
 * ponto, traçado e estimativas são os mesmos; quando sumiu uma volta ao mesmo
 * ponto, o /route refaz os números. Se ele falhar ou passar do prazo, a ordem
 * agrupada fica do mesmo jeito, com os números da anterior: pedido da mesma
 * casa separado no papel é erro que chega na porta, km estimado um pouco fora
 * não é — e a publicação refaz o traçado da ordem gravada de qualquer forma.
 */
export async function juntarMesmoLugar(
  cd: GeoPonto,
  candidatas: Array<Pick<CandidataParada, 'coordenada' | 'clienteId'>>,
  viagem: ResultadoTrip,
  osrm: ClienteOsrm,
  prazoMs = PRAZO_DO_REFINO_MS,
): Promise<ResultadoTrip> {
  const ponto = (indice: number) => candidatas[indice]!.coordenada;
  const ordem = agruparMesmoLugar(viagem.ordem, ponto, (indice) => candidatas[indice]!.clienteId);
  if (ordem.every((indice, i) => indice === viagem.ordem[i])) return viagem;
  if (mesmoPercurso(ordem, viagem.ordem, ponto)) return { ...viagem, ordem };
  const tracado = await comPrazo(
    osrm.route([cd, ...ordem.map(ponto), cd]).catch(() => null),
    prazoMs,
    () => null,
  );
  if (!tracado) return { ...viagem, ordem };
  return { ordem, polyline: tracado.polyline, distanciaKm: tracado.distanciaKm, duracaoMin: tracado.duracaoMin };
}

export async function previaDeRota(
  entrada: EntradaPrevia,
  repo: Repositorio,
  osrm: ClienteOsrm,
): Promise<ResultadoPrevia> {
  if (!entrada || !Array.isArray(entrada.pedidoIds) || entrada.pedidoIds.length === 0) {
    return { ok: false, status: 400, erro: 'Selecione ao menos um pedido' };
  }
  // O id vira caminho de documento (como na publicação): número estourava no
  // SDK do Firestore (500 em vez de 400) e barra apontaria para outra coleção.
  const idInvalido = entrada.pedidoIds.find((id) => typeof id !== 'string' || id === '' || id.includes('/'));
  if (idInvalido !== undefined) {
    return { ok: false, status: 400, erro: `Pedido inválido: ${JSON.stringify(idInvalido)}` };
  }
  if (typeof entrada.cdId !== 'string') {
    return { ok: false, status: 400, erro: 'Informe o CD de partida' };
  }

  const cds = await repo.obterCds();
  // hasOwnProperty: `cdId='__proto__'` retornaria o protótipo (truthy).
  const cd = Object.prototype.hasOwnProperty.call(cds, entrada.cdId) ? cds[entrada.cdId] : undefined;
  if (!cd) {
    return { ok: false, status: 400, erro: `CD '${entrada.cdId}' não cadastrado` };
  }
  const retornaAoCd = entrada.retornaAoCd ?? true;

  const coleta = await coletarParadas(entrada.pedidoIds, repo);
  if (!coleta.ok) return coleta;
  const candidatas = coleta.candidatas;

  let ordenadas: CandidataParada[];
  let polyline: string;
  let distanciaTotalKm: number;
  let duracaoTotalMin: number;

  try {
  if (entrada.ordemManual) {
    // RF-12: o operador conhece restrições que o algoritmo não conhece.
    const pontos = [cd.coordenada, ...candidatas.map((c) => c.coordenada)];
    if (retornaAoCd) pontos.push(cd.coordenada);
    const resultado = await osrm.route(pontos);
    ordenadas = candidatas;
    polyline = resultado.polyline;
    distanciaTotalKm = resultado.distanciaKm;
    duracaoTotalMin = resultado.duracaoMin;
  } else if (retornaAoCd) {
    const pontos = candidatas.map((c) => c.coordenada);
    const viagem = await osrm.trip(cd.coordenada, pontos, true);
    const limite = Date.now() + PRAZO_DO_REFINO_MS;
    const refinada = await refinarViagem(cd.coordenada, pontos, viagem, osrm);
    const resultado = await juntarMesmoLugar(cd.coordenada, candidatas, refinada, osrm, limite - Date.now());
    ordenadas = resultado.ordem.map((indice) => candidatas[indice]!);
    polyline = resultado.polyline;
    distanciaTotalKm = resultado.distanciaKm;
    duracaoTotalMin = resultado.duracaoMin;
  } else {
    // Rota ABERTA: o /trip do OSRM não resolve (responde NotImplemented sem um
    // fim fixo), então a ordem sai da matriz de durações — ver rota-aberta.ts.
    // O traçado vem depois, com a sequência já decidida.
    const duracoes = await osrm.table([cd.coordenada, ...candidatas.map((c) => c.coordenada)]);
    ordenadas = agruparMesmoLugar(
      ordemRotaAberta(duracoes).map((indice) => candidatas[indice]!),
      (c) => c.coordenada,
      (c) => c.clienteId,
    );
    const resultado = await osrm.route([cd.coordenada, ...ordenadas.map((c) => c.coordenada)]);
    polyline = resultado.polyline;
    distanciaTotalKm = resultado.distanciaKm;
    duracaoTotalMin = resultado.duracaoMin;
  }
  } catch (erro) {
    // Cold-start do OSRM ou falha de rota: mensagem clara em vez de 500 cru.
    return { ok: false, status: 503, erro: erro instanceof Error ? erro.message : 'Falha no roteirizador' };
  }

  const paradas: ParadaPrevia[] = ordenadas.map((c, i) => ({
    posicao: i + 1,
    pedidoId: c.pedidoId,
    clienteId: c.clienteId,
    nome: c.nome,
    endereco: c.endereco,
    coordenada: c.coordenada,
    volumes: c.volumes,
    pesoBrutoKg: c.pesoBrutoKg,
  }));

  return {
    ok: true,
    previa: {
      cd: { id: entrada.cdId, ...cd },
      retornaAoCd,
      paradas,
      polyline,
      distanciaTotalKm,
      duracaoTotalMin,
    },
  };
}
