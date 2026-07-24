import { useEffect, useMemo, useState } from 'react';
import { linkLigacao, linkWhatsApp, type GeoPonto, type ResultadoEntrega } from '@rota/shared';
import { Mapa } from './Mapa';
import { Login } from './Login';
import { Navegacao } from './Navegacao';
import { FotoReferencia } from './DossieLocal';
import { useAutenticacao } from './useAutenticacao';
import { useRotaDoDia } from './useRotaDoDia';
import { useClientesDaRota } from './useClientesDaRota';
import { useConfigGeral } from './useConfigGeral';
import { useMapaOffline } from './useMapaOffline';
import { estiloMapa, type Tema } from './estiloMapa';
import { tipoDeRede, URL_FONTE_PMTILES } from './mapaOffline';
import { registrarResultado } from './servicoEntrega';
import { dispararProcessamento } from './servicoMapeamento';
import { processarFilaFotos } from './servicoFotos';

interface ParadaDemo {
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
  /** Presente apenas nas paradas de rota real (não demo). */
  pedidoId?: string;
}

const CD_DEMO = { nome: 'CD ARAPIRACA', lat: -9.7515, lng: -36.6612 };

/**
 * Dados de demonstração da Fase 0 — na Fase 3 esta tela passa a ler a rota
 * publicada do cache local do Firestore (seção 12, camada 2).
 */
const PARADAS_DEMO: ParadaDemo[] = [
  {
    ordem: 1,
    cliente: 'MARIA JOSE DA SILVA',
    endereco: 'POVOADO BREJO DOS BOIS, 83 — ZONA RURAL, JUNQUEIRO/AL',
    telefone: '+5582999887766',
    coordenada: { lat: -9.956, lng: -36.493 },
    itens: 10,
    volumes: 1,
    pesoKg: 3.113,
    status: 'trilha',
    observacao: 'Próx. à piscina · portão azul — primeira entrega: gravar trilha e pin',
  },
  {
    ordem: 2,
    cliente: 'JOSEFA OLIVEIRA SANTOS',
    endereco: 'RUA DO COMERCIO, 45 — CENTRO, JUNQUEIRO/AL',
    telefone: '+5582988776655',
    coordenada: { lat: -9.925, lng: -36.477 },
    itens: 4,
    volumes: 1,
    pesoKg: 1.82,
    status: 'pendente',
  },
  {
    ordem: 3,
    cliente: 'ANA LUCIA FERREIRA',
    endereco: 'AV PRINCIPAL, 210 — SAO SEBASTIAO/AL',
    telefone: '+5582977665544',
    coordenada: { lat: -9.856, lng: -36.556 },
    itens: 7,
    volumes: 2,
    pesoKg: 4.6,
    status: 'entregue',
  },
];

const ICONE_STATUS: Record<ParadaDemo['status'], string> = {
  pendente: '●',
  entregue: '✔',
  trilha: '▲',
  insucesso: '✖',
};

const TEXTO_STATUS: Record<ParadaDemo['status'], string> = {
  pendente: 'A entregar',
  entregue: 'Entregue',
  trilha: 'Mapear no local',
  insucesso: 'Insucesso',
};

const MOTIVOS_INSUCESSO: Array<{ resultado: ResultadoEntrega; rotulo: string }> = [
  { resultado: 'ausente', rotulo: 'Ausente' },
  { resultado: 'nao_localizado', rotulo: 'Não localizado' },
  { resultado: 'recusa', rotulo: 'Recusa' },
];

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
    () => estiloMapa(tema, mapaOffline.versaoInstalada != null ? URL_FONTE_PMTILES : null),
    [tema, mapaOffline.versaoInstalada],
  );

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

  // Rota publicada para o motorista logado; sem rota, dados de demonstração.
  // Identidade presa ao id da rota: cada snapshot renova o objeto `rota`, e um
  // `cd` novo a cada confirmação recriaria o mapa da visão geral.
  const cd = useMemo(
    () => (rota ? { nome: rota.origemNome, ...rota.origemCoordenada } : CD_DEMO),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rota?.id],
  );
  const paradas: ParadaDemo[] = useMemo(
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
                    : cliente && cliente.statusMapeamento !== 'mapeado'
                      ? ('trilha' as const)
                      : ('pendente' as const),
              observacao: cliente?.observacoes || undefined,
              fotoPath: cliente?.fotoReferenciaPath ?? undefined,
              pedidoId: p.pedidoId,
            };
          })
        : PARADAS_DEMO,
    [rota, dossies],
  );
  const [insucessoAberto, setInsucessoAberto] = useState<string | null>(null);
  const [navegandoPara, setNavegandoPara] = useState<string | null>(null);

  function resolver(pedidoId: string | undefined, resultado: ResultadoEntrega) {
    if (!rota || !pedidoId) return;
    const parada = rota.paradas.find((p) => p.pedidoId === pedidoId);
    // Parada já resolvida não gera segunda entrega (proteção contra toque duplo).
    if (!parada || parada.status === 'entregue' || parada.status === 'insucesso') return;
    registrarResultado(rota, parada, resultado);
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
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chavePontos],
  );

  const entregues = paradas.filter((p) => p.status === 'entregue').length;

  if (carregando) {
    return <div className="tela-login"><div className="sub-login">CARREGANDO…</div></div>;
  }

  if (!usuario) {
    return <Login entrar={entrar} />;
  }

  const paradaNavegando =
    rota && navegandoPara ? (rota.paradas.find((p) => p.pedidoId === navegandoPara) ?? null) : null;

  if (rota && paradaNavegando) {
    return (
      <Navegacao
        rota={rota}
        parada={paradaNavegando}
        dossie={dossies[paradaNavegando.clienteId] ?? null}
        uid={usuario.uid}
        estilo={estilo}
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
        <div>
          <h1>Rota do dia</h1>
          <div className="dia">
            {rota ? `${rota.data} · ${rota.origemNome.toUpperCase()}` : 'DEMONSTRAÇÃO'}
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

      {rota ? (
        <div className="faixa-rota">ROTA PUBLICADA · {rota.distanciaTotalKm} km · {Math.floor(rota.duracaoTotalMin / 60)}h{String(rota.duracaoTotalMin % 60).padStart(2, '0')}</div>
      ) : (
        <div className="faixa-demo">Demonstração — aguardando rota publicada para você</div>
      )}

      {(mapaOffline.baixando != null || mapaOffline.atualizacao) && (
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

      {mapaOffline.pronto ? (
        <Mapa cd={cd} paradas={pontosMapa} polyline={rota?.polylinePlanejada} estilo={estilo} />
      ) : (
        <div className="mapa" />
      )}
      <div className="mapa-nota">
        {mapaOffline.versaoInstalada
          ? `Mapa embarcado de ${versaoLegivel(mapaOffline.versaoInstalada)} — navega sem sinal`
          : 'Basemap online — baixe o mapa offline para navegar sem sinal'}
      </div>

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

      {paradas.map((p) => (
        <article key={p.ordem} className="parada">
          <div className="ordem">PARADA {String(p.ordem).padStart(2, '0')}</div>
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
                </>
              )}
              {rota ? (
                <>
                  <button
                    className="navegar"
                    onClick={() => setNavegandoPara(p.pedidoId ?? null)}
                  >
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
                </>
              ) : (
                <button className="confirmar" onClick={() => navigator.vibrate?.(80)}>
                  ✔ Confirmar entrega
                </button>
              )}
            </div>
          )}
        </article>
      ))}

      <footer className="rodape">Offline-first · dados sincronizam ao reencontrar rede</footer>
    </div>
  );
}
