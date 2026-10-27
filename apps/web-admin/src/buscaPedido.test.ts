import { test } from 'node:test';
import assert from 'node:assert/strict';
import { casaBusca, ondeEstaOPedido } from './buscaPedido.js';

const P = { id: '536361204', numeroPedido: '536361204', numeroNota: 302856 };

test('número procura no pedido e na nota, com ou sem pontuação colada', () => {
  for (const termo of ['536361204', '536.361.204', ' 536 361 204 ', '361204', '302856']) {
    assert.equal(casaBusca(P, 'JOSÉ DA SILVA', termo), true, termo);
  }
  assert.equal(casaBusca(P, 'JOSÉ DA SILVA', '999999'), false);
});

test('nota no formato da tela ("302856/1") acha; série errada não', () => {
  const comSerie = { ...P, serie: 1 };
  assert.equal(casaBusca(comSerie, 'X', '302856/1'), true);
  assert.equal(casaBusca(comSerie, 'X', '302856 / 1'), true);
  assert.equal(casaBusca(comSerie, 'X', '302856/0'), false);
  assert.equal(casaBusca(comSerie, 'X', '30285/1'), false, 'nota inteira, não trecho');
});

test('texto procura no nome da cliente, sem acento nem caixa; vazio casa tudo', () => {
  assert.equal(casaBusca(P, 'JOSÉ DA SILVA', 'jose silva'), false, 'é trecho, não palavras soltas');
  assert.equal(casaBusca(P, 'JOSÉ DA SILVA', 'jose da'), true);
  assert.equal(casaBusca(P, 'JOSÉ DA SILVA', ''), true);
  // Nome com número não é tratado como número.
  assert.equal(casaBusca(P, 'MARIA 2', 'maria 2'), true);
});

test('o número da rota do romaneio do Boticário acha a folha inteira — só inteiro', () => {
  const doRomaneio = { ...P, romaneio: '1673300' };
  assert.equal(casaBusca(doRomaneio, 'X', '1673300'), true);
  assert.equal(casaBusca(doRomaneio, 'X', '1.673.300'), true);
  assert.equal(casaBusca(doRomaneio, 'X', '16733'), false, 'trecho traria pedidos de outras folhas');
  assert.equal(casaBusca(P, 'X', '1673300'), false);
});

test('o código do pedido do SITE, colado como a folha imprime ("160000001-1"), acha o pedido', () => {
  const doSite = { ...P, id: '160000001-1', numeroPedido: '160000001-1' };
  assert.equal(casaBusca(doSite, 'X', '160000001-1'), true);
  assert.equal(casaBusca(doSite, 'X', '160000001'), true);
  assert.equal(casaBusca(doSite, 'X', '160000001-2'), false);
  // Entrou primeiro pela planilha: id do ERP, código do site no externo.
  const daPlanilha = { ...P, id: '530000002', numeroPedido: '530000002', codigoExterno: '160000001-1' };
  assert.equal(casaBusca(daPlanilha, 'X', '160000001-1'), true);
});

test('onde está: rota com o dia, e o que fazer quando está fora da montagem', () => {
  assert.match(
    ondeEstaOPedido({ status: 'em_rota', rotaId: '2026-10-20_abcdef01' }),
    /rota publicada \(20\/10, 2026-10-20_abcdef01\)/,
  );
  assert.match(ondeEstaOPedido({ status: 'entregue_no_erp', rotaId: null }), /libere em "Fora da montagem"/);
  assert.match(ondeEstaOPedido({ status: 'retirada', rotaId: null }), /retirada na central/);
  assert.match(ondeEstaOPedido({ status: 'pendente_de_mapeamento', rotaId: null }), /exceção/);
});
