import { useEffect, useState } from 'react';
import type { Cliente, EnderecoFiscal, GeoPonto, Pedido } from '@rota/shared';
import { aguardandoEscolhaDeModo, retiradaDuvidosa } from '@rota/shared';
import {
  decidirEnderecoEntrega,
  decidirModoEntrega,
  decidirMudancaEndereco,
  listarClientes,
  listarPedidos,
} from '../api';
import { MapaDecisao } from '../MapaDecisao';

/**
 * Decisões — o que a importação não resolve sozinha. TRÊS perguntas caem aqui,
 * todas com o pedido em `pendente_de_decisao`:
 * - rota × retirada (ver retirada.ts): a nota tem cara de retirada no balcão —
 *   metade da importação do dia. Vem primeiro e em bloco com confirmação em
 *   lote, porque é volume;
 * - seção 8.4: a NF-e traz endereço de ENTREGA diferente do fiscal — o
 *   escritório vê os dois no mapa (A fiscal, B entrega) e escolhe qual vale; a
 *   escolha vira override no pedido, sem tocar o cadastro do cliente;
 * - seção 8.3: o endereço do CADASTRO mudou e o cliente já tinha ponto — o
 *   escritório confirma se aquele ponto sobrevive à mudança.
 * Uma nota pode levantar mais de uma: primeiro rota × retirada; respondida
 * "vai para rota", ela reaparece como cartão de endereço.
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
   * A pergunta de rota × retirada vem PRIMEIRO e sozinha: ela é metade da
   * importação (~60 notas/dia), enquanto as de endereço são raras. Sai num
   * bloco com confirmação em lote — uma tela de 60 cartões para clicar um a um
   * viraria "marcar tudo e seguir", que é pior que decidir automático porque
   * dá a ilusão de que alguém conferiu.
   *
   * Nota que levanta as duas perguntas aparece só aqui; respondida "vai para
   * rota", ela reaparece embaixo como cartão de endereço.
   */
  const escolhaDeModo = aguardando.filter(aguardandoEscolhaDeModo);
  const decisoesDeEndereco = aguardando.filter((p) => !aguardandoEscolhaDeModo(p));

  /**
   * Sempre recarrega em vez de só tirar o cartão da tela. Uma decisão mexe em
   * MAIS pedidos que o da vez: a de mudança de endereço libera todas as notas
   * do mesmo cliente presas pela mesma pergunta (senão elas continuariam na
   * lista e responder qualquer uma delas devolveria 409), e responder a
   * pergunta da entrega pode deixar a do cadastro em aberto no mesmo pedido.
   */
  function resolvido() {
    carregar();
  }

  return (
    <section className="cartao">
      <div className="cabecalho-secao">
        <h2>Decisões</h2>
        <button onClick={carregar}>Atualizar</button>
      </div>
      <p style={{ color: 'var(--texto-2)' }}>
        O que a importação não resolve sozinha: nota com cara de{' '}
        <strong>retirada no balcão</strong>, endereço de <strong>entrega</strong> diferente do
        fiscal, ou endereço do <strong>cadastro que mudou</strong> com ponto já estabelecido.
      </p>

      {erro && <div className="erro">{erro} — a API está no ar?</div>}
      {!erro && aguardando.length === 0 && (
        <div className="vazio">Nenhuma decisão pendente. 👍</div>
      )}

      {escolhaDeModo.length > 0 && (
        <BlocoRetirada
          pedidos={escolhaDeModo}
          clientes={clientes}
          aoResolver={resolvido}
        />
      )}

      {decisoesDeEndereco.map((pedido) =>
        // A pergunta da entrega vem primeiro; `usarEnderecoEntrega` definido
        // significa que ela já foi respondida e sobrou a do cadastro.
        pedido.enderecoEntrega && pedido.usarEnderecoEntrega === undefined ? (
          <CartaoDecisao
            key={pedido.id}
            pedido={pedido}
            cliente={clientes[pedido.clienteId] ?? null}
            aoResolver={resolvido}
          />
        ) : pedido.enderecoAnterior ? (
          <CartaoMudancaEndereco
            key={pedido.id}
            pedido={pedido}
            cliente={clientes[pedido.clienteId] ?? null}
            aoResolver={resolvido}
          />
        ) : null,
      )}
    </section>
  );
}

/**
 * Rota × retirada. Metade das notas do dia não sai no caminhão: a revendedora
 * vem ao CD, paga e leva. O `modFrete` da NF-e sugere isso (nas 318 notas que o
 * escritório separou como retirada, as 318 eram `modFrete='9'`), mas quem
 * decide é quem conhece a operação.
 *
 * O desenho da tela vem do VOLUME: são ~60 notas/dia. As óbvias vão em lote;
 * as duvidosas — `modFrete='9'` MAS com lote de remessa, ou seja, o ERP
 * agrupou aquela mercadoria num carregamento — ficam destacadas para olhar uma
 * a uma. É onde a regra pode errar, e é o único lugar que merece atenção.
 */
