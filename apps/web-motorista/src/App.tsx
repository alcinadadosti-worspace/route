import { useEffect, useMemo, useState } from 'react';
import {
  linkLigacao,
  linkWhatsApp,
  mensagemDeRota,
  mesclarParametrosAviso,
  mesclarParametrosTrilha,
  paradaPrecisaMapear,
  type GeoPonto,
  type ResultadoEntrega,
} from '@rota/shared';
import { Mapa } from './Mapa';
import { Login } from './Login';
import { Navegacao } from './Navegacao';
import { DossieLocal, FotoReferencia } from './DossieLocal';
import { useAutenticacao } from './useAutenticacao';
import { useRotaDoDia } from './useRotaDoDia';
import { useClientesDaRota } from './useClientesDaRota';
import { useConfigGeral } from './useConfigGeral';
import { useMapaOffline } from './useMapaOffline';
import { estiloMapa, type Tema } from './estiloMapa';
import { tipoDeRede } from './mapaOffline';
import { registrarAviso, registrarResultado } from './servicoEntrega';
import { dispararProcessamento, ordemSugerida } from './servicoMapeamento';
import { processarFilaFotos } from './servicoFotos';
import { usePosicao } from './usePosicao';
import { aplicarOrdemSugerida, ordenarPorProximidade } from './proximidade';
import { formatarDistancia } from './formato';

/**
 * Parada como a tela do motorista precisa dela: a ParadaRota da rota publicada
 * achatada com o que vem do dossiê do cliente.
 *
 * Não existe mais modo de demonstração. Ele foi útil na Fase 0, antes de haver
 * rota real; com o sistema em operação, mostrar três clientes inventados quando
 * não há rota publicada é pior que mostrar nada — o motorista não tem como
 * saber, olhando a tela, que aquilo não é entrega de verdade.
 */
interface ParadaTela {
  ordem: number;
  cliente: string;
  endereco: string;
  telefone: string;
  coordenada: GeoPonto;
  itens: number;
  volumes: number;
  pesoKg: number;
  status: 'pendente' | 'entregue' | 'trilha' | 'insucesso';
  observacao?: string;
  fotoPath?: string;
  pedidoId?: string;
  clienteId?: string;
  /** Minutos de direção acumulados desde o CD, calculados na publicação. */
  etaMin?: number;
  avisadoEm?: string | null;
}

const ICONE_STATUS: Record<ParadaTela['status'], string> = {
  pendente: '●',
  entregue: '✔',
  trilha: '▲',
  insucesso: '✖',
};

const TEXTO_STATUS: Record<ParadaTela['status'], string> = {
  pendente: 'A entregar',
  entregue: 'Entregue',
  trilha: 'Mapear no local',
  insucesso: 'Insucesso',
};

type Filtro = 'todas' | 'a_entregar' | 'entregues' | 'insucessos' | 'rural' | 'urbana';

const ABAS_FILTRO: Array<{ id: Filtro; rotulo: string }> = [
  { id: 'todas', rotulo: 'Todas' },
  { id: 'a_entregar', rotulo: 'A entregar' },
  { id: 'rural', rotulo: 'Rural' },
  { id: 'urbana', rotulo: 'Urbana' },
  { id: 'entregues', rotulo: 'Entregues' },
  { id: 'insucessos', rotulo: 'Insucessos' },
];

/** Quais status de parada compõem cada filtro (rural = as de "navegar e mapear"). */
const STATUS_DO_FILTRO: Record<Exclude<Filtro, 'todas'>, ParadaTela['status'][]> = {
  a_entregar: ['pendente', 'trilha'],
  entregues: ['entregue'],
  insucessos: ['insucesso'],
  rural: ['trilha'],
  urbana: ['pendente'],
};

const MOTIVOS_INSUCESSO: Array<{ resultado: ResultadoEntrega; rotulo: string }> = [
  { resultado: 'ausente', rotulo: 'Ausente' },
  { resultado: 'nao_localizado', rotulo: 'Não localizado' },
  { resultado: 'recusa', rotulo: 'Recusa' },
];

/** ISO → `08h15`, para o motorista ver de relance quando avisou o cliente. */
function horaCurta(iso: string): string {
  const data = new Date(iso);
  return `${data.getHours()}h${String(data.getMinutes()).padStart(2, '0')}`;
}

