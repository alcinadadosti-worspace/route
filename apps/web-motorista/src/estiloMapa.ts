import { layers, namedFlavor } from '@protomaps/basemaps';
import type { StyleSpecification } from 'maplibre-gl';

export type Tema = 'galpao' | 'patio';

const ORIGEM = typeof location !== 'undefined' ? location.origin : '';

/**
 * Estilo do basemap nos dois temas da seção 14.2: Galpão usa o flavor dark
 * (aço/carvão), Pátio o light (alto contraste ao sol). Com o mapa embarcado
 * ativo (`urlPmtiles` da instalação no OPFS), tudo é local: tiles do OPFS,
 * glyphs e sprites do bundle (nenhuma dependência de CDN em campo — seção 12,
 * camada 1). Sem ele, fallback de tiles OSM online, como nas fases 3–4.
 */
export function estiloMapa(tema: Tema, urlPmtiles: string | null): StyleSpecification {
  if (!urlPmtiles) {
    return {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '© OpenStreetMap',
        },
      },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
    };
  }

  const sabor = tema === 'galpao' ? 'dark' : 'light';
  return {
    version: 8,
    glyphs: `${ORIGEM}/basemap/fonts/{fontstack}/{range}.pbf`,
    sprite: `${ORIGEM}/basemap/sprites/v4/${sabor}`,
    sources: {
      basemap: {
        type: 'vector',
        url: urlPmtiles,
        attribution: '© OpenStreetMap',
      },
    },
    layers: layers('basemap', namedFlavor(sabor), { lang: 'pt' }),
  };
}
