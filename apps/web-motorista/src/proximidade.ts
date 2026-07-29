import { distanciaEmMetros, type GeoPonto } from '@rota/shared';

/**
 * Ordem das paradas por proximidade do motorista — uma VISÃO no aparelho, que
 * não altera a rota publicada. A ordem oficial continua sendo a do escritório
 * (o número da parada segue impresso no cartão); isto responde outra pergunta:
 * "de onde eu estou, qual é a próxima?".
 *
 * Duas fontes de ordem, com a mesma cara na tela:
 * - linha reta (`ordenarPorProximidade`): puro haversine, funciona sem rede
 *   nenhuma. Em zona rural erra pouco na hora de escolher QUAL é a próxima,
 *   que é a decisão real — não se está medindo quilometragem, e sim comparando.
 * - estrada (`aplicarOrdemSugerida`): a ordem vem do OSRM pela API, que exige
 *   sinal; aqui só se aplica o que veio.
 *
 * Parada já resolvida nunca disputa "a próxima": vai para o fim, na ordem
 * publicada.
 */

export type StatusParada = 'pendente' | 'entregue' | 'trilha' | 'insucesso';

export interface ParadaOrdenavel {
  coordenada: GeoPonto;
  status: StatusParada;
  /** Ausente nas paradas de demonstração; presente na rota real. */
  pedidoId?: string;
}

/** Parada anotada com a distância até o motorista (null sem posição). */
export type ComDistancia<T> = T & { distanciaM: number | null };

function resolvida(status: StatusParada): boolean {
  return status === 'entregue' || status === 'insucesso';
}

function anotar<T extends ParadaOrdenavel>(paradas: T[], posicao: GeoPonto | null): ComDistancia<T>[] {
  return paradas.map((p) => ({
    ...p,
    distanciaM: posicao ? Math.round(distanciaEmMetros(posicao, p.coordenada)) : null,
  }));
}

/**
 * Ordena por distância em linha reta. Sem posição não reordena nada: mostrar
 * uma ordem "por proximidade" sem saber onde o motorista está seria pior que
 * mostrar a ordem publicada.
 */
export function ordenarPorProximidade<T extends ParadaOrdenavel>(
  paradas: T[],
  posicao: GeoPonto | null,
): ComDistancia<T>[] {
  const anotadas = anotar(paradas, posicao);
  if (!posicao) return anotadas;
  // sort é estável (ES2019+): entre resolvidas, a ordem publicada se mantém.
  return anotadas.sort((a, b) => {
    if (resolvida(a.status) !== resolvida(b.status)) return resolvida(a.status) ? 1 : -1;
    if (resolvida(a.status)) return 0;
    return (a.distanciaM ?? 0) - (b.distanciaM ?? 0);
  });
}

/**
 * Aplica a ordem sugerida pela API (lista de pedidoIds já otimizada por
 * estrada). Quem não está na lista — paradas resolvidas, ou uma parada que
 * chegou depois do cálculo — vai para o fim, na ordem publicada, em vez de
 * sumir da tela.
 */
export function aplicarOrdemSugerida<T extends ParadaOrdenavel>(
  paradas: T[],
  ordem: string[],
  posicao: GeoPonto | null,
): ComDistancia<T>[] {
  const posicaoNaOrdem = new Map(ordem.map((pedidoId, i) => [pedidoId, i]));
  const anotadas = anotar(paradas, posicao);
  return anotadas.sort((a, b) => {
    // Mesma regra da ordenação por linha reta: quem já foi resolvido sai da
    // disputa. A parada entregue DEPOIS do cálculo ainda consta da ordem que
    // veio da API, e sem isto ficaria encalhada no meio das pendentes.
    if (resolvida(a.status) !== resolvida(b.status)) return resolvida(a.status) ? 1 : -1;
    const ia = a.pedidoId ? posicaoNaOrdem.get(a.pedidoId) : undefined;
    const ib = b.pedidoId ? posicaoNaOrdem.get(b.pedidoId) : undefined;
    if (ia === undefined && ib === undefined) return 0;
    if (ia === undefined) return 1;
    if (ib === undefined) return -1;
    return ia - ib;
  });
}
