/**
 * Pedido DIGITADO à mão na Importação: as colunas do romaneio do Boticário,
 * na ordem da folha, mais o CD (que na folha vem pelo motorista). Pedido do
 * usuário: "pedir apenas o que tem no romaneio" — o Admin copia a linha da
 * folha (a que o PDF não trouxe, ou a que veio em papel), e o pedido segue
 * pelo MESMO caminho do romaneio: casa com a base, repetido é ignorado,
 * endereço mudado em cliente com ponto vai para Decisões.
 *
 * A mesma regra roda no painel (erro em cada campo antes de enviar) e na API
 * (que não confia no painel).
 */
export interface PedidoDigitado {
  cdId: string;
  /** "NF do pedido". */
  notaFiscal: string;
  cep: string;
  /** "Nome do destinatário". */
  nome: string;
  /** "Pedido Entrega": o código do ERP, ou o do site com o traço. */
  pedido: string;
  bairro: string;
  cidade: string;
  /** "Endereço" como a folha imprime: "RUA, NÚMERO, COMPLEMENTO-REFERÊNCIA". */
  endereco: string;
}

export type CampoDoPedidoDigitado = keyof PedidoDigitado;

/** O pedido validado, no formato de uma linha do romaneio. */
export interface PedidoDigitadoValido {
  cdId: string;
  notaFiscal: number;
  /** Só dígitos; vazio quando não foi informado. */
  cep: string;
  nome: string;
  pedido: string;
  bairro: string;
  cidade: string;
  uf: string;
  endereco: string;
}

export type ResultadoPedidoDigitado =
  | { ok: true; pedido: PedidoDigitadoValido }
  | { ok: false; erros: Partial<Record<CampoDoPedidoDigitado, string>> };

/** O mesmo teste da leitura do PDF (`PEDIDO_DA_FOLHA`): 6–12 dígitos, ou o do
 * site com sufixo ("160000001-1"). */
const PEDIDO = /^\d{6,12}(-\d{1,4})?$/;

/** Espaços colapsados e caixa alta — como a base e a maior parte das folhas. */
function limpo(valor: unknown, maximo: number): string {
  return String(valor ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .slice(0, maximo);
}

export function validarPedidoDigitado(corpo: unknown): ResultadoPedidoDigitado {
  const c = (corpo && typeof corpo === 'object' ? corpo : {}) as Record<string, unknown>;
  const erros: Partial<Record<CampoDoPedidoDigitado, string>> = {};

  const cdId = String(c.cdId ?? '').trim();
  if (!cdId) erros.cdId = 'Escolha o CD.';

  const nf = String(c.notaFiscal ?? '').replace(/[\s.]/g, '');
  if (!/^\d{1,9}$/.test(nf) || Number(nf) === 0) erros.notaFiscal = 'Número da NF, só dígitos.';

  // O CEP é opcional: o pedido entra sem ele. Escrito errado, não.
  const cep = String(c.cep ?? '').replace(/[\s.-]/g, '');
  if (cep && !/^\d{8}$/.test(cep)) erros.cep = 'CEP com 8 dígitos (ou deixe em branco).';

  const nome = limpo(c.nome, 100);
  if (!/\p{L}.*\p{L}.*\p{L}/u.test(nome)) erros.nome = 'Nome do destinatário.';
  // CPF ou e-mail no nome: a base já trouxe isso uma vez, e o nome vai para a
  // tela do motorista e para a mensagem ao cliente.
  else if (/@|\d{3}\.?\d{3}\.?\d{3}-?\d{2}/.test(nome)) erros.nome = 'Só o nome — sem CPF nem e-mail.';

  const pedido = String(c.pedido ?? '').replace(/\s/g, '');
  if (!PEDIDO.test(pedido)) erros.pedido = 'Código do pedido (ex.: 537733613), ou o do site com o traço (160000001-1).';

  const bairro = limpo(c.bairro, 80);
  if (!bairro) erros.bairro = 'Bairro (ou o povoado).';

  const cidade = limpo(c.cidade, 60);
  if (!/\p{L}{3}/u.test(cidade)) erros.cidade = 'Cidade.';

  const endereco = limpo(c.endereco, 250);
  if (!/\p{L}{2}/u.test(endereco)) erros.endereco = 'Endereço como na folha: RUA, NÚMERO, COMPLEMENTO-REFERÊNCIA.';

  if (Object.keys(erros).length > 0) return { ok: false, erros };
  return {
    ok: true,
    pedido: { cdId, notaFiscal: Number(nf), cep, nome, pedido, bairro, cidade, uf: 'AL', endereco },
  };
}
