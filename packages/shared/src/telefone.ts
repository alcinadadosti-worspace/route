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

/**
 * Telefone que o motorista vê numa parada. O da parada foi copiado do cliente
 * na PUBLICAÇÃO e congela ali; o cliente que veio de um romaneio sem estar na
 * base nasce sem telefone, e o Admin Estoque costuma completar depois — com a
 * rota já no celular. Por isso o do cliente (lido ao vivo) manda, como o ponto
 * confirmado em campo vem antes da coordenada da publicação.
 *
 * `doCliente` undefined = o doc do cliente não chegou (offline): vale o da
 * parada. null = chegou SEM telefone — e aí fica sem: a importação nunca apaga
 * telefone, então só o Admin chega a esse null, corrigindo um número errado
 * (a homônima escolhida por engano). Cair no da parada devolvia ao motorista o
 * telefone da outra pessoa.
 */
export function telefoneDaParada(
  daParada: string | null | undefined,
  doCliente: string | null | undefined,
): string | null {
  return doCliente !== undefined ? doCliente || null : daParada || null;
}

/** Celular brasileiro (E.164): DDD + 9 + 8 dígitos. O WhatsApp é nele. */
export function ehCelular(telefone: string | null | undefined): boolean {
  return !!telefone && /^\+55\d{2}9\d{8}$/.test(telefone);
}

/** `+5582999990000` → `(82) 99999-0000`. O que não reconhece passa como veio. */
export function telefoneLegivel(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const m = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/**
 * Link de contato em um toque (RF-19). `wa.me` exige dígitos sem `+`.
 *
 * Com `mensagem`, abre a conversa com o texto já escrito — o motorista revisa
 * e envia. O WhatsApp NÃO permite envio automático por link, de propósito
 * (trava anti-spam): envio sem toque só pela API oficial da Meta, que é paga.
 */
export function linkWhatsApp(telefoneE164: string, mensagem?: string): string {
  const numero = telefoneE164.replace(/\D/g, '');
  return `https://wa.me/${numero}${mensagem ? `?text=${encodeURIComponent(mensagem)}` : ''}`;
}

export function linkLigacao(telefoneE164: string): string {
  return `tel:${telefoneE164}`;
}
