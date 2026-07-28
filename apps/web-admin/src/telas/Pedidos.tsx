import { useEffect, useState } from 'react';
import type { Pedido } from '@rota/shared';
import { listarPedidos } from '../api';

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

  useEffect(() => {
    listarPedidos()
      .then(setPedidos)
      .catch((e) => setErro(e instanceof Error ? e.message : 'Falha ao listar'));
  }, []);

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
                    {p.volumes} vol · {p.pesoBrutoKg.toFixed(3)} kg
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
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
