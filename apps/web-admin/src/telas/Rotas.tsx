import { useEffect, useMemo, useState } from 'react';
import type { CentroDistribuicao, Pedido, PreviaRota, Rota, Usuario } from '@rota/shared';
import {
  listarCds,
  listarPedidos,
  listarRotas,
  listarUsuarios,
  previaDeRota,
  publicarRota,
} from '../api';
import { MapaRota } from '../MapaRota';

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
  const [cds, setCds] = useState<Record<string, CentroDistribuicao>>({});
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [cdId, setCdId] = useState<string>('');
  const [retornaAoCd, setRetornaAoCd] = useState(true);
  const [previa, setPrevia] = useState<PreviaRota | null>(null);
  const [otimizando, setOtimizando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [usuarios, setUsuarios] = useState<Array<{ id: string } & Usuario>>([]);
  const [motoristaId, setMotoristaId] = useState('');
  const [publicando, setPublicando] = useState(false);
  const [publicada, setPublicada] = useState<string | null>(null);
  const [rotas, setRotas] = useState<Array<{ id: string } & Rota>>([]);

  function carregar() {
    Promise.all([listarPedidos(), listarCds(), listarUsuarios(), listarRotas()])
      .then(([ps, c, us, rs]) => {
        setPedidos(ps);
        setCds(c);
        setCdId((atual) => atual || (Object.keys(c)[0] ?? ''));
        const ativos = us.filter((u) => u.ativo);
        setUsuarios(ativos);
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

  function alternar(id: string) {
    const proximo = new Set(selecionados);
    if (proximo.has(id)) proximo.delete(id);
    else proximo.add(id);
    setSelecionados(proximo);
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
                <th>Insucessos</th>
                <th>km</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rotas.map((r) => {
                const entregues = r.paradas.filter((p) => p.status === 'entregue').length;
                const insucessos = r.paradas.filter((p) => p.status === 'insucesso').length;
                const s = ROTULO_ROTA[r.status] ?? { texto: r.status, classe: '' };
                return (
                  <tr key={r.id}>
                    <td className="mono">{r.id}</td>
                    <td>{nomeDoUsuario(r.motoristaId)}</td>
                    <td>{r.origemNome}</td>
                    <td className="mono">
                      {entregues + insucessos}/{r.paradas.length}
                    </td>
                    <td className="mono">{insucessos || '—'}</td>
                    <td className="mono">{r.distanciaTotalKm}</td>
                    <td>
                      <span className={`chip ${s.classe}`}>{s.texto}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="cartao">
        <h2>Montagem de rota</h2>

        <div className="config-rota">
          <fieldset>
            <legend>CD de partida</legend>
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
                <th></th>
                <th>Nota</th>
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
                  <td>{p.clienteId.slice(0, 8)}…</td>
                  <td>
                    {p.volumes} vol · {p.pesoBrutoKg.toFixed(3)} kg
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

        <div className="acoes-rota">
          <button
            className="primaria"
            disabled={selecionados.size === 0 || !cdId || otimizando}
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
                    {p.volumes} vol · {p.pesoBrutoKg.toFixed(3)} kg
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
                {usuarios.map((u) => (
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
