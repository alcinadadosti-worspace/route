import { useEffect, useRef } from 'react';
import { LngLatBounds, Map as MapaLibre, Marker, Popup } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  decodificarPolyline,
  haQuantoTempo,
  posicaoEstaVelha,
  validarGeoPonto,
  type GeoPonto,
  type PosicaoMotorista,
  type Rota,
} from '@rota/shared';

/**
 * Mapa do dia em andamento: onde o motorista está, o que já foi resolvido e o
 * que falta — de relance.
 *
 * O acompanhamento era só texto ("3/12 resolvidas · há 4 min"), e texto obriga
 * quem lê a montar a geografia de cabeça. Quando o cliente liga perguntando, a
 * pergunta é espacial: *o caminhão já passou pela minha rua?*
 *
 * O mapa NÃO substitui a tabela — ela continua sendo o resumo que se lê rápido.
 * Este é o detalhe de quem já decidiu olhar uma rota específica.
 */
export function MapaAcompanhamento({
  rota,
  posicao,
  agoraMs,
}: {
  rota: { id: string } & Rota;
  posicao: PosicaoMotorista | null;
  agoraMs: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapaRef = useRef<MapaLibre | null>(null);
  const marcadorMotoristaRef = useRef<Marker | null>(null);

  // O mapa é montado UMA vez por rota. A posição do motorista muda a cada
  // atualização, e recriar o mapa a cada uma reiniciaria o zoom e o
  // deslocamento que o operador acabou de ajustar — por isso o marcador dele é
  // movido no efeito separado, logo abaixo.
  useEffect(() => {
    if (!containerRef.current) return;

    const tracado = decodificarPolyline(rota.polylinePlanejada ?? '');
    const linha: Array<[number, number]> = tracado.map((p) => [p.lng, p.lat]);
    const origem = validarGeoPonto(rota.origemCoordenada);
    // Sem origem válida não há por onde começar o enquadramento. Não deveria
    // acontecer (a publicação exige o CD), mas um doc torto não pode derrubar
    // a aba inteira de acompanhamento.
    if (!origem) return;
    const cd: [number, number] = [origem.lng, origem.lat];

    // Parada sem coordenada utilizável fica FORA do mapa em vez de estourar o
    // enquadramento com NaN — que levaria o MapLibre a um zoom impossível e
    // apagaria o mapa inteiro por causa de uma parada.
    const paradasNoMapa = rota.paradas
      .map((p, i) => ({ parada: p, numero: i + 1, ponto: validarGeoPonto(p.coordenada) }))
      .filter((x): x is { parada: (typeof rota.paradas)[number]; numero: number; ponto: GeoPonto } =>
        x.ponto !== null,
      );

    const limites = [
      ...linha,
      cd,
      ...paradasNoMapa.map((x): [number, number] => [x.ponto.lng, x.ponto.lat]),
    ].reduce((b, c) => b.extend(c), new LngLatBounds(cd, cd));

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
      fitBoundsOptions: { padding: 48 },
    });
    mapa.on('error', (evento) => console.error('[mapa-acompanhamento]', evento.error));
    mapaRef.current = mapa;

    if (linha.length > 1) {
      mapa.on('load', () => {
        mapa.addSource('tracado', {
          type: 'geojson',
          data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: linha } },
        });
        mapa.addLayer({
          id: 'tracado',
          type: 'line',
          source: 'tracado',
          paint: { 'line-color': '#ff5f1f', 'line-width': 3, 'line-opacity': 0.7 },
        });
      });
    }

    new Marker({ color: '#2e3033' })
      .setLngLat(cd)
      .setPopup(new Popup({ offset: 24 }).setText(rota.origemNome))
      .addTo(mapa);

    // Cor por STATUS: o que interessa aqui não é a ordem, é o que já saiu do
    // caminhão. Verde entregue, vermelho insucesso, laranja ainda por fazer.
    for (const { parada, numero, ponto } of paradasNoMapa) {
      const elemento = document.createElement('div');
      elemento.className = `marcador-parada acomp-${parada.status}`;
      elemento.textContent = String(numero);
      const rotulo =
        parada.status === 'entregue'
          ? 'entregue'
          : parada.status === 'insucesso'
            ? 'insucesso'
            : 'a entregar';
      new Marker({ element: elemento })
        .setLngLat([ponto.lng, ponto.lat])
        .setPopup(new Popup({ offset: 18 }).setText(`${numero}. ${parada.nome} — ${rotulo}`))
        .addTo(mapa);
    }

    return () => {
      marcadorMotoristaRef.current = null;
      mapaRef.current = null;
      mapa.remove();
    };
  }, [rota]);

  // O motorista se move: só o marcador dele é atualizado, sem tocar no
  // enquadramento. Posição velha some do mapa em vez de mentir sobre onde ele
  // está — no mapa a mentira é pior que no texto, porque um ponto desenhado
  // parece um fato.
  useEffect(() => {
    const mapa = mapaRef.current;
    if (!mapa) return;
    const velha = posicao ? posicaoEstaVelha(posicao, agoraMs) : true;

    const ponto = posicao ? validarGeoPonto(posicao) : null;
    if (!posicao || velha || !ponto) {
      marcadorMotoristaRef.current?.remove();
      marcadorMotoristaRef.current = null;
      return;
    }
    if (!marcadorMotoristaRef.current) {
      const elemento = document.createElement('div');
      elemento.className = 'marcador-motorista';
      elemento.textContent = '🚚';
      marcadorMotoristaRef.current = new Marker({ element: elemento }).addTo(mapa);
    }
    marcadorMotoristaRef.current
      .setLngLat([ponto.lng, ponto.lat])
      .setPopup(
        new Popup({ offset: 20 }).setText(
          `Motorista · ${haQuantoTempo(posicao.em, agoraMs)} · GPS ±${posicao.precisaoM} m`,
        ),
      );
  }, [posicao, agoraMs]);

  return (
    <div className="mapa-acompanhamento">
      <div ref={containerRef} className="mapa-rota" />
      <div className="legenda-mapa">
        <span className="legenda entregue">entregue</span>
        <span className="legenda insucesso">insucesso</span>
        <span className="legenda pendente">a entregar</span>
        {posicao && !posicaoEstaVelha(posicao, agoraMs) ? (
          <span className="legenda">🚚 motorista</span>
        ) : (
          <span className="legenda apagada">🚚 sem posição recente</span>
        )}
      </div>
    </div>
  );
}
