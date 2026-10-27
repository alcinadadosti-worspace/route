/**
 * Formato do rotaId gerado na publicação (`AAAA-MM-DD_` + 8 hex do uuid).
 * Validar antes de consultar não é purismo: o rotaId vira caminho de documento
 * no Firestore, onde '/' separa níveis — a mesma injeção de caminho já fechada
 * na publicação (o campo `data`).
 */
export const FORMATO_ROTA_ID = /^\d{4}-\d{2}-\d{2}_[0-9a-f]{8}$/;

/**
 * Código do pedido como a PLANILHA do ERP e o ROMANEIO o escrevem: dígitos
 * ("530000001") e, no pedido do site, com sufixo ("160000001-1").
 */
export const FORMATO_CODIGO_PEDIDO = /^\d{1,20}(-\d{1,4})?$/;

/**
 * Id de documento de pedido: esse código, ou a chave de acesso da NF-e (44
 * dígitos, era XML). Uma regra só para a importação e para as rotas HTTP: a
 * importação passou a aceitar o pedido do site com hífen e as rotas, que
 * exigiam `\d{9}|\d{44}`, respondiam 404 — o pedido não se apagava nem saía
 * da aba Decisões.
 */
export const FORMATO_PEDIDO_ID = /^(\d{1,20}(-\d{1,4})?|\d{44})$/;
