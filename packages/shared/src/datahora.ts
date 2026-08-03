/**
 * Formatação de data/hora que não quebra com dado torto.
 *
 * Toda hora exibida vem de um campo ISO do Firestore — `avisadoEm`,
 * `chegouEm`, `confirmadaEm`, `em` da posição. Um campo faltando, um doc de
 * versão antiga ou uma escrita interrompida entregam string vazia ou lixo, e
 * as versões ingênuas devolvem coisas que vazam para a tela:
 *
 *   new Date('').toLocaleTimeString('pt-BR')  →  "Invalid Date"
 *   String(new Date('').getHours())           →  "NaN"      ("NaNhNaN")
 *   Math.round((agora - Date.parse('')) / 60000) →  NaN     ("há NaN min")
 *
 * Nenhuma dessas é aceitável numa tela de operação: "há NaN min" não diz nada
 * a quem precisa decidir se liga para o motorista. O traço é honesto — diz
 * "não sei" — e é o que estas funções devolvem.
 */

/** Marcador de dado ausente. Um traço lê como "não tenho", que é a verdade. */
export const SEM_DADO = '—';

function valida(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `14:05` — hora e minuto no relógio de quem lê. */
export function formatarHora(iso: string | null | undefined): string {
  const d = valida(iso);
  return d ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : SEM_DADO;
}

/** `14h05` — a forma curta que o motorista vê de relance na lista. */
export function formatarHoraCurta(iso: string | null | undefined): string {
  const d = valida(iso);
  if (!d) return SEM_DADO;
  return `${String(d.getHours()).padStart(2, '0')}h${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Minutos decorridos desde o instante, ou `null` quando não dá para saber.
 * Nunca negativo: relógio do aparelho adiantado em relação ao servidor faria
 * "há -3 min", que só confunde.
 */
export function minutosDesde(iso: string | null | undefined, agoraMs: number): number | null {
  const d = valida(iso);
  if (!d) return null;
  return Math.max(0, Math.round((agoraMs - d.getTime()) / 60_000));
}

/** `agora`, `há 3 min`, ou o traço quando a data não serve. */
export function haQuantoTempo(iso: string | null | undefined, agoraMs: number): string {
  const min = minutosDesde(iso, agoraMs);
  if (min === null) return SEM_DADO;
  return min === 0 ? 'agora' : `há ${min} min`;
}
