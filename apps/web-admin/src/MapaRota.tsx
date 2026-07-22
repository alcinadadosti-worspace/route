import { useEffect, useRef } from 'react';
import { LngLatBounds, Map as MapaLibre, Marker, Popup } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { decodificarPolyline, type PreviaRota } from '@rota/shared';

/**
 * Mapa da prévia de rota (RF-11): traçado OSRM decodificado + CD de partida
 * + paradas numeradas na ordem de visita.
 */
export function MapaRota({ previa }: { previa: PreviaRota }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const tracado = decodificarPolyline(previa.polyline);
    const linha: Array<[number, number]> = tracado.map((p) => [p.lng, p.lat]);

    const limites = linha.reduce(
      (b, c) => b.extend(c),
      new LngLatBounds(
        [previa.cd.coordenada.lng, previa.cd.coordenada.lat],
        [previa.cd.coordenada.lng, previa.cd.coordenada.lat],
      ),
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
      fitBoundsOptions: { padding: 56 },
    });

    mapa.on('load', () => {
      mapa.addSource('tracado', {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: linha },
        },
      });
      mapa.addLayer({
        id: 'tracado',
        type: 'line',
        source: 'tracado',
        paint: { 'line-color': '#ff5f1f', 'line-width': 4 },
      });
    });

    new Marker({ color: '#2e3033' })
      .setLngLat([previa.cd.coordenada.lng, previa.cd.coordenada.lat])
      .setPopup(new Popup({ offset: 24 }).setText(previa.cd.nome))
      .addTo(mapa);

    for (const parada of previa.paradas) {
      const elemento = document.createElement('div');
      elemento.className = 'marcador-parada';
      elemento.textContent = String(parada.posicao);
      new Marker({ element: elemento })
        .setLngLat([parada.coordenada.lng, parada.coordenada.lat])
        .setPopup(new Popup({ offset: 18 }).setText(`${parada.posicao}. ${parada.nome}`))
        .addTo(mapa);
    }

    return () => mapa.remove();
  }, [previa]);

  return <div ref={containerRef} className="mapa-rota" />;
}
