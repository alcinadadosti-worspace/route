import { useEffect, useRef, useState } from 'react';
import {
  distanciaEmMetros,
  PARAMETROS_TRILHA_PADRAO,
  rumoEmGraus,
  type GeoPonto,
  type ParadaRota,
  type ResultadoEntrega,
  type Rota,
} from '@rota/shared';
import { MapaNavegacao } from './MapaNavegacao';
import { DossieLocal } from './DossieLocal';
import { useWakeLock } from './useWakeLock';
import { usePosicao } from './usePosicao';
import { useBussola } from './useBussola';
import { GravadorTrilha } from './gravadorTrilha';
import { confirmarPin, salvarTrilhaBruta } from './servicoMapeamento';
import type { DossieCliente } from './useClientesDaRota';

const MOTIVOS_INSUCESSO: Array<{ resultado: ResultadoEntrega; rotulo: string }> = [
  { resultado: 'ausente', rotulo: 'Ausente' },
  { resultado: 'nao_localizado', rotulo: 'Não localizado' },
  { resultado: 'recusa', rotulo: 'Recusa' },
];

/**
 * Navegação por parada (RF-17, seção 11.3) com o modo trilha por cima:
 * — na malha conhecida o app segue a polyline planejada (pré-calculada na
 *   publicação — em campo não há chamada de rota);
 * — a ~100 m do pontoEntrada da trilha aprendida, handoff: a trilha vira o
 *   guia, com seta de direção e distância em linha reta até o pin;
 * — a ~30 m do pin (ou no toque em CHEGUEI), o cartão de chegada: confirmar
 *   pin quando o destino ainda não é mapeado (RF-07, encerra a gravação),
 *   depois entrega ou insucesso (RF-18).
 * Destino sem pin confirmado grava trilha automaticamente (seção 11.1);
 * destino já mapeado pode regravar pelo botão (reaprendizado, RF-09).
 */
