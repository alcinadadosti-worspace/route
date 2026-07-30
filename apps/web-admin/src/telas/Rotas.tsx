import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  distanciaEmMetros,
  formatarCarga,
  type CentroDistribuicao,
  type Cliente,
  type Entrega,
  type Pedido,
  type PreviaRota,
  type Rota,
  type Usuario,
} from '@rota/shared';
import {
  apagarRota,
  listarCds,
  listarClientes,
  listarEntregasDaRota,
  listarPedidos,
  listarRotas,
  listarUsuarios,
  previaDeRota,
  publicarRota,
} from '../api';
import { MapaRota } from '../MapaRota';

/** Status da parada em português — o enum cru não é para o operador ler. */
const ROTULO_PARADA: Record<string, string> = {
  em_rota: 'A entregar',
  entregue: 'Entregue',
  insucesso: 'Insucesso',
};

/** Motivo do insucesso como o motorista escolheu (RF-18). */
const ROTULO_RESULTADO: Record<string, string> = {
  entregue: 'Entregue',
  ausente: 'Cliente ausente',
  nao_localizado: 'Endereço não localizado',
  recusa: 'Recusou a mercadoria',
};

function horaDe(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

const ROTULO_ROTA: Record<string, { texto: string; classe: string }> = {
  rascunho: { texto: 'Rascunho', classe: '' },
  publicada: { texto: 'Publicada', classe: 'pendente' },
  em_execucao: { texto: 'Em execução', classe: 'pendente' },
  concluida: { texto: 'Concluída', classe: 'pronto' },
};

/**
 * Montagem de rota (RF-11): o operador seleciona os pedidos prontos, escolhe
 * o CD de partida e otimiza — a prévia mostra a ordem das paradas, o traçado
 * e as estimativas. Publicação para o motorista (RF-13) é o próximo passo.
 */
export function Rotas() {
  const [pedidos, setPedidos] = useState<Array<{ id: string } & Pedido>>([]);
  const [clientes, setClientes] = useState<Record<string, Cliente>>({});
  const [cds, setCds] = useState<Record<string, CentroDistribuicao>>({});
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [cdId, setCdId] = useState<string>('');
  /** O operador pediu para trocar o CD que as notas definiram. */
  const [trocandoCd, setTrocandoCd] = useState(false);
  const [retornaAoCd, setRetornaAoCd] = useState(true);
  const [previa, setPrevia] = useState<PreviaRota | null>(null);
  const [otimizando, setOtimizando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [usuarios, setUsuarios] = useState<Array<{ id: string } & Usuario>>([]);
  const [motoristaId, setMotoristaId] = useState('');
  const [publicando, setPublicando] = useState(false);
  const [publicada, setPublicada] = useState<string | null>(null);
  const [rotas, setRotas] = useState<Array<{ id: string } & Rota>>([]);
  /** Rota expandida no acompanhamento, para ver parada a parada. */
  const [rotaAberta, setRotaAberta] = useState<string | null>(null);
  /**
   * Confirmações da rota aberta, por pedidoId. Buscadas só ao expandir: o motivo
   * do insucesso não cabe na parada (que só guarda 'insucesso') e ler o
   * histórico inteiro para mostrar uma rota seria desperdício.
   */
  const [entregasDaRota, setEntregasDaRota] = useState<Record<string, Entrega>>({});
  const [carregandoEntregas, setCarregandoEntregas] = useState(false);

  useEffect(() => {
    if (!rotaAberta) {
      setEntregasDaRota({});
      return;
    }
    let ativo = true;
    setCarregandoEntregas(true);
    setEntregasDaRota({});
    listarEntregasDaRota(rotaAberta)
      .then((es) => {
        if (!ativo) return;
        // Mais recente por pedido: a coleção admite duplicata (id automático) e
        // a última é a que casa com o status gravado na parada.
        const porPedido: Record<string, Entrega> = {};
        for (const e of [...es].sort((a, b) => a.confirmadaEm.localeCompare(b.confirmadaEm))) {
          porPedido[e.pedidoId] = e;
        }
        setEntregasDaRota(porPedido);
      })
      .catch(() => ativo && setEntregasDaRota({}))
      .finally(() => ativo && setCarregandoEntregas(false));
    return () => {
      ativo = false;
    };
  }, [rotaAberta]);

  function carregar() {
    Promise.all([listarPedidos(), listarCds(), listarUsuarios(), listarRotas(), listarClientes()])
      .then(([ps, c, us, rs, cls]) => {
        setPedidos(ps);
        setClientes(Object.fromEntries(cls.map((cl) => [cl.id, cl])));
        setCds(c);
        setCdId((atual) => atual || (Object.keys(c)[0] ?? ''));
        // TODOS ficam guardados para dar nome às rotas antigas: filtrar aqui
        // fazia a rota de um motorista desativado exibir o uid cru para sempre.
        setUsuarios(us);
        const ativos = us.filter((u) => u.ativo);
        setMotoristaId(
          (atual) => atual || (ativos.find((u) => u.papel === 'motorista') ?? ativos[0])?.id || '',
        );
        setRotas(rs);
      })
      .catch((e) => setErro(e instanceof Error ? e.message : 'Falha ao carregar'));
  }

  useEffect(carregar, []);

  const nomeDoUsuario = (id: string) => usuarios.find((u) => u.id === id)?.nome ?? id.slice(0, 8);

  const prontos = useMemo(
    () => pedidos.filter((p) => p.status === 'pronto_para_rota'),
    [pedidos],
  );
  const pendentes = useMemo(
    () => pedidos.filter((p) => p.status === 'pendente_de_mapeamento'),
    [pedidos],
  );

  const todosProntosMarcados = prontos.length > 0 && prontos.every((p) => selecionados.has(p.id));
  const algumProntoMarcado = prontos.some((p) => selecionados.has(p.id));

  // CD que os pedidos selecionados dizem ser a origem (seção 8.5) — vem do
  // CNPJ do emitente da nota. Vazio quando não há consenso ou não se sabe.
  const cdsSelecionados = useMemo(
    () => [
      ...new Set(
        prontos.filter((p) => selecionados.has(p.id)).map((p) => p.cdId ?? null).filter(Boolean),
      ),
    ],
    [prontos, selecionados],
  );
  const cdDasNotas = cdsSelecionados.length === 1 ? cdsSelecionados[0]! : null;
  const misturaCds = cdsSelecionados.length > 1;

  // Pré-seleciona o CD das notas: o operador não precisa saber de cabeça de
  // qual galpão sai cada pedido. Continua podendo trocar — a nota diz quem
  // FATUROU, e nem sempre é de onde a mercadoria fisicamente sai.
  useEffect(() => {
    if (cdDasNotas && cdDasNotas !== cdId) {
      setCdId(cdDasNotas);
      setPrevia(null);
    }
    // Mudou a seleção de pedidos: a troca manual anterior era sobre OUTRAS
    // notas, e manter o seletor aberto sugeriria uma decisão que não é mais a
    // mesma.
    setTrocandoCd(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cdDasNotas]);

  // Poda a seleção quando a lista de prontos muda (Atualizar/publicar): um id que
  // deixou de estar pronto não pode seguir selecionado e ir para a otimização.
  useEffect(() => {
    setSelecionados((sel) => {
      const validos = new Set(prontos.map((p) => p.id));
      const podado = new Set([...sel].filter((id) => validos.has(id)));
      return podado.size === sel.size ? sel : podado;
    });
  }, [prontos]);

  function alternar(id: string) {
    const proximo = new Set(selecionados);
    if (proximo.has(id)) proximo.delete(id);
    else proximo.add(id);
    setSelecionados(proximo);
    setPrevia(null);
  }

  // Marca/desmarca todos os pedidos prontos de uma vez.
  function alternarTodos() {
    setSelecionados(todosProntosMarcados ? new Set() : new Set(prontos.map((p) => p.id)));
    setPrevia(null);
  }

  async function otimizar() {
    setOtimizando(true);
    setErro(null);
    setPublicada(null);
    try {
      setPrevia(await previaDeRota({ pedidoIds: [...selecionados], cdId, retornaAoCd }));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha na otimização');
    } finally {
      setOtimizando(false);
    }
  }

  // RF-12: o operador ajusta a ordem; o traçado é recalculado com a sequência fixa.
  async function mover(indice: number, delta: number) {
    if (!previa) return;
    const ids = previa.paradas.map((p) => p.pedidoId);
    const destino = indice + delta;
    if (destino < 0 || destino >= ids.length) return;
    [ids[indice], ids[destino]] = [ids[destino]!, ids[indice]!];
    setOtimizando(true);
    setErro(null);
    try {
      setPrevia(await previaDeRota({ pedidoIds: ids, cdId, retornaAoCd, ordemManual: true }));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao reordenar');
    } finally {
      setOtimizando(false);
    }
  }

  async function desfazerRota(r: { id: string } & Rota) {
    if (
      !window.confirm(
        `Desfazer a rota ${r.id}?\n\n` +
          `As ${r.paradas.length} paradas somem do app do motorista e os pedidos voltam a ficar ` +
          'disponíveis para montar outra rota. Nada do que já foi entregue é afetado.',
      )
    ) {
      return;
    }
    setErro(null);
    try {
      await apagarRota(r.id);
      carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao desfazer a rota');
    }
  }

  async function publicar() {
    if (!previa || !motoristaId) return;
    setPublicando(true);
    setErro(null);
    try {
      const resultado = await publicarRota({
        pedidoIds: previa.paradas.map((p) => p.pedidoId),
        cdId,
        retornaAoCd,
        motoristaId,
      });
      setPublicada(resultado.rotaId);
      setPrevia(null);
      setSelecionados(new Set());
      carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha na publicação');
    } finally {
      setPublicando(false);
    }
  }

  return (
    <>
      <section className="cartao">
        <div className="cabecalho-secao">
          <h2>Acompanhamento do dia</h2>
          <button onClick={carregar}>Atualizar</button>
        </div>
        {rotas.length === 0 && <div className="vazio">Nenhuma rota publicada ainda.</div>}
        {rotas.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Rota</th>
                <th>Motorista</th>
                <th>Partida</th>
                <th>Progresso</th>
                <th>Avisados</th>
                <th>Insucessos</th>
                <th>km</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rotas.map((r) => {
                const entregues = r.paradas.filter((p) => p.status === 'entregue').length;
                const insucessos = r.paradas.filter((p) => p.status === 'insucesso').length;
                const avisados = r.paradas.filter((p) => p.avisadoEm).length;
                const s = ROTULO_ROTA[r.status] ?? { texto: r.status, classe: '' };
                const aberta = rotaAberta === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr
                      onClick={() => setRotaAberta(aberta ? null : r.id)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td className="mono">{r.id}</td>
                      <td>{nomeDoUsuario(r.motoristaId)}</td>
                      <td>{r.origemNome}</td>
                      <td className="mono">
                        {entregues + insucessos}/{r.paradas.length} {aberta ? '▲' : '▾'}
                      </td>
                      <td className="mono">
                        {avisados}/{r.paradas.length}
                      </td>
                      <td className="mono">{insucessos || '—'}</td>
                      <td className="mono">{r.distanciaTotalKm}</td>
                      <td>
                        <span className={`chip ${s.classe}`}>{s.texto}</span>
                      </td>
                      <td>
                        {/* Desfazer a publicação. Só faz sentido enquanto nada
                            foi executado — depois disso é histórico, e a API
                            recusa (o botão nem aparece). */}
                        {entregues + insucessos === 0 && (
                          <button
                            className="apagar"
                            title="Desfazer esta rota"
                            aria-label={`Desfazer a rota ${r.id}`}
                            onClick={(evento) => {
                              evento.stopPropagation();
                              void desfazerRota(r);
                            }}
                          >
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                    {aberta && (
                      <tr>
                        <td colSpan={9}>
                          {/* Parada a parada com o aviso ao cliente: diante de um
                              "ausente", saber se ele tinha sido avisado é o que
                              separa aprendizado de reclamação (seção 11.8). */}
                          <table className="paradas-rota">
                            <tbody>
                              {r.paradas.map((p, i) => {
                                const e = entregasDaRota[p.pedidoId];
                                // Onde ele estava ao confirmar, contra o pin do
                                // cliente. "Ausente" registrado a 3 km da porta
                                // conta uma história diferente de "ausente" no
                                // portão — e é a única forma de saber.
                                const distancia =
                                  e?.posicaoConfirmacao
                                    ? Math.round(distanciaEmMetros(e.posicaoConfirmacao, p.coordenada))
                                    : null;
                                return (
                                  <Fragment key={p.pedidoId}>
                                    <tr>
                                      <td className="mono">{String(i + 1).padStart(2, '0')}</td>
                                      <td>{p.nome}</td>
                                      <td>
                                        <span
                                          className={`chip ${p.status === 'entregue' ? 'pronto' : p.status === 'insucesso' ? '' : 'pendente'}`}
                                        >
                                          {ROTULO_PARADA[p.status] ?? p.status}
                                        </span>
                                      </td>
                                      <td className="mono">
                                        {p.avisadoEm ? `avisado ${horaDe(p.avisadoEm)}` : 'não avisado'}
                                      </td>
                                    </tr>
                                    {/* O detalhe da confirmação: o "por quê" que
                                        o escritório precisa para ligar ao
                                        cliente, e que a parada não guarda. */}
                                    {e && (
                                      <tr className="confirmacao">
                                        <td />
                                        <td colSpan={3}>
                                          <strong>{ROTULO_RESULTADO[e.resultado] ?? e.resultado}</strong>{' '}
                                          às {horaDe(e.confirmadaEm)}
                                          {distancia != null
                                            ? ` · confirmado a ${distancia} m do ponto do cliente`
                                            : ' · sem posição (GPS indisponível na hora)'}
                                        </td>
                                      </tr>
                                    )}
                                    {!e && carregandoEntregas && (
                                      <tr className="confirmacao">
                                        <td />
                                        <td colSpan={3}>carregando confirmação…</td>
                                      </tr>
                                    )}
                                  </Fragment>
                                );
                              })}
                            </tbody>
                          </table>
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

      <section className="cartao">
        <h2>Montagem de rota</h2>

        <div className="config-rota">
          {/* Nada selecionado: não há o que configurar nem de onde deduzir o
              CD. Mostrar a escolha aqui é pedir uma decisão que não serve para
              nada ainda — o operador escolhe os pedidos primeiro.
              Com seleção, o CD sai das notas (CNPJ do emitente) e não há
              decisão a tomar. O seletor só aparece quando o app NÃO SABE
              (nenhuma nota reconhecida) ou quando o operador pede para trocar —
              o dado real mostra que a filial que fatura nem sempre é o galpão
              de onde o caminhão sai. */}
          {selecionados.size === 0 ? (
            <div className="cd-definido-fonte">
              Selecione os pedidos abaixo — o CD de partida vem das notas.
            </div>
          ) : cdDasNotas && !trocandoCd ? (
            <div className="cd-definido">
              <div>
                Partida: <strong>{cds[cdDasNotas]?.nome ?? cdDasNotas}</strong>
              </div>
              <div className="cd-definido-fonte">definido pelas notas selecionadas</div>
              <button type="button" onClick={() => setTrocandoCd(true)}>
                trocar
              </button>
            </div>
          ) : (
            <fieldset>
              <legend>CD de partida{cdsSelecionados.length === 0 ? ' (nota não reconhecida)' : ''}</legend>
              {Object.entries(cds).map(([id, cd]) => (
                <label key={id} className="opcao">
                  <input
                    type="radio"
                    name="cd"
                    checked={cdId === id}
                    onChange={() => {
                      setCdId(id);
                      setPrevia(null);
                    }}
                  />
                  {cd.nome}
                </label>
              ))}
            </fieldset>
          )}
          <label className="opcao">
            <input
              type="checkbox"
              checked={retornaAoCd}
              onChange={(e) => {
                setRetornaAoCd(e.target.checked);
                setPrevia(null);
              }}
            />
            Retornar ao CD ao fim da rota
          </label>
        </div>

        {prontos.length === 0 && (
          <div className="vazio">
            Nenhum pedido pronto para rota — importe notas ou resolva os mapeamentos pendentes.
          </div>
        )}

        {prontos.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Selecionar todos os pedidos"
                    checked={todosProntosMarcados}
                    ref={(el) => {
                      if (el) el.indeterminate = algumProntoMarcado && !todosProntosMarcados;
                    }}
                    onChange={alternarTodos}
                  />
                </th>
                <th>Nota</th>
                <th>CD</th>
                <th>Cliente</th>
                <th>Vol · Peso</th>
              </tr>
            </thead>
            <tbody>
              {prontos.map((p) => (
                <tr key={p.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Selecionar nota ${p.numeroNota}`}
                      checked={selecionados.has(p.id)}
                      onChange={() => alternar(p.id)}
                    />
                  </td>
                  <td className="mono">
                    {p.numeroNota}/{p.serie}
                  </td>
                  <td>{p.cdId ? (cds[p.cdId]?.nome ?? p.cdId) : '—'}</td>
                  <td>
                    {clientes[p.clienteId]?.nome ?? `${p.clienteId.slice(0, 8)}…`}
                    {clientes[p.clienteId]?.statusMapeamento === 'aproximado' && (
                      <span className="chip pendente" style={{ marginLeft: 8 }}>
                        aprox · a mapear
                      </span>
                    )}
                  </td>
                  <td>
                    {formatarCarga(p.volumes, p.pesoBrutoKg)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {pendentes.length > 0 && (
          <div className="alerta">
            {pendentes.length} pedido(s) pendente(s) de mapeamento — fora da seleção até ganharem
            coordenada (painel de pendências ou primeira entrega em campo).
          </div>
        )}

        {misturaCds && (
          <div className="erro">
            A seleção mistura pedidos de CDs diferentes ({cdsSelecionados.join(', ')}). A mercadoria
            está em dois galpões e o motorista sai de um só — monte uma rota por CD.
          </div>
        )}
        {cdDasNotas && cdDasNotas !== cdId && (
          <div className="alerta">
            As notas selecionadas foram emitidas por <strong>{cds[cdDasNotas]?.nome ?? cdDasNotas}</strong>,
            mas a partida escolhida é <strong>{cds[cdId]?.nome ?? cdId}</strong>. Se a mercadoria sai
            mesmo daqui, siga — a nota diz quem faturou, não necessariamente de onde o caminhão parte.
          </div>
        )}

        <div className="acoes-rota">
          <button
            className="primaria"
            disabled={selecionados.size === 0 || !cdId || otimizando || misturaCds}
            onClick={() => void otimizar()}
          >
            {otimizando ? 'OTIMIZANDO…' : `OTIMIZAR ROTA (${selecionados.size})`}
          </button>
        </div>

        {erro && <div className="erro">{erro}</div>}
        {publicada && (
          <div className="sucesso">
            Rota <span className="mono">{publicada}</span> publicada — já visível no app do
            motorista.
          </div>
        )}
      </section>

      {previa && (
        <section className="cartao">
          <h2>Prévia — {previa.cd.nome}</h2>
          <div className="grade-relatorio">
            <div className="metrica">
              <div className="valor">{previa.paradas.length}</div>
              <div className="rotulo">Paradas</div>
            </div>
            <div className="metrica">
              <div className="valor">{previa.distanciaTotalKm}</div>
              <div className="rotulo">km totais</div>
            </div>
            <div className="metrica">
              <div className="valor">
                {Math.floor(previa.duracaoTotalMin / 60)}h{String(previa.duracaoTotalMin % 60).padStart(2, '0')}
              </div>
              <div className="rotulo">Duração estimada</div>
            </div>
            <div className="metrica">
              <div className="valor">{previa.retornaAoCd ? 'SIM' : 'NÃO'}</div>
              <div className="rotulo">Retorna ao CD</div>
            </div>
          </div>

          <MapaRota previa={previa} />

          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Cliente</th>
                <th>Endereço</th>
                <th>Vol · Peso</th>
                <th>Ordem</th>
              </tr>
            </thead>
            <tbody>
              {previa.paradas.map((p, i) => (
                <tr key={p.pedidoId}>
                  <td className="mono">{String(p.posicao).padStart(2, '0')}</td>
                  <td>{p.nome}</td>
                  <td>{p.endereco}</td>
                  <td>
                    {formatarCarga(p.volumes, p.pesoBrutoKg)}
                  </td>
                  <td>
                    <div className="reordenar">
                      <button
                        aria-label={`Subir ${p.nome}`}
                        disabled={i === 0 || otimizando}
                        onClick={() => void mover(i, -1)}
                      >
                        ▲
                      </button>
                      <button
                        aria-label={`Descer ${p.nome}`}
                        disabled={i === previa.paradas.length - 1 || otimizando}
                        onClick={() => void mover(i, 1)}
                      >
                        ▼
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="publicacao">
            <label className="opcao">
              Motorista:
              <select value={motoristaId} onChange={(e) => setMotoristaId(e.target.value)}>
                {usuarios
                  .filter((u) => u.ativo)
                  .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.nome} ({u.papel})
                  </option>
                ))}
              </select>
            </label>
            <button
              className="primaria"
              disabled={publicando || !motoristaId}
              onClick={() => void publicar()}
            >
              {publicando ? 'PUBLICANDO…' : 'PUBLICAR ROTA'}
            </button>
          </div>
        </section>
      )}
    </>
  );
}
