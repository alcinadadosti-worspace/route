import type { ItemPedido } from './tipos.js';

/**
 * Quantos PRODUTOS este pedido/parada leva.
 *
 * Existe porque as duas fontes de importação respondem isso de jeitos
 * diferentes, e contar errado é invisível:
 * - a NF-e traz a LISTA de itens, e "item" na fala da operação é a soma das
 *   quantidades (`qCom`), não a contagem de linhas — nas notas reais dá três
 *   vezes de diferença (8,3 linhas contra 24,1 unidades por nota);
 * - a planilha do ERP não traz lista nenhuma, só `QtdeMateriais`. Quem some
 *   `itens.length` num pedido dela lê ZERO — foi o que fez o relatório de
 *   produtividade dizer "0 itens entregues" num mês inteiro de entregas, e as
 *   telas do painel mostrarem "0 itens" com a caixa cheia.
 */
export function quantidadeDeItens(
  origem: { itens?: ItemPedido[] | null; quantidadeMateriais?: number | null },
): number {
  const lista = origem.itens ?? [];
  if (lista.length > 0) {
    return lista.reduce(
      (soma, item) => soma + (Number.isFinite(item?.quantidade) ? item.quantidade : 0),
      0,
    );
  }
  const daPlanilha = origem.quantidadeMateriais;
  return Number.isFinite(daPlanilha) && (daPlanilha as number) > 0 ? (daPlanilha as number) : 0;
}

/**
 * A fonte disse QUANTOS itens o pedido leva? O romaneio do Boticário não diz:
 * não traz lista nem quantidade, e o pedido dele chega com zero nos dois. Sem
 * esta pergunta, `quantidadeDeItens` devolve 0 e a porta da cliente mostrava
 * "0 itens · 1 vol", e a produtividade, "0 item(ns)" com o caminhão cheio.
 */
export function itensConhecidos(
  origem: { itens?: ItemPedido[] | null; quantidadeMateriais?: number | null },
): boolean {
  return quantidadeDeItens(origem) > 0;
}

/**
 * Quantos produtos DISTINTOS — `null` quando a fonte não permite saber (a
 * planilha do ERP manda só a quantidade; o romaneio, nem isso). Null e zero
 * dizem coisas diferentes: "não sei" não pode virar "nenhum" numa métrica que
 * o Admin Estoque lê.
 */
export function produtosDistintos(
  origem: { itens?: ItemPedido[] | null; quantidadeMateriais?: number | null },
): number | null {
  const lista = origem.itens ?? [];
  return lista.length > 0 ? lista.length : null;
}
