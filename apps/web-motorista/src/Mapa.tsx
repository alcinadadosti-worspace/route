import { useEffect, useRef } from 'react';
import { LngLatBounds, Map as MapaLibre, Marker, Popup, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { decodificarPolyline, type GeoPonto } from '@rota/shared';
import { camadaContorno, camadaLinha, COR_ROTA } from './estiloRota';

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
}: {
  cd: GeoPonto & { nome: string };
  paradas: PontoMapa[];
  /** Traçado planejado (encoded polyline). Sem ele, liga os pontos em linha reta. */
  polyline?: string;
  estilo: StyleSpecification;
  /** Toque em "Navegar até aqui" no balão da parada — o mapa vira o seletor. */
  aoEscolherParada?: (pedidoId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Por referência: o mapa é recriado quando as props mudam de identidade, e
  // um callback novo a cada render do pai recriaria o MapLibre sem parar.
  const aoEscolherRef = useRef(aoEscolherParada);
  aoEscolherRef.current = aoEscolherParada;

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
      // Contorno escuro por baixo + dourado por cima: é o que faz a rota saltar
      // do mapa. Sem traçado do OSRM, a ligação em linha reta entre os pontos é
      // um palpite e vai tracejada, para não passar por caminho de verdade.
      mapa.addLayer(camadaContorno('tracado-contorno', 'tracado', 5));
      mapa.addLayer(
        camadaLinha('tracado', 'tracado', 5, COR_ROTA, tracado ? undefined : [2, 1.5]),
      );
    });

    new Marker({ color: '#2e3033' })
      .setLngLat([cd.lng, cd.lat])
      .setPopup(new Popup({ offset: 24 }).setText(cd.nome))
      .addTo(mapa);

    for (const p of paradas) {
      new Marker({ color: COR_STATUS[p.status] })
        .setLngLat([p.coordenada.lng, p.coordenada.lat])
        .setPopup(new Popup({ offset: 24 }).setDOMContent(balaoDaParada(p, aoEscolherRef)))
        .addTo(mapa);
    }

    return () => {
      const global = window as unknown as { __mapa?: unknown };
      if (global.__mapa === mapa) delete global.__mapa;
      mapa.remove();
    };
  }, [cd, paradas, polyline, estilo]);

  return <div ref={containerRef} className="mapa" />;
}

/**
 * Conteúdo do balão da parada: identificação e, quando ainda há o que entregar,
 * o atalho para navegar direto dali — é o que faz do mapa um seletor de parada,
 * sem obrigar o motorista a caçar o cartão certo numa lista de dez.
 */
function balaoDaParada(
  p: PontoMapa,
  aoEscolherRef: { current: ((pedidoId: string) => void) | undefined },
): HTMLElement {
  const conteudo = document.createElement('div');
  conteudo.className = 'balao-parada';

  const titulo = document.createElement('div');
  titulo.className = 'balao-titulo';
  titulo.textContent = `PARADA ${String(p.ordem).padStart(2, '0')}`;
  const nome = document.createElement('div');
  nome.textContent = p.cliente;
  conteudo.append(titulo, nome);

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
