import type { ItemPedido, GeoPonto, ParadaPrevia, PreviaRota } from '@rota/shared';
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

    if (!cliente.coordenada) {
      pendentes.push({ pedidoId, nome: cliente.nome });
      continue;
    }

    const e = cliente.enderecoFiscal;
    candidatas.push({
      pedidoId,
      clienteId: pedido.clienteId,
      nome: cliente.nome,
      endereco: `${e.logradouro}, ${e.numero} — ${e.bairro}, ${e.municipio}/${e.uf}`,
      telefone: cliente.telefone,
      itens: pedido.itens,
      volumes: pedido.volumes,
      pesoBrutoKg: pedido.pesoBrutoKg,
      coordenada: cliente.coordenada,
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
  const cd = cds[entrada.cdId];
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

  if (entrada.ordemManual) {
    // RF-12: o operador conhece restrições que o algoritmo não conhece.
    const pontos = [cd.coordenada, ...candidatas.map((c) => c.coordenada)];
    if (retornaAoCd) pontos.push(cd.coordenada);
    const resultado = await osrm.route(pontos);
    ordenadas = candidatas;
    polyline = resultado.polyline;
    distanciaTotalKm = resultado.distanciaKm;
    duracaoTotalMin = resultado.duracaoMin;
  } else {
    const resultado = await osrm.trip(
      cd.coordenada,
      candidatas.map((c) => c.coordenada),
      retornaAoCd,
    );
    ordenadas = resultado.ordem.map((indice) => candidatas[indice]!);
    polyline = resultado.polyline;
    distanciaTotalKm = resultado.distanciaKm;
    duracaoTotalMin = resultado.duracaoMin;
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
