import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alteracoesPendentes, confirmarDescarte, marcarAlteracao, perguntaDeDescarte } from './alteracoesPendentes.js';

test('sem nada digitado, sair não pergunta nada', () => {
  let perguntou = false;
  assert.equal(confirmarDescarte(() => (perguntou = true)), true);
  assert.equal(perguntou, false);
});

test('com algo digitado, pergunta; "não" mantém, "sim" descarta e limpa', () => {
  marcarAlteracao('a', true);
  marcarAlteracao('b', true);
  marcarAlteracao('b', false);
  assert.equal(alteracoesPendentes(), 1);
  let texto = '';
  assert.equal(confirmarDescarte((t) => ((texto = t), false)), false);
  assert.match(texto, /1 formulário/);
  assert.equal(alteracoesPendentes(), 1, 'recusou: continua pendente');
  assert.equal(confirmarDescarte(() => true), true);
  assert.equal(alteracoesPendentes(), 0);
});

test('a pergunta não vaza placeholder', () => {
  assert.doesNotMatch(perguntaDeDescarte(3), /\{|undefined|NaN/);
});
