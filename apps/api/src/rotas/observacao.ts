import { observacaoDaRota } from '@rota/shared';
import type { Repositorio } from '../db/repositorio.js';

export type ResultadoObservacao =
  | { ok: true; observacao: string | null }
  | { ok: false; status: number; erro: string };

/**
 * Troca a observação de uma rota já publicada — o campo do Acompanhamento do
 * dia, na hora de baixar o PDF de novo. Na transação da rota: o app do
 * motorista grava nas paradas ao mesmo tempo, e regravar o documento lido
 * antes desfaria a entrega que ele acabou de confirmar.
 */
export async function trocarObservacaoDaRota(
  repo: Repositorio,
  rotaId: string,
  corpo: unknown,
): Promise<ResultadoObservacao> {
  const v = observacaoDaRota((corpo as { observacao?: unknown } | null)?.observacao);
  if (!v.ok) return { ok: false, status: 400, erro: v.erro };
  const feito = await repo.transacaoNaRota(rotaId, async (rota) => {
    const { observacao: _antiga, ...resto } = rota;
    return {
      gravar: true,
      rota: v.observacao ? { ...resto, observacao: v.observacao } : resto,
      pedidos: {},
      resultado: v.observacao,
    };
  });
  if (!feito) return { ok: false, status: 404, erro: 'Rota não encontrada' };
  return { ok: true, observacao: feito.resultado };
}
