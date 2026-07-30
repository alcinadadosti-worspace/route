import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Entrega } from '@rota/shared';
import { criarApp } from './app.js';
import { RepositorioMemoria } from './db/repositorio.js';
import type { Autenticador } from './auth/autenticador.js';

/**
 * `GET /api/rotas/:rotaId/entregas` — o motivo do insucesso, a hora e a posição
 * da confirmação. A parada guarda só 'insucesso'; sem este endpoint o
 * escritório via a falha sem saber por quê, que é o que ele precisa para ligar
 * ao cliente.
 */

const autenticador: Autenticador = {
  async verificar(token) {
    if (token === 'tk-admin') return { uid: 'u-admin', papel: 'admin' };
    if (token === 'tk-motorista') return { uid: 'u-mot', papel: 'motorista' };
    return null;
  },
};
const admin = { authorization: 'Bearer tk-admin' };

function entrega(rotaId: string, pedidoId: string, resultado: Entrega['resultado']): Entrega {
  return {
    pedidoId,
    rotaId,
    clienteId: `c-${pedidoId}`,
    resultado,
    confirmadaEm: '2026-07-29T09:00:00-03:00',
    posicaoConfirmacao: null,
    gravadaPor: 'u-mot',
  };
}

const ROTA_A = '2026-07-29_aaaaaaaa';
const ROTA_B = '2026-07-29_bbbbbbbb';

async function comEntregas() {
  const repo = new RepositorioMemoria();
  repo.entregas = [
    entrega(ROTA_A, 'p1', 'entregue'),
    entrega(ROTA_A, 'p2', 'ausente'),
    entrega(ROTA_B, 'p3', 'recusa'),
  ];
  return { repo, app: await criarApp({ repo, autenticador }) };
}

test('devolve só as entregas da rota pedida, com o motivo', async () => {
  const { app } = await comEntregas();
  const r = await app.inject({ method: 'GET', url: `/api/rotas/${ROTA_A}/entregas`, headers: admin });
  assert.equal(r.statusCode, 200);
  const corpo = r.json() as Entrega[];
  assert.equal(corpo.length, 2, 'a entrega da outra rota não pode vazar');
  assert.deepEqual(
    corpo.map((e) => e.resultado).sort(),
    ['ausente', 'entregue'],
    'o motivo é justamente o que a parada não guarda',
  );
  await app.close();
});

test('rotaId fora do formato é recusado antes de virar consulta', async () => {
  const { app } = await comEntregas();
  for (const id of ['../pedidos', 'rota-1', '2026-07-29']) {
    const r = await app.inject({
      method: 'GET',
      url: `/api/rotas/${encodeURIComponent(id)}/entregas`,
      headers: admin,
    });
    assert.equal(r.statusCode, 400, `${id} deveria ser recusado`);
  }
  await app.close();
});

test('é do escritório: motorista não lista confirmação de rota', async () => {
  const { app } = await comEntregas();
  const r = await app.inject({
    method: 'GET',
    url: `/api/rotas/${ROTA_A}/entregas`,
    headers: { authorization: 'Bearer tk-motorista' },
  });
  assert.equal(r.statusCode, 403);
  await app.close();
});

test('rota sem confirmação nenhuma devolve lista vazia, não erro', async () => {
  const { app } = await comEntregas();
  const r = await app.inject({
    method: 'GET',
    url: '/api/rotas/2026-07-29_cccccccc/entregas',
    headers: admin,
  });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), []);
  await app.close();
});
