import { useEffect, useRef } from 'react';
import { LngLatBounds, Map as MapaLibre, Marker, Popup } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { decodificarPolyline, type GeoPonto } from '@rota/shared';

export interface PontoMapa {
  ordem: number;
  cliente: string;
  coordenada: GeoPonto;
  status: 'pendente' | 'entregue' | 'trilha';
}

const COR_STATUS: Record<PontoMapa['status'], string> = {
  pendente: '#ffb020',
  entregue: '#2ea043',
  trilha: '#ff5f1f',
};

/**
 * Mapa da rota do dia. Nesta fase o basemap vem de tiles OSM online — o mapa
 * embarcado (PMTiles em OPFS, seção 12 camada 3) substitui esta fonte na Fase 5
 * sem mudar o componente: MapLibre é o mesmo, troca-se apenas o source.
 */
export function Mapa({
  cd,
  paradas,
  polyline,
}: {
  cd: GeoPonto & { nome: string };
  paradas: PontoMapa[];
  /** Traçado planejado (encoded polyline). Sem ele, liga os pontos em linha reta. */
  polyline?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const tracado = polyline ? decodificarPolyline(polyline) : null;
    const coordenadas: Array<[number, number]> = tracado
      ? tracado.map((p): [number, number] => [p.lng, p.lat])
      : [
          [cd.lng, cd.lat],
          ...paradas.map((p): [number, number] => [p.coordenada.lng, p.coordenada.lat]),
        ];
    const limites = coordenadas.reduce(
      (b, c) => b.extend(c),
      new LngLatBounds(coordenadas[0], coordenadas[0]),
    );

    const mapa = new MapaLibre({
      container: containerRef.current,
      style: {
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
      },
      bounds: limites,
      fitBoundsOptions: { padding: 48, maxZoom: 13 },
    });

    if (import.meta.env.DEV) {
      (window as unknown as { __mapa?: unknown }).__mapa = mapa;
    }

    mapa.on('load', () => {
      mapa.addSource('tracado', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coordenadas } },
      });
      mapa.addLayer({
        id: 'tracado',
        type: 'line',
        source: 'tracado',
        paint: tracado
          ? { 'line-color': '#ff5f1f', 'line-width': 4 }
          : { 'line-color': '#ff5f1f', 'line-width': 4, 'line-dasharray': [2, 1.5] },
      });
    });

    new Marker({ color: '#2e3033' })
      .setLngLat([cd.lng, cd.lat])
      .setPopup(new Popup({ offset: 24 }).setText(cd.nome))
      .addTo(mapa);

    for (const p of paradas) {
      new Marker({ color: COR_STATUS[p.status] })
        .setLngLat([p.coordenada.lng, p.coordenada.lat])
        .setPopup(
          new Popup({ offset: 24 }).setText(
            `PARADA ${String(p.ordem).padStart(2, '0')} — ${p.cliente}`,
          ),
        )
        .addTo(mapa);
    }

    return () => mapa.remove();
  }, [cd, paradas, polyline]);

  return <div ref={containerRef} className="mapa" />;
}
