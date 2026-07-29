import type { LineLayerSpecification } from 'maplibre-gl';

/**
 * Aparência das linhas de rota no mapa do motorista.
 *
 * O truque que faz a rota "saltar" do mapa em qualquer app de navegação é o
 * CONTORNO: duas camadas, uma escura e mais larga por baixo, a cor viva por
 * cima. Sem ele, uma linha de cor única some sobre estrada clara, se confunde
 * com rio ou divisa, e perde contraste ao sol. Junto vão pontas e junções
 * arredondadas — é o que separa um traçado de aparência profissional de uma
 * sequência de segmentos com bico — e espessura que cresce com o zoom.
 *
 * Duas linguagens de cor, que não podem se confundir em campo:
 * - DOURADO = o caminho a seguir (rota planejada ou recalculada). É o mesmo
 *   dourado da identidade, que na interface já significa foco e ação.
 * - LARANJA = trilha aprendida, o trecho fora da malha. Mantém o laranja de
 *   segurança que a interface inteira já usa para rural (cartão da parada,
 *   chip de status, aba de filtro).
 */

/** Dourado vivo o bastante para os dois temas — vai sempre sobre o contorno. */
export const COR_ROTA = '#e8b95a';
export const COR_TRILHA = '#ff5f1f';
/** Quase preto, com o verde da identidade: contorno em Galpão e em Pátio. */
const COR_CONTORNO = '#12140f';

const LAYOUT_LINHA = { 'line-cap': 'round', 'line-join': 'round' } as const;

type LarguraLinha = NonNullable<LineLayerSpecification['paint']>['line-width'];

/**
 * Espessura por zoom: fina na visão de rota inteira, grossa quando o motorista
 * está enxergando a rua. Sem isso, a linha ou vira um fio no zoom de rua ou
 * uma mancha na visão geral.
 */
export function larguraLinha(base: number): LarguraLinha {
  return ['interpolate', ['linear'], ['zoom'], 10, base * 0.55, 14, base, 18, base * 1.7];
}

/** Camada de contorno — entra ANTES da colorida, para ficar por baixo. */
export function camadaContorno(id: string, fonte: string, base: number): LineLayerSpecification {
  return {
    id,
    type: 'line',
    source: fonte,
    layout: LAYOUT_LINHA,
    paint: { 'line-color': COR_CONTORNO, 'line-width': larguraLinha(base + 3), 'line-opacity': 0.85 },
  };
}

export function camadaLinha(
  id: string,
  fonte: string,
  base: number,
  cor: string,
  tracejado?: [number, number],
): LineLayerSpecification {
  return {
    id,
    type: 'line',
    source: fonte,
    layout: LAYOUT_LINHA,
    paint: {
      'line-color': cor,
      'line-width': larguraLinha(base),
      ...(tracejado ? { 'line-dasharray': tracejado } : {}),
    },
  };
}
