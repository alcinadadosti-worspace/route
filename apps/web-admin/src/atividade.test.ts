import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atividadesEmCurso, comecarAtividade, ouvirAtividade } from './atividade.js';

test('conta as ações em curso; terminar duas vezes não desconta duas', () => {
  const vistos: number[] = [];
  const parar = ouvirAtividade((n) => vistos.push(n));
  const a = comecarAtividade();
  const b = comecarAtividade();
  assert.equal(atividadesEmCurso(), 2);
  a();
  a();
  assert.equal(atividadesEmCurso(), 1);
  b();
  assert.equal(atividadesEmCurso(), 0);
  assert.deepEqual(vistos, [1, 2, 1, 0]);
  parar();
});
