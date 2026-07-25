import { useEffect, useRef } from 'react';
import { LngLatBounds, Map as MapaLibre, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { GeoPonto } from '@rota/shared';

/** Fallback de centro quando nenhum dos dois endereços tem coordenada. */
const PENEDO: GeoPonto = { lat: -10.2807606, lng: -36.5594998 };

/**
 * Mapa da decisão de endereço (seção 8.4): mostra o pin A (endereço fiscal, fixo)
 * e o pin B (endereço de entrega, ARRASTÁVEL). O operador confere no mapa e, se a
 * entrega não foi geocodificada (ou está no lugar errado), arrasta o B para o
 * ponto certo — a coordenada volta pelo `aoMoverEntrega`. Criado uma vez; ler as
 * props na montagem basta (cada cartão de decisão tem seu mapa).
 */
export function MapaDecisao({
  fiscal,
  entrega,
  aoMoverEntrega,
}: {
  fiscal: GeoPonto | null;
  entrega: GeoPonto | null;
  aoMoverEntrega: (p: GeoPonto) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Posição inicial do pin B: geocodificado; senão perto do fiscal (para o
  // operador arrastar de um ponto plausível); senão a base.
  const inicioEntrega = entrega ?? fiscal ?? PENEDO;

  useEffect(() => {
    if (!containerRef.current) return;

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
      center: [inicioEntrega.lng, inicioEntrega.lat],
      zoom: 13,
    });
    mapa.on('error', (evento) => console.error('[mapa-decisao]', evento.error));

    // Pin A — endereço fiscal (cinza, fixo). Só existe se o cliente tem coordenada.
    if (fiscal) {
      const elementoA = document.createElement('div');
      elementoA.className = 'pin-decisao pin-a';
      elementoA.textContent = 'A';
      new Marker({ element: elementoA }).setLngLat([fiscal.lng, fiscal.lat]).addTo(mapa);
    }

    // Pin B — endereço de entrega (laranja, arrastável).
    const elementoB = document.createElement('div');
    elementoB.className = 'pin-decisao pin-b';
    elementoB.textContent = 'B';
    const marcadorB = new Marker({ element: elementoB, draggable: true })
      .setLngLat([inicioEntrega.lng, inicioEntrega.lat])
      .addTo(mapa);
    marcadorB.on('dragend', () => {
      const { lat, lng } = marcadorB.getLngLat();
      aoMoverEntrega({ lat, lng });
    });

    // Enquadra A e B quando os dois existem; senão fica no centro do B.
    if (fiscal) {
      const limites = new LngLatBounds(
        [fiscal.lng, fiscal.lat],
        [fiscal.lng, fiscal.lat],
      ).extend([inicioEntrega.lng, inicioEntrega.lat]);
      mapa.fitBounds(limites, { padding: 70, maxZoom: 15, duration: 0 });
    }

    return () => mapa.remove();
    // Criação única: as coordenadas mudam por arraste, sem recriar o mapa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="mapa-rota" />;
}
