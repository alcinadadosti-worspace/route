import { useEffect, useState } from 'react';
import type { Cliente, EnderecoFiscal, GeoPonto, Pedido } from '@rota/shared';
import {
  decidirEnderecoEntrega,
  decidirMudancaEndereco,
  listarClientes,
  listarPedidos,
} from '../api';
import { MapaDecisao } from '../MapaDecisao';

/**
 * Decisões de endereço. Duas perguntas diferentes caem aqui, ambas com o pedido
 * em `pendente_de_decisao`:
 * - seção 8.4: a NF-e traz endereço de ENTREGA diferente do fiscal — o
 *   escritório vê os dois no mapa (A fiscal, B entrega) e escolhe qual vale; a
 *   escolha vira override no pedido, sem tocar o cadastro do cliente;
 * - seção 8.3: o endereço do CADASTRO mudou e o cliente já tinha ponto — o
 *   escritório confirma se aquele ponto sobrevive à mudança.
 * Uma nota pode levantar as duas: respondida a da entrega, sobra a do cadastro.
 */
export function Decisoes() {
  const [pedidos, setPedidos] = useState<Array<{ id: string } & Pedido>>([]);
  const [clientes, setClientes] = useState<Record<string, Cliente>>({});
  const [erro, setErro] = useState<string | null>(null);

  function carregar() {
    Promise.all([listarPedidos(), listarClientes()])
      .then(([ps, cs]) => {
        setPedidos(ps);
        setClientes(Object.fromEntries(cs.map((c) => [c.id, c])));
        setErro(null);
      })
      .catch((e) => setErro(e instanceof Error ? e.message : 'Falha ao carregar'));
  }
  useEffect(carregar, []);

  const aguardando = pedidos.filter((p) => p.status === 'pendente_de_decisao');

  /**
   * Resolver uma pergunta nem sempre tira o pedido da fila: responder a da
   * entrega num pedido que também mudou de cadastro deixa a segunda pergunta em
   * aberto (a API devolve `pendente_de_decisao` de novo). Aí recarrega, para o
   * cartão certo aparecer.
   */
  function resolvido(id: string, status: string) {
    if (status === 'pendente_de_decisao') carregar();
    else setPedidos((atual) => atual.filter((p) => p.id !== id));
  }

  return (
    <section className="cartao">
      <div className="cabecalho-secao">
        <h2>Decisões de endereço</h2>
        <button onClick={carregar}>Atualizar</button>
      </div>
      <p style={{ color: 'var(--texto-2)' }}>
        Pedidos que a importação não roteiriza sozinha: o endereço de{' '}
        <strong>entrega</strong> difere do fiscal, ou o endereço do{' '}
        <strong>cadastro mudou</strong> e o ponto que o cliente já tinha pode não valer mais.
      </p>

      {erro && <div className="erro">{erro} — a API está no ar?</div>}
      {!erro && aguardando.length === 0 && (
        <div className="vazio">Nenhuma decisão pendente. 👍</div>
      )}

      {aguardando.map((pedido) =>
        // A pergunta da entrega vem primeiro; `usarEnderecoEntrega` definido
        // significa que ela já foi respondida e sobrou a do cadastro.
        pedido.enderecoEntrega && pedido.usarEnderecoEntrega === undefined ? (
          <CartaoDecisao
            key={pedido.id}
            pedido={pedido}
            cliente={clientes[pedido.clienteId] ?? null}
            aoResolver={(status) => resolvido(pedido.id, status)}
          />
        ) : pedido.enderecoAnterior ? (
          <CartaoMudancaEndereco
            key={pedido.id}
            pedido={pedido}
            cliente={clientes[pedido.clienteId] ?? null}
            aoResolver={(status) => resolvido(pedido.id, status)}
          />
        ) : null,
      )}
    </section>
  );
}

/**
 * Seção 8.3: o cadastro mudou de endereço e o cliente já tinha ponto. O ponto
 * (pin de campo, trilha aprendida ou geocodificação) foi estabelecido para o
 * endereço ANTIGO — quem conhece a operação diz se ele sobrevive à mudança.
 */
