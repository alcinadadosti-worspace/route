import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_OBSERVACAO_ROTA, observacaoDaRota } from './observacaoDaRota.js';

test('observação da rota: espaços e quebras colapsam; vazio é "sem observação"', () => {
  assert.deepEqual(observacaoDaRota('  Levar o troco.\n\nVolta antes das 16h  '), {
    ok: true,
    observacao: 'Levar o troco. Volta antes das 16h',
  });
  assert.deepEqual(observacaoDaRota('   '), { ok: true, observacao: null });
  assert.deepEqual(observacaoDaRota(undefined), { ok: true, observacao: null });
  assert.deepEqual(observacaoDaRota(null), { ok: true, observacao: null });
});

test('observação da rota: longa demais ou de outro tipo é recusada, com o motivo', () => {
  const longa = observacaoDaRota('x'.repeat(MAX_OBSERVACAO_ROTA + 1));
  assert.equal(longa.ok, false);
  if (!longa.ok) assert.match(longa.erro, /301 caracteres.*300/);
  assert.equal(observacaoDaRota('x'.repeat(MAX_OBSERVACAO_ROTA)).ok, true);
  assert.equal(observacaoDaRota(42).ok, false);
});
