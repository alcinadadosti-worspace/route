import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEM_DADO,
  formatarHora,
  formatarHoraCurta,
  haQuantoTempo,
  minutosDesde,
} from './datahora.js';

const QUINZE_HORAS = '2026-08-03T15:07:00-03:00';

test('formata a hora normalmente', () => {
  assert.equal(formatarHora(QUINZE_HORAS), '15:07');
  assert.equal(formatarHoraCurta(QUINZE_HORAS), '15h07');
});

test('data TORTA vira traço, não "Invalid Date" nem "NaNhNaN"', () => {
  // Campo faltando, doc de versão antiga ou escrita interrompida. As versões
  // ingênuas vazavam isso direto para a tela de operação.
  for (const ruim of ['', 'nao-e-data', null, undefined]) {
    assert.equal(formatarHora(ruim), SEM_DADO, `formatarHora(${ruim})`);
    assert.equal(formatarHoraCurta(ruim), SEM_DADO, `formatarHoraCurta(${ruim})`);
  }
});

test('idade em minutos, e NULL quando não dá para saber', () => {
  const agora = Date.parse('2026-08-03T15:10:00-03:00');
  assert.equal(minutosDesde(QUINZE_HORAS, agora), 3);
  assert.equal(minutosDesde('lixo', agora), null);
  assert.equal(minutosDesde(null, agora), null);
});

test('relógio adiantado não vira "há -3 min"', () => {
  // O aparelho do motorista pode estar à frente do servidor: um número
  // negativo na tela só confunde quem precisa decidir se liga para ele.
  const agora = Date.parse('2026-08-03T15:04:00-03:00');
  assert.equal(minutosDesde(QUINZE_HORAS, agora), 0);
});

test('"agora" para o que acabou de chegar; traço para o que não se sabe', () => {
  const agora = Date.parse('2026-08-03T15:07:20-03:00');
  assert.equal(haQuantoTempo(QUINZE_HORAS, agora), 'agora');
  assert.equal(haQuantoTempo(QUINZE_HORAS, Date.parse('2026-08-03T15:30:00-03:00')), 'há 23 min');
  assert.equal(haQuantoTempo('', agora), SEM_DADO);
});
