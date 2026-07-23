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
}

export const PARAMETROS_TRILHA_PADRAO: ParametrosTrilha = {
  precisaoMaximaM: 25,
  distanciaMinimaM: 12,
  toleranciaSimplificacaoM: 10,
  trilhaMinimaM: 20,
  raioHandoffM: 100,
  raioChegadaM: 30,
};
