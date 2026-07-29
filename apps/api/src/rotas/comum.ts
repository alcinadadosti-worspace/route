/**
 * Formato do rotaId gerado na publicação (`AAAA-MM-DD_` + 8 hex do uuid).
 * Validar antes de consultar não é purismo: o rotaId vira caminho de documento
 * no Firestore, onde '/' separa níveis — a mesma injeção de caminho já fechada
 * na publicação (o campo `data`).
 */
export const FORMATO_ROTA_ID = /^\d{4}-\d{2}-\d{2}_[0-9a-f]{8}$/;
