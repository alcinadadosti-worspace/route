import type { GeoPonto } from '@rota/shared';
import type { Repositorio } from '../db/repositorio.js';
import type { ClienteOsrm } from './osrm.js';

/**
 * Ordem sugerida das paradas que faltam, a partir de ONDE O MOTORISTA ESTÁ
 * (RF-12 em campo). A ordem publicada é calculada uma vez, no escritório,
 * partindo do CD; quando o dia sai do plano — saiu de casa, começou por outra
 * parada, um cliente pediu para adiantar — o resto da rota fica desotimizado e
 * ninguém recalcula.
 *
 * NÃO GRAVA NADA. Só devolve a ordem sugerida, e o app a usa como visão. O
 * documento da rota é escrito pelo app do motorista a cada confirmação de
 * entrega (o array `paradas` inteiro); se o servidor reescrevesse esse mesmo
 * array aqui, uma confirmação feita no mesmo instante seria apagada — e a
 * ordem oficial, que o escritório publicou e acompanha, mudaria sozinha.
 */

export type ResultadoOrdemSugerida =
  | { ok: true; ordem: string[] }
  | { ok: false; status: number; erro: string };

/** Formato do rotaId gerado na publicação: `AAAA-MM-DD_` + 8 hex do uuid. */
const FORMATO_ROTA_ID = /^\d{4}-\d{2}-\d{2}_[0-9a-f]{8}$/;

export async function sugerirOrdemDeParadas(
  entrada: {
    rotaId: string;
    origem: GeoPonto | null | undefined;
    /** uid do chamador; null quando a API roda sem autenticador (dev/CI). */
    uid: string | null;
  },
  repo: Repositorio,
  osrm: ClienteOsrm,
): Promise<ResultadoOrdemSugerida> {
  // O rotaId vira caminho de documento no Firestore ('/' separa níveis):
  // validar aqui fecha a mesma injeção de caminho já tratada na publicação.
  if (!FORMATO_ROTA_ID.test(entrada.rotaId ?? '')) {
    return { ok: false, status: 404, erro: 'Rota não encontrada' };
  }
  const origem = validarCoordenada(entrada.origem);
  if (!origem) {
    return { ok: false, status: 400, erro: 'Posição atual inválida' };
  }

  const rota = await repo.obterRota(entrada.rotaId);
  if (!rota) return { ok: false, status: 404, erro: 'Rota não encontrada' };
  // O motorista reordena apenas a PRÓPRIA rota — mesma regra das security
  // rules. Sem uid a API está sem autenticador (dev/CI), onde tudo é aberto
  // por desenho e o log da subida avisa.
  if (entrada.uid && rota.motoristaId !== entrada.uid) {
    return { ok: false, status: 403, erro: 'Rota de outro motorista' };
  }

  const pendentes = rota.paradas.filter(
    (p) => p.status !== 'entregue' && p.status !== 'insucesso',
  );
  // Com 0 ou 1 parada não há o que otimizar — devolve direto sem acordar o
  // OSRM (que dorme no plano free e custa ~1 min de cold start).
  if (pendentes.length < 2) return { ok: true, ordem: pendentes.map((p) => p.pedidoId) };

  try {
    const resultado = await osrm.trip(
      origem,
      pendentes.map((p) => p.coordenada),
      // Sem retorno à origem: o motorista quer terminar as entregas, não
      // voltar ao ponto onde estava quando pediu o recálculo.
      false,
    );
    return { ok: true, ordem: resultado.ordem.map((i) => pendentes[i]!.pedidoId) };
  } catch (erro) {
    return {
      ok: false,
      status: 503,
      erro: erro instanceof Error ? erro.message : 'Falha no roteirizador',
    };
  }
}

function validarCoordenada(c: GeoPonto | null | undefined): GeoPonto | null {
  if (!c || typeof c.lat !== 'number' || typeof c.lng !== 'number') return null;
  if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) return null;
  if (c.lat < -90 || c.lat > 90 || c.lng < -180 || c.lng > 180) return null;
  return { lat: c.lat, lng: c.lng };
}
