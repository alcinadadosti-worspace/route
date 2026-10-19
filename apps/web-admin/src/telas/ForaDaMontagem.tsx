import { useEffect, useMemo, useState } from 'react';
import { formatarDia, type Cliente, type Pedido } from '@rota/shared';
import { alterarLiberacao } from '../api';
import { CampoBusca } from '../CampoBusca';
import {
  listarForaDaMontagem,
  type TipoForaDaMontagem,
  type VistaForaDaMontagem,
} from '../foraDaMontagem';

/**
 * O que o ERP deixou fora da montagem — retirada na central, e entrega que ele
 * já dá como entregue — com o caminho de volta para a rota.
 *
 * Existe porque o "entregue" do ERP mente nos dois casos (usuário, 19/10/2026):
 * ele marca sozinho depois de 6 dias, e há retirada que acaba indo no
 * caminhão. Ficar de fora é o padrão; o Admin Estoque marca o que ainda não
 * foi entregue e libera. Fechada por padrão: num ciclo são ~1700 pedidos, e a
 * montagem do dia não pode ficar soterrada debaixo deles.
 */

/** Linhas desenhadas de uma vez. A busca e a cidade estreitam o resto. */
const LIMITE = 150;

const ROTULO_STATUS: Record<string, string> = {
  pronto_para_rota: 'na montagem',
  pendente_de_mapeamento: 'na montagem · sem ponto no mapa',
  pendente_de_decisao: 'aguardando decisão (aba Decisões)',
};