export function Navegacao({
  rota,
  parada,
  dossie,
  uid,
  aoResolver,
  aoFechar,
}: {
  rota: { id: string } & Rota;
  parada: ParadaRota;
  dossie: DossieCliente | null;
  uid: string;
  aoResolver: (pedidoId: string, resultado: ResultadoEntrega) => void;
  aoFechar: () => void;
}) {
  const parametros = PARAMETROS_TRILHA_PADRAO;
  const cliente = dossie?.cliente ?? null;
  const trilha = dossie?.trilha ?? null;
  const pinDoCliente = cliente?.coordenada ?? parada.coordenada;
  // Sem o doc do cliente (cache frio) não dá para saber o status: trata como
  // mapeado e não grava — a pré-carga da publicação torna isso raro.
  const precisaMapear = cliente != null && cliente.statusMapeamento !== 'mapeado';

  useWakeLock(true);
  const { leitura, erro: erroGps } = usePosicao(true);
  const bussola = useBussola();

  // Gravação (seção 11.1): automática quando falta o pin; manual no botão.
  const gravadorRef = useRef<GravadorTrilha | null>(null);
  const [gravando, setGravando] = useState(false);
  const [pontosGravados, setPontosGravados] = useState(0);
  useEffect(() => {
    if (precisaMapear && !gravadorRef.current) iniciarGravacao();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [precisaMapear]);
  useEffect(() => {
    if (!leitura || !gravando || !gravadorRef.current) return;
    if (gravadorRef.current.registrar(leitura)) {
      setPontosGravados(gravadorRef.current.quantidade);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leitura]);

  function iniciarGravacao() {
    gravadorRef.current = new GravadorTrilha();
    setPontosGravados(0);
    setGravando(true);
  }

  // Rumo do aparelho: bússola → rumo do GPS → deslocamento entre leituras.
  const anteriorRef = useRef<GeoPonto | null>(null);
  const [rumoDeslocamento, setRumoDeslocamento] = useState<number | null>(null);
  useEffect(() => {
    if (!leitura) return;
    const anterior = anteriorRef.current;
    if (!anterior) {
      anteriorRef.current = leitura;
      return;
    }
    if (distanciaEmMetros(anterior, leitura) >= 5) {
      setRumoDeslocamento(rumoEmGraus(anterior, leitura));
      anteriorRef.current = leitura;
    }
  }, [leitura]);
  const rumoAparelho = bussola ?? leitura?.rumoGps ?? rumoDeslocamento;

  const distanciaAoPin = leitura ? distanciaEmMetros(leitura, pinDoCliente) : null;
  const rumoAoPin = leitura ? rumoEmGraus(leitura, pinDoCliente) : null;

  // Handoff (seção 11.3): entrar no raio do pontoEntrada liga o modo trilha
  // e ele fica ligado — afastar-se da entrada seguindo a trilha é o esperado.
  const [modoTrilha, setModoTrilha] = useState(false);
  useEffect(() => {
    if (modoTrilha || !trilha || !leitura) return;
    if (distanciaEmMetros(leitura, trilha.pontoEntrada) <= parametros.raioHandoffM) {
      setModoTrilha(true);
      navigator.vibrate?.(80);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leitura, trilha, modoTrilha]);

  // Chegada (RF-18): raio de ~30 m ou toque manual em CHEGUEI.
  const [chegou, setChegou] = useState(false);
  useEffect(() => {
    if (chegou || distanciaAoPin == null) return;
    if (distanciaAoPin <= parametros.raioChegadaM) {
      setChegou(true);
      navigator.vibrate?.([120, 60, 120]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distanciaAoPin, chegou]);

  // Ajuste do pin (RF-07): marcador arrastável a partir da posição atual.
  const [pinAjustado, setPinAjustado] = useState<GeoPonto | null>(null);
  const [pinConfirmado, setPinConfirmado] = useState(false);
  const ajustandoPin = chegou && precisaMapear && !pinConfirmado;
  // Sugestão congelada na primeira leitura do ajuste — o marcador não pode
  // ficar perseguindo o jitter do GPS enquanto o motorista mira o portão.
  useEffect(() => {
    if (ajustandoPin && !pinAjustado && leitura) {
      setPinAjustado({ lat: leitura.lat, lng: leitura.lng });
    }
  }, [ajustandoPin, pinAjustado, leitura]);
  const pinNoMapa = ajustandoPin ? (pinAjustado ?? pinDoCliente) : pinDoCliente;

  const [perguntaReaprendizado, setPerguntaReaprendizado] = useState(false);
  useEffect(() => {
    if (chegou && gravando && !precisaMapear) setPerguntaReaprendizado(true);
  }, [chegou, gravando, precisaMapear]);

  function encerrarGravacao(salvar: boolean) {
    const gravacao = gravadorRef.current?.finalizar();
    gravadorRef.current = null;
    setGravando(false);
    setPerguntaReaprendizado(false);
    if (salvar && gravacao && gravacao.pontos.length >= 2) {
      salvarTrilhaBruta({ clienteId: parada.clienteId, rotaId: rota.id, uid, ...gravacao });
    }
  }

  function confirmarPinAqui() {
    confirmarPin(parada.clienteId, pinNoMapa, uid);
    encerrarGravacao(true);
    setPinConfirmado(true);
  }

  const [insucessoAberto, setInsucessoAberto] = useState(false);
  function resolver(resultado: ResultadoEntrega) {
    if (gravando) encerrarGravacao(false);
    aoResolver(parada.pedidoId, resultado);
    aoFechar();
  }

  // Fechar no meio de uma gravação descarta o rastro — nunca em silêncio.
  function fechar() {
    if (
      gravando &&
      pontosGravados > 0 &&
      !window.confirm('A gravação do caminho será descartada. Fechar mesmo assim?')
    ) {
      return;
    }
    aoFechar();
  }

  // A seta gira sempre pelo arco curto: interpolar 359°→1° pelo caminho
  // longo faria o ponteiro dar uma volta inteira a cada cruzamento do norte.
  const anguloSetaRef = useRef(0);
  const alvoSeta = rumoAoPin != null && rumoAparelho != null ? rumoAoPin - rumoAparelho : 0;
  anguloSetaRef.current += ((((alvoSeta - anguloSetaRef.current) % 360) + 540) % 360) - 180;

  const rotuloModo = chegou
    ? 'VOCÊ CHEGOU'
    : modoTrilha
      ? 'TRECHO APRENDIDO — SIGA A TRILHA'
      : trilha
        ? 'SIGA O TRAÇADO ATÉ A ENTRADA DA TRILHA'
        : 'SIGA O TRAÇADO';

  return (
    <div className="navegacao">
      <header className="nav-topo">
        <div>
          <div className="ordem">NAVEGANDO ATÉ</div>
          <h2>{parada.nome}</h2>
        </div>
        <button className="tema-botao" onClick={fechar} aria-label="Voltar à lista">
          ✕ FECHAR
        </button>
      </header>

      {gravando && (
        <div className="nav-gravando">
          ● GRAVANDO CAMINHO · {pontosGravados} {pontosGravados === 1 ? 'ponto' : 'pontos'}
        </div>
      )}

      <MapaNavegacao
        pin={pinNoMapa}
        polylinePlanejada={rota.polylinePlanejada}
        trilha={trilha}
        modoTrilha={modoTrilha}
        posicao={leitura}
        ajustandoPin={ajustandoPin}
        aoAjustarPin={setPinAjustado}
      />

      <div className="nav-painel">
        {erroGps && !leitura && <div className="nav-gps-erro">⚠ {erroGps}</div>}
        <div className="nav-direcao">
          <div
            className="nav-seta"
            style={{ transform: `rotate(${anguloSetaRef.current}deg)` }}
            aria-hidden
          >
            ➤
          </div>
          <div>
            <div className="nav-distancia">{formatarDistancia(distanciaAoPin)}</div>
            <div className="nav-modo">{rotuloModo}</div>
          </div>
        </div>

        {!chegou && (
          <div className="nav-acoes">
            {!gravando && !precisaMapear && (
              <button className="insucesso-botao" onClick={iniciarGravacao}>
                ⏺ Gravar caminho
              </button>
            )}
            <button className="confirmar" onClick={() => setChegou(true)}>
              CHEGUEI
            </button>
          </div>
        )}

        {chegou && ajustandoPin && (
          <div className="nav-chegada">
            <p className="nav-instrucao">
              Arraste o pin no mapa até o ponto exato da entrega, se precisar.
            </p>
            <button className="confirmar" onClick={confirmarPinAqui}>
              📍 Confirmar pin de entrega
            </button>
          </div>
        )}

        {chegou && perguntaReaprendizado && (
          <div className="nav-chegada">
            <p className="nav-instrucao">Caminho gravado. Tornar este o caminho padrão?</p>
            <div className="nav-acoes">
              <button className="confirmar" onClick={() => encerrarGravacao(true)}>
                ✔ Sim, usar este
              </button>
              <button className="insucesso-botao" onClick={() => encerrarGravacao(false)}>
                ✖ Descartar
              </button>
            </div>
          </div>
        )}

        {chegou && !ajustandoPin && !perguntaReaprendizado && (
          <div className="nav-chegada">
            {cliente && <DossieLocal cliente={cliente} />}
            <div className="nav-acoes">
              <button className="confirmar" onClick={() => resolver('entregue')}>
                ✔ Confirmar entrega
              </button>
              <button className="insucesso-botao" onClick={() => setInsucessoAberto(!insucessoAberto)}>
                ✖ Registrar insucesso
              </button>
            </div>
            {insucessoAberto && (
              <div className="motivos">
                {MOTIVOS_INSUCESSO.map((m) => (
                  <button key={m.resultado} onClick={() => resolver(m.resultado)}>
                    {m.rotulo}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatarDistancia(metros: number | null): string {
  if (metros == null) return '— m';
  if (metros < 1000) return `${Math.round(metros)} m`;
  return `${(metros / 1000).toFixed(1)} km`;
}
