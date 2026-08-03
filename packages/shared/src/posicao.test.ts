import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BATIMENTO_PARADO_MS,
  INTERVALO_MINIMO_MS,
  deveEnviarPosicao,
  posicaoEstaVelha,
} from './posicao.js';

const PENEDO = { lat: -10.2808, lng: -36.5595 };
/** ~90 m ao norte — passa do movimento mínimo. */
const ANDOU = { lat: -10.2800, lng: -36.5595 };
/** ~11 m — ruído de GPS parado. */
const RUIDO = { lat: -10.28090, lng: -36.5595 };

test('a primeira leitura sempre vai — o painel precisa de um ponto de partida', () => {
  assert.equal(deveEnviarPosicao(null, PENEDO, 1_000_000), true);
});

test('parado gera BATIMENTO, não 40 posições iguais', () => {
  const ultima = { ponto: PENEDO, emMs: 0 };
  // Antes do batimento, parado no ruído do GPS: não manda.
  assert.equal(deveEnviarPosicao(ultima, RUIDO, INTERVALO_MINIMO_MS + 1), false);
  assert.equal(deveEnviarPosicao(ultima, RUIDO, BATIMENTO_PARADO_MS - 1), false);
  // No batimento, manda mesmo sem sair do lugar: é o que distingue "parado no
  // cliente" de "app fechado" ou "celular sem bateria".
  assert.equal(deveEnviarPosicao(ultima, RUIDO, BATIMENTO_PARADO_MS), true);
});

test('movimento real manda, respeitando o teto entre envios', () => {
  const ultima = { ponto: PENEDO, emMs: 0 };
  // Andou de verdade, mas faz 5 s: o teto segura (senão seriam 120 escritas/min).
  assert.equal(deveEnviarPosicao(ultima, ANDOU, 5_000), false);
  assert.equal(deveEnviarPosicao(ultima, ANDOU, INTERVALO_MINIMO_MS), true);
});

test('relógio andando para trás não trava o envio para sempre', () => {
  // Ajuste de hora ou troca de fuso no meio da rota: tratar como "faz tempo" é
  // melhor que nunca mais mandar posição nenhuma.
  assert.equal(deveEnviarPosicao({ ponto: PENEDO, emMs: 10_000_000 }, ANDOU, 9_000_000), true);
});

test('posição velha é tratada como velha — o painel não finge que sabe', () => {
  const agora = Date.parse('2026-08-03T14:00:00-03:00');
  const recente = { em: '2026-08-03T13:58:00-03:00' };
  const antiga = { em: '2026-08-03T12:00:00-03:00' };
  assert.equal(posicaoEstaVelha(recente, agora), false);
  assert.equal(posicaoEstaVelha(antiga, agora), true);
  // Data corrompida vale como velha: melhor dizer "não sei" que mostrar um
  // ponto qualquer como se fosse atual.
  assert.equal(posicaoEstaVelha({ em: 'nao-e-data' }, agora), true);
});
