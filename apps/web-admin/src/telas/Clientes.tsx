import { Fragment, useEffect, useMemo, useState } from 'react';
import { normalizar, type Cliente, type Pedido } from '@rota/shared';
import { listarClientes, listarPedidos, refazerPontoDoCliente } from '../api';
import { FotoReferencia } from '../FotoReferencia';

/** Status em que há um ponto para refazer (RF-23). */
const TEM_PONTO = new Set(['mapeado', 'geocodificado', 'aproximado']);

const ROTULO_MAPEAMENTO: Record<string, { texto: string; classe: string }> = {
  nao_mapeado: { texto: 'Não mapeado', classe: 'pendente' },
  aproximado: { texto: 'Aproximado (a mapear)', classe: 'pendente' },
  geocodificado: { texto: 'Geocodificado', classe: '' },
  mapeado: { texto: 'Mapeado', classe: 'pronto' },
};

const ROTULO_STATUS_PEDIDO: Record<string, string> = {
  pendente_de_mapeamento: 'Pendente de mapeamento',
  pendente_de_decisao: 'Aguardando decisão',
  pronto_para_rota: 'Pronto para rota',
  retirada: 'Retirada no balcão',
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

  async function refazerPonto(c: { id: string } & Cliente) {
    if (
      !window.confirm(
        `Descartar o ponto de ${c.nome}?\n\n` +
          'A coordenada, a autoria do pin e a trilha aprendida são apagadas, e o endereço é ' +
          'geocodificado de novo. Sem resultado, o destino volta para mapeamento em campo. ' +
          'A foto e as observações do local são preservadas.',
      )
    ) {
      return;
    }
    setErro(null);
    try {
      await refazerPontoDoCliente(c.id);
      const [cs, ps] = await Promise.all([listarClientes(), listarPedidos()]);
      setClientes(cs);
      setPedidos(ps);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao refazer o ponto');
    }
  }

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
                      {/* Saída para pin no lugar errado: depois de `mapeado` o
                          app do motorista não oferece mais o ajuste, e sem isto
                          o ponto errado seria definitivo. */}
                      {TEM_PONTO.has(c.statusMapeamento) && (
                        <button
                          className="apagar"
                          style={{ marginLeft: 8 }}
                          title="Descartar o ponto e reclassificar pelo endereço"
                          onClick={(evento) => {
                            evento.stopPropagation();
                            void refazerPonto(c);
                          }}
                        >
                          ↺
                        </button>
                      )}
                    </td>
                    <td className="mono">{meus.length > 0 ? `${meus.length} ${aberto ? '▲' : '▾'}` : '—'}</td>
                  </tr>
                  {aberto && (
                    <tr>
                      <td colSpan={6}>
                        {(c.fotoReferenciaPath || c.observacoes) && (
                          <div className="dossie-bloco">
                            {c.fotoReferenciaPath && (
                              <FotoReferencia
                                caminho={c.fotoReferenciaPath}
                                alt={`Referência de ${c.nome}`}
                              />
                            )}
                            {c.observacoes && (
                              <div className="dossie-obs-admin">📌 {c.observacoes}</div>
                            )}
                          </div>
                        )}
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
