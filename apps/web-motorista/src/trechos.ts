import { distanciaEmMetros, type GeoPonto } from '@rota/shared';

/**
 * Recorte do traçado da rota nos trechos entre paradas.
 *
 * A rota publicada guarda UMA polyline só, do CD à última parada (seção 10) —
 * ela não diz onde termina o trecho de cada entrega. Para poder desenhar "o
 * caminho até ESTA parada", o traçado é recortado aqui: para cada parada,
 * acha-se o vértice do traçado mais próximo dela, e esses vértices viram as
 * emendas.
 *
 * A busca de cada parada começa onde a anterior terminou. Isso não é
 * otimização, é correção: a rota costuma passar perto de uma parada distante
 * antes de chegar nela — numa estrada que vai e volta, o vértice mais próximo
 * da parada 5 pode estar no começo do traçado. Restringir a busca ao que vem
 * depois garante que os trechos não se cruzem nem voltem no tempo.
 */
export function indicesDasParadas(tracado: GeoPonto[], paradas: GeoPonto[]): number[] {
  const indices: number[] = [];
  let inicio = 0;
  for (const parada of paradas) {
    let melhor = inicio;
    let menor = Infinity;
    for (let i = inicio; i < tracado.length; i++) {
      const distancia = distanciaEmMetros(tracado[i]!, parada);
      if (distancia < menor) {
        menor = distancia;
        melhor = i;
      }
    }
    indices.push(melhor);
    inicio = melhor;
  }
  return indices;
}

/**
 * Trecho que chega na parada de índice `posicao` (0-based): do ponto anterior
 * — o CD na primeira, a parada anterior nas outras — até ela.
 *
 * Devolve pelo menos dois pontos quando há traçado: um trecho de um ponto só
 * não desenha linha nenhuma, e o mapa ficaria mudo justamente na parada que o
 * motorista escolheu olhar.
 */
export function trechoDaParada(
  tracado: GeoPonto[],
  indices: number[],
  posicao: number,
): GeoPonto[] {
  if (posicao < 0 || posicao >= indices.length || tracado.length === 0) return tracado;
  const fim = indices[posicao]!;
  const inicio = posicao === 0 ? 0 : indices[posicao - 1]!;
  const trecho = tracado.slice(inicio, fim + 1);
  if (trecho.length >= 2) return trecho;
  // Emenda degenerada (duas paradas no mesmo vértice, ou a primeira em cima do
  // CD): estica um vértice para trás para haver linha.
  return tracado.slice(Math.max(0, fim - 1), fim + 1);
}
