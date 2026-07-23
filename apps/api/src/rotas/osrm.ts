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

export interface ResultadoRoute {
  polyline: string;
  distanciaKm: number;
  duracaoMin: number;
  /** Uma perna por trecho entre pontos consecutivos, na ordem dada. */
  pernas: Array<{ distanciaKm: number; duracaoMin: number }>;
}

export interface ResultadoMatch {
  /**
   * Um item por ponto de entrada: a posição casada na malha OSM, ou null
   * quando o ponto não tem correspondência — o trecho fora do mapa (seção 11.2).
   */
  pontos: Array<GeoPonto | null>;
}

/** Ponto de trilha bruta para o `/match` — precisão vira o raio de busca. */
export interface PontoMatch extends GeoPonto {
  precisaoM?: number;
}

export interface ClienteOsrm {
  trip(cd: GeoPonto, paradas: GeoPonto[], roundtrip: boolean): Promise<ResultadoTrip>;
  /** `/route`: traçado e estimativas para uma sequência FIXA de pontos (RF-12/RF-13). */
  route(pontos: GeoPonto[]): Promise<ResultadoRoute>;
  /** `/match`: classifica cada ponto do rastro como dentro ou fora da malha (RF-08). */
  match(pontos: PontoMatch[]): Promise<ResultadoMatch>;
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

    async route(pontos) {
      const coordenadas = pontos.map((p) => `${p.lng},${p.lat}`).join(';');
      const url = `${raiz}/route/v1/driving/${coordenadas}?geometries=polyline&overview=full`;

      const resposta = await fetchFn(url);
      if (!resposta.ok) throw new Error(`OSRM respondeu HTTP ${resposta.status}`);
      const corpo: any = await resposta.json();
      const rota = corpo?.routes?.[0];
      if (corpo?.code !== 'Ok' || !rota) {
        throw new Error(`OSRM não encontrou rota (${corpo?.code ?? 'sem resposta'})`);
      }

      return {
        polyline: String(rota.geometry ?? ''),
        distanciaKm: Math.round((rota.distance / 1000) * 10) / 10,
        duracaoMin: Math.round(rota.duration / 60),
        pernas: (rota.legs ?? []).map((l: any) => ({
          distanciaKm: Math.round((l.distance / 1000) * 10) / 10,
          duracaoMin: Math.round(l.duration / 60),
        })),
      };
    },

    async match(pontos) {
      if (pontos.length < 2) return { pontos: pontos.map(() => null) };

      // osrm-routed limita o /match a 100 coordenadas por chamada
      // (--max-matching-size); lotes com 1 ponto de sobreposição cobrem
      // rastros longos — ponto casado em qualquer lote conta como casado.
      const TAMANHO_LOTE = 100;
      const casados: Array<GeoPonto | null> = new Array(pontos.length).fill(null);

      for (let inicio = 0; inicio < pontos.length - 1; inicio += TAMANHO_LOTE - 1) {
        const fim = Math.min(inicio + TAMANHO_LOTE, pontos.length);
        const lote = pontos.slice(inicio, fim);
        const resultado = await matchLote(lote);
        resultado.forEach((p, j) => {
          if (p) casados[inicio + j] = p;
        });
        if (fim === pontos.length) break;
      }

      return { pontos: casados };

      async function matchLote(lote: PontoMatch[]): Promise<Array<GeoPonto | null>> {
        const coordenadas = lote.map((p) => `${p.lng},${p.lat}`).join(';');
        // Raio de busca por ponto = precisão do GPS na leitura (mínimo 10 m).
        const raios = lote.map((p) => Math.max(10, Math.ceil(p.precisaoM ?? 15))).join(';');
        const url =
          `${raiz}/match/v1/driving/${coordenadas}` +
          `?geometries=polyline&overview=false&radiuses=${raios}`;

        const resposta = await fetchFn(url);
        const corpo: any = await resposta.json().catch(() => null);
        // NoMatch/NoSegment não são erro: é o rastro inteiro fora da malha —
        // exatamente o caso das entradas rurais que o sistema quer aprender.
        if (corpo?.code === 'NoMatch' || corpo?.code === 'NoSegment') {
          return lote.map(() => null);
        }
        if (!resposta.ok) throw new Error(`OSRM respondeu HTTP ${resposta.status}`);
        if (corpo?.code !== 'Ok' || !Array.isArray(corpo?.tracepoints)) {
          throw new Error(`OSRM não casou o rastro (${corpo?.code ?? 'sem resposta'})`);
        }
        return corpo.tracepoints.map((t: any) =>
          t?.location ? { lat: Number(t.location[1]), lng: Number(t.location[0]) } : null,
        );
      }
    },
  };
}

function urlPadrao(): string | undefined {
  if (process.env.OSRM_URL) return process.env.OSRM_URL;
  if (process.env.OSRM_HOST) return `https://${process.env.OSRM_HOST}`;
  return undefined;
}
