import { useEffect, useState } from 'react';
import { formatarCarga, type Pedido } from '@rota/shared';
import { apagarPedido, listarPedidos } from '../api';

/**
 * Só o que ainda não foi executado em campo pode ser apagado (a API confere
 * também). Pedido `em_rota` PODE: a parada sai da rota junto.
 */
const APAGAVEIS = new Set([
  'importado',
  'pendente_de_mapeamento',
  'pendente_de_decisao',
  'pronto_para_rota',
  'em_rota',
]);

const ROTULO_STATUS: Record<string, { texto: string; classe: string }> = {
  pendente_de_mapeamento: { texto: 'Pendente de mapeamento', classe: 'pendente' },
  pendente_de_decisao: { texto: 'Aguardando escolha de endereço', classe: 'pendente' },
  pronto_para_rota: { texto: 'Pronto para rota', classe: 'pronto' },
  importado: { texto: 'Importado', classe: '' },
  em_rota: { texto: 'Em rota', classe: '' },
  entregue: { texto: 'Entregue', classe: 'pronto' },
  insucesso: { texto: 'Insucesso', classe: '' },
};

export function Pedidos() {
  const [pedidos, setPedidos] = useState<Array<{ id: string } & Pedido>>([]);
  const [filtro, setFiltro] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => {
    listarPedidos()
      .then(setPedidos)
      .catch((e) => setErro(e instanceof Error ? e.message : 'Falha ao listar'));
  }, []);

  async function apagar(p: { id: string } & Pedido) {
    // Some da tela para sempre: vale um passo de confirmação com o número da
    // nota, para não apagar a linha de baixo por engano. Em rota, o aviso diz
    // que a parada sai do celular do motorista — é a consequência que importa.
    const aviso =
      p.status === 'em_rota'
        ? `Apagar a nota ${p.numeroNota}/${p.serie}?\n\nEla está numa rota publicada: a parada sai da rota e desaparece do app do motorista. O traçado e a quilometragem da rota continuam os antigos.`
        : `Apagar a nota ${p.numeroNota}/${p.serie}? A importação dela é desfeita.`;
    if (!window.confirm(aviso)) return;
    setErro(null);
    try {
      const { rotaApagada } = await apagarPedido(p.id);
      setPedidos((atual) => atual.filter((outro) => outro.id !== p.id));
      if (rotaApagada) setAviso(`Era a última parada: a rota ${rotaApagada} também foi apagada.`);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao apagar');
    }
  }

  const q = filtro.trim();
  const filtrados = q
    ? pedidos.filter(
        (p) =>
          String(p.numeroNota).includes(q) ||
          (p.numeroPedido ?? '').includes(q) ||
          (p.lote ?? '').includes(q),
      )
    : pedidos;

  return (
    <section className="cartao">
      <h2>Pedidos</h2>
      {pedidos.length > 0 && (
        <input
          type="search"
          className="filtro"
          placeholder="Filtrar por nº da nota, pedido ou lote…"
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
        />
      )}
      {erro && <div className="erro">{erro}</div>}
      {aviso && <div className="alerta">{aviso}</div>}
      {!erro && pedidos.length === 0 && (
        <div className="vazio">Nenhum pedido importado ainda. Comece pela aba Importação.</div>
      )}
      {pedidos.length > 0 && filtrados.length === 0 && (
        <div className="vazio">Nenhum pedido bate com “{filtro}”.</div>
      )}
      {filtrados.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Nota</th>
              <th>Pedido / Lote</th>
              <th>Emitida em</th>
              <th>Itens</th>
              <th>Vol · Peso</th>
              <th>Valor</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtrados.map((p) => {
              const s = ROTULO_STATUS[p.status] ?? { texto: p.status, classe: '' };
              return (
                <tr key={p.id}>
                  <td className="mono">
                    {p.numeroNota}/{p.serie}
                  </td>
                  <td className="mono">
                    {p.numeroPedido ?? '—'} · {p.lote ?? '—'}
                  </td>
                  <td>{p.emitidoEm.slice(0, 10)}</td>
                  <td>{p.itens.length}</td>
                  <td>
                    {formatarCarga(p.volumes, p.pesoBrutoKg)}
                  </td>
                  <td className="mono">
                    {p.valorTotal.toLocaleString('pt-BR', {
                      style: 'currency',
                      currency: 'BRL',
                    })}
                  </td>
                  <td>
                    <span className={`chip ${s.classe}`}>{s.texto}</span>
                  </td>
                  <td>
                    {APAGAVEIS.has(p.status) && (
                      <button
                        className="apagar"
                        title={`Apagar a nota ${p.numeroNota}`}
                        aria-label={`Apagar a nota ${p.numeroNota}`}
                        onClick={() => void apagar(p)}
                      >
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
