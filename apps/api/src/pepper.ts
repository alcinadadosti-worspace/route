import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * Pepper do clienteId (HMAC do CPF — ver packages/shared/documento.ts).
 * Ordem de resolução:
 *   1. CLIENTE_ID_PEPPER explícito — recomendado quando se quer o segredo
 *      desacoplado da chave do service account;
 *   2. derivado do service account já configurado (FIREBASE_SERVICE_ACCOUNT
 *      ou GOOGLE_APPLICATION_CREDENTIALS) — segredo estável e nunca no bundle,
 *      então a proteção do CPF funciona SEM env var nova, só com o deploy.
 *   3. nenhum dos dois (dev/CI sem credenciais): undefined → SHA-256 puro,
 *      reversível, aceitável só para dado de teste.
 *
 * ATENÇÃO: rotacionar a chave do service account muda o pepper derivado e
 * quebra o dedup por cliente (mesmo CPF viraria um id novo). Se um dia
 * rotacionar a chave, fixe CLIENTE_ID_PEPPER com o valor antigo antes.
 */
let memo: string | null | undefined;

export function pepperClienteId(): string | undefined {
  const explicito = process.env.CLIENTE_ID_PEPPER;
  if (explicito) return explicito;
  if (memo === undefined) memo = derivarDoServiceAccount();
  return memo ?? undefined;
}

/** Fonte do pepper derivado (para o log de subida distinguir a origem). */
export function origemDoPepper(): 'explicito' | 'derivado' | 'ausente' {
  if (process.env.CLIENTE_ID_PEPPER) return 'explicito';
  if (memo === undefined) memo = derivarDoServiceAccount();
  return memo ? 'derivado' : 'ausente';
}

function derivarDoServiceAccount(): string | null {
  const conteudo = process.env.FIREBASE_SERVICE_ACCOUNT;
  const caminho = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!conteudo && !caminho) return null;
  try {
    const sa = JSON.parse(conteudo ?? readFileSync(caminho!, 'utf8'));
    const segredo: unknown = sa.private_key ?? sa.private_key_id;
    if (typeof segredo !== 'string' || !segredo) return null;
    return createHash('sha256').update(`rota-cliente-id::${segredo}`).digest('hex');
  } catch {
    return null;
  }
}
