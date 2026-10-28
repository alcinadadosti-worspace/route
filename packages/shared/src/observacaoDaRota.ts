/**
 * Observação da rota: o recado do Admin Estoque ao motorista que sai no RODAPÉ
 * de toda página do PDF (pedido do usuário). Mora na rota, não no PDF: baixar
 * de novo no Acompanhamento do dia imprime o mesmo recado, e trocá-lo ali vale
 * para as próximas impressões.
 *
 * O teto é o que cabe no pé da página sem comer a lista de paradas: ~3 linhas.
 */
export const MAX_OBSERVACAO_ROTA = 300;

export type ResultadoObservacao = { ok: true; observacao: string | null } | { ok: false; erro: string };

export function observacaoDaRota(valor: unknown): ResultadoObservacao {
  if (valor === undefined || valor === null) return { ok: true, observacao: null };
  if (typeof valor !== 'string') return { ok: false, erro: 'Observação inválida.' };
  // Quebra de linha vira espaço: o rodapé é uma faixa corrida no papel.
  const texto = valor.replace(/\s+/g, ' ').trim();
  if (texto.length > MAX_OBSERVACAO_ROTA) {
    return { ok: false, erro: `A observação tem ${texto.length} caracteres — o máximo é ${MAX_OBSERVACAO_ROTA}.` };
  }
  return { ok: true, observacao: texto || null };
}
