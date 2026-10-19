import type { ExcecaoRota, ParadaRota, Rota, StatusPedido } from '@rota/shared';
import { randomUUID } from 'node:crypto';
import { coletarParadas, enderecoEmLinha, type FalhaColeta } from './previa.js';
import type { Repositorio } from '../db/repositorio.js';
import type { ClienteOsrm } from './osrm.js';

/**
 * Publicação de rota (RF-13): grava a rota na ordem final do operador, com
 * ETA e distância por parada, e move os pedidos para `em_rota`. No app do
 * motorista, a rota publicada é a rota do dia; a pré-carga offline (Fase 5)
 * parte deste mesmo documento.
 */

export interface EntradaPublicacao {
  /** Ordem FINAL das paradas (já otimizada e/ou ajustada no painel). */
  pedidoIds: string[];
  /**
   * Pedidos SEM ponto no mapa que vão no caminhão mesmo assim (zona rural que
   * o motorista conhece). Entram na rota como exceção — fora da ordem, do
   * traçado e do ETA — e ficam reservados como as paradas.
   */
  excecaoIds?: string[];
  cdId: string;
  retornaAoCd?: boolean;
  motoristaId: string;
  /** YYYY-MM-DD; padrão: hoje no fuso de Alagoas. */
  data?: string;
}

export type ResultadoPublicacao =
  | { ok: true; rotaId: string; rota: Rota }
  | FalhaColeta;

