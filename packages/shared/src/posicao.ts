import { distanciaEmMetros } from './geo.js';
import type { GeoPonto } from './tipos.js';

/**
 * Posição do motorista compartilhada com o escritório (seção 11.4).
 *
 * Mora numa coleção PRÓPRIA, `posicoes/{rotaId}`, e não dentro do doc da rota.
 * A razão é concreta: o app do motorista escuta a própria rota em tempo real —
 * gravar a posição ali dispararia uma leitura no celular DELE a cada
 * atualização, pagando duas vezes pelo mesmo dado e re-renderizando a tela no
 * meio do trabalho. Num doc à parte, só o painel lê.
 */
export interface PosicaoMotorista {
  lat: number;
  lng: number;
  precisaoM: number;
  /** Rumo em graus do norte, quando o GPS informa (null parado). O painel usa
   * para apontar a seta e para deslizar o ponto entre atualizações. */
  rumo: number | null;
  /** Velocidade em m/s, quando o GPS informa. Alimenta a mesma interpolação. */
  velocidadeMs: number | null;
  /**
   * ISO da leitura NO APARELHO — nunca a hora do servidor. Com a fila offline
   * do Firestore, uma escrita pode chegar minutos depois de medida; o que o
   * escritório precisa saber é QUANDO o motorista estava ali, não quando o
   * dado subiu.
   */
  em: string;
  motoristaId: string;
}

/**
 * Teto entre envios em movimento. Com Starlink no carro os dados não são o
 * gargalo, e 30 s a 35 km/h dão um ponto a cada ~290 m — resolução de sobra
 * para "onde ele está" sem transformar a cota em problema.
 */
export const INTERVALO_MINIMO_MS = 30_000;

/**
 * Mesmo PARADO, manda de tempos em tempos. Sem este batimento o painel não
 * distingue "parado no cliente" de "app fechado" ou "celular sem bateria" — e
 * essas três coisas exigem reações bem diferentes de quem está no escritório.
 */
export const BATIMENTO_PARADO_MS = 5 * 60_000;

/** Abaixo disto é ruído de GPS, não deslocamento: não vale uma escrita. */
export const MOVIMENTO_MINIMO_M = 50;

/**
 * Envia esta leitura?
 *
 * A economia que importa não é mandar menos vezes por relógio — é NÃO MANDAR
 * quando nada mudou. Motorista parado 20 min na porta do cliente gera 4
 * batimentos, não 40 posições iguais.
 */
export function deveEnviarPosicao(
  ultima: { ponto: GeoPonto; emMs: number } | null,
  atual: GeoPonto,
  agoraMs: number,
): boolean {
  if (!ultima) return true;
  const desde = agoraMs - ultima.emMs;
  // Relógio do aparelho pode andar para trás (ajuste de hora, fuso): tratar
  // como "faz tempo" é melhor que travar o envio para sempre.
  if (desde < 0) return true;
  if (desde < INTERVALO_MINIMO_MS) return false;
  if (desde >= BATIMENTO_PARADO_MS) return true;
  return distanciaEmMetros(ultima.ponto, atual) >= MOVIMENTO_MINIMO_M;
}

/** Quanto tempo até a posição virar "velha" na tela do escritório. Passado
 * isso, o painel para de fingir que sabe onde ele está. */
export const POSICAO_VELHA_MS = 3 * BATIMENTO_PARADO_MS;

export function posicaoEstaVelha(posicao: { em: string }, agoraMs: number): boolean {
  const t = Date.parse(posicao.em);
  if (!Number.isFinite(t)) return true;
  return agoraMs - t > POSICAO_VELHA_MS;
}
