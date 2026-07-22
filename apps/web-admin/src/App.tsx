import { useState } from 'react';
import { Importacao } from './telas/Importacao';
import { Pedidos } from './telas/Pedidos';
import { Clientes } from './telas/Clientes';
import { Login } from './telas/Login';
import { useAutenticacao } from './useAutenticacao';

type Aba = 'importacao' | 'pedidos' | 'clientes';

const ABAS: Array<{ id: Aba; rotulo: string }> = [
  { id: 'importacao', rotulo: 'Importação' },
  { id: 'pedidos', rotulo: 'Pedidos' },
  { id: 'clientes', rotulo: 'Clientes' },
];

export function App() {
  const [aba, setAba] = useState<Aba>('importacao');
  const { usuario, carregando, entrar, sair } = useAutenticacao();

  if (carregando) {
    return <div className="tela-login"><div className="sub">CARREGANDO…</div></div>;
  }

  if (!usuario) {
    return <Login entrar={entrar} />;
  }

  return (
    <div className="painel">
      <header className="topo">
        <div>
          <h1>Rota · Grupo Alcina Maria</h1>
          <div className="sub">Painel do escritório — importação e rotas</div>
        </div>
        <div className="topo-direita">
          <span className="sub mono">{usuario.email}</span>
          <button onClick={() => void sair()}>Sair</button>
        </div>
      </header>

      <nav className="abas" role="tablist">
        {ABAS.map((a) => (
          <button
            key={a.id}
            role="tab"
            aria-selected={aba === a.id}
            onClick={() => setAba(a.id)}
          >
            {a.rotulo}
          </button>
        ))}
      </nav>

      {aba === 'importacao' && <Importacao />}
      {aba === 'pedidos' && <Pedidos />}
      {aba === 'clientes' && <Clientes />}
    </div>
  );
}
