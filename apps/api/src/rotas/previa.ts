import {
  precisaMapearEmCampo,
  type ItemPedido,
  type GeoPonto,
  type ParadaPrevia,
  type PreviaRota,
} from '@rota/shared';
import { ordemRotaAberta } from './rota-aberta.js';
import type { Repositorio } from '../db/repositorio.js';
import type { ClienteOsrm } from './osrm.js';

/**
 * Prévia de rota (RF-11/RF-12): seleção de pedidos + CD de partida → ordem das
 * paradas (otimizada via /trip, ou fixa via /route quando o operador ajustou
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
  itens: ItemPedido[];
  volumes: number;
  pesoBrutoKg: number;
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
      const pergunta = pedido.enderecoEntrega
        ? 'escolha de endereço de entrega'
        : 'confirmação do ponto após mudança de endereço';
      return {
        ok: false,
        status: 422,
        erro: `Pedido ${pedido.numeroNota} aguarda ${pergunta} (aba Decisões)`,
      };
    }

    // Override: quando o escritório escolheu o endereço de entrega, a rota usa a
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
      endereco: `${e.logradouro}, ${e.numero} — ${e.bairro}, ${e.municipio}/${e.uf}`,
      telefone: cliente.telefone,
      itens: pedido.itens,
      volumes: pedido.volumes,
      pesoBrutoKg: pedido.pesoBrutoKg,
      coordenada,
      // Entrega em local diverso já é um ponto escolhido pelo escritório; senão,
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

export async function previaDeRota(
  entrada: EntradaPrevia,
  repo: Repositorio,
  osrm: ClienteOsrm,
): Promise<ResultadoPrevia> {
  if (!entrada.pedidoIds?.length) {
    return { ok: false, status: 400, erro: 'Selecione ao menos um pedido' };
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
    const resultado = await osrm.trip(
      cd.coordenada,
      candidatas.map((c) => c.coordenada),
      true,
    );
    ordenadas = resultado.ordem.map((indice) => candidatas[indice]!);
    polyline = resultado.polyline;
    distanciaTotalKm = resultado.distanciaKm;
    duracaoTotalMin = resultado.duracaoMin;
  } else {
    // Rota ABERTA: o /trip do OSRM não resolve (responde NotImplemented sem um
    // fim fixo), então a ordem sai da matriz de durações — ver rota-aberta.ts.
    // O traçado vem depois, com a sequência já decidida.
    const duracoes = await osrm.table([cd.coordenada, ...candidatas.map((c) => c.coordenada)]);
    ordenadas = ordemRotaAberta(duracoes).map((indice) => candidatas[indice]!);
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
