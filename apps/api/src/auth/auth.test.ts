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

/* ---------- /api/pedidos/:chave/modo-entrega (camada HTTP) ---------- */

test('modo-entrega é rota de ESCRITÓRIO: motorista → 403', async () => {
  const app = await criarApp({ repo: new RepositorioMemoria(), autenticador });
  const r = await app.inject({
    method: 'POST',
    url: '/api/pedidos/27260314750618000155550010002761651000070282/modo-entrega',
    headers: bearer('tk-motorista'),
    payload: { escolha: 'retirada' },
  });
  assert.equal(r.statusCode, 403);
  await app.close();
});

test('modo-entrega: chave malformada → 404 antes de tocar o banco', async () => {
  const app = await criarApp({ repo: new RepositorioMemoria(), autenticador });
  const r = await app.inject({
    method: 'POST',
    url: '/api/pedidos/nao-e-chave/modo-entrega',
    headers: bearer('tk-admin'),
    payload: { escolha: 'retirada' },
  });
  assert.equal(r.statusCode, 404);
  await app.close();
});

test('modo-entrega: escolha inválida → 400 com a mensagem do serviço', async () => {
  const app = await criarApp({ repo: new RepositorioMemoria(), autenticador });
  const r = await app.inject({
    method: 'POST',
    url: '/api/pedidos/27260314750618000155550010002761651000070282/modo-entrega',
    headers: bearer('tk-admin'),
    payload: { escolha: 'balcao' },
  });
  assert.equal(r.statusCode, 400);
  assert.match(JSON.parse(r.body).erro, /rota ou retirada/);
  await app.close();
});

/* ---------- /api/importacoes: limites dimensionados pela remessa REAL ---------- */

/** Monta um corpo multipart com N arquivos minúsculos (conteúdo inválido de
 * propósito — o que se testa aqui é o TRANSPORTE, não o parser). */
function corpoMultipart(n: number): { payload: string; headers: Record<string, string> } {
  const b = 'fronteira-teste';
  const partes: string[] = [];
  for (let i = 0; i < n; i++) {
    partes.push(
      `--${b}\r\ncontent-disposition: form-data; name="arquivos"; filename="n${i}.xml"\r\n` +
        `content-type: text/xml\r\n\r\nnao-e-xml\r\n`,
    );
  }
  partes.push(`--${b}--\r\n`);
  return {
    payload: partes.join(''),
    headers: { 'content-type': `multipart/form-data; boundary=${b}` },
  };
}

test('importação aceita a remessa do tamanho REAL: 125 arquivos (o lote diário) num envio só', async () => {
  // O teto antigo era 60, dimensionado antes de medir o volume: o lote diário
  // do ERP tem ~125 notas e um ciclo inteiro tem ~2050. Com 60, o dia REAL
  // estourava o limite TODO DIA — e, por ser streaming, os 60 primeiros
  // entravam e o resto virava 500: importação parcial escondida num erro.
  const app = await criarApp({ repo: new RepositorioMemoria(), autenticador });
  const { payload, headers } = corpoMultipart(125);
  const r = await app.inject({
    method: 'POST',
    url: '/api/importacoes',
    headers: { ...headers, ...bearer('tk-admin') },
    payload,
  });
  assert.equal(r.statusCode, 200);
  const rel = JSON.parse(r.body);
  assert.equal(rel.total, 125);
  // nada de "(remessa interrompida)" no fim
  assert.ok(!rel.rejeitados.some((x: { arquivo: string }) => x.arquivo.includes('interrompida')));
  await app.close();
});

test('estourar o teto não vira 500: o relatório sai com o aviso de remessa interrompida', async () => {
  // Streaming: o que veio antes do estouro JÁ FOI processado. Um 500 esconderia
  // isso do operador. O teto real é 4000; aqui manda 4001.
  const app = await criarApp({ repo: new RepositorioMemoria(), autenticador });
  const { payload, headers } = corpoMultipart(4001);
  const r = await app.inject({
    method: 'POST',
    url: '/api/importacoes',
    headers: { ...headers, ...bearer('tk-admin') },
    payload,
  });
  assert.equal(r.statusCode, 200);
  const rel = JSON.parse(r.body);
  assert.equal(rel.total, 4000); // processou até o teto
  const aviso = rel.rejeitados.at(-1);
  assert.match(aviso.arquivo, /interrompida/);
  assert.match(aviso.motivo, /reenvie/);
  await app.close();
});

test('/api/posicoes é rota de ESCRITÓRIO: motorista não acompanha o colega', async () => {
  const app = await criarApp({ repo: new RepositorioMemoria(), autenticador });
  const r = await app.inject({
    method: 'GET',
    url: '/api/posicoes',
    headers: bearer('tk-motorista'),
  });
  assert.equal(r.statusCode, 403);
  await app.close();
});

test('/api/posicoes devolve só as rotas EM EXECUÇÃO', async () => {
  // Rota concluída não tem posição a mostrar: fora do expediente ninguém é
  // seguido, e o app do motorista para de mandar sozinho.
  const app = await criarApp({ repo: new RepositorioMemoria(), autenticador });
  const r = await app.inject({ method: 'GET', url: '/api/posicoes', headers: bearer('tk-admin') });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), { posicoes: {} });
  await app.close();
});

test('/api/acompanhamento devolve as rotas ABERTAS, não só as em execução', async () => {
  // O bug que motivou o endpoint: o painel só ligava o polling com rota JÁ em
  // execução. Quem abrisse a tela antes de o motorista começar ficava com o
  // progresso congelado em "0/12" e sem rastreio — e nada dizia que era preciso
  // clicar em Atualizar.
  const app = await criarApp({ repo: new RepositorioMemoria(), autenticador });
  const r = await app.inject({
    method: 'GET',
    url: '/api/acompanhamento',
    headers: bearer('tk-admin'),
  });
  assert.equal(r.statusCode, 200);
  const corpo = JSON.parse(r.body);
  assert.deepEqual(corpo, { rotas: [], posicoes: {} });
  await app.close();
});

test('/api/acompanhamento é de ESCRITÓRIO', async () => {
  const app = await criarApp({ repo: new RepositorioMemoria(), autenticador });
  const r = await app.inject({
    method: 'GET',
    url: '/api/acompanhamento',
    headers: bearer('tk-motorista'),
  });
  assert.equal(r.statusCode, 403);
  await app.close();
});