export async function publicarRota(
  entrada: EntradaPublicacao,
  repo: Repositorio,
  osrm: ClienteOsrm,
): Promise<ResultadoPublicacao> {
  if (!Array.isArray(entrada.pedidoIds) || entrada.pedidoIds.length === 0) {
    return { ok: false, status: 400, erro: 'Selecione ao menos um pedido' };
  }
  const excecaoIds = entrada.excecaoIds ?? [];
  if (!Array.isArray(excecaoIds)) {
    return { ok: false, status: 400, erro: 'excecaoIds inválido' };
  }
  // O id vira caminho de documento: número estoura no SDK do Firestore (500
  // em vez de 400) e barra apontaria para outra coleção.
  const idInvalido = [...entrada.pedidoIds, ...excecaoIds].find(
    (id) => typeof id !== 'string' || id === '' || id.includes('/'),
  );
  if (idInvalido !== undefined) {
    return { ok: false, status: 400, erro: `Pedido inválido: ${JSON.stringify(idInvalido)}` };
  }
  // O mesmo pedido duas vezes viraria duas paradas — o motorista bateria duas
  // vezes na mesma porta e a baixa de uma deixaria a outra pendurada.
  const todos = [...entrada.pedidoIds, ...excecaoIds];
  const repetido = todos.find((id, i) => todos.indexOf(id) !== i);
  if (repetido) {
    return { ok: false, status: 400, erro: `Pedido ${repetido} aparece duas vezes na rota` };
  }
  if (!entrada.motoristaId) {
    return { ok: false, status: 400, erro: 'Escolha o motorista da rota' };
  }
  // `data` entra no rotaId, que vira caminho de documento no Firestore ('/'
  // separa níveis): sem validar, `data` com barras escreveria num caminho
  // arbitrário sob rotas/.
  if (entrada.data !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(entrada.data)) {
    return { ok: false, status: 400, erro: 'Data inválida (esperado AAAA-MM-DD)' };
  }

  const usuarios = await repo.listarUsuarios();
  const motorista = usuarios.find((u) => u.id === entrada.motoristaId && u.ativo);
  if (!motorista) {
    return { ok: false, status: 400, erro: 'Motorista inválido ou inativo' };
  }

  const cds = await repo.obterCds();
  // hasOwnProperty: `cdId='__proto__'` retornaria o protótipo (truthy) e
  // furaria a checagem, seguindo com coordenada undefined.
  const cd = Object.prototype.hasOwnProperty.call(cds, entrada.cdId) ? cds[entrada.cdId] : undefined;
  if (!cd) return { ok: false, status: 400, erro: `CD '${entrada.cdId}' não cadastrado` };
  const retornaAoCd = entrada.retornaAoCd ?? true;

  const coleta = await coletarParadas(entrada.pedidoIds, repo);
  if (!coleta.ok) return coleta;
  const candidatas = coleta.candidatas;

  // O status lido AGORA é o que a gravação confere: se outro operador publicar
  // um destes pedidos enquanto o OSRM responde, a transação recusa.
  const statusLido: Record<string, StatusPedido> = {};
  const notaDe: Record<string, number> = {};
  // Leituras em paralelo, aqui e nas exceções: uma a uma, as 237 exceções
  // sugeridas numa cidade sem localização feita seriam ~480 idas ao Firestore
  // em série — perto de um minuto antes mesmo do OSRM, com o proxy do Render
  // cortando a requisição e o operador sem saber se a rota foi gravada.
  const lidos = await Promise.all(candidatas.map((c) => repo.obterPedido(c.pedidoId)));
  for (const [i, c] of candidatas.entries()) {
    const pedido = lidos[i]!;
    if (pedido.status === 'em_rota') {
      return { ok: false, status: 409, erro: `Pedido ${pedido.numeroNota} já está em outra rota` };
    }
    if (pedido.status === 'entregue') {
      return { ok: false, status: 409, erro: `Pedido ${pedido.numeroNota} já foi entregue` };
    }
    statusLido[c.pedidoId] = pedido.status;
    notaDe[c.pedidoId] = pedido.numeroNota;
  }

  const excecoes: ExcecaoRota[] = [];
  const cdsDaRota = new Set(candidatas.map((c) => c.cdId).filter(Boolean));
  const lidasExcecoes = await Promise.all(
    excecaoIds.map(async (id) => {
      const pedido = await repo.obterPedido(id);
      return { id, pedido, cliente: pedido ? await repo.obterCliente(pedido.clienteId) : null };
    }),
  );
  for (const { id, pedido, cliente } of lidasExcecoes) {
    if (!pedido) return { ok: false, status: 404, erro: `Pedido ${id} não encontrado` };
    // Só quem está esperando ponto entra como exceção. Pedido COM ponto é
    // parada (tem lugar na ordem); os demais status são os mesmos bloqueios
    // das paradas — rota, retirada, decisão pendente, já executado.
    if (pedido.status !== 'pendente_de_mapeamento') {
      const motivo =
        pedido.status === 'pronto_para_rota'
          ? 'já tem ponto no mapa — entra como parada, não como exceção'
          : pedido.status === 'em_rota'
            ? `já está na rota ${pedido.rotaId ?? '(publicada)'}`
            : `está como ${pedido.status}`;
      return { ok: false, status: 409, erro: `Pedido ${pedido.numeroNota} ${motivo} — atualize a tela e monte de novo` };
    }
    if (!cliente) {
      return { ok: false, status: 404, erro: `Cliente do pedido ${id} não encontrado` };
    }
    const e =
      pedido.usarEnderecoEntrega === true && pedido.enderecoEntrega
        ? pedido.enderecoEntrega
        : cliente.enderecoFiscal;
    excecoes.push({
      pedidoId: id,
      numero: excecoes.length + 1,
      clienteId: pedido.clienteId,
      nome: cliente.nome,
      endereco: enderecoEmLinha(e),
      telefone: cliente.telefone,
      numeroNota: pedido.numeroNota,
      serie: pedido.serie,
      numeroPedido: pedido.numeroPedido,
      volumes: pedido.volumes,
      pesoBrutoKg: pedido.pesoBrutoKg,
      ...(pedido.quantidadeMateriais !== undefined
        ? { quantidadeMateriais: pedido.quantidadeMateriais }
        : {}),
      status: 'em_rota',
    });
    statusLido[id] = pedido.status;
    notaDe[id] = pedido.numeroNota;
    // A mercadoria de outro galpão não está neste caminhão — mesma regra das
    // paradas (seção 8.5), que `coletarParadas` já aplicou a elas.
    if (pedido.cdId && cdsDaRota.size > 0 && !cdsDaRota.has(pedido.cdId)) {
      return {
        ok: false,
        status: 422,
        erro: `Exceção ${pedido.numeroNota} é de outro CD (${pedido.cdId}) — monte uma rota por CD`,
      };
    }
  }

  const pontos = [cd.coordenada, ...candidatas.map((c) => c.coordenada)];
  if (retornaAoCd) pontos.push(cd.coordenada);
  let tracado;
  try {
    tracado = await osrm.route(pontos);
  } catch (erro) {
    // Cold-start do OSRM ou falha de rota: mensagem clara em vez de 500 cru.
    return { ok: false, status: 503, erro: erro instanceof Error ? erro.message : 'Falha no roteirizador' };
  }

  let etaAcumuladoSeg = 0;
  const paradas: ParadaRota[] = candidatas.map((c, i) => {
    const perna = tracado.pernas[i] ?? { distanciaKm: 0, duracaoSeg: 0 };
    etaAcumuladoSeg += perna.duracaoSeg;
    return {
      pedidoId: c.pedidoId,
      numero: i + 1,
      clienteId: c.clienteId,
      nome: c.nome,
      endereco: c.endereco,
      telefone: c.telefone,
      numeroNota: c.numeroNota,
      serie: c.serie,
      numeroPedido: c.numeroPedido,
      itens: c.itens,
      volumes: c.volumes,
      pesoBrutoKg: c.pesoBrutoKg,
      ...(c.quantidadeMateriais !== undefined ? { quantidadeMateriais: c.quantidadeMateriais } : {}),
      coordenada: c.coordenada,
      // Acumula segundos crus e arredonda uma vez: o ETA de uma parada nunca
      // ultrapassa a duração total da rota (que também é arredondada do total cru).
      etaMin: Math.round(etaAcumuladoSeg / 60),
      distanciaKm: perna.distanciaKm,
      status: 'em_rota',
      precisaMapear: c.precisaMapear,
    };
  });

  const data = entrada.data ?? hojeEmAlagoas();
  const rotaId = `${data}_${randomUUID().slice(0, 8)}`;
  const rota: Rota = {
    data,
    motoristaId: entrada.motoristaId,
    origemCdId: entrada.cdId,
    origemNome: cd.nome,
    origemCoordenada: cd.coordenada,
    retornaAoCd,
    paradas,
    // Só grava o campo quando há exceção: rota sem nenhuma fica com a forma de
    // sempre, e quem lê `excecoes ?? []` não distingue as duas.
    ...(excecoes.length > 0 ? { excecoes } : {}),
    polylinePlanejada: tracado.polyline,
    distanciaTotalKm: tracado.distanciaKm,
    duracaoTotalMin: tracado.duracaoMin,
    status: 'publicada',
    publicadaEm: new Date().toISOString(),
    concluidaEm: null,
  };

  // Escrita atômica: grava a rota e move os pedidos para em_rota de uma vez, e
  // só se nenhum deles mudou desde a leitura (ver publicarRotaAtomica).
  const conflito = await repo.publicarRotaAtomica(rotaId, rota, statusLido);
  if (conflito) {
    const onde =
      conflito.status === 'em_rota'
        ? `acabou de entrar na rota ${conflito.rotaId ?? '(publicada)'}`
        : conflito.status === null
          ? 'foi apagado'
          : `mudou para ${conflito.status}`;
    return {
      ok: false,
      status: 409,
      erro: `Pedido ${notaDe[conflito.pedidoId] ?? conflito.pedidoId} ${onde} enquanto esta rota era publicada — nada foi gravado. Atualize a tela e monte de novo.`,
    };
  }

  return { ok: true, rotaId, rota };
}

export function hojeEmAlagoas(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Maceio' }).format(new Date());
}
