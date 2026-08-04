import { useState } from 'react';
import { Importacao } from './telas/Importacao';
import { Decisoes } from './telas/Decisoes';
import { Pedidos } from './telas/Pedidos';
import { Clientes } from './telas/Clientes';
import { Produtividade } from './telas/Produtividade';
import { Rotas } from './telas/Rotas';
import { Login } from './telas/Login';
import { useAutenticacao } from './useAutenticacao';
import { useAtualizacao } from './useAtualizacao';

type Aba = 'importacao' | 'decisoes' | 'rotas' | 'pedidos' | 'clientes' | 'produtividade';

/** Papel do custom claim em português — o operador não lê enum. */
const ROTULO_PAPEL: Record<string, string> = {
  admin: 'administrador',
  operador: 'operador',
  motorista: 'motorista',
};

const ABAS: Array<{ id: Aba; rotulo: string }> = [
  { id: 'importacao', rotulo: 'Importação' },
  { id: 'decisoes', rotulo: 'Decisões' },
  { id: 'rotas', rotulo: 'Rotas' },
  { id: 'pedidos', rotulo: 'Pedidos' },
  { id: 'clientes', rotulo: 'Clientes' },
  { id: 'produtividade', rotulo: 'Produtividade' },
];

export function App() {
  const [aba, setAba] = useState<Aba>('importacao');
  const atualizacao = useAtualizacao();
  const { usuario, papel, ehEscritorio, carregando, entrar, sair } = useAutenticacao();

  if (carregando) {
    return <div className="tela-login"><div className="sub">CARREGANDO…</div></div>;
  }

  if (!usuario) {
    return <Login entrar={entrar} />;
  }

  /**
   * Conta sem papel de Admin Estoque: o painel ABRIA e cada ação morria em 403,
   * com mensagem que não dizia que o problema era a conta. Diz agora, uma vez,
   * antes de deixar tentar — é a diferença entre "o sistema não funciona" e
   * "entrei com a conta errada".
   */
  if (ehEscritorio === false) {
    return (
      <div className="tela-login">
        <img src="/logo.png" className="logo-marca" alt="Grupo Alcina Maria" />
        <h1>Sem acesso ao painel</h1>
        <div className="erro" style={{ maxWidth: 460, textAlign: 'left' }}>
          A conta <span className="mono">{usuario.email}</span> está cadastrada como{' '}
          <strong>{papel ? ROTULO_PAPEL[papel] ?? papel : 'sem papel definido'}</strong>. O painel do
          Admin Estoque exige <strong>admin</strong> ou <strong>operador</strong>.
          {papel === 'motorista' && (
            <>
              {' '}
              Esta é a conta do app de entrega — para importar notas e montar rotas, entre com a
              conta do Admin Estoque.
            </>
          )}
        </div>
        <button onClick={() => void sair()}>Entrar com outra conta</button>
      </div>
    );
  }

  return (
    <div className="painel">
      {/* Versão nova disponível. Não recarrega sozinho: perderia a seleção de
          pedidos e a prévia já otimizada. */}
      {atualizacao.temAtualizacao && (
        <button className="faixa-atualizacao" onClick={() => atualizacao.aplicar?.()}>
          ⬆ Nova versão do painel disponível — toque para atualizar
        </button>
      )}
      <header className="topo">
        <div className="topo-marca">
          <img src="/logo.png" className="logo-marca" alt="Grupo Alcina Maria" />
          <div>
            <h1>Rota · Grupo Alcina Maria</h1>
            <div className="sub">Painel Admin Estoque — importação e rotas</div>
          </div>
        </div>
        <div className="topo-direita">
          {/* Com quem está logado E em que papel: duas contas no mesmo
              navegador é o normal aqui, e o e-mail sozinho não avisa qual. */}
          <span className="sub mono">
            {usuario.email}
            {papel && ` · ${ROTULO_PAPEL[papel] ?? papel}`}
          </span>
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
      {aba === 'decisoes' && <Decisoes />}
      {aba === 'rotas' && <Rotas />}
      {aba === 'pedidos' && <Pedidos />}
      {aba === 'clientes' && <Clientes />}
      {aba === 'produtividade' && <Produtividade />}
    </div>
  );
}
