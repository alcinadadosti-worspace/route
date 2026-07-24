import { useEffect, useRef, useState } from 'react';
import {
  Map as MapaLibre,
  Marker,
  type GeoJSONSource,
  type LngLatLike,
  type StyleSpecification,
} from 'maplibre-gl';
import type { Feature, LineString } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import { decodificarPolyline, type GeoPonto, type Trilha } from '@rota/shared';

/**
 * Mapa da navegação por parada (RF-17, seção 11.3). Ao contrário do mapa de
 * visão geral, este é criado UMA vez e atualizado por referência: a posição
 * chega a cada segundo e recriar o MapLibre a cada leitura é inviável.
 * Camadas: traçado planejado (contexto), trilha aprendida (destaca no
 * handoff), pin do destino (arrastável no ajuste) e posição do veículo.
 */
export function MapaNavegacao({
  pin,
  polylinePlanejada,
  trilha,
  modoTrilha,
  posicao,
  ajustandoPin,
  aoAjustarPin,
  estilo,
}: {
  pin: GeoPonto;
  polylinePlanejada?: string;
  trilha: Trilha | null;
  modoTrilha: boolean;
  posicao: GeoPonto | null;
  /** Pin arrastável (RF-07) — a câmera para de seguir o veículo. */
  ajustandoPin: boolean;
  aoAjustarPin: (p: GeoPonto) => void;
  /** Definido na montagem (o tema não muda durante a navegação). */
  estilo: StyleSpecification;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapaRef = useRef<MapaLibre | null>(null);
  const marcadorPinRef = useRef<Marker | null>(null);
  const marcadorPosicaoRef = useRef<Marker | null>(null);
  const veiculoNoMapaRef = useRef(false);
  /** Gesto do motorista pausa o follow — a câmera não pode brigar com o dedo. */
  const seguirAPartirDeRef = useRef(0);
  const [pronto, setPronto] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const mapa = new MapaLibre({
      container: containerRef.current,
      style: estilo,
      center: [pin.lng, pin.lat] as LngLatLike,
      zoom: 14,
    });
    mapaRef.current = mapa;

    mapa.on('load', () => {
      mapa.addSource('planejada', { type: 'geojson', data: linhaVazia() });
      mapa.addLayer({
        id: 'planejada',
        type: 'line',
        source: 'planejada',
        paint: { 'line-color': '#8a8f98', 'line-width': 3 },
      });
      mapa.addSource('trilha', { type: 'geojson', data: linhaVazia() });
      mapa.addLayer({
        id: 'trilha',
        type: 'line',
        source: 'trilha',
        paint: { 'line-color': '#ff5f1f', 'line-width': 5, 'line-dasharray': [1, 2] },
      });
      setPronto(true);
    });

    const marcadorPin = new Marker({ color: '#ff5f1f' })
      .setLngLat([pin.lng, pin.lat])
      .addTo(mapa);
    marcadorPin.on('dragend', () => {
      const posicaoPin = marcadorPin.getLngLat();
      aoAjustarPin({ lat: posicaoPin.lat, lng: posicaoPin.lng });
    });
    marcadorPinRef.current = marcadorPin;

    const elementoVeiculo = document.createElement('div');
    elementoVeiculo.className = 'veiculo-marcador';
    marcadorPosicaoRef.current = new Marker({ element: elementoVeiculo });

    // `originalEvent` distingue gesto do usuário de movimento do easeTo.
    const aoInteragir = (evento: { originalEvent?: unknown }) => {
      if (evento.originalEvent) seguirAPartirDeRef.current = Date.now() + 10_000;
    };
    mapa.on('dragstart', aoInteragir);
    mapa.on('zoomstart', aoInteragir);

    if (import.meta.env.DEV) {
      (window as unknown as { __mapaNavegacao?: unknown }).__mapaNavegacao = mapa;
    }

    return () => {
      mapaRef.current = null;
      veiculoNoMapaRef.current = false;
      setPronto(false);
      mapa.remove();
    };
    // Criação única: as props mudam via efeitos abaixo, sem recriar o mapa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Traçado planejado e trilha aprendida.
  useEffect(() => {
    const mapa = mapaRef.current;
    if (!mapa || !pronto) return;
    atualizarLinha(mapa, 'planejada', polylinePlanejada ? decodificarPolyline(polylinePlanejada) : []);
    atualizarLinha(mapa, 'trilha', trilha ? decodificarPolyline(trilha.polyline) : []);
  }, [pronto, polylinePlanejada, trilha]);

  // Handoff (seção 11.3): a trilha tracejada vira linha cheia e mais grossa.
  useEffect(() => {
    const mapa = mapaRef.current;
    if (!mapa || !pronto) return;
    mapa.setPaintProperty('trilha', 'line-dasharray', modoTrilha ? [1, 0] : [1, 2]);
    mapa.setPaintProperty('trilha', 'line-width', modoTrilha ? 7 : 5);
  }, [pronto, modoTrilha]);

  // Pin do destino: segue o doc do cliente; arrastável só durante o ajuste.
  useEffect(() => {
    marcadorPinRef.current?.setLngLat([pin.lng, pin.lat]);
  }, [pin.lat, pin.lng]);
  useEffect(() => {
    marcadorPinRef.current?.setDraggable(ajustandoPin);
    if (ajustandoPin && mapaRef.current) {
      mapaRef.current.easeTo({ center: [pin.lng, pin.lat], zoom: 17, duration: 600 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ajustandoPin]);

  // Posição do veículo: marcador + câmera seguindo (exceto durante o ajuste).
  useEffect(() => {
    const mapa = mapaRef.current;
    if (!mapa || !posicao) return;
    const marcador = marcadorPosicaoRef.current!;
    marcador.setLngLat([posicao.lng, posicao.lat]);
    if (!veiculoNoMapaRef.current) {
      marcador.addTo(mapa);
      veiculoNoMapaRef.current = true;
    }
    if (!ajustandoPin && Date.now() >= seguirAPartirDeRef.current) {
      mapa.easeTo({ center: [posicao.lng, posicao.lat], duration: 800 });
    }
  }, [posicao, ajustandoPin]);

  return <div ref={containerRef} className="mapa mapa-navegacao" />;
}

function linhaVazia(): Feature<LineString> {
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } };
}

function atualizarLinha(mapa: MapaLibre, id: string, pontos: GeoPonto[]): void {
  const fonte = mapa.getSource(id) as GeoJSONSource | undefined;
  fonte?.setData({
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: pontos.map((p) => [p.lng, p.lat]) },
  });
}
