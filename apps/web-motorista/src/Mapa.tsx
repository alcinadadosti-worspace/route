import { useEffect, useRef } from 'react';
import { LngLatBounds, Map as MapaLibre, Marker, Popup, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { decodificarPolyline, type GeoPonto } from '@rota/shared';

export interface PontoMapa {
  ordem: number;
  cliente: string;
  coordenada: GeoPonto;
  status: 'pendente' | 'entregue' | 'trilha' | 'insucesso';
}

const COR_STATUS: Record<PontoMapa['status'], string> = {
  pendente: '#ffb020',
  entregue: '#2ea043',
  trilha: '#ff5f1f',
  insucesso: '#d64545',
};

/**
 * Mapa da rota do dia. O basemap vem do estilo recebido — mapa embarcado
 * (PMTiles em OPFS, seção 12 camada 3) quando instalado, tiles OSM online
 * como fallback.
 */
export function Mapa({
  cd,
  paradas,
  polyline,
  estilo,
}: {
  cd: GeoPonto & { nome: string };
  paradas: PontoMapa[];
  /** Traçado planejado (encoded polyline). Sem ele, liga os pontos em linha reta. */
  polyline?: string;
  estilo: StyleSpecification;
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
      style: estilo,
      bounds: limites,
      fitBoundsOptions: { padding: 48, maxZoom: 13 },
    });

    // Exposto também no build: os E2E (RNF-01) inspecionam o estado do mapa.
    (window as unknown as { __mapa?: unknown }).__mapa = mapa;
    // Sem handler, erros de tile/estilo somem em produção — em campo o log
    // é o único jeito de diagnosticar mapa em branco.
    mapa.on('error', (evento) => console.error('[mapa]', evento.error));

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
  }, [cd, paradas, polyline, estilo]);

  return <div ref={containerRef} className="mapa" />;
}
