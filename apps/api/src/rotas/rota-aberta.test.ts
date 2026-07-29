import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ordemRotaAberta } from './rota-aberta.js';

/**
 * Matriz de durações a partir de posições numa reta: o custo entre dois pontos
 * é a distância entre eles. A rota aberta ótima é visitar em ordem crescente
 * (ou decrescente) a partir da origem — sem voltar.
 */
function matrizDaReta(posicoes: number[]): number[][] {
  return posicoes.map((a) => posicoes.map((b) => Math.abs(a - b)));
}

test('sem paradas ou com uma só, não há o que otimizar', () => {
  assert.deepEqual(ordemRotaAberta([[0]]), []);
  assert.deepEqual(ordemRotaAberta(matrizDaReta([0, 5])), [0]);
});

test('numa reta, visita na ordem e NÃO volta à origem', () => {
  // Origem em 0; paradas em 30, 10, 20 (índices de parada 0, 1, 2).
  const ordem = ordemRotaAberta(matrizDaReta([0, 30, 10, 20]));
  assert.deepEqual(ordem, [1, 2, 0]); // 10 → 20 → 30
});

test('2-opt desfaz o zigue-zague que o vizinho mais próximo cria', () => {
  // Clássico do guloso: ele pega o 1 (perto), depois é forçado a atravessar.
  // Origem 0; paradas em 1, 9, 10, 11 → o ótimo aberto é 1,9,10,11.
  const ordem = ordemRotaAberta(matrizDaReta([0, 1, 9, 10, 11]));
  assert.deepEqual(ordem, [0, 1, 2, 3]);
});

test('respeita assimetria (mão única): a volta cara não inverte a ordem', () => {
  // 3 pontos: origem(0), A(1), B(2). Ir A→B é barato; B→A é caríssimo.
  // A rota aberta certa é A depois B, mesmo B estando mais perto da origem.
  const duracoes = [
    [0, 10, 8],
    [10, 0, 1],
    [8, 900, 0],
  ];
  assert.deepEqual(ordemRotaAberta(duracoes), [0, 1]);
});

test('parada inalcançável entra na ordem em vez de sumir', () => {
  // A parada 2 não tem caminho de lugar nenhum (Infinity em tudo).
  const duracoes = [
    [0, 5, Infinity],
    [5, 0, Infinity],
    [Infinity, Infinity, 0],
  ];
  const ordem = ordemRotaAberta(duracoes);
  assert.equal(ordem.length, 2);
  assert.deepEqual([...ordem].sort(), [0, 1]);
});

test('nenhuma parada é perdida nem duplicada em matriz maior', () => {
  const posicoes = [0, 7, 3, 12, 1, 9, 5, 15, 2, 11];
  const ordem = ordemRotaAberta(matrizDaReta(posicoes));
  assert.equal(ordem.length, posicoes.length - 1);
  assert.deepEqual([...ordem].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});
