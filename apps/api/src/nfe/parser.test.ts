import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseNfe } from './parser.js';

let xml: string;

before(async () => {
  xml = await readFile(new URL('../../test/fixtures/nfe-276165.xml', import.meta.url), 'utf8');
});

test('extrai todos os campos da NF-e 276165 (critério de aceite da Fase 1)', async () => {
  const resultado = await parseNfe(xml);
  assert.ok(resultado.ok, 'nota deveria ser aceita');
  const nota = resultado.nota;

  assert.equal(nota.chaveAcesso, '27260314750618000155550010002761651000070282');
  assert.equal(nota.numeroNota, 276165);
  assert.equal(nota.serie, 1);
  assert.equal(nota.emitidoEm, '2026-03-11T09:14:00-03:00');

  assert.equal(nota.numeroPedido, '499450697');
  assert.equal(nota.lote, '47097393');

  assert.equal(nota.itens.length, 10);
  assert.deepEqual(nota.itens[0], {
    codigo: '101001',
    descricao: 'COLONIA FLORAL 100ML',
    quantidade: 1,
  });

  assert.equal(nota.valorTotal, 760.69);
  assert.equal(nota.volumes, 1);
  assert.equal(nota.pesoBrutoKg, 3.113);

  const dest = nota.destinatario;
  assert.equal(dest.nome, 'MARIA JOSE DA SILVA');
  assert.equal(dest.documentoMascarado, '***.***.***-82');
  assert.equal(dest.telefone, '+5582999887766');
  assert.equal(dest.email, 'maria.exemplo@gmail.com');
  assert.equal(dest.enderecoFiscal.logradouro, 'POVOADO BREJO DOS BOIS');
  assert.equal(dest.enderecoFiscal.numero, '83');
  assert.equal(dest.enderecoFiscal.complemento, 'PROX A PISCINA');
  assert.equal(dest.enderecoFiscal.bairro, 'ZONA RURAL');
  assert.equal(dest.enderecoFiscal.municipio, 'JUNQUEIRO');
  assert.equal(dest.enderecoFiscal.uf, 'AL');
  assert.equal(dest.enderecoFiscal.cep, '57270000');
  assert.match(dest.clienteId, /^[0-9a-f]{64}$/);
});

test('rejeita XML que não é nfeProc', async () => {
  const resultado = await parseNfe('<outro><coisa/></outro>');
  assert.equal(resultado.ok, false);
});

test('rejeita XML não parseável', async () => {
  const resultado = await parseNfe('isto não é xml <<<');
  assert.equal(resultado.ok, false);
});

test('rejeita modelo diferente de 55', async () => {
  const resultado = await parseNfe(xml.replace('<mod>55</mod>', '<mod>65</mod>'));
  assert.equal(resultado.ok, false);
  if (!resultado.ok) assert.match(resultado.motivo, /Modelo 65/);
});

test('rejeita nota não autorizada (cStat diferente de 100)', async () => {
  const resultado = await parseNfe(xml.replace('<cStat>100</cStat>', '<cStat>110</cStat>'));
  assert.equal(resultado.ok, false);
  if (!resultado.ok) assert.match(resultado.motivo, /cStat=110/);
});
