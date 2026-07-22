import { useEffect, useState } from 'react';
import { linkLigacao, linkWhatsApp } from '@rota/shared';

type Tema = 'galpao' | 'patio';

interface ParadaDemo {
  ordem: number;
  cliente: string;
  endereco: string;
  telefone: string;
  itens: number;
  volumes: number;
  pesoKg: number;
  status: 'pendente' | 'entregue' | 'trilha';
  observacao?: string;
}

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

  // Alternância Galpão/Pátio em um toque no topo da tela (seção 14.2).
  useEffect(() => {
    document.documentElement.dataset.tema = tema;
  }, [tema]);

  const entregues = PARADAS_DEMO.filter((p) => p.status === 'entregue').length;

  return (
    <div className="app">
      <header className="topo">
        <div>
          <h1>Rota do dia</h1>
          <div className="dia">TER 22/07 · CD ARAPIRACA</div>
        </div>
        <button
          className="tema-botao"
          onClick={() => setTema(tema === 'galpao' ? 'patio' : 'galpao')}
          aria-label="Alternar tema claro/escuro"
        >
          {tema === 'galpao' ? '☀ PÁTIO' : '● GALPÃO'}
        </button>
      </header>

      <div className="faixa-demo">Demonstração — rota real chega na Fase 3</div>

      <div className="resumo">
        <div className="bloco">
          <div className="num">{PARADAS_DEMO.length}</div>
          <div className="rot">Paradas</div>
        </div>
        <div className="bloco">
          <div className="num">{entregues}</div>
          <div className="rot">Entregues</div>
        </div>
        <div className="bloco">
          <div className="num">{PARADAS_DEMO.length - entregues}</div>
          <div className="rot">Restantes</div>
        </div>
      </div>

      {PARADAS_DEMO.map((p) => (
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
              <a href={linkLigacao(p.telefone)}>📞 Ligar</a>
              <a href={linkWhatsApp(p.telefone)} target="_blank" rel="noreferrer">
                💬 WhatsApp
              </a>
              <button className="confirmar" onClick={() => navigator.vibrate?.(80)}>
                ✔ Confirmar entrega
              </button>
            </div>
          )}
        </article>
      ))}

      <footer className="rodape">Offline-first · dados sincronizam ao reencontrar rede</footer>
    </div>
  );
}
