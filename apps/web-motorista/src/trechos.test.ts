import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indicesDasParadas, trechoDaParada } from './trechos.js';

/** Traçado reto de 11 vértices ao longo do meridiano -36,56 (~100 m entre eles). */
const TRACADO = Array.from({ length: 11 }, (_, i) => ({ lat: -10.28 + i * 0.001, lng: -36.56 }));

test('cada parada casa com o vértice mais próximo, em ordem', () => {
  const paradas = [TRACADO[3]!, TRACADO[6]!, TRACADO[10]!];
  assert.deepEqual(indicesDasParadas(TRACADO, paradas), [3, 6, 10]);
});

test('o trecho de uma parada vai do ponto anterior até ela', () => {
  const indices = [3, 6, 10];
  // Primeira parada: do começo do traçado (o CD) até ela.
  assert.deepEqual(trechoDaParada(TRACADO, indices, 0), TRACADO.slice(0, 4));
  // Segunda: da primeira até ela — não inclui o caminho desde o CD.
  assert.deepEqual(trechoDaParada(TRACADO, indices, 1), TRACADO.slice(3, 7));
  assert.deepEqual(trechoDaParada(TRACADO, indices, 2), TRACADO.slice(6, 11));
});

test('estrada que volta: a parada não casa com um vértice anterior', () => {
  // Traçado em "V": sobe até o vértice 5 e volta. A parada final fica perto do
  // começo em linha reta, mas só é alcançada no FIM do percurso.
  const ida = Array.from({ length: 6 }, (_, i) => ({ lat: -10.28 + i * 0.001, lng: -36.56 }));
  const volta = Array.from({ length: 5 }, (_, i) => ({ lat: -10.284 - i * 0.001, lng: -36.56 }));
  const vaiEVolta = [...ida, ...volta];
  const paradas = [ida[5]!, volta[4]!];

  const indices = indicesDasParadas(vaiEVolta, paradas);

  assert.equal(indices[0], 5);
  assert.ok(
    indices[1]! > indices[0]!,
    `a segunda parada tem de casar DEPOIS da primeira, veio ${indices[1]}`,
  );
  // E o trecho dela é a volta, não um pedaço da ida.
  const trecho = trechoDaParada(vaiEVolta, indices, 1);
  assert.ok(trecho.length >= 2);
  assert.deepEqual(trecho[trecho.length - 1], vaiEVolta[indices[1]!]);
});

test('duas paradas no mesmo vértice ainda desenham linha', () => {
  const indices = indicesDasParadas(TRACADO, [TRACADO[4]!, TRACADO[4]!]);
  assert.deepEqual(indices, [4, 4]);
  const trecho = trechoDaParada(TRACADO, indices, 1);
  assert.ok(trecho.length >= 2, 'trecho de um ponto só não desenharia nada no mapa');
});

test('índice fora da faixa devolve o traçado inteiro, não vazio', () => {
  assert.deepEqual(trechoDaParada(TRACADO, [3, 6], 9), TRACADO);
  assert.deepEqual(trechoDaParada(TRACADO, [3, 6], -1), TRACADO);
});
