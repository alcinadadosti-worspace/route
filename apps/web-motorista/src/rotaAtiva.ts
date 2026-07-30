import type { Rota } from '@rota/shared';

/**
 * Qual rota o motorista vê, entre as que a consulta trouxe (últimos 7 dias, só
 * dele). O app mostra UMA — a tela é para dirigir, não para escolher.
 *
 * Estava inline no hook e sem teste, justamente a regra em que mais importa
 * saber a resposta exata: "publiquei outra rota para ele no meio da primeira,
 * e agora?".
 *
 * A ordem de decisão:
 *  1. rota ATIVA (não concluída) ganha de concluída — terminado o dia, ele
 *     continua vendo o resumo do que fez, mas nunca no lugar de trabalho aberto;
 *  2. entre ativas, a data mais RECENTE — uma rota de ontem esquecida em
 *     execução não pode segurar a de hoje para sempre;
 *  3. empate na data: a JÁ INICIADA (`em_execucao`) vem primeiro — publicar a
 *     segunda rota do dia não pode esconder aquela que ele está no meio de
 *     executar, com paradas entregues e o resto por entregar;
 *  4. ainda empatado (as duas só publicadas, nenhuma iniciada): a publicada por
 *     último. É o caso em que a rota nova SUBSTITUI a anterior na tela dele.
 */
export function escolherRotaAtiva<T extends { id: string } & Rota>(rotas: T[]): T | null {
  const validas = rotas.filter((r) => r.status !== 'rascunho');
  const ativas = validas.filter((r) => r.status !== 'concluida');
  const candidatas = [...(ativas.length > 0 ? ativas : validas)];
  candidatas.sort(
    (a, b) =>
      b.data.localeCompare(a.data) ||
      Number(b.status === 'em_execucao') - Number(a.status === 'em_execucao') ||
      (b.publicadaEm ?? '').localeCompare(a.publicadaEm ?? ''),
  );
  return candidatas[0] ?? null;
}

export type AbaRota = 'abertas' | 'fechadas';

/**
 * As duas listas do motorista. ABERTAS primeiro pela data mais próxima de hoje
 * (é o trabalho); FECHADAS em ordem inversa, que é como se lê histórico — o
 * último dia no topo.
 */
export function separarRotas<T extends { id: string } & Rota>(
  rotas: T[],
): Record<AbaRota, T[]> {
  const validas = rotas.filter((r) => r.status !== 'rascunho');
  const porDataDesc = (a: T, b: T) =>
    b.data.localeCompare(a.data) || (b.publicadaEm ?? '').localeCompare(a.publicadaEm ?? '');
  return {
    abertas: validas.filter((r) => r.status !== 'concluida').sort(porDataDesc),
    fechadas: validas.filter((r) => r.status === 'concluida').sort(porDataDesc),
  };
}

/** Quanto falta numa rota — o número que decide o texto do aviso de fechar. */
export function paradasPorResolver(rota: Rota): number {
  return rota.paradas.filter((p) => p.status !== 'entregue' && p.status !== 'insucesso').length;
}