/** `20260723` → `23/07/2026` — a versão do mapa é a data do extrato OSM. */
function versaoLegivel(versao: string): string {
  return `${versao.slice(6, 8)}/${versao.slice(4, 6)}/${versao.slice(0, 4)}`;
}

export function App() {
  const [tema, setTema] = useState<Tema>('galpao');
  const { usuario, carregando, entrar, sair } = useAutenticacao();
  const { rota } = useRotaDoDia(usuario?.uid ?? null);
  const dossies = useClientesDaRota(rota);
  const config = useConfigGeral(usuario?.uid ?? null);
  const mapaOffline = useMapaOffline(config);
  const estilo = useMemo(
    () => estiloMapa(tema, mapaOffline.urlFonte),
    [tema, mapaOffline.urlFonte],
  );
  // Parâmetros de trilha: padrões mesclados com os overrides de config/geral —
  // o escritório ajusta filtros de GPS/handoff sem novo deploy (seção 11).
  const parametrosTrilha = useMemo(() => mesclarParametrosTrilha(config?.trilha), [config?.trilha]);
  // Redação e ritmo do aviso ao cliente — também ajustáveis sem deploy.
  const parametrosAviso = useMemo(() => mesclarParametrosAviso(config?.aviso), [config?.aviso]);

  // Alternância Galpão/Pátio em um toque no topo da tela (seção 14.2).
  useEffect(() => {
    document.documentElement.dataset.tema = tema;
  }, [tema]);

  // O que ficou pendente offline (trilhas por processar, fotos na fila) é
  // retomado em toda abertura logada e sempre que a rede volta.
  useEffect(() => {
    if (!usuario) return;
    dispararProcessamento();
    void processarFilaFotos();
    const aoVoltarRede = () => {
      dispararProcessamento();
      void processarFilaFotos();
    };
    window.addEventListener('online', aoVoltarRede);
    return () => window.removeEventListener('online', aoVoltarRede);
  }, [usuario]);

  // CD de partida da rota publicada. Identidade presa ao id da rota: cada
  // snapshot renova o objeto `rota`, e um `cd` novo a cada confirmação
  // recriaria o mapa da visão geral.
  const cd = useMemo(
    () => (rota ? { nome: rota.origemNome, ...rota.origemCoordenada } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rota?.id],
  );
  const paradas: ParadaTela[] = useMemo(
    () =>
      rota
        ? rota.paradas.map((p, i) => {
            const cliente = dossies[p.clienteId]?.cliente ?? null;
            return {
              ordem: i + 1,
              cliente: p.nome,
              endereco: p.endereco,
              telefone: p.telefone ?? '',
              coordenada: p.coordenada,
              itens: p.itens.length,
              volumes: p.volumes,
              pesoKg: p.pesoBrutoKg,
              status:
                p.status === 'entregue'
                  ? ('entregue' as const)
                  : p.status === 'insucesso'
                    ? ('insucesso' as const)
                    : // Destino sem ponto confiável (rural/aproximado) → 'trilha'
                      // (mapear em campo); geocodificado/mapeado é entrega normal.
                      paradaPrecisaMapear(p.precisaMapear, cliente?.statusMapeamento)
                      ? ('trilha' as const)
                      : ('pendente' as const),
              observacao: cliente?.observacoes || undefined,
              fotoPath: cliente?.fotoReferenciaPath ?? undefined,
              pedidoId: p.pedidoId,
              clienteId: p.clienteId,
              etaMin: p.etaMin,
              avisadoEm: p.avisadoEm ?? null,
            };
          })
        : [],
    [rota, dossies],
  );
  const [insucessoAberto, setInsucessoAberto] = useState<string | null>(null);
  const [navegandoPara, setNavegandoPara] = useState<string | null>(null);
  const [dossieAberto, setDossieAberto] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<Filtro>('todas');
  const [porProximidade, setPorProximidade] = useState(false);
  /** Ordem por estrada vinda da API (null = linha reta, o padrão offline). */
  const [ordemEstrada, setOrdemEstrada] = useState<string[] | null>(null);
  const [refinando, setRefinando] = useState(false);
  const [erroOrdem, setErroOrdem] = useState<string | null>(null);

  function resolver(pedidoId: string | undefined, resultado: ResultadoEntrega) {
    if (!rota || !pedidoId || !usuario) return;
    const parada = rota.paradas.find((p) => p.pedidoId === pedidoId);
    // Parada já resolvida não gera segunda entrega (proteção contra toque duplo).
    if (!parada || parada.status === 'entregue' || parada.status === 'insucesso') return;
    registrarResultado(rota, parada, resultado, usuario.uid);
    setInsucessoAberto(null);
  }

  // O componente Mapa recria o MapLibre quando as props mudam de identidade;
  // os snapshots de dossiê renovam `paradas` a cada chegada, então os pontos
  // só devem trocar de identidade quando algo visível no mapa mudar de fato.
  const chavePontos = paradas
    .map((p) => `${p.ordem}:${p.status}:${p.coordenada.lat},${p.coordenada.lng}`)
    .join('|');
  const pontosMapa = useMemo(
    () =>
      paradas.map((p) => ({
        ordem: p.ordem,
        cliente: p.cliente,
        coordenada: p.coordenada,
        status: p.status,
        pedidoId: p.pedidoId,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chavePontos],
  );

  const entregues = paradas.filter((p) => p.status === 'entregue').length;

  const contagem = useMemo((): Record<Filtro, number> => {
    const conta = (fs: ParadaTela['status'][]) => paradas.filter((p) => fs.includes(p.status)).length;
    return {
      todas: paradas.length,
      a_entregar: conta(STATUS_DO_FILTRO.a_entregar),
      entregues: conta(STATUS_DO_FILTRO.entregues),
      insucessos: conta(STATUS_DO_FILTRO.insucessos),
      rural: conta(STATUS_DO_FILTRO.rural),
      urbana: conta(STATUS_DO_FILTRO.urbana),
    };
  }, [paradas]);

  const paradasFiltradas = useMemo(
    () =>
      filtro === 'todas'
        ? paradas
        : paradas.filter((p) => STATUS_DO_FILTRO[filtro].includes(p.status)),
    [paradas, filtro],
  );

  // Visão "mais perto de mim" (não altera a rota publicada). O GPS só liga
  // quando o motorista pede — na lista, um watch permanente seria bateria à toa
  // — e desliga durante a navegação, que tem o watch dela: dois `watchPosition`
  // no mesmo aparelho é o dobro de acordar o GPS sem nenhum ganho.
  const { leitura: posicaoLista } = usePosicao(porProximidade && !navegandoPara);
  const posicao = useMemo(
    () => (posicaoLista ? { lat: posicaoLista.lat, lng: posicaoLista.lng } : null),
    [posicaoLista],
  );
  const paradasNaTela = useMemo(() => {
    if (!porProximidade) return paradasFiltradas.map((p) => ({ ...p, distanciaM: null }));
    return ordemEstrada
      ? aplicarOrdemSugerida(paradasFiltradas, ordemEstrada, posicao)
      : ordenarPorProximidade(paradasFiltradas, posicao);
  }, [paradasFiltradas, porProximidade, ordemEstrada, posicao]);
  // A primeira ainda por entregar é "a próxima" — só faz sentido com a lista
  // realmente ordenada por distância (ou pela sugestão da estrada).
  const proximaPedidoId =
    porProximidade && posicao
      ? (paradasNaTela.find((p) => p.status === 'pendente' || p.status === 'trilha')?.pedidoId ??
        null)
      : null;

  async function refinarPorEstrada() {
    if (!rota || !posicao) return;
    setRefinando(true);
    setErroOrdem(null);
    try {
      setOrdemEstrada(await ordemSugerida(rota.id, posicao));
    } catch (e) {
      setErroOrdem(e instanceof Error ? e.message : 'Não deu para calcular agora');
    } finally {
      setRefinando(false);
    }
  }

  if (carregando) {
    return <div className="tela-login"><div className="sub-login">CARREGANDO…</div></div>;
  }

  if (!usuario) {
    return <Login entrar={entrar} />;
  }

  const paradaNavegando =
    rota && navegandoPara ? (rota.paradas.find((p) => p.pedidoId === navegandoPara) ?? null) : null;

  if (rota && paradaNavegando) {
    // Demais paradas por entregar, na ordem publicada — o número no mapa é o
    // mesmo do cartão, senão o motorista teria duas numerações para conciliar.
    const outrasParadas = rota.paradas
      .map((p, i) => ({ parada: p, ordem: i + 1 }))
      .filter(
        ({ parada: p }) =>
          p.pedidoId !== paradaNavegando.pedidoId &&
          p.status !== 'entregue' &&
          p.status !== 'insucesso',
      )
      .map(({ parada: p, ordem }) => ({
        pedidoId: p.pedidoId,
        ordem,
        nome: p.nome,
        // Pin confirmado em campo na frente da coordenada da publicação —
        // mesma precedência do destino atual, para o marcador não cair num
        // ponto que já se sabe errado.
        coordenada: dossies[p.clienteId]?.cliente?.coordenada ?? p.coordenada,
      }));
    return (
      <Navegacao
        // Trocar de parada REMONTA a tela: chegada, pin ajustado, gravação e
        // traçado recalculado são estado DAQUELA parada e têm de zerar juntos.
        key={paradaNavegando.pedidoId}
        rota={rota}
        parada={paradaNavegando}
        dossie={dossies[paradaNavegando.clienteId] ?? null}
        uid={usuario.uid}
        estilo={estilo}
        estiloKey={mapaOffline.urlFonte ?? 'online'}
        parametros={parametrosTrilha}
        parametrosAviso={parametrosAviso}
        outrasParadas={outrasParadas}
        aoTrocarParada={setNavegandoPara}
        aoResolver={(pedidoId, resultado) => resolver(pedidoId, resultado)}
        aoFechar={() => setNavegandoPara(null)}
      />
    );
  }

  // Guarda de egresso (seção 12): download só em Wi-Fi; rede indetectável
  // pede confirmação em vez de bloquear.
  function baixarMapaComGuarda() {
    const mb = Math.round((mapaOffline.atualizacao?.tamanhoBytes ?? 0) / 1e6);
    const rede = tipoDeRede();
    if (rede === 'celular') {
      window.alert(`Download de ~${mb} MB — conecte ao Wi-Fi da base para baixar.`);
      return;
    }
    if (rede === 'desconhecida' && !window.confirm(`Não deu para confirmar o Wi-Fi. Baixar ~${mb} MB agora?`)) {
      return;
    }
    mapaOffline.baixar();
  }

  return (
    <div className="app">
      <header className="topo">
        <div className="topo-marca">
          <img src="/logo.png" className="logo-marca" alt="Alcina Maria" />
          <div>
            <h1>Rota do dia</h1>
            <div className="dia">
              {rota ? `${rota.data} · ${rota.origemNome.toUpperCase()}` : 'SEM ROTA PUBLICADA'}
            </div>
          </div>
        </div>
        <div className="topo-acoes">
          <button
            className="tema-botao"
            onClick={() => setTema(tema === 'galpao' ? 'patio' : 'galpao')}
            aria-label="Alternar tema claro/escuro"
          >
            {tema === 'galpao' ? '☀ PÁTIO' : '● GALPÃO'}
          </button>
          <button className="tema-botao" onClick={() => void sair()} aria-label="Sair da conta">
            SAIR
          </button>
        </div>
      </header>

      {rota && (
        <div className="faixa-rota">ROTA PUBLICADA · {rota.distanciaTotalKm} km · {Math.floor(rota.duracaoTotalMin / 60)}h{String(rota.duracaoTotalMin % 60).padStart(2, '0')}</div>
      )}

      {mapaOffline.pronto && (mapaOffline.baixando != null || mapaOffline.atualizacao) && (
        <section className="mapa-offline">
          <div className="mapa-offline-info">
            <div className="mapa-offline-titulo">Mapa offline</div>
            {mapaOffline.baixando != null ? (
              <>
                <div className="mapa-offline-texto">
                  Baixando… {Math.round(mapaOffline.baixando * 100)}%
                </div>
                <div className="progresso">
                  <div
                    className="progresso-preenchido"
                    style={{ width: `${Math.round(mapaOffline.baixando * 100)}%` }}
                  />
                </div>
              </>
            ) : (
              <div className="mapa-offline-texto">
                {mapaOffline.erro
                  ? `Falha no download — ${mapaOffline.erro}`
                  : `${
                      mapaOffline.versaoInstalada
                        ? `Nova versão de ${versaoLegivel(mapaOffline.atualizacao!.versao)}`
                        : 'Mapa de Alagoas para navegar sem sinal'
                    } · ${Math.round(mapaOffline.atualizacao!.tamanhoBytes / 1e6)} MB — baixe no Wi-Fi da base`}
              </div>
            )}
          </div>
          {mapaOffline.baixando == null && (
            <button className="mapa-offline-botao" onClick={baixarMapaComGuarda}>
              {mapaOffline.erro ? '↻ Tentar de novo' : mapaOffline.versaoInstalada ? '⬇ Atualizar' : '⬇ Baixar'}
            </button>
          )}
        </section>
      )}

      {/* Sem rota não há o que desenhar: o mapa da visão geral existe para
          mostrar as paradas do dia. */}
      {rota &&
        (mapaOffline.pronto && cd ? (
          <Mapa
            cd={cd}
            paradas={pontosMapa}
            polyline={rota.polylinePlanejada}
            estilo={estilo}
            aoEscolherParada={setNavegandoPara}
          />
        ) : (
          <div className="mapa" />
        ))}
      {/* Estado do mapa embarcado: interessa mesmo sem rota, porque baixá-lo é
          o que o motorista faz no Wi-Fi da base ANTES de sair. */}
      <div className="mapa-nota">
        {mapaOffline.versaoInstalada
          ? `Mapa embarcado de ${versaoLegivel(mapaOffline.versaoInstalada)} — navega sem sinal`
          : 'Basemap online — baixe o mapa offline para navegar sem sinal'}
      </div>

      {!rota && (
        <section className="sem-rota">
          <div className="sem-rota-titulo">Nenhuma rota publicada para você</div>
          <p>
            Quando o escritório publicar a rota do dia, ela aparece aqui sozinha — e fica no
            aparelho, para você seguir mesmo sem sinal.
          </p>
          <p className="sem-rota-dica">
            Aproveite o Wi-Fi da base para baixar o mapa offline, se ainda não baixou.
          </p>
        </section>
      )}

      {rota && (
      <>
      <div className="resumo">
        <div className="bloco">
          <div className="num">{paradas.length}</div>
          <div className="rot">Paradas</div>
        </div>
        <div className="bloco">
          <div className="num">{entregues}</div>
          <div className="rot">Entregues</div>
        </div>
        <div className="bloco">
          <div className="num">{paradas.length - entregues}</div>
          <div className="rot">Restantes</div>
        </div>
      </div>

      <nav className="abas-filtro" role="tablist" aria-label="Filtrar paradas">
        {/* Abas vazias somem, MENOS a que está selecionada: entregar a última
            parada rural fazia a aba Rural desaparecer com o filtro ainda nela,
            deixando a lista vazia sem nenhuma aba marcada. */}
        {ABAS_FILTRO.filter(
          (a) => a.id === 'todas' || a.id === 'a_entregar' || a.id === filtro || contagem[a.id] > 0,
        ).map((a) => (
          <button
            key={a.id}
            role="tab"
            aria-selected={filtro === a.id}
            className={`aba-filtro${a.id === 'rural' ? ' rural' : ''}`}
            onClick={() => setFiltro(a.id)}
          >
            {a.rotulo} <span className="aba-contagem">{contagem[a.id]}</span>
          </button>
        ))}
      </nav>

      <div className="ordenacao">
        <button
          className="aba-filtro"
          aria-pressed={porProximidade}
          aria-selected={porProximidade}
          onClick={() => {
            setPorProximidade(!porProximidade);
            // A ordem por estrada foi calculada de onde o motorista ESTAVA:
            // sair e voltar ao modo recomeça pela linha reta, que é sempre atual.
            setOrdemEstrada(null);
            setErroOrdem(null);
          }}
        >
          📍 Mais perto de mim
        </button>
        {porProximidade && !posicao && <span className="ordenacao-aviso">procurando GPS…</span>}
        {porProximidade && posicao && rota && (
          <button className="aba-filtro" disabled={refinando} onClick={() => void refinarPorEstrada()}>
            {refinando ? '🛣 calculando…' : ordemEstrada ? '🛣 por estrada ✔' : '🛣 refinar por estrada'}
          </button>
        )}
      </div>
      {porProximidade && (
        <div className="ordenacao-nota">
          {erroOrdem
            ? `⚠ ${erroOrdem} — seguindo pela distância em linha reta.`
            : ordemEstrada
              ? 'Ordem por distância de estrada, a partir de onde você está.'
              : 'Ordem por distância em linha reta (funciona sem sinal). A ordem oficial da rota não muda.'}
        </div>
      )}

      {paradasNaTela.length === 0 && (
        <div className="vazio-filtro">Nenhuma parada neste filtro.</div>
      )}

      {paradasNaTela.map((p) => (
        <article key={p.ordem} className={`parada${p.status === 'trilha' ? ' rural' : ''}`}>
          <div className="ordem">
            PARADA {String(p.ordem).padStart(2, '0')}
            {p.distanciaM != null && (
              <span className="parada-distancia">· {formatarDistancia(p.distanciaM)}</span>
            )}
            {p.pedidoId != null && p.pedidoId === proximaPedidoId && (
              <span className="chip-proxima">PRÓXIMA</span>
            )}
          </div>
          <h2>{p.cliente}</h2>
          <div className="endereco">{p.endereco}</div>
          <div className="carga">
            {p.itens} itens · {p.volumes} vol · {p.pesoKg.toFixed(3)} kg
          </div>
          {p.fotoPath && <FotoReferencia caminho={p.fotoPath} alt={`Referência de ${p.cliente}`} />}
          {p.observacao && <div className="obs">📌 {p.observacao}</div>}
          <span className={`estado ${p.status}`}>
            {ICONE_STATUS[p.status]} {TEXTO_STATUS[p.status]}
          </span>

          {(p.status === 'pendente' || p.status === 'trilha') && (
            <div className="acoes">
              {p.telefone && (
                <>
                  <a href={linkLigacao(p.telefone)}>📞 Ligar</a>
                  <a href={linkWhatsApp(p.telefone)} target="_blank" rel="noreferrer">
                    💬 WhatsApp
                  </a>
                  {/* Aviso com a janela estimada — o que evita o "ausente".
                      A mensagem é montada na renderização para a janela ficar
                      sempre relativa a agora; o WhatsApp abre com o texto
                      pronto e o motorista revisa antes de enviar. */}
                  <a
                    className={`avisar${p.avisadoEm ? ' feito' : ''}`}
                    href={linkWhatsApp(
                      p.telefone,
                      mensagemDeRota(new Date(), p.etaMin ?? 0, p.ordem - 1, parametrosAviso),
                    )}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => {
                      if (rota && p.pedidoId) registrarAviso(rota, p.pedidoId);
                    }}
                  >
                    {p.avisadoEm ? `✔ Avisado ${horaCurta(p.avisadoEm)}` : '📣 Avisar chegada'}
                  </a>
                </>
              )}
              <button className="navegar" onClick={() => setNavegandoPara(p.pedidoId ?? null)}>
                🧭 Navegar{p.status === 'trilha' ? ' e mapear' : ''}
              </button>
              <button className="confirmar" onClick={() => resolver(p.pedidoId, 'entregue')}>
                ✔ Confirmar entrega
              </button>
              <button
                className="insucesso-botao"
                onClick={() =>
                  setInsucessoAberto(insucessoAberto === p.pedidoId ? null : (p.pedidoId ?? null))
                }
              >
                ✖ Registrar insucesso
              </button>
              {insucessoAberto === p.pedidoId && (
                <div className="motivos">
                  {MOTIVOS_INSUCESSO.map((m) => (
                    <button key={m.resultado} onClick={() => resolver(p.pedidoId, m.resultado)}>
                      {m.rotulo}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {(p.status === 'entregue' || p.status === 'insucesso') &&
            p.clienteId &&
            dossies[p.clienteId]?.cliente && (
              <>
                <button
                  className="dossie-toggle"
                  onClick={() =>
                    setDossieAberto(dossieAberto === p.pedidoId ? null : (p.pedidoId ?? null))
                  }
                >
                  📋 {dossieAberto === p.pedidoId ? 'Fechar dossiê do local' : 'Dossiê do local'}
                </button>
                {dossieAberto === p.pedidoId && (
                  <DossieLocal cliente={dossies[p.clienteId]!.cliente!} />
                )}
              </>
            )}
        </article>
      ))}
      </>
      )}

      <footer className="rodape">Offline-first · dados sincronizam ao reencontrar rede</footer>
    </div>
  );
}
