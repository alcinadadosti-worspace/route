import { test } from 'node:test';
import assert from 'node:assert/strict';
import { produtosDistintos, quantidadeDeItens } from './itens.js';

test('com lista, item é a SOMA das quantidades — não a contagem de linhas', () => {
  // Nas notas reais são 8,3 linhas para 24,1 unidades: três vezes de diferença.
  const itens = [
    { codigo: 'a', descricao: 'GEL', quantidade: 3 },
    { codigo: 'b', descricao: 'CREME', quantidade: 5 },
  ];
  assert.equal(quantidadeDeItens({ itens }), 8);
  assert.equal(produtosDistintos({ itens }), 2);
});

test('pedido da PLANILHA não tem lista: vale a quantidade do ERP', () => {
  // O bug que motivou o módulo: somar `itens.length` aqui devolvia ZERO — a
  // produtividade do mês dizia "0 itens entregues" com o caminhão cheio.
  assert.equal(quantidadeDeItens({ itens: [], quantidadeMateriais: 7 }), 7);
  assert.equal(quantidadeDeItens({ quantidadeMateriais: 7 }), 7);
});

test('produtos distintos é NULL na planilha — "não sei" não pode virar "nenhum"', () => {
  assert.equal(produtosDistintos({ itens: [], quantidadeMateriais: 7 }), null);
  // Sem lista e sem quantidade, aí sim é zero de verdade.
  assert.equal(produtosDistintos({ itens: [] }), 0);
});

test('a lista manda quando existe, mesmo com a quantidade do ERP junto', () => {
  const itens = [{ codigo: 'a', descricao: 'GEL', quantidade: 4 }];
  assert.equal(quantidadeDeItens({ itens, quantidadeMateriais: 99 }), 4);
});

test('dado torto não derruba a conta', () => {
  assert.equal(quantidadeDeItens({}), 0);
  assert.equal(quantidadeDeItens({ itens: null, quantidadeMateriais: null }), 0);
  assert.equal(quantidadeDeItens({ quantidadeMateriais: -3 }), 0);
  assert.equal(
    quantidadeDeItens({ itens: [{ codigo: 'a', descricao: 'X', quantidade: NaN }] }),
    0,
  );
});
