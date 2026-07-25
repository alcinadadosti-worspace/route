import type { EnderecoFiscal, StatusMapeamento } from './tipos.js';

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
const PREFIXOS_RURAIS = ['POVOADO', 'SITIO', 'FAZENDA', 'ASSENTAMENTO', 'ENGENHO', 'ROD', 'RODOVIA', 'KM'];

export function ehEnderecoRural(endereco: EnderecoFiscal): boolean {
  const bairro = normalizar(endereco.bairro);
  if (bairro.includes('ZONA RURAL') || bairro.includes('POVOADO')) return true;

  const logradouro = normalizar(endereco.logradouro);
  return PREFIXOS_RURAIS.some((p) => logradouro === p || logradouro.startsWith(p + ' '));
}

/**
 * Dois endereços apontam para lugares diferentes o suficiente para roteirizar?
 * Compara logradouro+número+bairro+município+UF+CEP normalizados (o CEP só pelos
 * dígitos, então `57200-000` == `57200000`). Usado para decidir se o bloco
 * `<entrega>` da NF-e diverge do endereço fiscal — quando diverge, o pedido vai
 * para a decisão do escritório em vez de roteirizar no palpite (seção 8.4).
 */
export function enderecosDivergem(a: EnderecoFiscal, b: EnderecoFiscal): boolean {
  const campos = ['logradouro', 'numero', 'bairro', 'municipio', 'uf'] as const;
  if (campos.some((c) => normalizar(a[c] ?? '') !== normalizar(b[c] ?? ''))) return true;

  // CEP só desempata quando os DOIS lados têm: um <entrega> que repete o endereço
  // mas omite o CEP (opcional) não deve virar divergência falsa; dois CEPs
  // diferentes de fato, sim. (Complemento não entra — apto/bloco é o mesmo ponto.)
  const cepA = (a.cep ?? '').replace(/\D/g, '');
  const cepB = (b.cep ?? '').replace(/\D/g, '');
  return cepA !== '' && cepB !== '' && cepA !== cepB;
}

/**
 * Ponto de entrega ainda não confiável — precisa ser estabelecido/refinado em
 * campo (gravando a trilha na 1ª viagem). Vale para 'nao_mapeado' (sem ponto) e
 * 'aproximado' (ponto grosseiro do geocodificador); 'geocodificado' e 'mapeado'
 * já são pontos bons. Usado pelo app do motorista para ligar o "navegar e mapear".
 */
export function precisaMapearEmCampo(status: StatusMapeamento): boolean {
  return status === 'nao_mapeado' || status === 'aproximado';
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