function CartaoMudancaEndereco({
  pedido,
  cliente,
  aoResolver,
}: {
  pedido: { id: string } & Pedido;
  cliente: Cliente | null;
  aoResolver: (status: string) => void;
}) {
  const [escolha, setEscolha] = useState<'manter' | 'remapear' | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function confirmar() {
    if (!escolha) return;
    setSalvando(true);
    setErro(null);
    try {
      const { status } = await decidirMudancaEndereco(pedido.id, escolha);
      aoResolver(status);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao salvar');
      setSalvando(false);
    }
  }

  return (
    <div className="decisao">
      <div className="decisao-cabecalho">
        <strong className="mono">
          Nota {pedido.numeroNota}/{pedido.serie}
        </strong>
        <span className="chip pendente">Endereço do cadastro mudou</span>
      </div>

      <div className="decisao-opcoes">
        <div className="decisao-opcao">
          <div>
            <div className="decisao-rotulo">Antes (endereço do ponto atual)</div>
            <div className="decisao-endereco">
              {pedido.enderecoAnterior ? formatarEndereco(pedido.enderecoAnterior) : '—'}
            </div>
            <div className="decisao-aviso">
              {cliente ? DESCRICAO_PONTO[cliente.statusMapeamento] : 'cliente não carregado'}
              {cliente?.trilhaAtivaId ? ' · com trilha aprendida' : ''}
            </div>
          </div>
        </div>
        <div className="decisao-opcao">
          <div>
            <div className="decisao-rotulo">Agora (endereço desta nota)</div>
            <div className="decisao-endereco">
              {cliente ? formatarEndereco(cliente.enderecoFiscal) : '—'}
            </div>
          </div>
        </div>
      </div>

      <div className="decisao-opcoes">
        <label className={`decisao-opcao${escolha === 'manter' ? ' ativa' : ''}`}>
          <input
            type="radio"
            name={`mudanca-${pedido.id}`}
            checked={escolha === 'manter'}
            onChange={() => setEscolha('manter')}
          />
          <div>
            <div className="decisao-rotulo">O ponto atual continua valendo</div>
            <div className="decisao-aviso">
              mudou o cadastro, não o lugar da entrega — o pedido volta ao fluxo normal
            </div>
          </div>
        </label>

        <label className={`decisao-opcao${escolha === 'remapear' ? ' ativa' : ''}`}>
          <input
            type="radio"
            name={`mudanca-${pedido.id}`}
            checked={escolha === 'remapear'}
            onChange={() => setEscolha('remapear')}
          />
          <div>
            <div className="decisao-rotulo">O cliente mudou de lugar — refazer o ponto</div>
            <div className="decisao-aviso">
              descarta o pin e a trilha e tenta o endereço novo; sem geocodificação (zona rural), o
              motorista mapeia na primeira viagem
            </div>
          </div>
        </label>
      </div>

      {erro && <div className="erro">{erro}</div>}

      <div className="acoes-rota">
        <button
          className="primaria"
          disabled={!escolha || salvando}
          onClick={() => void confirmar()}
        >
          {salvando ? 'SALVANDO…' : 'CONFIRMAR'}
        </button>
      </div>
    </div>
  );
}

const DESCRICAO_PONTO: Record<Cliente['statusMapeamento'], string> = {
  nao_mapeado: 'sem ponto',
  geocodificado: 'ponto do geocodificador',
  aproximado: 'ponto aproximado (grosseiro)',
  mapeado: 'pin confirmado em campo pelo motorista',
};

function CartaoDecisao({
  pedido,
  cliente,
  aoResolver,
}: {
  pedido: { id: string } & Pedido;
  cliente: Cliente | null;
  aoResolver: (status: string) => void;
}) {
  const fiscal = cliente?.enderecoFiscal ?? null;
  const entrega = pedido.enderecoEntrega ?? null;
  const [escolha, setEscolha] = useState<'fiscal' | 'entrega' | null>(null);
  // Coordenada do pin B: a geocodificada na importação (pode ser ajustada no mapa).
  const [coordEntrega, setCoordEntrega] = useState<GeoPonto | null>(
    pedido.coordenadaEntrega ?? null,
  );
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function confirmar() {
    if (!escolha) return;
    setSalvando(true);
    setErro(null);
    try {
      const { status } = await decidirEnderecoEntrega(
        pedido.id,
        escolha,
        escolha === 'entrega' ? coordEntrega : undefined,
      );
      aoResolver(status);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao salvar');
      setSalvando(false);
    }
  }

  return (
    <div className="decisao">
      <div className="decisao-cabecalho">
        <strong className="mono">
          Nota {pedido.numeroNota}/{pedido.serie}
        </strong>
        <span className="chip pendente">Entrega em local diverso</span>
      </div>

      <MapaDecisao
        fiscal={cliente?.coordenada ?? null}
        entrega={coordEntrega ?? cliente?.coordenada ?? null}
        aoMoverEntrega={setCoordEntrega}
      />

      <div className="decisao-opcoes">
        <label className={`decisao-opcao${escolha === 'fiscal' ? ' ativa' : ''}`}>
          <input
            type="radio"
            name={`escolha-${pedido.id}`}
            checked={escolha === 'fiscal'}
            onChange={() => setEscolha('fiscal')}
          />
          <div>
            <div className="decisao-rotulo">A · Endereço fiscal (cadastro)</div>
            <div className="decisao-endereco">{fiscal ? formatarEndereco(fiscal) : '—'}</div>
            {!cliente?.coordenada && (
              <div className="decisao-aviso">sem coordenada — irá para mapeamento em campo</div>
            )}
          </div>
        </label>

        <label className={`decisao-opcao${escolha === 'entrega' ? ' ativa' : ''}`}>
          <input
            type="radio"
            name={`escolha-${pedido.id}`}
            checked={escolha === 'entrega'}
            onChange={() => setEscolha('entrega')}
          />
          <div>
            <div className="decisao-rotulo">B · Endereço de entrega (nota)</div>
            <div className="decisao-endereco">{entrega ? formatarEndereco(entrega) : '—'}</div>
            <div className="decisao-aviso">
              {coordEntrega
                ? 'arraste o pin laranja (B) no mapa para ajustar'
                : 'sem coordenada — arraste o pin B no mapa, ou irá para mapeamento'}
            </div>
          </div>
        </label>
      </div>

      {erro && <div className="erro">{erro}</div>}

      <div className="acoes-rota">
        <button
          className="primaria"
          disabled={!escolha || salvando || (escolha === 'entrega' && !coordEntrega)}
          onClick={() => void confirmar()}
        >
          {salvando ? 'SALVANDO…' : 'CONFIRMAR ESCOLHA'}
        </button>
      </div>
    </div>
  );
}

function formatarEndereco(e: EnderecoFiscal): string {
  const complemento = e.complemento ? ` (${e.complemento})` : '';
  return `${e.logradouro}, ${e.numero || 'S/N'}${complemento} — ${e.bairro}, ${e.municipio}/${e.uf}`;
}
