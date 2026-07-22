import type { EnderecoFiscal } from './tipos.js';

/**
 * Heurística de zona rural (seção 9, passo 2): endereço com qualquer um destes sinais
 * pula a geocodificação e vai direto para `pendente_de_mapeamento` — geocodificar
 * seria obter um ponto errado com cara de certo.
 */
const PREFIXOS_RURAIS = ['POVOADO', 'SITIO', 'FAZENDA', 'ASSENTAMENTO', 'ROD', 'KM'];

export function ehEnderecoRural(endereco: EnderecoFiscal): boolean {
  const cep = endereco.cep.replace(/\D/g, '');
  if (cep.endsWith('000')) return true;

  const bairro = normalizar(endereco.bairro);
  if (bairro.includes('ZONA RURAL')) return true;

  const logradouro = normalizar(endereco.logradouro);
  return PREFIXOS_RURAIS.some((p) => logradouro.startsWith(p));
}

/** Caixa alta sem acentos, espaçamento colapsado — tolerante ao texto livre da NF-e. */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}
