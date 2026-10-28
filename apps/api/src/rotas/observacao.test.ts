import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Rota } from '@rota/shared';
import { trocarObservacaoDaRota } from './observacao.js';
import { RepositorioMemoria } from '../db/repositorio.js';

const ROTA: Rota = {
  data: '2026-10-28',
  motoristaId: 'm1',
  origemCdId: 'penedo',
  origemNome: 'CD Penedo',
  origemCoordenada: { lat: -10.28, lng: -36.56 },
  retornaAoCd: true,
  paradas: [],
  polylinePlanejada: '',
  distanciaTotalKm: 1,
  duracaoTotalMin: 1,
  status: 'publicada',
  publicadaEm: null,
  concluidaEm: null,
};

test('observação da rota: grava limpa, troca, e em branco sai da rota', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarRota('r1', ROTA);
  assert.deepEqual(await trocarObservacaoDaRota(repo, 'r1', { observacao: ' Levar o troco.\n' }), {
    ok: true,
    observacao: 'Levar o troco.',
  });
  assert.equal((await repo.obterRota('r1'))?.observacao, 'Levar o troco.');
  await trocarObservacaoDaRota(repo, 'r1', { observacao: '  ' });
  assert.equal('observacao' in (await repo.obterRota('r1'))!, false);
  // O resto da rota não muda.
  assert.equal((await repo.obterRota('r1'))?.motoristaId, 'm1');
});

test('observação da rota: longa demais → 400 sem gravar; rota que não existe → 404', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarRota('r1', { ...ROTA, observacao: 'antiga' });
  const longa = await trocarObservacaoDaRota(repo, 'r1', { observacao: 'x'.repeat(301) });
  assert.equal(longa.ok, false);
  if (!longa.ok) assert.equal(longa.status, 400);
  assert.equal((await repo.obterRota('r1'))?.observacao, 'antiga');
  const sumida = await trocarObservacaoDaRota(repo, 'nao-existe', { observacao: 'x' });
  assert.equal(sumida.ok, false);
  if (!sumida.ok) assert.equal(sumida.status, 404);
});
