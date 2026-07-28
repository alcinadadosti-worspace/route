import { Fragment, useEffect, useMemo, useState } from 'react';
import { normalizar, type Cliente, type Pedido } from '@rota/shared';
import { listarClientes, listarPedidos } from '../api';

const ROTULO_MAPEAMENTO: Record<string, { texto: string; classe: string }> = {
  nao_mapeado: { texto: 'Não mapeado', classe: 'pendente' },
  aproximado: { texto: 'Aproximado (a mapear)', classe: 'pendente' },
  geocodificado: { texto: 'Geocodificado', classe: '' },
  mapeado: { texto: 'Mapeado', classe: 'pronto' },
};

const ROTULO_STATUS_PEDIDO: Record<string, string> = {
  pendente_de_mapeamento: 'Pendente de mapeamento',
  pendente_de_decisao: 'Aguardando endereço',
  pronto_para_rota: 'Pronto para rota',
  importado: 'Importado',
  em_rota: 'Em rota',
  entregue: 'Entregue',
  insucesso: 'Insucesso',
};

export function Clientes() {
  const [clientes, setClientes] = useState<Array<{ id: string } & Cliente>>([]);
  const [pedidos, setPedidos] = useState<Array<{ id: string } & Pedido>>([]);
  const [filtro, setFiltro] = useState('');
  const [expandido, setExpandido] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listarClientes(), listarPedidos()])
      .then(([cs, ps]) => {
        setClientes(cs);
        setPedidos(ps);
      })
      .catch((e) => setErro(e instanceof Error ? e.message : 'Falha ao listar'));
  }, []);

  // Pedidos agrupados por cliente (mais recentes primeiro).
  const pedidosPorCliente = useMemo(() => {
    const mapa: Record<string, Array<{ id: string } & Pedido>> = {};
    for (const p of pedidos) (mapa[p.clienteId] ??= []).push(p);
    for (const lista of Object.values(mapa)) {
      lista.sort((a, b) => (b.emitidoEm ?? '').localeCompare(a.emitidoEm ?? ''));
    }
    return mapa;
  }, [pedidos]);

  const q = normalizar(filtro.trim());
  const filtrados = q ? clientes.filter((c) => normalizar(c.nome).includes(q)) : clientes;

  return (
    <section className="cartao">
      <h2>Clientes</h2>
      {clientes.length > 0 && (
        <input
          type="search"
          className="filtro"
          placeholder="Filtrar por nome do cliente…"
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
        />
      )}
      {erro && <div className="erro">{erro}</div>}
      {!erro && clientes.length === 0 && (
        <div className="vazio">Nenhum cliente ainda — eles nascem da importação das notas.</div>
      )}
      {clientes.length > 0 && filtrados.length === 0 && (
        <div className="vazio">Nenhum cliente com “{filtro}”.</div>
      )}
      {filtrados.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Nome</th>
              <th>Documento</th>
              <th>Telefone</th>
              <th>Endereço fiscal</th>
              <th>Mapeamento</th>
              <th>Pedidos</th>
            </tr>
          </thead>
          <tbody>
            {filtrados.map((c) => {
              const s = ROTULO_MAPEAMENTO[c.statusMapeamento] ?? {
                texto: c.statusMapeamento,
                classe: '',
              };
              const e = c.enderecoFiscal;
              const meus = pedidosPorCliente[c.id] ?? [];
              const aberto = expandido === c.id;
              return (
                <Fragment key={c.id}>
                  <tr
                    onClick={() => meus.length > 0 && setExpandido(aberto ? null : c.id)}
                    style={{ cursor: meus.length > 0 ? 'pointer' : 'default' }}
                  >
                    <td>{c.nome}</td>
                    <td className="mono">{c.documentoMascarado}</td>
                    <td className="mono">{c.telefone ?? '—'}</td>
                    <td>
                      {e.logradouro}, {e.numero} — {e.bairro}, {e.municipio}/{e.uf}
                    </td>
                    <td>
                      <span className={`chip ${s.classe}`}>{s.texto}</span>
                    </td>
                    <td className="mono">{meus.length > 0 ? `${meus.length} ${aberto ? '▲' : '▾'}` : '—'}</td>
                  </tr>
                  {aberto && (
                    <tr>
                      <td colSpan={6}>
                        <div className="pedidos-cliente">
                          {meus.map((p) => (
                            <div key={p.id} className="pedido-linha">
                              <span className="mono">
                                {p.numeroNota}/{p.serie}
                              </span>
                              <span>{p.emitidoEm.slice(0, 10)}</span>
                              <span>
                                {p.itens.length} itens · {p.volumes} vol
                              </span>
                              <span className="mono">
                                {p.valorTotal.toLocaleString('pt-BR', {
                                  style: 'currency',
                                  currency: 'BRL',
                                })}
                              </span>
                              <span className="chip">{ROTULO_STATUS_PEDIDO[p.status] ?? p.status}</span>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
