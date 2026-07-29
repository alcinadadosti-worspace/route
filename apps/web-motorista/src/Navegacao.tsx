import { useEffect, useMemo, useRef, useState } from 'react';
import type { StyleSpecification } from 'maplibre-gl';
import {
  decodificarPolyline,
  distanciaAoTracadoEmMetros,
  distanciaEmMetros,
  paradaPrecisaMapear,
  rumoEmGraus,
  type GeoPonto,
  type ParadaRota,
  type ParametrosTrilha,
  type ResultadoEntrega,
  type Rota,
} from '@rota/shared';
import { MapaNavegacao } from './MapaNavegacao';
import { DossieLocal } from './DossieLocal';
import { useWakeLock } from './useWakeLock';
import { usePosicao } from './usePosicao';
import { useBussola } from './useBussola';
import { GravadorTrilha } from './gravadorTrilha';
import { confirmarPin, recalcularTracado, salvarTrilhaBruta } from './servicoMapeamento';
import { formatarDistancia } from './formato';
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
  estilo,
  estiloKey,
  parametros,
  aoResolver,
  aoFechar,
}: {
  rota: { id: string } & Rota;
  parada: ParadaRota;
  dossie: DossieCliente | null;
  uid: string;
  estilo: StyleSpecification;
  /** Identidade do estilo. Muda só se o mapa embarcado for instalado no meio
   * da navegação (raro): força o MapaNavegacao a remontar com o mapa offline
   * em vez de ficar preso no basemap online que falha ao sair do sinal. */
  estiloKey: string;
  aoResolver: (pedidoId: string, resultado: ResultadoEntrega) => void;
  aoFechar: () => void;
  /** Parâmetros de trilha já mesclados de config/geral (seção 11). */
  parametros: ParametrosTrilha;
}) {
  const cliente = dossie?.cliente ?? null;
  const trilha = dossie?.trilha ?? null;
  const pinDoCliente = cliente?.coordenada ?? parada.coordenada;
  // Destino sem ponto confiável (rural/aproximado) grava trilha e confirma pin em
  // campo. Geocodificado (preciso) e já mapeado: navega até o pin e entrega, sem
  // esse fluxo. Sem o doc do cliente (cache frio) vale a flag da rota publicada.
  const precisaMapear = paradaPrecisaMapear(parada.precisaMapear, cliente?.statusMapeamento);

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
    gravadorRef.current = new GravadorTrilha(parametros);
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

  // Desvio do traçado (seção 11.6). A DETECÇÃO é geometria pura e roda offline;
  // só o recálculo precisa de rede. Uma vez recalculado, o desvio passa a ser
  // medido contra o traçado novo — senão o app pediria outro a cada leitura.
  const [rerota, setRerota] = useState<{ polyline: string; distanciaKm: number } | null>(null);
  const [recalculando, setRecalculando] = useState(false);
  const [erroRerota, setErroRerota] = useState<string | null>(null);
  const tracadoDesenhado = rerota?.polyline ?? rota.polylinePlanejada;
  const pontosTracado = useMemo(
    () => (tracadoDesenhado ? decodificarPolyline(tracadoDesenhado) : []),
    [tracadoDesenhado],
  );
  // Memorizado: o traçado tem milhares de pontos e a tela re-renderiza por
  // muito mais que leitura de GPS (abrir dossiê, digitar observação).
  const desvioM = useMemo(
    () => (leitura ? distanciaAoTracadoEmMetros(leitura, pontosTracado) : null),
    [leitura, pontosTracado],
  );
  // Perto do destino o traçado acaba e a orientação passa a ser a seta (e a
  // trilha, quando existe): desvio ali é esperado, não é motivo de recálculo.
  const longeDoDestino = distanciaAoPin == null || distanciaAoPin > 400;
  const foraDoTracado =
    desvioM != null && desvioM > parametros.desvioMinimoM && longeDoDestino && !chegou && !modoTrilha;

  const recalcularRef = useRef<() => void>(() => {});
  const [tentativaEm, setTentativaEm] = useState(0);
  recalcularRef.current = () => {
    if (!leitura || recalculando) return;
    setRecalculando(true);
    setErroRerota(null);
    setTentativaEm(Date.now());
    recalcularTracado(rota.id, parada.pedidoId, { lat: leitura.lat, lng: leitura.lng })
      .then((novo) => setRerota(novo))
      .catch((erro: unknown) =>
        setErroRerota(erro instanceof Error ? erro.message : 'Não deu para recalcular'),
      )
      .finally(() => setRecalculando(false));
  };

  // Dispara sozinho depois de LEITURAS SEGUIDAS fora do traçado — um salto de
  // GPS não pode acordar o OSRM à toa —, uma vez por minuto no máximo, e só
  // com rede: offline a chamada só queimaria bateria.
  const forasSeguidosRef = useRef(0);
  useEffect(() => {
    if (!foraDoTracado) {
      forasSeguidosRef.current = 0;
      return;
    }
    forasSeguidosRef.current += 1;
    if (forasSeguidosRef.current < 3) return;
    if (!navigator.onLine || recalculando) return;
    if (tentativaEm && Date.now() - tentativaEm < 60_000) return;
    recalcularRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foraDoTracado, leitura]);

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

  /**
   * Saída para quando o GPS não deu posição e o motorista não arrastou o pin:
   * segue para a entrega SEM gravar pin. Confirmar aqui gravaria a coordenada
   * aproximada do geocodificador com `statusMapeamento: 'mapeado'` — o ponto
   * errado viraria definitivo e o app nunca mais pediria para mapear o cliente.
   * Sem pin, ele continua 'aproximado' e é oferecido de novo na próxima visita.
   */
  function seguirSemPin() {
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
        key={estiloKey}
        estilo={estilo}
        pin={pinNoMapa}
        polylinePlanejada={tracadoDesenhado}
        trilha={trilha}
        modoTrilha={modoTrilha}
        posicao={leitura}
        ajustandoPin={ajustandoPin}
        aoAjustarPin={setPinAjustado}
      />

      <div className="nav-painel">
        {erroGps && !leitura && <div className="nav-gps-erro">⚠ {erroGps}</div>}

        {foraDoTracado && (
          <div className="nav-desvio">
            <span>
              ⚠ Fora do traçado · {formatarDistancia(desvioM)}
              {erroRerota && ` — ${erroRerota}`}
            </span>
            {recalculando ? (
              <span className="nav-desvio-estado">recalculando…</span>
            ) : navigator.onLine ? (
              <button onClick={() => recalcularRef.current()}>Recalcular</button>
            ) : (
              <span className="nav-desvio-estado">sem sinal — traçado antigo</span>
            )}
          </div>
        )}
        {rerota && !foraDoTracado && (
          <div className="nav-desvio ok">
            ✔ Traçado recalculado daqui · {rerota.distanciaKm} km até o destino
          </div>
        )}
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
            {pinAjustado ? (
              <>
                <p className="nav-instrucao">
                  Arraste o pin no mapa até o ponto exato da entrega, se precisar.
                  {leitura && ` (GPS ±${Math.round(leitura.precisaoM)} m)`}
                </p>
                <button className="confirmar" onClick={confirmarPinAqui}>
                  📍 Confirmar pin de entrega
                </button>
              </>
            ) : (
              // Sem leitura de GPS o pin no mapa ainda é o ponto aproximado do
              // geocodificador: gravá-lo como confirmado seria mentira que fica.
              <>
                <p className="nav-instrucao">
                  ⚠ Sem posição do GPS para marcar o pin. Arraste o pin no mapa até a porta do
                  cliente, ou siga sem marcar — o ponto continua aproximado e o app pede de novo
                  na próxima visita.
                </p>
                <button className="insucesso-botao" onClick={seguirSemPin}>
                  Seguir sem marcar o pin
                </button>
              </>
            )}
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
