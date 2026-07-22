import type { GeoPonto } from '@rota/shared';

/**
 * Cliente do OSRM (seção 10): `/trip` ordena as paradas (caixeiro-viajante
 * aproximado) partindo do CD; `roundtrip` controla o retorno ao CD de origem.
 * O serviço roda privado no Render com o extrato de Alagoas.
 */

export interface ResultadoTrip {
  /** Índices das paradas de entrada, na ordem otimizada de visita. */
  ordem: number[];
  /** Traçado completo (encoded polyline, precisão 5). */
  polyline: string;
  distanciaKm: number;
  duracaoMin: number;
}

export interface ClienteOsrm {
  trip(cd: GeoPonto, paradas: GeoPonto[], roundtrip: boolean): Promise<ResultadoTrip>;
}

export function criarClienteOsrm(
  base: string | undefined = urlPadrao(),
  fetchFn: typeof fetch = fetch,
): ClienteOsrm | null {
  if (!base) return null;
  const raiz = base.replace(/\/+$/, '');

  return {
    async trip(cd, paradas, roundtrip) {
      const coordenadas = [cd, ...paradas].map((p) => `${p.lng},${p.lat}`).join(';');
      const url =
        `${raiz}/trip/v1/driving/${coordenadas}` +
        `?source=first&roundtrip=${roundtrip}&geometries=polyline&overview=full`;

      const resposta = await fetchFn(url);
      if (!resposta.ok) throw new Error(`OSRM respondeu HTTP ${resposta.status}`);
      const corpo: any = await resposta.json();
      if (corpo?.code !== 'Ok' || !corpo?.trips?.[0]) {
        throw new Error(`OSRM não encontrou rota (${corpo?.code ?? 'sem resposta'})`);
      }

      const viagem = corpo.trips[0];
      // waypoints[i] corresponde à i-ésima coordenada de entrada; waypoint_index
      // é a posição dela na viagem. Entrada 0 é o CD; ordenamos as paradas
      // (entradas 1..n) pela posição de visita.
      const posicoes: Array<{ indiceParada: number; posicao: number }> = corpo.waypoints
        .slice(1)
        .map((w: any, i: number) => ({ indiceParada: i, posicao: Number(w.waypoint_index) }));
      posicoes.sort((a, b) => a.posicao - b.posicao);

      return {
        ordem: posicoes.map((p) => p.indiceParada),
        polyline: String(viagem.geometry ?? ''),
        distanciaKm: Math.round((viagem.distance / 1000) * 10) / 10,
        duracaoMin: Math.round(viagem.duration / 60),
      };
    },
  };
}

function urlPadrao(): string | undefined {
  if (process.env.OSRM_URL) return process.env.OSRM_URL;
  if (process.env.OSRM_HOST) return `https://${process.env.OSRM_HOST}`;
  return undefined;
}
