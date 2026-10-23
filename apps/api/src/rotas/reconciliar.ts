import type { Entrega, Pedido, Rota } from '@rota/shared';
import { FORMATO_ROTA_ID } from './comum.js';
import type { Repositorio } from '../db/repositorio.js';

/**
 * Aplica à rota as confirmações que o app registrou em `entregas` mas que não
 * entraram no array de paradas.
 *
 * Acontece de verdade: o app grava o array `paradas` INTEIRO a partir do cache
 * do celular, e as rules exigem o mesmo nº de paradas do servidor. Se o
 * escritório tirou um pedido da rota (cancelado no ERP, apagado) enquanto o
 * motorista estava sem sinal, todas as confirmações daquela janela são
 * recusadas em bloco ao voltar a rede — a parada volta a "a entregar" no
 * celular e no painel, sem aviso nenhum. O registro de entrega, que é um doc
 * próprio e imutável, é aceito: ele é a verdade, e daqui ele volta para a rota.
 *
 * Só mexe em parada ainda `em_rota`: o que já tem resultado (pelo app ou pela
 * baixa do painel) é histórico e não é reescrito.
 */
export async function reconciliarComEntregas(
  repo: Repositorio,
  rotaId: string,
): Promise<{ ok: true; aplicadas: number } | { ok: false; status: number; erro: string }> {
  if (!FORMATO_ROTA_ID.test(rotaId ?? '')) return { ok: false, status: 404, erro: 'Rota não encontrada' };
  const entregas = await repo.listarEntregasDaRota(rotaId);
  if (entregas.length === 0) return { ok: true, aplicadas: 0 };
  // A mais recente por pedido — a coleção admite duplicata (id automático).
  const ultima = new Map<string, Entrega>();
  for (const e of [...entregas].sort((a, b) => a.confirmadaEm.localeCompare(b.confirmadaEm))) {
    ultima.set(e.pedidoId, e);
  }

  const r = await repo.transacaoNaRota<number>(rotaId, async (rota, ler) => {
    const aplicar = rota.paradas.filter((p) => p.status === 'em_rota' && ultima.has(p.pedidoId));
    if (aplicar.length === 0) return { gravar: false, resultado: 0 };
    const lidos = await Promise.all(aplicar.map((p) => ler.pedido(p.pedidoId)));

    const pedidos: Record<string, Partial<Pedido>> = {};
    const resolvidos = new Map<string, 'entregue' | 'insucesso'>();
    aplicar.forEach((p, i) => {
      const e = ultima.get(p.pedidoId)!;
      const status = e.resultado === 'entregue' ? 'entregue' : 'insucesso';
      resolvidos.set(p.pedidoId, status);
      const pedido = lidos[i];
      // O pedido também, se ainda é desta rota (o lote do app caiu junto).
      if (pedido && pedido.status === 'em_rota' && pedido.rotaId === rotaId) pedidos[p.pedidoId] = { status };
    });

    const paradas = rota.paradas.map((p) => {
      const status = resolvidos.get(p.pedidoId);
      if (!status) return p;
      const e = ultima.get(p.pedidoId)!;
      return { ...p, status, confirmadaEm: e.confirmadaEm, recebidoPor: e.recebidoPor ?? p.recebidoPor ?? null };
    });
    const todas = [...paradas, ...(rota.excecoes ?? [])];
    const acabou = todas.every((p) => p.status === 'entregue' || p.status === 'insucesso');
    const nova: Rota = {
      ...rota,
      paradas,
      status: rota.status === 'concluida' || acabou ? 'concluida' : 'em_execucao',
      concluidaEm: rota.concluidaEm ?? (acabou ? new Date().toISOString() : null),
    };
    return { gravar: true, rota: nova, pedidos, resultado: aplicar.length };
  });
  return { ok: true, aplicadas: r?.resultado ?? 0 };
}