function BlocoRetirada({
  pedidos,
  clientes,
  aoResolver,
}: {
  pedidos: Array<{ id: string } & Pedido>;
  clientes: Record<string, Cliente>;
  aoResolver: () => void;
}) {
  const [salvando, setSalvando] = useState(false);
  /** Progresso do lote. A API é uma chamada por nota e a instância do Render
   * pode estar fria: sem isto, confirmar 60 notas deixa a tela muda por vários
   * segundos e quem está usando conclui que travou e recarrega no meio. */
  const [progresso, setProgresso] = useState<{ feitas: number; total: number } | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const duvidosas = pedidos.filter(retiradaDuvidosa);
  const diretas = pedidos.filter((p) => !retiradaDuvidosa(p));

  async function decidir(ids: string[], escolha: 'rota' | 'retirada') {
    if (ids.length === 0) return;
    setSalvando(true);
    setErro(null);
    setProgresso(ids.length > 1 ? { feitas: 0, total: ids.length } : null);
    try {
      // Sequencial de propósito: são poucas dezenas, e uma falha no meio deixa
      // o que já foi decidido gravado — recarregar mostra o que sobrou, em vez
      // de perder tudo por causa de uma nota.
      for (const [i, id] of ids.entries()) {
        await decidirModoEntrega(id, escolha);
        if (ids.length > 1) setProgresso({ feitas: i + 1, total: ids.length });
      }
      aoResolver();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao salvar');
      // Recarrega mesmo com erro: o que já gravou some da fila, e sobra na tela
      // exatamente o que falta decidir.
      aoResolver();
    } finally {
      setSalvando(false);
      setProgresso(null);
    }
  }

  return (
    <div className="decisao">
      <div className="decisao-cabecalho">
        <strong>Rota ou retirada no balcão?</strong>
        <span className="chip pendente">{pedidos.length} nota(s)</span>
      </div>
      <p style={{ color: 'var(--texto-2)', marginTop: 0 }}>
        A nota fiscal marca <strong>sem ocorrência de transporte</strong>, o que costuma significar
        que a revendedora vem buscar no CD. Confirme antes de montar a rota — o que ficar como
        retirada não some, fica na aba Pedidos e pode voltar para a fila.
      </p>

      {erro && <div className="erro">{erro}</div>}

      {duvidosas.length > 0 && (
        <>
          <div className="decisao-rotulo" style={{ marginTop: '1rem' }}>
            ⚠ {duvidosas.length} com lote de remessa — o ERP agrupou para carregar. Confira uma a
            uma:
          </div>
          {duvidosas.map((p) => (
            <LinhaRetirada
              key={p.id}
              pedido={p}
              cliente={clientes[p.clienteId] ?? null}
              salvando={salvando}
              aoDecidir={(escolha) => void decidir([p.id], escolha)}
            />
          ))}
        </>
      )}

      {diretas.length > 0 && (
        <>
          <div className="decisao-rotulo" style={{ marginTop: '1rem' }}>
            {diretas.length} sem lote de remessa — nada foi separado para carregar:
          </div>
          {diretas.map((p) => (
            <LinhaRetirada
              key={p.id}
              pedido={p}
              cliente={clientes[p.clienteId] ?? null}
              salvando={salvando}
              aoDecidir={(escolha) => void decidir([p.id], escolha)}
            />
          ))}
          <div className="acoes-rota">
            <button
              className="primaria"
              disabled={salvando}
              onClick={() => void decidir(diretas.map((p) => p.id), 'retirada')}
            >
              {progresso
                ? `Salvando… ${progresso.feitas} de ${progresso.total}`
                : salvando
                  ? 'Salvando…'
                  : `Confirmar as ${diretas.length} como retirada`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Uma nota da fila de rota × retirada: o que a pessoa precisa ver para decidir. */
function LinhaRetirada({
  pedido,
  cliente,
  salvando,
  aoDecidir,
}: {
  pedido: { id: string } & Pedido;
  cliente: Cliente | null;
  salvando: boolean;
  aoDecidir: (escolha: 'rota' | 'retirada') => void;
}) {
  const municipio = cliente?.enderecoFiscal.municipio ?? '—';
  const unidades = pedido.itens.reduce((s, i) => s + i.quantidade, 0);
  return (
    <div className="decisao-opcao" style={{ alignItems: 'center', gap: '0.75rem' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="decisao-rotulo">{cliente?.nome ?? 'cliente não carregado'}</div>
        <div className="decisao-aviso">
          <span className="mono">
            Nota {pedido.numeroNota}/{pedido.serie}
          </span>{' '}
          · {municipio} · {unidades} un · {formatarValor(pedido.valorTotal)}
          {pedido.lote ? ` · lote ${pedido.lote}` : ''}
        </div>
      </div>
      <button disabled={salvando} onClick={() => aoDecidir('rota')}>
        Vai para rota
      </button>
      <button disabled={salvando} onClick={() => aoDecidir('retirada')}>
        Retirada
      </button>
    </div>
  );
}

/** pt-BR, como todo número que o escritório lê (seção 14). */
function formatarValor(valor: number): string {
  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
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
  aoResolver: () => void;
}) {
  const [escolha, setEscolha] = useState<'manter' | 'remapear' | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function confirmar() {
    if (!escolha) return;
    setSalvando(true);
    setErro(null);
    try {
      await decidirMudancaEndereco(pedido.id, escolha);
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
              descarta o pin, a trilha e o dossiê do local (foto e observações, que são do endereço
              antigo) e tenta o endereço novo; sem geocodificação (zona rural), o motorista mapeia
              na primeira viagem
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
