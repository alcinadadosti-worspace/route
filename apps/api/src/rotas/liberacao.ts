import {
  devolverParaForaDaMontagem,
  liberarParaRota,
  type Cliente,
  type Pedido,
  type StatusPedido,
} from '@rota/shared';
import type { Repositorio } from '../db/repositorio.js';

/**
 * Liberação em lote do que ficou fora da montagem pelo ERP (retirada, ou
 * "entregue" segundo ele) — e o caminho de volta. A regra de cada pedido é
 * pura (`liberacao.ts` no shared); aqui só se lê e grava em lote.
 *
 * Lote, e não um por um: o Admin Estoque marca dezenas de uma vez na lista, e
 * um `get`/`set` por pedido com ~130 ms cada (medido em produção) passaria do
 * tempo do proxy do Render.
 */

export type AcaoLiberacao = 'liberar' | 'devolver';

export type ResultadoLiberacaoLote =
  | {
      ok: true;
      alterados: Array<{ id: string; status: StatusPedido }>;
      recusados: Array<{ id: string; motivo: string }>;
    }
  | { ok: false; status: number; erro: string };

/** Teto por chamada: uma lista inteira de ciclo cabe folgada. */
const MAXIMO = 2000;

export async function alterarLiberacao(
  repo: Repositorio,
  pedidoIds: unknown,
  acao: unknown,
  quem: string,
  agora: Date = new Date(),
): Promise<ResultadoLiberacaoLote> {
  if (acao !== 'liberar' && acao !== 'devolver') {
    return { ok: false, status: 400, erro: 'Ação inválida (liberar ou devolver)' };
  }
  if (!Array.isArray(pedidoIds) || pedidoIds.length === 0) {
    return { ok: false, status: 400, erro: 'Selecione ao menos um pedido' };
  }
  if (pedidoIds.length > MAXIMO) {
    return { ok: false, status: 400, erro: `No máximo ${MAXIMO} pedidos por vez` };
  }
  // O id vira caminho de documento: barra apontaria para outra coleção.
  if (pedidoIds.some((id) => typeof id !== 'string' || id === '' || id.includes('/'))) {
    return { ok: false, status: 400, erro: 'Pedido inválido na lista' };
  }
  const ids = [...new Set(pedidoIds as string[])];

  const pedidos = await repo.pedidosPorIds(ids);
  const clientes =
    acao === 'liberar'
      ? new Map(
          (await repo.clientesPorIds([...new Set(pedidos.map((p) => p.clienteId))])).map((c) => [c.id, c]),
        )
      : new Map();

  const encontrados = new Set(pedidos.map((p) => p.id));
  const recusados = ids.filter((id) => !encontrados.has(id)).map((id) => ({ id, motivo: 'não encontrado' }));
  const alteracoes: Array<{ id: string; statusEsperado: StatusPedido; dados: Pedido }> = [];
  const pontos = new Map<string, Partial<Cliente>>();
  const marca = { em: agora.toISOString(), por: quem };

  for (const { id, ...pedido } of pedidos) {
    const cliente = clientes.get(pedido.clienteId) ?? null;
    const r =
      acao === 'liberar'
        ? // O ponto que outra retirada do MESMO cliente acabou de trazer vale
          // para esta também: duas notas, um lugar.
          liberarParaRota(
            pedido,
            cliente && pontos.has(pedido.clienteId) ? { ...cliente, ...pontos.get(pedido.clienteId) } : cliente,
            marca,
          )
        : devolverParaForaDaMontagem(pedido);
    if (!r.ok) {
      recusados.push({ id, motivo: `Pedido ${pedido.numeroNota} ${r.motivo}` });
      continue;
    }
    if (r.pontoDoCliente) {
      pontos.set(pedido.clienteId, { coordenada: r.pontoDoCliente, statusMapeamento: 'geocodificado' });
    }
    alteracoes.push({ id, statusEsperado: pedido.status, dados: r.pedido });
  }

  // O ponto do cadastro vai ANTES do pedido: pedido pronto com cliente sem
  // coordenada seria recusado pela montagem; cliente com ponto e pedido que
  // não chegou a mudar não faz mal nenhum — o GPS é do próprio cadastro.
  await repo.gravarEmLote(
    [...pontos].map(([id, dados]) => ({ colecao: 'clientes' as const, id, dados, merge: true })),
  );
  // Só grava o pedido que não mudou desde a leitura: devolver por cima de uma
  // publicação deixava o pedido "retirada" com a rota ainda o levando, e
  // liberar por cima do apagar de um cancelado o recriava pronto para sempre.
  const conflitos = new Set(await repo.atualizarPedidosSeStatus(alteracoes));
  const alterados: Array<{ id: string; status: StatusPedido }> = [];
  for (const a of alteracoes) {
    if (conflitos.has(a.id)) {
      recusados.push({
        id: a.id,
        motivo: `Pedido ${a.dados.numeroNota} mudou enquanto era gravado (publicado, apagado ou alterado noutra tela) — atualize`,
      });
    } else {
      alterados.push({ id: a.id, status: a.dados.status });
    }
  }
  return { ok: true, alterados, recusados };
}
