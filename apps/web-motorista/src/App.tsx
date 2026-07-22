import { useEffect, useMemo, useState } from 'react';
import { linkLigacao, linkWhatsApp, type GeoPonto } from '@rota/shared';
import { Mapa } from './Mapa';
import { Login } from './Login';
import { useAutenticacao } from './useAutenticacao';
import { useRotaDoDia } from './useRotaDoDia';

type Tema = 'galpao' | 'patio';

interface ParadaDemo {
  ordem: number;
  cliente: string;
  endereco: string;
  telefone: string;
  coordenada: GeoPonto;
  itens: number;
  volumes: number;
  pesoKg: number;
  status: 'pendente' | 'entregue' | 'trilha';
  observacao?: string;
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
};

const TEXTO_STATUS: Record<ParadaDemo['status'], string> = {
  pendente: 'A entregar',
  entregue: 'Entregue',
  trilha: 'Mapear no local',
};

export function App() {
  const [tema, setTema] = useState<Tema>('galpao');
  const { usuario, carregando, entrar, sair } = useAutenticacao();
  const { rota } = useRotaDoDia(usuario?.uid ?? null);

  // Alternância Galpão/Pátio em um toque no topo da tela (seção 14.2).
  useEffect(() => {
    document.documentElement.dataset.tema = tema;
  }, [tema]);

  // Rota publicada para o motorista logado; sem rota, dados de demonstração.
  const cd = useMemo(
    () => (rota ? { nome: rota.origemNome, ...rota.origemCoordenada } : CD_DEMO),
    [rota],
  );
  const paradas: ParadaDemo[] = useMemo(
    () =>
      rota
        ? rota.paradas.map((p, i) => ({
            ordem: i + 1,
            cliente: p.nome,
            endereco: p.endereco,
            telefone: p.telefone ?? '',
            coordenada: p.coordenada,
            itens: p.itens.length,
            volumes: p.volumes,
            pesoKg: p.pesoBrutoKg,
            status: p.status === 'entregue' ? 'entregue' : 'pendente',
          }))
        : PARADAS_DEMO,
    [rota],
  );

  const pontosMapa = useMemo(
    () =>
      paradas.map((p) => ({
        ordem: p.ordem,
        cliente: p.cliente,
        coordenada: p.coordenada,
        status: p.status,
      })),
    [paradas],
  );

  const entregues = paradas.filter((p) => p.status === 'entregue').length;

  if (carregando) {
    return <div className="tela-login"><div className="sub-login">CARREGANDO…</div></div>;
  }

  if (!usuario) {
    return <Login entrar={entrar} />;
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

      <Mapa cd={cd} paradas={pontosMapa} polyline={rota?.polylinePlanejada} />
      <div className="mapa-nota">
        Basemap online de demonstração — o mapa embarcado (offline) chega na Fase 5
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
          {p.observacao && <div className="obs">📌 {p.observacao}</div>}
          <span className={`estado ${p.status}`}>
            {ICONE_STATUS[p.status]} {TEXTO_STATUS[p.status]}
          </span>

          {p.status !== 'entregue' && (
            <div className="acoes">
              {p.telefone && (
                <>
                  <a href={linkLigacao(p.telefone)}>📞 Ligar</a>
                  <a href={linkWhatsApp(p.telefone)} target="_blank" rel="noreferrer">
                    💬 WhatsApp
                  </a>
                </>
              )}
              {!rota && (
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
