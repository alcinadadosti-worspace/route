import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aguardandoEscolhaDeModo, retiradaDuvidosa, sugerirModoEntrega } from './retirada.js';

test('modFrete=9 sugere retirada; =1 sugere rota', () => {
  assert.equal(sugerirModoEntrega('9'), 'retirada');
  assert.equal(sugerirModoEntrega('1'), 'rota');
});

test('código desconhecido não vira palpite — a pergunta vai sem sugestão', () => {
  // A fixture de teste traz modFrete=0 (CIF), que não aparece em nenhuma das
  // 3507 notas reais deste emissor. Chutar num código novo classificaria errado
  // em silêncio; melhor perguntar sem palpite.
  assert.equal(sugerirModoEntrega(undefined), null);
});

test('a dúvida é a nota "sem transporte" QUE MESMO ASSIM tem lote de remessa', () => {
  // O ERP agrupou aquela mercadoria num carregamento: se o palpite de retirada
  // estiver errado, é aqui. São 39% das notas modFrete=9 na base real.
  assert.equal(retiradaDuvidosa({ modFrete: '9', lote: '48421133' }), true);
  assert.equal(retiradaDuvidosa({ modFrete: '9', lote: null }), false);
});

test('nota de rota nunca é duvidosa, nem com lote', () => {
  // Nenhuma das 1686 notas modFrete=1 da base real se parece com retirada:
  // todas têm caixa embalada e lote. Lote nelas é o normal, não sinal.
  assert.equal(retiradaDuvidosa({ modFrete: '1', lote: '48421133' }), false);
  assert.equal(retiradaDuvidosa({ modFrete: undefined, lote: '48421133' }), false);
});

test('só a sugestão de RETIRADA levanta pergunta — rota segue direto', () => {
  assert.equal(aguardandoEscolhaDeModo({ modFrete: '9', modoEntrega: undefined }), true);
  assert.equal(aguardandoEscolhaDeModo({ modFrete: '1', modoEntrega: undefined }), false);
  // Pedido importado antes do campo existir não fica preso numa pergunta que
  // ninguém pode responder.
  assert.equal(aguardandoEscolhaDeModo({ modFrete: undefined, modoEntrega: undefined }), false);
});

test('respondida, a pergunta não volta — inclusive quando a resposta foi "vai para rota"', () => {
  // Sem isto, escolher rota devolveria o pedido à fila de decisão para sempre:
  // o modFrete continua '9' no doc, porque é fato da nota, não a decisão.
  assert.equal(aguardandoEscolhaDeModo({ modFrete: '9', modoEntrega: 'rota' }), false);
  assert.equal(aguardandoEscolhaDeModo({ modFrete: '9', modoEntrega: 'retirada' }), false);
});
