import type { ParadaPrevia, PreviaRota } from '@rota/shared';
import type { Repositorio } from '../db/repositorio.js';
import type { ClienteOsrm } from './osrm.js';

/**
 * Prévia de rota (RF-11): seleção de pedidos + CD de partida → ordem otimizada
 * das paradas via OSRM /trip, traçado e estimativas. É o insumo da montagem no
 * painel; a publicação (RF-13) grava a rota e dispara a pré-carga do motorista.
 */

export interface EntradaPrevia {
  pedidoIds: string[];
  cdId: string;
  /** Retorno ao CD de origem por padrão (seção 18, decisão 1). */
  retornaAoCd?: boolean;
}

export type ResultadoPrevia =
  | { ok: true; previa: PreviaRota }
  | { ok: false; status: number; erro: string; pendentes?: Array<{ pedidoId: string; nome: string }> };

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

  const candidatas: Array<Omit<ParadaPrevia, 'posicao'>> = [];
  const pendentes: Array<{ pedidoId: string; nome: string }> = [];

  for (const pedidoId of entrada.pedidoIds) {
    const pedido = await repo.obterPedido(pedidoId);
    if (!pedido) return { ok: false, status: 404, erro: `Pedido ${pedidoId} não encontrado` };

    const cliente = await repo.obterCliente(pedido.clienteId);
    if (!cliente) return { ok: false, status: 404, erro: `Cliente do pedido ${pedidoId} não encontrado` };

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
      coordenada: cliente.coordenada,
      volumes: pedido.volumes,
      pesoBrutoKg: pedido.pesoBrutoKg,
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

  const resultado = await osrm.trip(
    cd.coordenada,
    candidatas.map((p) => p.coordenada),
    retornaAoCd,
  );

  const paradas: ParadaPrevia[] = resultado.ordem.map((indice, posicao) => ({
    posicao: posicao + 1,
    ...candidatas[indice]!,
  }));

  return {
    ok: true,
    previa: {
      cd: { id: entrada.cdId, ...cd },
      retornaAoCd,
      paradas,
      polyline: resultado.polyline,
      distanciaTotalKm: resultado.distanciaKm,
      duracaoTotalMin: resultado.duracaoMin,
    },
  };
}
