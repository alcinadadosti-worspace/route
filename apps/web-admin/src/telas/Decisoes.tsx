import { useEffect, useState } from 'react';
import type { Cliente, EnderecoFiscal, GeoPonto, Pedido } from '@rota/shared';
import { decidirEnderecoEntrega, listarClientes, listarPedidos } from '../api';
import { MapaDecisao } from '../MapaDecisao';

/**
 * Decisões de endereço (seção 8.4). Quando a NF-e traz um endereço de entrega
 * diferente do fiscal, o pedido nasce `pendente_de_decisao` e aparece aqui: o
 * escritório vê os dois endereços no mapa (A fiscal, B entrega) e escolhe qual
 * vale. A escolha vira override no pedido — nunca toca o cadastro do cliente.
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

  return (
    <section className="cartao">
      <div className="cabecalho-secao">
        <h2>Decisões de endereço</h2>
        <button onClick={carregar}>Atualizar</button>
      </div>
      <p style={{ color: 'var(--texto-2)' }}>
        Notas em que o endereço de <strong>entrega</strong> difere do endereço fiscal do cliente.
        Escolha qual vale para cada pedido — a rota usa o que você escolher, sem alterar o cadastro.
      </p>

      {erro && <div className="erro">{erro} — a API está no ar?</div>}
      {!erro && aguardando.length === 0 && (
        <div className="vazio">Nenhuma decisão pendente. 👍</div>
      )}

      {aguardando.map((pedido) => (
        <CartaoDecisao
          key={pedido.id}
          pedido={pedido}
          cliente={clientes[pedido.clienteId] ?? null}
          aoResolver={() => setPedidos((atual) => atual.filter((p) => p.id !== pedido.id))}
        />
      ))}
    </section>
  );
}

function CartaoDecisao({
  pedido,
  cliente,
  aoResolver,
}: {
  pedido: { id: string } & Pedido;
  cliente: Cliente | null;
  aoResolver: () => void;
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
      await decidirEnderecoEntrega(
        pedido.id,
        escolha,
        escolha === 'entrega' ? coordEntrega : undefined,
      );
      aoResolver();
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
