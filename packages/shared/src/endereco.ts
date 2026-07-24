import type { EnderecoFiscal } from './tipos.js';

/**
 * Heurística de zona rural (seção 9, passo 2): endereço com marca EXPLÍCITA de
 * zona rural pula a geocodificação e vai direto para `pendente_de_mapeamento`.
 * O resto é geocodificado — o filtro de precisão do geocodificador (rejeita
 * resultado "APPROXIMATE" e município fora do esperado) é quem decide se o
 * ponto presta. NÃO se usa `cep.endsWith('000')`: em cidades menores (Penedo,
 * Coruripe) o CEP genérico da cidade termina em 000 e vale para endereços
 * URBANOS também — usar o CEP marcava rua urbana como rural e ela nunca
 * ganhava coordenada.
 */
const PREFIXOS_RURAIS = ['POVOADO', 'SITIO', 'FAZENDA', 'ASSENTAMENTO', 'ENGENHO', 'ROD', 'KM'];

export function ehEnderecoRural(endereco: EnderecoFiscal): boolean {
  const bairro = normalizar(endereco.bairro);
  if (bairro.includes('ZONA RURAL') || bairro.includes('POVOADO')) return true;

  const logradouro = normalizar(endereco.logradouro);
  return PREFIXOS_RURAIS.some((p) => logradouro === p || logradouro.startsWith(p + ' '));
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
