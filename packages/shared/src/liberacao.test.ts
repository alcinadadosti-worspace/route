import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  devolverParaForaDaMontagem,
  foraDaMontagemPeloErp,
  liberacaoDesfazivel,
  liberarParaRota,
} from './liberacao.js';
import type { Pedido } from './tipos.js';

const MARCA = { em: '2026-10-19T18:00:00.000Z', por: 'admin-1' };
const COM_PONTO = { coordenada: { lat: -10.1, lng: -36.6 }, enderecoEmRevisao: null };
const SEM_PONTO = { coordenada: null, enderecoEmRevisao: null };

function pedido(status: Pedido['status'], extra: Partial<Pedido> = {}): Pedido {
  return {
    numeroNota: 302856,
    serie: 1,
    numeroPedido: '536361204',
    lote: null,
    clienteId: '7000943',
    emitidoEm: '2026-10-15T00:00:00-03:00',
    itens: [],
    valorTotal: 100,
    volumes: 1,
    pesoBrutoKg: 2,
    status,
    rotaId: null,
    xmlStoragePath: null,
    modoEntrega: status === 'retirada' ? 'retirada' : 'rota',
    ...extra,
  };
}

test('só retirada e entregue no ERP ficam fora da montagem pelo ERP', () => {
  assert.equal(foraDaMontagemPeloErp(pedido('retirada')), true);
  assert.equal(foraDaMontagemPeloErp(pedido('entregue_no_erp')), true);
  for (const s of ['pronto_para_rota', 'em_rota', 'entregue', 'pendente_de_mapeamento'] as const) {
    assert.equal(foraDaMontagemPeloErp(pedido(s)), false, s);
  }
});

test('liberar: com ponto vai pronto; sem ponto, para o mapeamento; retirada vira rota', () => {
  const pronto = liberarParaRota(pedido('entregue_no_erp'), COM_PONTO, MARCA);
  assert.ok(pronto.ok);
  if (pronto.ok) {
    assert.equal(pronto.pedido.status, 'pronto_para_rota');
    assert.deepEqual(pronto.pedido.liberadoParaRota, { de: 'entregue_no_erp', ...MARCA });
  }

  const retirada = liberarParaRota(pedido('retirada'), SEM_PONTO, MARCA);
  assert.ok(retirada.ok);
  if (retirada.ok) {
    assert.equal(retirada.pedido.status, 'pendente_de_mapeamento');
    // Sem isto a montagem e a publicação continuariam tratando como retirada.
    assert.equal(retirada.pedido.modoEntrega, 'rota');
    assert.equal(retirada.pedido.liberadoParaRota!.de, 'retirada');
  }
});

test('liberar com endereço em revisão vai para Decisões, levando o endereço anterior', () => {
  const r = liberarParaRota(
    pedido('retirada'),
    { coordenada: { lat: -10.1, lng: -36.6 }, enderecoEmRevisao: { logradouro: 'VELHA' } as never },
    MARCA,
  );
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.pedido.status, 'pendente_de_decisao');
    // É por ele que a aba Decisões desenha o cartão e a resposta acha o pedido.
    assert.equal(r.pedido.enderecoAnterior?.logradouro, 'VELHA');
  }
});

test('retirada com GPS do cadastro e cliente sem ponto: o ponto vem junto e ela sai pronta', () => {
  const gps = { lat: -10.286906, lng: -36.549603 };
  const r = liberarParaRota(pedido('retirada', { pinDoCadastro: gps }), SEM_PONTO, MARCA);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.pedido.status, 'pronto_para_rota');
    assert.deepEqual(r.pontoDoCliente, gps);
  }
  // Cliente que já tem ponto (pin de campo) não é trocado pelo do cadastro.
  const comPonto = liberarParaRota(pedido('retirada', { pinDoCadastro: gps }), COM_PONTO, MARCA);
  assert.ok(comPonto.ok);
  if (comPonto.ok) assert.equal(comPonto.pontoDoCliente, undefined);
});

test('liberar recusa o que não está fora da montagem', () => {
  for (const s of ['pronto_para_rota', 'em_rota', 'entregue', 'insucesso'] as const) {
    const r = liberarParaRota(pedido(s), COM_PONTO, MARCA);
    assert.equal(r.ok, false, s);
  }
});

test('desfazer devolve para onde estava, e só antes de sair numa rota', () => {
  const lib = liberarParaRota(pedido('retirada'), COM_PONTO, MARCA);
  assert.ok(lib.ok);
  if (!lib.ok) return;
  assert.equal(liberacaoDesfazivel(lib.pedido), true);
  const volta = devolverParaForaDaMontagem(lib.pedido);
  assert.ok(volta.ok);
  if (volta.ok) {
    assert.equal(volta.pedido.status, 'retirada');
    assert.equal(volta.pedido.modoEntrega, 'retirada');
    assert.equal('liberadoParaRota' in volta.pedido, false);
  }

  // Já no caminhão: desfazer aqui deixaria a rota com um pedido "retirada".
  const naRota = { ...lib.pedido, status: 'em_rota' as const, rotaId: '2026-10-19_abcdef01' };
  assert.equal(liberacaoDesfazivel(naRota), false);
  assert.equal(devolverParaForaDaMontagem(naRota).ok, false);
  // Pronto que nunca foi liberado não tem para onde "voltar".
  assert.equal(devolverParaForaDaMontagem(pedido('pronto_para_rota')).ok, false);
});
