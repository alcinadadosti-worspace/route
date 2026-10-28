import { BuscaNaBase } from '../BuscaNaBase';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { normalizar, quantidadeDeItens, type Cliente, type Pedido } from '@rota/shared';
import { listarClientes, listarPedidos, refazerPontoDoCliente } from '../api';
import { FotoReferencia } from '../FotoReferencia';
import { CompletarDados } from '../CompletarDados';
import { confirmarDescarte } from '../alteracoesPendentes';

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
  entregue_no_erp: 'Entregue no ERP (fora da rota)',
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
  /** Cliente com o formulário de dados aberto (telefone, referência). */
  const [editando, setEditando] = useState<string | null>(null);
  const [soACompletar, setSoACompletar] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // "Nenhum cliente" só depois de ler: com a API acordando a leitura leva até
  // 1 min, e o vazio na tela era lido como "não há nada".
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    Promise.all([listarClientes(), listarPedidos()])
      .then(([cs, ps]) => {
        setClientes(cs);
        setPedidos(ps);
      })
      .catch((e) => setErro(e instanceof Error ? e.message : 'Falha ao listar'))
      .finally(() => setCarregando(false));
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

  /** Cliente com o ponto sendo refeito: o ↺ dele gira (a busca leva segundos). */
  const [refazendo, setRefazendo] = useState<string | null>(null);

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
    setRefazendo(c.id);
    try {
      await refazerPontoDoCliente(c.id);
      const [cs, ps] = await Promise.all([listarClientes(), listarPedidos()]);
      setClientes(cs);
      setPedidos(ps);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao refazer o ponto');
    } finally {
      setRefazendo(null);
    }
  }

  const aCompletar = clientes.filter((c) => c.completarDados).length;
  // Completado o último, a lista inteira volta sozinha — e não uma tabela vazia.
  const soEsses = soACompletar && aCompletar > 0;
  const q = normalizar(filtro.trim());
  // O cliente em edição fica na lista mesmo que o filtro o esconda: sumir da
  // tabela desmontava o formulário e descartava o que foi digitado.
  const filtrados = clientes.filter(
    (c) => c.id === editando || ((!soEsses || c.completarDados) && (!q || normalizar(c.nome).includes(q))),
  );

  return (
    <section className="cartao">
      <h2>Clientes</h2>
      <BuscaNaBase clientesNaLista={clientes.length} />
      {clientes.length > 0 && (
        <input
          type="search"
          className="filtro"
          placeholder="Filtrar por nome do cliente…"
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
        />
      )}
      {/* Quem veio de romaneio sem estar na base só tem nome e endereço: sem
          telefone o motorista não liga, não avisa a chegada nem manda recibo. */}
      {aCompletar > 0 && (
        <div className="alerta">
          {aCompletar} cliente(s) vieram de romaneio sem estar na base de revendedoras e só têm o nome e o
          endereço da folha — complete o telefone e a referência.{' '}
          <button className="ligacao alvo-toque" onClick={() => setSoACompletar((s) => !s)}>
            {soEsses ? 'Mostrar todos' : 'Mostrar só esses'}
          </button>
        </div>
      )}
      {erro && <div className="erro">{erro}</div>}
      {carregando && <div className="vazio">Carregando os clientes…</div>}
      {!carregando && !erro && clientes.length === 0 && (
        <div className="vazio">Nenhum cliente ainda — eles nascem da importação das notas.</div>
      )}
      {clientes.length > 0 && filtrados.length === 0 && (
        <div className="vazio">
          {/* Com "Mostrar só esses" ligado, a cliente completa não aparece —
              e "nenhum cliente" dava a entender que ela não existia. */}
          Nenhum cliente {soEsses ? 'a completar ' : ''}com “{filtro}”.
        </div>
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
                    <td>
                      {c.nome}
                      {c.completarDados && (
                        <span className="chip pendente" style={{ marginLeft: 8 }}>
                          completar dados
                        </span>
                      )}
                    </td>
                    <td className="mono">{c.documentoMascarado}</td>
                    <td className="mono">
                      {c.telefone ?? '—'}{' '}
                      <button
                        className="ligacao alvo-toque"
                        title="Completar ou corrigir telefone e referência"
                        onClick={(evento) => {
                          evento.stopPropagation();
                          // Abrir outro (ou fechar este) desmonta o formulário aberto.
                          if (editando !== null && !confirmarDescarte()) return;
                          setEditando(editando === c.id ? null : c.id);
                        }}
                      >
                        ✎ editar
                      </button>
                    </td>
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
                          disabled={refazendo !== null}
                          onClick={(evento) => {
                            evento.stopPropagation();
                            void refazerPonto(c);
                          }}
                        >
                          {refazendo === c.id ? <span className="giro pequeno so-giro" aria-hidden="true" /> : '↺'}
                        </button>
                      )}
                    </td>
                    <td className="mono">{meus.length > 0 ? `${meus.length} ${aberto ? '▲' : '▾'}` : '—'}</td>
                  </tr>
                  {editando === c.id && (
                    <tr>
                      <td colSpan={6}>
                        <CompletarDados
                          cliente={{
                            id: c.id,
                            nome: c.nome,
                            endereco: `${e.logradouro}, ${e.numero} — ${e.bairro}, ${e.municipio}/${e.uf}`,
                            telefone: c.telefone,
                            observacoes: c.observacoes,
                            codigoErp: c.codigoErp ?? null,
                          }}
                          pendente={c.completarDados === true}
                          aoConcluir={(atualizado) => {
                            setClientes((atual) => atual.map((x) => (x.id === atualizado.id ? atualizado : x)));
                            setEditando(null);
                          }}
                          aoCancelar={() => setEditando(null)}
                        />
                      </td>
                    </tr>
                  )}
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
                              {/* Pedido do romaneio (ou digitado da folha) não traz itens nem valor. */}
                              <span>
                                {p.romaneio
                                  ? `romaneio ${p.romaneio}`
                                  : p.digitado
                                    ? 'digitado'
                                    : `${quantidadeDeItens(p)} itens`}{' '}
                                · {p.volumes} vol
                              </span>
                              <span className="mono">
                                {p.romaneio || p.digitado
                                  ? '—'
                                  : p.valorTotal.toLocaleString('pt-BR', {
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
