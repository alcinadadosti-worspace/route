import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pedido } from '@rota/shared';
import { diaDeEntrada, diasComPedidos, separarPorOrigem, type PedidoComId } from './origemPedidos.js';

/** Pedido inventado; `extra` diz de onde ele veio. */
function pedido(id: string, numeroNota: number, emitidoEm: string, extra: Partial<Pedido> = {}): PedidoComId {
  return {
    id,
    numeroNota,
    serie: 0,
    numeroPedido: id,
    lote: null,
    clienteId: `c-${id}`,
    emitidoEm,
    itens: [],
    valorTotal: 0,
    volumes: 1,
    pesoBrutoKg: 0,
    status: 'pronto_para_rota',
    rotaId: null,
    xmlStoragePath: null,
    cdId: 'penedo',
    ...extra,
  };
}

const PEDIDOS = [
  pedido('r1', 30, '2026-10-28T08:52:00-03:00', { romaneio: '1678242', cdId: 'palmeira' }),
  pedido('r2', 10, '2026-10-28T08:52:00-03:00', { romaneio: '1678242', cdId: 'palmeira' }),
  pedido('r3', 20, '2026-10-27T16:56:00-03:00', { romaneio: '1677001' }),
  pedido('d1', 40, '2026-10-28T09:10:00-03:00', { digitado: { por: 'admin-1', em: '2026-10-28T09:10:00-03:00' } }),
  pedido('d2', 41, '2026-10-28T11:30:00-03:00', { digitado: { por: 'admin-1', em: '2026-10-28T11:30:00-03:00' } }),
  // Planilha do ERP e XML: têm documento de origem, ficam fora desta aba.
  pedido('p1', 50, '2026-10-28T07:00:00-03:00', { lote: 'L1' }),
  pedido('x1', 60, '2026-10-28T07:00:00-03:00'),
];

test('separa romaneio (por folha) e digitado; planilha e XML ficam de fora', () => {
  const r = separarPorOrigem(PEDIDOS, null);
  assert.equal(r.totalViaRomaneio, 3);
  assert.deepEqual(
    r.romaneios.map((g) => [g.numero, g.dia, g.cdId, g.pedidos.map((p) => p.id)]),
    [
      // Folha mais recente primeiro; dentro dela, pela nota.
      ['1678242', '2026-10-28', 'palmeira', ['r2', 'r1']],
      ['1677001', '2026-10-27', 'penedo', ['r3']],
    ],
  );
  // Digitado mais recente primeiro.
  assert.deepEqual(r.digitados.map((p) => p.id), ['d2', 'd1']);
});

test('filtrar por dia conta só o que entrou naquele dia', () => {
  const r = separarPorOrigem(PEDIDOS, '2026-10-27');
  assert.equal(r.totalViaRomaneio, 1);
  assert.deepEqual(r.romaneios.map((g) => g.numero), ['1677001']);
  assert.deepEqual(r.digitados, []);
  assert.deepEqual(diasComPedidos(PEDIDOS), ['2026-10-28', '2026-10-27']);
});

test('digitado conta como digitado mesmo com número de romaneio; folha sem número fica junta', () => {
  const r = separarPorOrigem(
    [
      pedido('a', 1, '2026-10-28T08:00:00-03:00', {
        romaneio: '1678242',
        digitado: { por: 'admin-1', em: '2026-10-28T08:00:00-03:00' },
      }),
      pedido('b', 2, '2026-10-28T08:00:00-03:00', { romaneio: '' }),
      pedido('c', 3, '2026-10-28T08:00:00-03:00', { romaneio: ' ' }),
    ],
    null,
  );
  assert.deepEqual(r.digitados.map((p) => p.id), ['a']);
  assert.deepEqual(r.romaneios.map((g) => [g.numero, g.pedidos.length]), [['', 2]]);
});

test('o dia de entrada do digitado é quando foi digitado; data quebrada não vira dia', () => {
  assert.equal(
    diaDeEntrada({ emitidoEm: '2026-10-27T23:00:00-03:00', digitado: { por: 'x', em: '2026-10-28T00:10:00-03:00' } }),
    '2026-10-28',
  );
  assert.equal(diaDeEntrada({ emitidoEm: '' }), null);
});

test('dado torto do banco não derruba a aba: romaneio nulo não é romaneio, digitado sem data entra', () => {
  const r = separarPorOrigem(
    [
      pedido('n', 1, '2026-10-28T08:00:00-03:00', { romaneio: null as unknown as string }),
      pedido('s', 2, '2026-10-28T08:00:00-03:00', { digitado: { por: 'x' } as unknown as Pedido['digitado'] }),
      pedido('t', 3, '2026-10-28T09:00:00-03:00', { digitado: { por: 'x', em: '2026-10-28T09:00:00-03:00' } }),
    ],
    null,
  );
  assert.equal(r.totalViaRomaneio, 0);
  assert.deepEqual(r.digitados.map((p) => p.id), ['t', 's']);
});
