import { validarGeoPonto, type GeoPonto } from '@rota/shared';
import { FORMATO_ROTA_ID } from './comum.js';
import type { Repositorio } from '../db/repositorio.js';
import type { ClienteOsrm } from './osrm.js';

/**
 * Traçado novo da posição ATUAL até a parada que o motorista está fazendo
 * (seção 11.6). A polyline publicada é calculada uma vez, saindo do CD; quando
 * o motorista desvia, o app detecta sozinho (geometria, offline) e pede isto —
 * que exige rede, porque quem sabe traçar caminho por estrada é o OSRM.
 *
 * Como a ordem sugerida, NÃO grava nada: devolve a polyline e o app a desenha
 * no lugar da planejada enquanto durar a navegação daquela parada.
 *
 * O destino vem do servidor, nunca do corpo da requisição: além de ser a fonte
 * correta (o pin do cliente pode ter sido confirmado depois da publicação),
 * impede usar o endpoint como proxy de roteirização para pontos arbitrários.
 */

export type ResultadoRerota =
  | { ok: true; polyline: string; distanciaKm: number; duracaoMin: number }
  | { ok: false; status: number; erro: string };

export async function recalcularTracado(
  entrada: {
    rotaId: string;
    pedidoId: string;
    origem: GeoPonto | null | undefined;
    /** uid do chamador; null quando a API roda sem autenticador (dev/CI). */
    uid: string | null;
  },
  repo: Repositorio,
  osrm: ClienteOsrm,
): Promise<ResultadoRerota> {
  if (!FORMATO_ROTA_ID.test(entrada.rotaId ?? '')) {
    return { ok: false, status: 404, erro: 'Rota não encontrada' };
  }
  const origem = validarGeoPonto(entrada.origem);
  if (!origem) return { ok: false, status: 400, erro: 'Posição atual inválida' };

  const rota = await repo.obterRota(entrada.rotaId);
  if (!rota) return { ok: false, status: 404, erro: 'Rota não encontrada' };
  if (entrada.uid && rota.motoristaId !== entrada.uid) {
    return { ok: false, status: 403, erro: 'Rota de outro motorista' };
  }

  const parada = rota.paradas.find((p) => p.pedidoId === entrada.pedidoId);
  if (!parada) return { ok: false, status: 404, erro: 'Parada não encontrada nesta rota' };
  if (parada.status === 'entregue' || parada.status === 'insucesso') {
    return { ok: false, status: 409, erro: 'Parada já resolvida' };
  }

  // Mesma precedência do app: o pin confirmado em campo vale mais que a
  // coordenada denormalizada na publicação; sem pin, a da parada.
  const cliente = await repo.obterCliente(parada.clienteId);
  const destino = validarGeoPonto(cliente?.coordenada) ?? validarGeoPonto(parada.coordenada);
  if (!destino) return { ok: false, status: 409, erro: 'Parada sem coordenada de destino' };

  try {
    const resultado = await osrm.route([origem, destino]);
    return {
      ok: true,
      polyline: resultado.polyline,
      distanciaKm: resultado.distanciaKm,
      duracaoMin: resultado.duracaoMin,
    };
  } catch (erro) {
    return {
      ok: false,
      status: 503,
      erro: erro instanceof Error ? erro.message : 'Falha no roteirizador',
    };
  }
}
