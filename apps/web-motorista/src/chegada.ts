/**
 * Detector de chegada (seção 11.9): permanência contínua perto do pin por
 * tempo suficiente = chegou. É o que separa VIAGEM de ATENDIMENTO na
 * produtividade — sem isto, "tempo por parada" mistura os dois e o número
 * não diz se o motorista dirigiu 40 min ou conversou 40 min.
 *
 * Padrão de mercado é geofência de 50–200 m que BLOQUEIA a confirmação fora
 * dela. Aqui o raio é 100 m e o registro é automático e silencioso: detectar
 * errado não pode travar entrega nenhuma — no pior caso a parada fica sem
 * `chegouEm`, exatamente como as rotas antigas.
 *
 * Três decisões contra o GPS de celular:
 * - PERMANÊNCIA (30 s), não primeiro contato: passar de carro na frente da
 *   casa a caminho de outra parada não é chegada;
 * - leitura com precisão pior que 50 m é IGNORADA (não conta nem zera): um
 *   pico de imprecisão sob árvore não pode reiniciar uma contagem legítima;
 * - dispara UMA vez. Quem grava é o chamador; o detector só decide.
 */

export const RAIO_CHEGADA_M = 100;
export const PERMANENCIA_CHEGADA_MS = 30_000;
export const PRECISAO_MAXIMA_CHEGADA_M = 50;

export interface DetectorChegada {
  /**
   * Alimenta uma leitura; devolve true UMA única vez, quando a permanência
   * fecha. `agoraMs` vem de fora para o detector ser testável sem relógio.
   */
  registrar(distanciaM: number | null, precisaoM: number, agoraMs: number): boolean;
}

export function criarDetectorChegada(
  raioM: number = RAIO_CHEGADA_M,
  permanenciaMs: number = PERMANENCIA_CHEGADA_MS,
): DetectorChegada {
  let dentroDesde: number | null = null;
  let disparado = false;

  return {
    registrar(distanciaM, precisaoM, agoraMs) {
      if (disparado) return false;
      // Sem posição ou com posição ruim: não sabemos onde ele está — e "não
      // sei" não pode nem começar nem zerar a contagem.
      if (distanciaM == null || precisaoM > PRECISAO_MAXIMA_CHEGADA_M) return false;
      if (distanciaM > raioM) {
        dentroDesde = null;
        return false;
      }
      dentroDesde ??= agoraMs;
      if (agoraMs - dentroDesde >= permanenciaMs) {
        disparado = true;
        return true;
      }
      return false;
    },
  };
}
