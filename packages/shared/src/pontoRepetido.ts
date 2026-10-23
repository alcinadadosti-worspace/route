import { enderecosDivergem } from './endereco.js';
import type { EnderecoFiscal, GeoPonto } from './tipos.js';

/**
 * Ponto "exato" que não é exato: clientes de endereços DIFERENTES no mesmo
 * ponto, até a 5ª casa decimal (~1 m). Duas casas distintas não ficam no mesmo
 * metro — é a busca (ou o GPS do cadastro) caindo no centro da cidade, do
 * povoado ou da rua.
 *
 * Medido em produção em 21/10/2026: 26 pontos repetidos entre 81 clientes, e
 * 23 deles marcados `geocodificado` — "Chá da Ponte", "Povoado Ingá" e
 * "Povoado Retiro" no mesmo ponto que 8 aproximados no centro de Junqueiro.
 * Marcado como exato, o PDF não avisava "confirme o local" e o caminhão ia ao
 * centro da cidade achando que era a porta da cliente.
 *
 * O mesmo endereço no mesmo ponto (mãe e filha revendedoras na mesma casa) não
 * conta: ali o ponto repetido é verdade.
 */

export function chaveDePonto(p: GeoPonto): string {
  return `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
}

/** IDs dos clientes cujo ponto é dividido com outro de endereço diferente. */
export function pontosRepetidos<
  T extends { id: string; coordenada: GeoPonto | null; enderecoFiscal: EnderecoFiscal },
>(clientes: T[]): Set<string> {
  const porPonto = new Map<string, T[]>();
  for (const c of clientes) {
    if (!c.coordenada) continue;
    const chave = chaveDePonto(c.coordenada);
    porPonto.set(chave, [...(porPonto.get(chave) ?? []), c]);
  }
  const suspeitos = new Set<string>();
  for (const grupo of porPonto.values()) {
    for (const c of grupo) {
      if (grupo.some((outro) => outro.id !== c.id && enderecosDivergem(outro.enderecoFiscal, c.enderecoFiscal))) {
        suspeitos.add(c.id);
      }
    }
  }
  return suspeitos;
}
