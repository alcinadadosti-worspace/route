import { useState } from 'react';
import { Importacao } from './telas/Importacao';
import { Pedidos } from './telas/Pedidos';
import { Clientes } from './telas/Clientes';

type Aba = 'importacao' | 'pedidos' | 'clientes';

const ABAS: Array<{ id: Aba; rotulo: string }> = [
  { id: 'importacao', rotulo: 'Importação' },
  { id: 'pedidos', rotulo: 'Pedidos' },
  { id: 'clientes', rotulo: 'Clientes' },
];

export function App() {
  const [aba, setAba] = useState<Aba>('importacao');

  return (
    <div className="painel">
      <header className="topo">
        <div>
          <h1>Rota · Grupo Alcina Maria</h1>
          <div className="sub">Painel do escritório — importação e rotas</div>
        </div>
        <div className="sub mono">v0.1 · Fase 1</div>
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
