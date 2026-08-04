import type { Pedido } from './tipos.js';

/**
 * Retirada no balcão × entrega na rota.
 *
 * Metade das notas do dia nunca entra no caminhão: a revendedora vem ao CD,
 * paga e leva. Nada na NF-e diz isso com todas as letras — o campo que mais se
 * aproxima é `transp/modFrete`, que é fiscal ("quem paga o frete"), não
 * logístico. Mas a evidência é forte: das 318 notas que o Admin Estoque separou
 * como retirada, **as 318 são `modFrete='9'`**, e nenhuma das 1686 notas
 * `'1'` da base sequer se parece com elas (todas têm caixa embalada e lote de
 * remessa, sem uma exceção).
 *
 * Por isso o `modFrete` SUGERE e o Admin Estoque DECIDE. Importar já classificando
 * seria decidir no lugar de quem sabe, e o erro é invisível: o pedido
 * simplesmente não sairia, e ninguém saberia por quê.
 */

/**
 * O que propor na aba Decisões. `null` quando a nota não traz `modFrete`
 * (pedido importado antes deste campo) — aí a pergunta vai sem palpite.
 */
export function sugerirModoEntrega(
  modFrete: Pedido['modFrete'],
): 'rota' | 'retirada' | null {
  if (modFrete === '9') return 'retirada';
  if (modFrete === '1') return 'rota';
  return null;
}

/**
 * A regra erra num sentido só, e é este: nota `'9'` que MESMO ASSIM tem lote de
 * remessa — o ERP agrupou aquela mercadoria num carregamento. São 39% das `'9'`
 * na base real (685 notas, 160 delas para outra cidade). Se o palpite
 * "retirada" estiver errado, está aqui dentro.
 *
 * A tela destaca essas para o Admin Estoque olhar uma a uma em vez de confirmar
 * junto com o resto. Se o aviso nunca acender em campo, o assunto morre; se
 * acender sempre, o sinal certo era o LOTE e não o `modFrete`.
 */
export function retiradaDuvidosa(pedido: Pick<Pedido, 'modFrete' | 'lote'>): boolean {
  return pedido.modFrete === '9' && Boolean(pedido.lote);
}

/**
 * A pergunta "rota ou retirada?" ainda está em aberto nesta nota?
 *
 * Existe como função porque TRÊS lugares promovem pedido para
 * `pronto_para_rota` — as duas decisões de endereço e a liberação em lote de
 * um cliente que saiu de revisão. Sem consultar isto, responder a pergunta do
 * endereço soltaria para a rota uma nota que ninguém confirmou que sai.
 *
 * Só há pergunta quando a sugestão é RETIRADA: `modFrete='1'` (e nota sem
 * `modFrete`, importada antes do campo) segue direto, como sempre seguiu.
 */
export function aguardandoEscolhaDeModo(
  pedido: Pick<Pedido, 'modoEntrega' | 'modFrete'>,
): boolean {
  return pedido.modoEntrega === undefined && sugerirModoEntrega(pedido.modFrete) === 'retirada';
}
