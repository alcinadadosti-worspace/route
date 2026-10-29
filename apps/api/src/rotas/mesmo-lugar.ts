import type { GeoPonto } from '@rota/shared';

/**
 * Paradas do MESMO ponto em sequência na ordem de visita — e, dentro dele, os
 * pedidos da mesma cliente colados.
 *
 * Sintoma: rota de Palmeira dos Índios de 29/10/2026, 13 paradas da zona rural
 * de Igaci no mesmo ponto aproximado (o centro da cidade, que é o que o Google
 * acha para povoado). Entre pontos iguais a matriz não distingue ordem nenhuma,
 * e a cliente com 5 pedidos saiu como paradas 07 e 08 e depois 17, 18 e 19 —
 * no papel, a mesma casa duas vezes, com outros povoados no meio.
 *
 * Cada grupo fica onde o PRIMEIRO dos seus apareceu, e colada numa parada do
 * mesmo ponto a parada custa zero. Tirá-la do meio do caminho (A → P → B vira
 * A → B) em geral não alonga, mas a malha real não garante: o OSRM às vezes
 * acha caminho melhor PASSANDO por um ponto do que indo direto (medido em
 * 29/10/2026, Maceió: X→P→Y 3,6 km, X→Y 5,8 km). Depois do refino, o que sobra
 * separado no mesmo ponto é empate; por isso, quando o agrupamento muda o
 * percurso, quem chama refaz km e tempo no /route em vez de supor.
 */
export function agruparMesmoLugar<T>(
  itens: T[],
  ponto: (item: T) => GeoPonto,
  cliente: (item: T) => string,
): T[] {
  const porPonto = new Map<string, Map<string, T[]>>();
  for (const item of itens) {
    const k = chaveDoPonto(ponto(item));
    const daqui = porPonto.get(k) ?? new Map<string, T[]>();
    porPonto.set(k, daqui);
    const c = cliente(item);
    daqui.set(c, [...(daqui.get(c) ?? []), item]);
  }
  // Map guarda a ordem de inserção: pontos e clientes saem na ordem em que
  // apareceram pela primeira vez.
  return [...porPonto.values()].flatMap((daqui) => [...daqui.values()].flat());
}

/**
 * As duas ordens passam pelos mesmos pontos na mesma sequência — só trocaram
 * de lugar paradas de um mesmo ponto. Então traçado, km e tempo são os mesmos e
 * não precisa perguntar de novo ao OSRM.
 */
export function mesmoPercurso<T>(a: T[], b: T[], ponto: (item: T) => GeoPonto): boolean {
  return a.length === b.length && a.every((item, i) => chaveDoPonto(ponto(item)) === chaveDoPonto(ponto(b[i]!)));
}

/** Igualdade EXATA: o centro de cidade que o Google devolve para povoado é sempre o mesmo número. */
function chaveDoPonto(p: GeoPonto): string {
  return `${p.lat},${p.lng}`;
}
