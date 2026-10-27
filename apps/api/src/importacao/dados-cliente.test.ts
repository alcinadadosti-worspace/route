import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Cliente } from '@rota/shared';
import { buscarNaBase, camposDosDados, candidatasDoCliente, salvarDadosDoCliente } from './dados-cliente.js';
import { RepositorioMemoria, type Revendedora } from '../db/repositorio.js';

function cliente(extra: Partial<Cliente> = {}): Cliente {
  return {
    nome: 'MARIA DO SITE',
    documentoMascarado: 'fora da base',
    telefone: null,
    email: null,
    enderecoFiscal: { logradouro: 'RUA A', numero: '10', bairro: 'CENTRO', municipio: 'QUEBRANGULO', uf: 'AL', cep: '' },
    coordenada: null,
    statusMapeamento: 'nao_mapeado',
    trilhaAtivaId: null,
    mapeadoPor: null,
    mapeadoEm: null,
    fotoReferenciaPath: null,
    observacoes: '',
    completarDados: true,
    ...extra,
  };
}

const ID = 'a'.repeat(64);

test('dados: telefone vira +55 como na importação; sem DDD é recusado dizendo o formato', () => {
  const r = camposDosDados({ telefone: '(82) 99999-1234', observacoes: '  casa azul depois da igreja ' });
  assert.ok(r.ok);
  assert.equal(r.campos.telefone, '+5582999991234');
  assert.equal(r.campos.observacoes, 'casa azul depois da igreja');
  assert.equal(r.campos.completarDados, false);

  const ruim = camposDosDados({ telefone: '9999-1234' });
  assert.ok(!ruim.ok);
  assert.match(ruim.erro, /DDD/);
});

test('dados: corpo vazio só tira da lista ("não tenho mais dados") — não apaga nada', () => {
  const r = camposDosDados({});
  assert.ok(r.ok);
  assert.deepEqual(r.campos, { completarDados: false });
  assert.deepEqual(camposDosDados(null), { ok: true, campos: { completarDados: false } });
});

test('dados: telefone em branco APAGA (é o Admin corrigindo); tipo errado e texto enorme são recusados', () => {
  const r = camposDosDados({ telefone: '  ' });
  assert.ok(r.ok);
  assert.equal(r.campos.telefone, null);
  assert.equal(camposDosDados({ telefone: 82999991234 }).ok, false);
  assert.equal(camposDosDados({ observacoes: 'x'.repeat(1001) }).ok, false);
  assert.equal(camposDosDados({ codigo: '../clientes/1' }).ok, false);
});

test('dados: a revendedora reconhecida na base deixa o código à vista — o id do cliente não muda', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente(ID, cliente());
  const r = await salvarDadosDoCliente(repo, ID, { telefone: '82988887777', papel: 'Ouro', codigo: '70000001' });
  assert.ok(r.ok);
  const c = await repo.obterCliente(ID);
  assert.equal(c?.telefone, '+5582988887777');
  assert.equal(c?.papel, 'Ouro');
  assert.equal(c?.documentoMascarado, 'cód. 70000001');
  assert.equal(c?.codigoErp, '70000001');
  assert.equal(c?.completarDados, false);
  // O resto do cliente fica como estava.
  assert.equal(c?.enderecoFiscal.logradouro, 'RUA A');
});

test('dados: "é ela" não vale para cliente do ERP; null desliga; telefone apagado fica MARCADO', async () => {
  assert.equal(camposDosDados({ codigo: '70000002' }, '70000001').ok, false);
  const desligar = camposDosDados({ codigo: null }, ID);
  assert.ok(desligar.ok);
  assert.equal(desligar.campos.codigoErp, null);
  assert.equal(desligar.campos.documentoMascarado, 'fora da base');
  const apagar = camposDosDados({ telefone: '' }, ID);
  assert.ok(apagar.ok);
  assert.equal(apagar.campos.telefoneApagado, true);
  const novo = camposDosDados({ telefone: '82999991234' }, ID);
  assert.ok(novo.ok);
  assert.equal(novo.campos.telefoneApagado, false);
});

test('dados: cliente inexistente → 404; dado inválido → 400 sem gravar', async () => {
  const repo = new RepositorioMemoria();
  assert.deepEqual(await salvarDadosDoCliente(repo, ID, {}), { ok: false, status: 404, erro: 'Cliente não encontrado' });
  await repo.salvarCliente(ID, cliente());
  const r = await salvarDadosDoCliente(repo, ID, { telefone: '123' });
  assert.equal(r.ok ? 0 : r.status, 400);
  assert.equal((await repo.obterCliente(ID))?.completarDados, true, 'recusado não tira da lista');
});

function rev(id: string, cidade: string, extra: Partial<Revendedora> = {}): { id: string; dados: Revendedora } {
  return {
    id,
    dados: {
      nome: 'MARIA DO SITE',
      chave: `MARIA DO SITE|${cidade.replace(/[^A-Z0-9]/g, '')}`,
      telefone: '+5582911110000',
      papel: 'Bronze',
      endereco: { logradouro: 'RUA X', numero: '1', bairro: 'CENTRO', municipio: cidade, uf: 'AL', cep: '' },
      referencia: '',
      pin: null,
      situacao: 'Ativo',
      dadosDe: null,
      ...extra,
    },
  };
}

test('busca na base: pelo começo do nome (qualquer cidade) ou pelo código; termo curto não varre nada', async () => {
  const repo = new RepositorioMemoria();
  await repo.gravarRevendedoras([
    rev('1', 'IGACI'),
    { id: '2', dados: { ...rev('2', 'PENEDO').dados, nome: 'MARIA DO SITE SANTOS', chave: 'MARIA DO SITE SANTOS|PENEDO' } },
    { id: '3', dados: { ...rev('3', 'PENEDO').dados, nome: 'JOANA', chave: 'JOANA|PENEDO' } },
  ]);
  assert.deepEqual((await buscarNaBase(repo, 'maria do site')).map((c) => c.codigo).sort(), ['1', '2']);
  assert.deepEqual((await buscarNaBase(repo, '3')).map((c) => c.nome), ['JOANA']);
  assert.deepEqual(await buscarNaBase(repo, 'ma'), []);
});

test('candidatas: mesmo nome em qualquer cidade, a MESMA cidade primeiro; nome diferente não entra', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente(ID, cliente());
  await repo.gravarRevendedoras([
    rev('1', 'IGACI', { dadosDe: '2026-09-01T00:00:00-03:00' }),
    rev('2', 'QUEBRANGULO'),
    rev('3', 'PENEDO'),
    // "MARIA DO SITE SANTOS" começa igual mas é outro nome: a faixa da chave
    // termina no "|", não no começo do texto.
    { id: '4', dados: { ...rev('4', 'QUEBRANGULO').dados, nome: 'MARIA DO SITE SANTOS', chave: 'MARIA DO SITE SANTOS|QUEBRANGULO' } },
  ]);
  const r = await candidatasDoCliente(repo, ID);
  assert.ok(r.ok);
  assert.deepEqual(r.candidatas.map((c) => c.codigo), ['2', '1', '3']);
  assert.equal(r.candidatas[0]!.endereco, 'RUA X, 1 — CENTRO, QUEBRANGULO/AL');
  assert.equal(r.candidatas[0]!.telefone, '+5582911110000');
});
