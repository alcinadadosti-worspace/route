import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LngLatBounds,
  Map as MapaLibre,
  Marker,
  Popup,
  type GeoJSONSource,
  type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { decodificarPolyline, type GeoPonto } from '@rota/shared';
import { camadaContorno, camadaLinha, COR_ROTA } from './estiloRota';
import { indicesDasParadas, trechoDaParada } from './trechos';

export interface PontoMapa {
  ordem: number;
  cliente: string;
  coordenada: GeoPonto;
  status: 'pendente' | 'entregue' | 'trilha' | 'insucesso';
  /** Sempre presente nas paradas de rota publicada; sem ele não há para onde navegar. */
  pedidoId?: string;
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
  aoEscolherParada,
  paradaFocada = null,
  aoFocarParada,
}: {
  cd: GeoPonto & { nome: string };
  paradas: PontoMapa[];
  /** Traçado planejado (encoded polyline). Sem ele, liga os pontos em linha reta. */
  polyline?: string;
  estilo: StyleSpecification;
  /** Toque em "Navegar até aqui" no balão da parada — o mapa vira o seletor. */
  aoEscolherParada?: (pedidoId: string) => void;
  /**
   * Parada em foco (índice 0-based). Com foco, o mapa desenha SÓ o trecho que
   * chega nela e enquadra esse trecho — a rota inteira de uma vez não aponta
   * para nada. Null desenha a rota toda.
   */
  paradaFocada?: number | null;
  /** Toque no marcador da parada. */
  aoFocarParada?: (indice: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapaRef = useRef<MapaLibre | null>(null);
  const [pronto, setPronto] = useState(false);
  // Por referência: o mapa é recriado quando as props mudam de identidade, e
  // um callback novo a cada render do pai recriaria o MapLibre sem parar.
  const aoEscolherRef = useRef(aoEscolherParada);
  aoEscolherRef.current = aoEscolherParada;
  const aoFocarRef = useRef(aoFocarParada);
  aoFocarRef.current = aoFocarParada;

  /**
   * Traçado e emendas por parada. Sem polyline do OSRM, a ligação reta entre os
   * pontos serve de traçado — e o recorte por parada funciona igual.
   */
  const desenho = useMemo(() => {
    const doOsrm = polyline ? decodificarPolyline(polyline) : null;
    const linha: GeoPonto[] = doOsrm ?? [
      { lat: cd.lat, lng: cd.lng },
      ...paradas.map((p) => p.coordenada),
    ];
    return {
      linha,
      indices: indicesDasParadas(
        linha,
        paradas.map((p) => p.coordenada),
      ),
      doOsrm: doOsrm != null,
    };
  }, [polyline, paradas, cd]);

  useEffect(() => {
    if (!containerRef.current) return;

    const coordenadas = desenho.linha.map((p): [number, number] => [p.lng, p.lat]);
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
    mapaRef.current = mapa;

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
      // Contorno escuro por baixo + dourado por cima: é o que faz a rota saltar
      // do mapa. Sem traçado do OSRM, a ligação em linha reta entre os pontos é
      // um palpite e vai tracejada, para não passar por caminho de verdade.
      mapa.addLayer(camadaContorno('tracado-contorno', 'tracado', 5));
      mapa.addLayer(
        camadaLinha('tracado', 'tracado', 5, COR_ROTA, desenho.doOsrm ? undefined : [2, 1.5]),
      );
      setPronto(true);
    });

    new Marker({ color: '#2e3033' })
      .setLngLat([cd.lng, cd.lat])
      .setPopup(new Popup({ offset: 24 }).setText(cd.nome))
      .addTo(mapa);

    paradas.forEach((p, indice) => {
      const balao = new Popup({ offset: 24 });
      balao.setDOMContent(balaoDaParada(p, indice, aoEscolherRef, aoFocarRef, balao));
      new Marker({ color: COR_STATUS[p.status] })
        .setLngLat([p.coordenada.lng, p.coordenada.lat])
        .setPopup(balao)
        .addTo(mapa);
    });

    return () => {
      const global = window as unknown as { __mapa?: unknown };
      if (global.__mapa === mapa) delete global.__mapa;
      mapaRef.current = null;
      setPronto(false);
      mapa.remove();
    };
  }, [cd, paradas, desenho, estilo]);

  // Foco: redesenha a linha e enquadra o trecho, SEM recriar o mapa — recriar
  // recarregaria o basemap a cada toque de parada.
  useEffect(() => {
    const mapa = mapaRef.current;
    if (!mapa || !pronto) return;
    const pontos =
      paradaFocada == null
        ? desenho.linha
        : trechoDaParada(desenho.linha, desenho.indices, paradaFocada);
    if (pontos.length === 0) return;

    const fonte = mapa.getSource('tracado') as GeoJSONSource | undefined;
    fonte?.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: pontos.map((p) => [p.lng, p.lat]) },
    });

    const limites = pontos.reduce(
      (b, p) => b.extend([p.lng, p.lat]),
      new LngLatBounds([pontos[0]!.lng, pontos[0]!.lat], [pontos[0]!.lng, pontos[0]!.lat]),
    );
    mapa.fitBounds(limites, { padding: 60, maxZoom: 15, duration: 500 });
  }, [pronto, paradaFocada, desenho]);

  return <div ref={containerRef} className="mapa" />;
}

/**
 * Conteúdo do balão da parada: identificação e as duas ações que fazem do mapa
 * um seletor — ver só o caminho até ela, e navegar direto dali. Ambas em botão
 * explícito: depender do clique no marcador escondia a função (no computador o
 * clique lê como "abrir o balão", e o balão ainda cobre o mapa).
 */
function balaoDaParada(
  p: PontoMapa,
  indice: number,
  aoEscolherRef: { current: ((pedidoId: string) => void) | undefined },
  aoFocarRef: { current: ((indice: number) => void) | undefined },
  balao: Popup,
): HTMLElement {
  const conteudo = document.createElement('div');
  conteudo.className = 'balao-parada';

  const titulo = document.createElement('div');
  titulo.className = 'balao-titulo';
  titulo.textContent = `PARADA ${String(p.ordem).padStart(2, '0')}`;
  const nome = document.createElement('div');
  nome.textContent = p.cliente;
  conteudo.append(titulo, nome);

  const focar = document.createElement('button');
  focar.type = 'button';
  focar.className = 'balao-focar';
  focar.textContent = '🔍 Ver só este caminho';
  focar.addEventListener('click', () => {
    aoFocarRef.current?.(indice);
    // Fecha o balão: ele cobre justamente o trecho que acabou de ser desenhado.
    balao.remove();
  });
  conteudo.appendChild(focar);

  const pendente = p.status === 'pendente' || p.status === 'trilha';
  if (p.pedidoId && pendente) {
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'balao-navegar';
    botao.textContent = '🧭 Navegar até aqui';
    botao.addEventListener('click', () => aoEscolherRef.current?.(p.pedidoId!));
    conteudo.appendChild(botao);
  }
  return conteudo;
}
