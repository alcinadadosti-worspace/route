import { useEffect, useMemo, useState } from 'react';
import type { CentroDistribuicao, Pedido, PreviaRota } from '@rota/shared';
import { listarCds, listarPedidos, previaDeRota } from '../api';
import { MapaRota } from '../MapaRota';

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

  useEffect(() => {
    Promise.all([listarPedidos(), listarCds()])
      .then(([ps, c]) => {
        setPedidos(ps);
        setCds(c);
        setCdId(Object.keys(c)[0] ?? '');
      })
      .catch((e) => setErro(e instanceof Error ? e.message : 'Falha ao carregar'));
  }, []);

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
    try {
      setPrevia(await previaDeRota({ pedidoIds: [...selecionados], cdId, retornaAoCd }));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha na otimização');
    } finally {
      setOtimizando(false);
    }
  }

  return (
    <>
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
              </tr>
            </thead>
            <tbody>
              {previa.paradas.map((p) => (
                <tr key={p.pedidoId}>
                  <td className="mono">{String(p.posicao).padStart(2, '0')}</td>
                  <td>{p.nome}</td>
                  <td>{p.endereco}</td>
                  <td>
                    {p.volumes} vol · {p.pesoBrutoKg.toFixed(3)} kg
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
