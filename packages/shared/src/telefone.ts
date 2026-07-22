import { somenteDigitos } from './documento.js';

/**
 * Normaliza o fone da NF-e para E.164 (`+5582...`) — seção 7.1.
 * O campo `fone` vem sem padrão (com/sem DDI, com/sem zeros à esquerda).
 */
export function normalizarTelefone(fone: string | null | undefined): string | null {
  if (!fone) return null;
  let digitos = somenteDigitos(fone).replace(/^0+/, '');
  if (digitos.length < 10) return null; // sem DDD não há como discar com segurança
  if (digitos.startsWith('55') && (digitos.length === 12 || digitos.length === 13)) {
    return `+${digitos}`;
  }
  if (digitos.length === 10 || digitos.length === 11) {
    return `+55${digitos}`;
  }
  return null;
}

/** Link de contato em um toque (RF-19). wa.me exige dígitos sem `+`. */
export function linkWhatsApp(telefoneE164: string): string {
  return `https://wa.me/${telefoneE164.replace(/\D/g, '')}`;
}

export function linkLigacao(telefoneE164: string): string {
  return `tel:${telefoneE164}`;
}
