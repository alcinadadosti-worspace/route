import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarApp } from '../app.js';
import { RepositorioMemoria } from '../db/repositorio.js';
import type { Autenticador } from './autenticador.js';

// Verificador falso: troca a verificação real do Firebase (rede) por tokens
// fixos, para exercitar o hook — token → usuário/papel.
const autenticador: Autenticador = {
  async verificar(token) {
    if (token === 'tk-admin') return { uid: 'u-admin', papel: 'admin' };
    if (token === 'tk-operador') return { uid: 'u-op', papel: 'operador' };
    if (token === 'tk-motorista') return { uid: 'u-mot', papel: 'motorista' };
    return null;
  },
};

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

test('/health fica público (health check do Render)', async () => {
  const app = await criarApp({ repo: new RepositorioMemoria(), autenticador });
  const r = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(r.statusCode, 200);
  await app.close();
});

test('rota de escritório sem token → 401', async () => {
  const app = await criarApp({ repo: new RepositorioMemoria(), autenticador });
  const r = await app.inject({ method: 'GET', url: '/api/rotas' });
  assert.equal(r.statusCode, 401);
  await app.close();
});

test('token inválido → 401', async () => {
  const app = await criarApp({ repo: new RepositorioMemoria(), autenticador });
  const r = await app.inject({ method: 'GET', url: '/api/rotas', headers: bearer('lixo') });
  assert.equal(r.statusCode, 401);
  await app.close();
});

test('papel sem permissão (motorista em rota de escritório) → 403', async () => {
  const app = await criarApp({ repo: new RepositorioMemoria(), autenticador });
  const r = await app.inject({ method: 'GET', url: '/api/rotas', headers: bearer('tk-motorista') });
  assert.equal(r.statusCode, 403);
  await app.close();
});

test('admin acessa rota de escritório', async () => {
  const app = await criarApp({ repo: new RepositorioMemoria(), autenticador });
  const r = await app.inject({ method: 'GET', url: '/api/rotas', headers: bearer('tk-admin') });
  assert.equal(r.statusCode, 200);
  await app.close();
});

test('processar trilhas exige só token válido — motorista passa da auth', async () => {
  const app = await criarApp({ repo: new RepositorioMemoria(), autenticador });
  // Sem OSRM o handler responde 503, mas isso já é DEPOIS da auth: o que
  // importa é não ser 401/403.
  const r = await app.inject({
    method: 'POST',
    url: '/api/trilhas/processar',
    headers: bearer('tk-motorista'),
  });
  assert.notEqual(r.statusCode, 401);
  assert.notEqual(r.statusCode, 403);
  await app.close();
});

test('processar trilhas sem token → 401', async () => {
  const app = await criarApp({ repo: new RepositorioMemoria(), autenticador });
  const r = await app.inject({ method: 'POST', url: '/api/trilhas/processar' });
  assert.equal(r.statusCode, 401);
  await app.close();
});

test('sem autenticador a API segue aberta (dev/CI)', async () => {
  const app = await criarApp({ repo: new RepositorioMemoria() });
  const r = await app.inject({ method: 'GET', url: '/api/rotas' });
  assert.equal(r.statusCode, 200);
  await app.close();
});
