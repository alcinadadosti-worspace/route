import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alternarGrupo, estadoDoGrupo } from './selecaoCidades.js';

const PRONTOS = new Set(['pi1', 'pi2', 'fd1', 'pe1', 'pe2']);
const PIACABUCU = ['pi1', 'pi2'];
const FELIZ_DESERTO = ['fd1'];

test('clicar numa segunda cidade SOMA à seleção, não troca', () => {
  // O que o usuário não conseguia: marcar um bloco a mais.
  const um = alternarGrupo(PIACABUCU, PRONTOS, new Set());
  const dois = alternarGrupo(FELIZ_DESERTO, PRONTOS, um);
  assert.deepEqual([...dois].sort(), ['fd1', 'pi1', 'pi2']);
});

test('clicar de novo numa cidade marcada tira só ela', () => {
  const sel = new Set(['pi1', 'pi2', 'fd1', 'avulso']);
  assert.deepEqual([...alternarGrupo(PIACABUCU, PRONTOS, sel)].sort(), ['avulso', 'fd1']);
});

test('cidade marcada em parte: o clique completa, e o estado diz "em parte"', () => {
  const sel = new Set(['pi1']);
  assert.equal(estadoDoGrupo(PIACABUCU, PRONTOS, sel).marcado, 'mixed');
  assert.deepEqual([...alternarGrupo(PIACABUCU, PRONTOS, sel)].sort(), ['pi1', 'pi2']);
});

test('pedido que já saiu numa rota não conta — a cidade não fica presa "em parte"', () => {
  // pi2 foi publicado depois que a sugestão chegou: não está mais pronto.
  const prontos = new Set(['pi1', 'fd1']);
  const sel = new Set(['pi1']);
  const estado = estadoDoGrupo(PIACABUCU, prontos, sel);
  assert.deepEqual(estado.vivos, ['pi1']);
  assert.equal(estado.marcado, true);
  assert.deepEqual([...alternarGrupo(PIACABUCU, prontos, sel)], []);
  // E não volta para a seleção ao marcar a cidade de novo.
  assert.deepEqual([...alternarGrupo(PIACABUCU, prontos, new Set())], ['pi1']);
});
