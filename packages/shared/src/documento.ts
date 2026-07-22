/**
 * Identidade de cliente por CPF/CNPJ (seção 7.1): o documento em claro nunca é
 * persistido no Firestore — vira hash SHA-256 (identidade) + máscara (exibição).
 */

const encoder = new TextEncoder();

/** clienteId = SHA-256 hex do documento (apenas dígitos). Web Crypto: funciona em Node 20+ e navegador. */
export async function clienteIdDeDocumento(documento: string): Promise<string> {
  const digitos = somenteDigitos(documento);
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(digitos));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Exibe só os 2 últimos dígitos: CPF vira `***.***.***-82`; CNPJ, o equivalente com barra. */
export function mascararDocumento(documento: string): string {
  const digitos = somenteDigitos(documento);
  const finais = digitos.slice(-2);
  if (digitos.length === 14) {
    return `**.***.***/****-${finais}`;
  }
  return `***.***.***-${finais}`;
}

export function somenteDigitos(valor: string): string {
  return valor.replace(/\D/g, '');
}
