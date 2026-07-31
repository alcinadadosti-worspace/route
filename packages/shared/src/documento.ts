/**
 * Identidade de cliente por CPF/CNPJ (seção 7.1): o documento em claro nunca é
 * persistido no Firestore — vira hash (identidade) + máscara (exibição).
 *
 * COM pepper (segredo server-side, HMAC-SHA256): o id é determinístico (mesmo
 * CPF → mesmo id, dedup funciona) mas NÃO reversível — sem o segredo não dá
 * para força-brutar o CPF a partir do id. SEM pepper (dev/CI): SHA-256 puro,
 * que é reversível (~10⁹ CPFs) — não usar com dado real.
 */

const encoder = new TextEncoder();

/**
 * Número da nota e série extraídos da PRÓPRIA chave de acesso (44 dígitos):
 * cUF(2) AAMM(4) CNPJ(14) modelo(2) série(3) nNF(9) tpEmis(1) cNF(8) DV(1).
 * Existe para rotas publicadas ANTES de a parada carregar `numeroNota` — o
 * pedidoId é a chave, então o número sempre esteve lá dentro.
 * (Conferido contra nota real: ...55 001 000280683... → 280683/1.)
 */
export function notaDaChaveDeAcesso(
  chave: string,
): { numeroNota: number; serie: number } | null {
  if (!/^\d{44}$/.test(chave)) return null;
  return {
    serie: Number(chave.slice(22, 25)),
    numeroNota: Number(chave.slice(25, 34)),
  };
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** clienteId do documento (apenas dígitos). Web Crypto: Node 20+ e navegador. */
export async function clienteIdDeDocumento(documento: string, pepper?: string): Promise<string> {
  const digitos = somenteDigitos(documento);
  if (pepper) {
    const chave = await crypto.subtle.importKey(
      'raw',
      encoder.encode(pepper),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    return hex(await crypto.subtle.sign('HMAC', chave, encoder.encode(digitos)));
  }
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(digitos)));
}

/** Exibe só os 2 últimos dígitos: CPF vira `***.***.***-82`; CNPJ, o equivalente com barra. */
export function mascararDocumento(documento: string): string {
  const digitos = somenteDigitos(documento);
  const finais = digitos.slice(-2);
  if (digitos.length === 14) return `**.***.***/****-${finais}`;
  if (digitos.length === 11) return `***.***.***-${finais}`;
  // Documento fora do padrão CPF/CNPJ (dado malformado): não expõe dígitos nem
  // finge um formato — melhor um marcador neutro que uma máscara enganosa.
  return '***';
}

export function somenteDigitos(valor: string): string {
  return valor.replace(/\D/g, '');
}