export function ForaDaMontagem({
  pedidos,
  clientes,
  aoAlterar,
}: {
  pedidos: Array<{ id: string } & Pedido>;
  clientes: Record<string, Cliente>;
  aoAlterar: () => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [vista, setVista] = useState<VistaForaDaMontagem>('fora');
  const [tipo, setTipo] = useState<TipoForaDaMontagem>('todos');
  const [cidade, setCidade] = useState('');
  const [busca, setBusca] = useState('');
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [enviando, setEnviando] = useState(false);
  const [mensagem, setMensagem] = useState<{ texto: string; erro: boolean } | null>(null);

  const lista = useMemo(
    () => listarForaDaMontagem(pedidos, clientes, { vista, tipo, cidade, busca }),
    [pedidos, clientes, vista, tipo, cidade, busca],
  );
  const visiveis = lista.linhas.slice(0, LIMITE);

  // Marca é da vista em que foi feita: liberar na lista de liberados (ou o
  // contrário) mandaria a ação errada para pedidos que o operador nem vê mais.
  // Os filtros também: uma busca esquecida na outra aba esconderia pedidos
  // sem ninguém perceber por quê.
  useEffect(() => {
    setMarcados(new Set());
    setCidade('');
    setBusca('');
  }, [vista]);
  // Cidade escolhida que sumiu das opções (mudou o tipo) não pode filtrar às cegas.
  useEffect(() => {
    if (cidade && !lista.cidades.some((c) => c.chave === cidade)) setCidade('');
  }, [lista.cidades, cidade]);
  // Pedido que saiu da vista (liberado, apagado, recarregado) sai da marcação.
  // Contra a vista INTEIRA, não a filtrada: buscar um nome para marcar o
  // quarto pedido não pode desmarcar os três de antes.
  const idsDaVista = useMemo(
    () =>
      new Set(
        listarForaDaMontagem(pedidos, clientes, { vista, tipo: 'todos', cidade: '', busca: '' }).linhas.map(
          (l) => l.pedido.id,
        ),
      ),
    [pedidos, clientes, vista],
  );
  useEffect(() => {
    setMarcados((m) => {
      const podado = new Set([...m].filter((id) => idsDaVista.has(id)));
      return podado.size === m.size ? m : podado;
    });
  }, [idsDaVista]);
  const idsFiltrados = new Set(lista.linhas.map((l) => l.pedido.id));
  const marcadosEscondidos = [...marcados].filter((id) => !idsFiltrados.has(id)).length;

  const todosVisiveisMarcados = visiveis.length > 0 && visiveis.every((l) => marcados.has(l.pedido.id));

  function alternar(id: string) {
    setMarcados((m) => {
      const novo = new Set(m);
      if (novo.has(id)) novo.delete(id);
      else novo.add(id);
      return novo;
    });
  }

  function alternarVisiveis() {
    setMarcados((m) => {
      const novo = new Set(m);
      for (const l of visiveis) {
        if (todosVisiveisMarcados) novo.delete(l.pedido.id);
        else novo.add(l.pedido.id);
      }
      return novo;
    });
  }

  async function aplicar() {
    const ids = [...marcados];
    if (ids.length === 0) return;
    const acao = vista === 'fora' ? 'liberar' : 'devolver';
    const pergunta =
      acao === 'liberar'
        ? `Liberar ${ids.length} pedido(s) para a montagem de rota?\n\n` +
          'Eles passam a aparecer na montagem como qualquer pedido de entrega. Dá para desfazer ' +
          'enquanto não saírem numa rota.'
        : `Devolver ${ids.length} pedido(s) para fora da montagem?`;
    if (!window.confirm(pergunta)) return;
    setEnviando(true);
    setMensagem(null);
    try {
      const r = await alterarLiberacao(ids, acao);
      setMarcados(new Set());
      setMensagem({ texto: resumo(acao, r.alterados, r.recusados), erro: r.recusados.length > 0 });
      aoAlterar();
    } catch (e) {
      setMensagem({ texto: e instanceof Error ? e.message : 'Falha ao gravar', erro: true });
    } finally {
      setEnviando(false);
    }
  }

  const { contagem } = lista;
  return (
    <section className="cartao fora-da-montagem">
      <div className="cabecalho-secao">
        <h2>Fora da montagem</h2>
        <button type="button" aria-expanded={aberto} onClick={() => setAberto(!aberto)}>
          {aberto ? 'Esconder' : 'Mostrar'}
        </button>
      </div>
      <p className="nota-publicacao">
        {contagem.retiradas} retirada(s) na central · {contagem.entreguesNoErp} entrega(s) que o ERP já
        dá como entregue · {contagem.liberados} liberado(s) para a rota. Não entram na montagem até você
        liberar — o ERP marca "entregue" sozinho depois de 6 dias, e há retirada que vai no caminhão.
      </p>

      {aberto && (
        <>
          <div className="abas" role="tablist">
            <button role="tab" aria-selected={vista === 'fora'} onClick={() => setVista('fora')}>
              Fora da montagem ({contagem.retiradas + contagem.entreguesNoErp})
            </button>
            <button role="tab" aria-selected={vista === 'liberados'} onClick={() => setVista('liberados')}>
              Liberados ({contagem.liberados})
            </button>
          </div>

          <div className="filtros-fora">
            {vista === 'fora' && (
              <select value={tipo} onChange={(e) => setTipo(e.target.value as TipoForaDaMontagem)}>
                <option value="todos">Retiradas e entregues no ERP</option>
                <option value="entregue_no_erp">Só entrega que o ERP dá como entregue</option>
                <option value="retirada">Só retirada na central</option>
              </select>
            )}
            <select value={cidade} onChange={(e) => setCidade(e.target.value)}>
              <option value="">Todas as cidades</option>
              {lista.cidades.map((c) => (
                <option key={c.chave} value={c.chave}>
                  {c.nome} ({c.n})
                </option>
              ))}
            </select>
            <CampoBusca
              valor={busca}
              aoMudar={setBusca}
              rotulo="Buscar em Fora da montagem"
              placeholder="Nº do pedido, nota ou cliente…"
            />
          </div>

          {lista.linhas.length === 0 ? (
            <div className="vazio">
              {vista === 'fora' ? 'Nada fora da montagem com este filtro.' : 'Nenhum pedido liberado esperando rota.'}
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Marcar todos os mostrados"
                      checked={todosVisiveisMarcados}
                      onChange={alternarVisiveis}
                    />
                  </th>
                  <th>Nota</th>
                  <th>Cliente</th>
                  <th>Cidade</th>
                  <th>{vista === 'fora' ? 'Situação no ERP' : 'Origem · agora'}</th>
                  <th>Emitida</th>
                </tr>
              </thead>
              <tbody>
                {visiveis.map(({ pedido: p, cliente, cidade: nomeCidade, origem }) => (
                  <tr key={p.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Marcar nota ${p.numeroNota}`}
                        checked={marcados.has(p.id)}
                        onChange={() => alternar(p.id)}
                      />
                    </td>
                    <td className="mono">
                      {p.numeroNota}/{p.serie}
                    </td>
                    <td>{cliente}</td>
                    <td>{nomeCidade}</td>
                    <td>
                      {origem === 'retirada' ? 'Retirada na central' : 'Entrega'}
                      {vista === 'fora'
                        ? p.entregueNoErp && ` · ERP: entregue ${formatarDia(p.entregueNoErp.data)}`
                        : ` · ${ROTULO_STATUS[p.status] ?? p.status}`}
                    </td>
                    <td className="mono">{formatarDia(p.emitidoEm?.slice(0, 10))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {lista.linhas.length > LIMITE && (
            <div className="vazio">
              Mostrando {LIMITE} de {lista.linhas.length} — escolha a cidade ou busque para achar o resto.
            </div>
          )}

          {marcados.size > 0 && (
            <div className="barra-rota">
              <button className="primaria" disabled={enviando} onClick={() => void aplicar()}>
                {enviando
                  ? 'GRAVANDO…'
                  : vista === 'fora'
                    ? `LIBERAR ${marcados.size} PARA A MONTAGEM`
                    : `DEVOLVER ${marcados.size} PARA FORA DA MONTAGEM`}
              </button>
              <button disabled={enviando} onClick={() => setMarcados(new Set())}>
                Limpar marcas
              </button>
              {/* Marcado e escondido pelo filtro também vai — dizer antes. */}
              {marcadosEscondidos > 0 && (
                <span className="nota-publicacao">
                  {marcadosEscondidos} marcado(s) não aparece(m) com o filtro atual e vai(ão) junto.
                </span>
              )}
            </div>
          )}
          {mensagem && <div className={mensagem.erro ? 'alerta' : 'sucesso'}>{mensagem.texto}</div>}
        </>
      )}
    </section>
  );
}

/** O que aconteceu, dito em termos de ONDE cada pedido foi parar. */
function resumo(
  acao: 'liberar' | 'devolver',
  alterados: Array<{ status: string }>,
  recusados: Array<{ motivo: string }>,
): string {
  const partes: string[] = [];
  if (acao === 'liberar') {
    const conta = (s: string) => alterados.filter((a) => a.status === s).length;
    const prontos = conta('pronto_para_rota');
    const semPonto = conta('pendente_de_mapeamento');
    const decisao = conta('pendente_de_decisao');
    partes.push(`${alterados.length} liberado(s): ${prontos} pronto(s) na montagem`);
    if (semPonto > 0) {
      partes.push(
        `${semPonto} sem ponto no mapa (vão como exceção da cidade, ou use "Localizar endereços" na Importação)`,
      );
    }
    if (decisao > 0) partes.push(`${decisao} aguardando decisão de endereço (aba Decisões)`);
  } else {
    partes.push(`${alterados.length} devolvido(s) para fora da montagem`);
  }
  if (recusados.length > 0) {
    partes.push(`${recusados.length} não mudou: ${recusados.map((r) => r.motivo).join('; ')}`);
  }
  return partes.join(' · ') + '.';
}
