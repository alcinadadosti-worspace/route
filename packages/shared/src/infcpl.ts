/**
 * Extração de número do pedido e lote a partir de `infAdic/infCpl` (seção 8.2).
 * O layout desse texto é definido pelo ERP emissor e pode mudar sem aviso:
 * regex tolerante + campo editável no painel quando nada casar (RF-02).
 */

const RE_PEDIDO = /PEDIDO\s*[:#]?\s*(\d+)/i;
const RE_LOTE = /LOTE\s*[:#]?\s*(\d+)/i;

export interface PedidoELote {
  numeroPedido: string | null;
  lote: string | null;
}

export function extrairPedidoELote(infCpl: string | null | undefined): PedidoELote {
  if (!infCpl) return { numeroPedido: null, lote: null };
  // Tolerância a asteriscos decorativos e espaçamento irregular.
  const texto = infCpl.replace(/\*/g, ' ').replace(/\s+/g, ' ');
  return {
    numeroPedido: RE_PEDIDO.exec(texto)?.[1] ?? null,
    lote: RE_LOTE.exec(texto)?.[1] ?? null,
  };
}
