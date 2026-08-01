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

/** Insere um bloco <entrega> como irmão do <dest> (as NF-e reais deste emitente
 * não trazem o bloco; sintetizamos para exercitar a seção 8.4). */
function comEntrega(bloco: string): string {
  return xml.replace('</dest>', `</dest>${bloco}`);
}

test('sem bloco <entrega>, a nota não tem endereço de entrega', async () => {
  const resultado = await parseNfe(xml);
  assert.ok(resultado.ok);
  assert.equal(resultado.nota.enderecoEntrega, undefined);
});

test('bloco <entrega> DIVERGENTE do fiscal vira endereço de entrega', async () => {
  const resultado = await parseNfe(
    comEntrega(
      '<entrega><xLgr>RUA DA ENTREGA</xLgr><nro>500</nro><xBairro>CENTRO</xBairro>' +
        '<xMun>MACEIO</xMun><UF>AL</UF><CEP>57000000</CEP></entrega>',
    ),
  );
  assert.ok(resultado.ok);
  const e = resultado.nota.enderecoEntrega;
  assert.equal(e?.logradouro, 'RUA DA ENTREGA');
  assert.equal(e?.numero, '500');
  assert.equal(e?.municipio, 'MACEIO');
  assert.equal(e?.cep, '57000000');
});

test('bloco <entrega> IGUAL ao fiscal é ignorado (cópia inócua)', async () => {
  const resultado = await parseNfe(
    comEntrega(
      '<entrega><xLgr>POVOADO BREJO DOS BOIS</xLgr><nro>83</nro><xBairro>ZONA RURAL</xBairro>' +
        '<xMun>JUNQUEIRO</xMun><UF>AL</UF><CEP>57270000</CEP></entrega>',
    ),
  );
  assert.ok(resultado.ok);
  assert.equal(resultado.nota.enderecoEntrega, undefined);
});

test('bloco <entrega> sem logradouro (só documento) é ignorado', async () => {
  const resultado = await parseNfe(comEntrega('<entrega><CNPJ>14750618000155</CNPJ></entrega>'));
  assert.ok(resultado.ok);
  assert.equal(resultado.nota.enderecoEntrega, undefined);
});

test('nota de ENTRADA é recusada — mercadoria voltando não gera entrega', async () => {
  // As 66 notas tpNF=0 das 3507 reais passavam no parser e viravam pedido, com
  // nome de revendedora e endereço legítimos: o motorista iria à porta buscar
  // quem já devolveu. Nada na tela as distinguia de uma venda.
  const resultado = await parseNfe(xml.replace('<tpNF>1</tpNF>', '<tpNF>0</tpNF>'));
  assert.equal(resultado.ok, false);
  assert.match(resultado.ok ? '' : resultado.motivo, /não gera entrega/);
});

test('a recusa nomeia devolução quando finNFe=4 — o operador precisa saber o que chegou', async () => {
  const resultado = await parseNfe(
    xml.replace('<tpNF>1</tpNF>', '<tpNF>0</tpNF>').replace('<finNFe>1</finNFe>', '<finNFe>4</finNFe>'),
  );
  assert.equal(resultado.ok, false);
  assert.match(resultado.ok ? '' : resultado.motivo, /devolução/);
});

test('modFrete é lido como fato da nota (sugere retirada × rota)', async () => {
  const nove = await parseNfe(xml.replace('<modFrete>0</modFrete>', '<modFrete>9</modFrete>'));
  assert.ok(nove.ok);
  assert.equal(nove.nota.modFrete, '9');

  const um = await parseNfe(xml.replace('<modFrete>0</modFrete>', '<modFrete>1</modFrete>'));
  assert.ok(um.ok);
  assert.equal(um.nota.modFrete, '1');
});

test('modFrete fora de 1/9 não vira palpite', async () => {
  // A fixture traz 0 (CIF), que não existe nas notas reais deste emissor.
  // Chutar num código novo classificaria errado em silêncio.
  const resultado = await parseNfe(xml);
  assert.ok(resultado.ok);
  assert.equal(resultado.nota.modFrete, undefined);
});
