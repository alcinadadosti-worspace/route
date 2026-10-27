import { test } from 'node:test';
import assert from 'node:assert/strict';
import { celulas, codigoDoSite, textosCompartilhados } from './planilha.js';

test('sharedStrings: um <si/> vazio não engole o texto seguinte', () => {
  // Antes, o `<si/>` procurava o `</si>` do PRÓXIMO e todo índice dali em
  // diante apontava para o texto de outra célula.
  const xml = '<sst><si><t>A</t></si><si/><si><t>B</t></si><si><t>C</t></si></sst>';
  assert.deepEqual(textosCompartilhados(xml), ['A', '', 'B', 'C']);
});

test('célula inline com <t xml:space="preserve"> não sai vazia', () => {
  const linha = '<row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve"> MARIA </t></is></c></row>';
  assert.deepEqual([...celulas(linha)], [['A', ' MARIA ']]);
});

test('célula sem r= é a coluna seguinte à anterior, não some', () => {
  const linha = '<row><c r="B3"><v>1</v></c><c><v>2</v></c><c r="Z3"><v>3</v></c><c><v>4</v></c></row>';
  assert.deepEqual([...celulas(linha)], [['B', '1'], ['C', '2'], ['Z', '3'], ['AA', '4']]);
});

test('código do pedido do site: o externo da planilha no formato da folha do romaneio', () => {
  assert.equal(codigoDoSite('160000001BOT-F1'), '160000001-1');
  assert.equal(codigoDoSite('160000001EUD-F2'), '160000001-2');
  assert.equal(codigoDoSite('160000001QDB-F1'), '160000001-1');
  // Pedido de revendedora: sem código externo.
  assert.equal(codigoDoSite(''), null);
  assert.equal(codigoDoSite('qualquer coisa'), null);
});
