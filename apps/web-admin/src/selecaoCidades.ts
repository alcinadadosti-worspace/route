/**
 * Seleção por cidade na montagem de rota. A cidade da sugestão SOMA à seleção
 * (ou sai dela), em vez de substituí-la: antes, clicar numa cidade apagava a
 * escolha anterior, e não havia como levar duas cidades vizinhas na mesma rota
 * sem marcar caixa por caixa.
 *
 * Só conta o que AINDA está pronto: a sugestão é de quando foi pedida, e os
 * pedidos de uma cidade que entrou numa rota publicada não voltam a ela —
 * contá-los deixaria a cidade "marcada em parte" para sempre, sem como tirar.
 */

export type MarcacaoDoGrupo = boolean | 'mixed';

export function estadoDoGrupo(
  ids: string[],
  prontos: ReadonlySet<string>,
  selecionados: ReadonlySet<string>,
): { vivos: string[]; marcado: MarcacaoDoGrupo } {
  const vivos = ids.filter((id) => prontos.has(id));
  const marcados = vivos.filter((id) => selecionados.has(id)).length;
  return {
    vivos,
    marcado: marcados === 0 ? false : marcados === vivos.length ? true : 'mixed',
  };
}

export function alternarGrupo(
  ids: string[],
  prontos: ReadonlySet<string>,
  selecionados: ReadonlySet<string>,
): Set<string> {
  const { vivos, marcado } = estadoDoGrupo(ids, prontos, selecionados);
  const proximo = new Set(selecionados);
  // Marcada só em parte (o operador desmarcou um pedido na lista): o clique
  // completa a cidade, que é o que se espera ao clicar nela.
  for (const id of vivos) {
    if (marcado === true) proximo.delete(id);
    else proximo.add(id);
  }
  return proximo;
}
