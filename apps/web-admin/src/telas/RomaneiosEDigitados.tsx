import { useEffect, useMemo, useState } from 'react';
import { formatarDia, formatarHoraCurta, type CentroDistribuicao, type Cliente, type Usuario } from '@rota/shared';
import { listarCds, listarClientes, listarPedidos, listarUsuarios } from '../api';
import { diasComPedidos, separarPorOrigem, type PedidoComId } from '../origemPedidos';
import { ROTULO_STATUS } from './Pedidos';

/**
 * Quanto entrou pelo romaneio em PDF (por folha) e quanto foi digitado à mão.
 * O digitado não tem documento de origem: esta lista, com quem digitou e
 * quando, é o que permite conferi-lo contra o papel.
 */
export function RomaneiosEDigitados() {
  const [pedidos, setPedidos] = useState<PedidoComId[]>([]);
  const [clientes, setClientes] = useState<Record<string, Cliente>>({});
  const [usuarios, setUsuarios] = useState<Array<{ id: string } & Usuario>>([]);
  const [cds, setCds] = useState<Record<string, CentroDistribuicao>>({});
  /** null = todos os dias. */
  const [dia, setDia] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    // Nome e cidade moram no CLIENTE, não no pedido. Usuários e CDs são
    // listas curtas; sem elas o "digitado por" e a folha só teriam códigos.
    Promise.all([listarPedidos(), listarClientes(), listarUsuarios(), listarCds()])
      .then(([ps, cs, us, cd]) => {
        setPedidos(ps);
        setClientes(Object.fromEntries(cs.map((c) => [c.id, c])));
        setUsuarios(us);
        setCds(cd);
      })
      .catch((e) => setErro(e instanceof Error ? e.message : 'Falha ao listar'))
      .finally(() => setCarregando(false));
  }, []);

  const dias = useMemo(() => diasComPedidos(pedidos), [pedidos]);
  const { romaneios, totalViaRomaneio, digitados } = useMemo(
    () => separarPorOrigem(pedidos, dia),
    [pedidos, dia],
  );
  const nomeDoUsuario = (id: string) => usuarios.find((u) => u.id === id)?.nome ?? id.slice(0, 8);
  const nada = totalViaRomaneio === 0 && digitados.length === 0;

  return (
    <section className="cartao">
      <h2>Romaneios e digitados</h2>
      <div className="sub">
        Pedidos que entraram pelo romaneio em PDF e os digitados à mão na Importação. Os de planilha e
        XML ficam na aba Pedidos.
      </div>
      {erro && <div className="erro">{erro}</div>}
      {carregando && <div className="vazio">Carregando os pedidos…</div>}

      {!carregando && !erro && (
        <>
          {dias.length > 0 && (
            <div className="periodo origem-dia">
              <label className="opcao">
                Dia
                <select value={dia ?? ''} onChange={(e) => setDia(e.target.value || null)}>
                  <option value="">Todos os dias</option>
                  {dias.map((d) => (
                    <option key={d} value={d}>
                      {formatarDia(d, true)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          <div className="grade-relatorio">
            <div className="metrica">
              <div className="valor">{totalViaRomaneio}</div>
              <div className="rotulo">
                Via romaneio · {romaneios.length} folha{romaneios.length === 1 ? '' : 's'}
              </div>
            </div>
            <div className="metrica">
              <div className="valor">{digitados.length}</div>
              <div className="rotulo">Digitados</div>
            </div>
          </div>

          {nada && (
            <div className="vazio">
              {dias.length === 0
                ? 'Nenhum pedido entrou por romaneio nem foi digitado ainda. Comece pela aba Importação.'
                : 'Nada de romaneio nem digitado neste dia.'}
            </div>
          )}

          {romaneios.map((r) => (
            <div key={r.numero || '(sem número)'} className="origem-grupo">
              <h3>
                {r.numero ? <>Romaneio <span className="mono">{r.numero}</span></> : 'Romaneio sem número'}
                {' · '}
                {r.pedidos.length} pedido{r.pedidos.length === 1 ? '' : 's'}
              </h3>
              <div className="sub">
                {[r.cdId ? cds[r.cdId]?.nome ?? r.cdId : null, r.dia ? formatarDia(r.dia, true) : null]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              <TabelaDePedidos pedidos={r.pedidos} clientes={clientes} />
            </div>
          ))}

          {digitados.length > 0 && (
            <div className="origem-grupo">
              <h3>
                Digitados · {digitados.length} pedido{digitados.length === 1 ? '' : 's'}
              </h3>
              <TabelaDePedidos
                pedidos={digitados}
                clientes={clientes}
                digitadoPor={(p) =>
                  `${nomeDoUsuario(p.digitado!.por ?? '')} · ${formatarDia(p.digitado!.em?.slice(0, 10))} ${formatarHoraCurta(p.digitado!.em)}`
                }
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}

function TabelaDePedidos({
  pedidos,
  clientes,
  digitadoPor,
}: {
  pedidos: PedidoComId[];
  clientes: Record<string, Cliente>;
  /** Só na lista dos digitados: quem digitou e quando. */
  digitadoPor?: (p: PedidoComId) => string;
}) {
  return (
    <div className="rolagem-tabela">
      <table>
        <thead>
          <tr>
            <th>Pedido</th>
            <th>NF</th>
            <th>Cliente</th>
            <th>Cidade</th>
            {digitadoPor && <th>Digitado por</th>}
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {pedidos.map((p) => {
            const c = clientes[p.clienteId];
            // Entrega em local diverso escolhida na aba Decisões: a cidade que
            // vale é a da entrega, não a do cadastro.
            const e = p.usarEnderecoEntrega && p.enderecoEntrega ? p.enderecoEntrega : c?.enderecoFiscal;
            const s = ROTULO_STATUS[p.status] ?? { texto: p.status, classe: '' };
            return (
              <tr key={p.id}>
                <td className="mono">{p.numeroPedido ?? p.id}</td>
                <td className="mono">{p.numeroNota || '—'}</td>
                <td>{c?.nome ?? '—'}</td>
                <td>{e ? [e.bairro, e.municipio].filter(Boolean).join(', ') : '—'}</td>
                {digitadoPor && <td>{digitadoPor(p)}</td>}
                <td>
                  <span className={`chip ${s.classe}`}>{s.texto}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
