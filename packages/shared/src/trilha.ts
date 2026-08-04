/**
 * Parâmetros de gravação, pós-processamento e navegação (seções 11.1–11.3).
 * São os valores iniciais da especificação; `config/geral` pode sobrescrevê-los
 * sem novo deploy — os apps e a API leem o doc e mesclam sobre estes padrões.
 */
export interface ParametrosTrilha {
  /** Leituras com accuracy acima disso são descartadas na gravação. */
  precisaoMaximaM: number;
  /** Deslocamento mínimo entre pontos gravados (evita nuvem parado no semáforo). */
  distanciaMinimaM: number;
  /** Tolerância do Douglas-Peucker no pós-processamento. */
  toleranciaSimplificacaoM: number;
  /** Trecho órfão mais curto que isso é ruído de GPS, não caminho a aprender. */
  trilhaMinimaM: number;
  /** Raio em torno do pontoEntrada que troca a navegação para o modo trilha. */
  raioHandoffM: number;
  /** Raio em torno do pin que aciona o cartão de chegada (RF-18). */
  raioChegadaM: number;
  /**
   * Distância do traçado desenhado a partir da qual o motorista é considerado
   * fora do caminho (dispara o recálculo online, seção 11.6). Folgado de
   * propósito: erro de GPS e via larga não podem virar desvio.
   */
  desvioMinimoM: number;
}

export const PARAMETROS_TRILHA_PADRAO: ParametrosTrilha = {
  precisaoMaximaM: 25,
  distanciaMinimaM: 12,
  toleranciaSimplificacaoM: 10,
  trilhaMinimaM: 20,
  raioHandoffM: 100,
  raioChegadaM: 30,
  desvioMinimoM: 150,
};

/**
 * Mescla os overrides de `config/geral` sobre os padrões: só sobrescreve com
 * número finito e positivo (são todos thresholds em metros), ignorando chaves
 * estranhas ou valores inválidos. Assim o Admin Estoque afrouxa, p.ex., o
 * `precisaoMaximaM` para o GPS ruim do interior sem um novo deploy.
 */
export function mesclarParametrosTrilha(override?: Partial<ParametrosTrilha>): ParametrosTrilha {
  const parametros = { ...PARAMETROS_TRILHA_PADRAO };
  if (!override) return parametros;
  for (const chave of Object.keys(PARAMETROS_TRILHA_PADRAO) as Array<keyof ParametrosTrilha>) {
    const valor = override[chave];
    if (typeof valor === 'number' && Number.isFinite(valor) && valor > 0) {
      parametros[chave] = valor;
    }
  }
  return parametros;
}
