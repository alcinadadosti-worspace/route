import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Cliente, Pedido } from '@rota/shared';
import { listarForaDaMontagem, type FiltroForaDaMontagem } from './foraDaMontagem.js';

function pedido(id: string, status: Pedido['status'], clienteId: string, emitidoEm: string, extra: Partial<Pedido> = {}) {
  return {
    id,
    numeroNota: Number(id),
    serie: 1,
    numeroPedido: `5363${id}`,
    lote: null,
    clienteId,
    emitidoEm,
    itens: [],
    valorTotal: 1,
    volumes: 1,
    pesoBrutoKg: 1,
    status,
    rotaId: null,
    xmlStoragePath: null,
    ...extra,
  } as { id: string } & Pedido;
}

function cliente(nome: string, municipio: string): Cliente {
  return { nome, enderecoFiscal: { municipio } } as unknown as Cliente;
}

const CLIENTES = {
  a: cliente('JOSÉ DA SILVA', "OLHO D'ÁGUA GRANDE"),
  b: cliente('MARIA SOUZA', 'OLHO DÁGUA GRANDE'),
  c: cliente('ANA LIMA', 'PENEDO'),
};

const PEDIDOS = [
  pedido('100', 'retirada', 'a', '2026-10-10T00:00:00-03:00'),
  pedido('101', 'entregue_no_erp', 'b', '2026-10-15T00:00:00-03:00'),
  pedido('102', 'entregue_no_erp', 'c', '2026-10-12T00:00:00-03:00'),
  pedido('103', 'pronto_para_rota', 'c', '2026-10-16T00:00:00-03:00', {
    liberadoParaRota: { de: 'retirada', em: '2026-10-19T00:00:00Z', por: 'x' },
  }),
  // Liberado que já saiu numa rota não se desfaz — não aparece em "liberados".
  pedido('104', 'em_rota', 'c', '2026-10-16T00:00:00-03:00', {
    liberadoParaRota: { de: 'entregue_no_erp', em: '2026-10-19T00:00:00Z', por: 'x' },
  }),
  pedido('105', 'pronto_para_rota', 'c', '2026-10-16T00:00:00-03:00'),
];

const TODOS: FiltroForaDaMontagem = { vista: 'fora', tipo: 'todos', cidade: '', busca: '' };
const ids = (r: ReturnType<typeof listarForaDaMontagem>) => r.linhas.map((l) => l.pedido.id);

test('fora da montagem: retiradas e entregues no ERP, mais recentes primeiro, com a contagem', () => {
  const r = listarForaDaMontagem(PEDIDOS, CLIENTES, TODOS);
  assert.deepEqual(ids(r), ['101', '102', '100']);
  assert.deepEqual(r.contagem, { retiradas: 1, entreguesNoErp: 2, liberados: 1 });
});

test('filtro por tipo, e cidade com e sem apóstrofo é uma opção só', () => {
  assert.deepEqual(ids(listarForaDaMontagem(PEDIDOS, CLIENTES, { ...TODOS, tipo: 'retirada' })), ['100']);
  const r = listarForaDaMontagem(PEDIDOS, CLIENTES, TODOS);
  assert.deepEqual(
    r.cidades.map((c) => [c.nome, c.n]),
    [["OLHO D'ÁGUA GRANDE", 2], ['PENEDO', 1]],
  );
  const olho = r.cidades[0]!.chave;
  assert.deepEqual(ids(listarForaDaMontagem(PEDIDOS, CLIENTES, { ...TODOS, cidade: olho })), ['101', '100']);
});

test('busca por nome sem acento, nota ou nº do pedido', () => {
  assert.deepEqual(ids(listarForaDaMontagem(PEDIDOS, CLIENTES, { ...TODOS, busca: 'jose' })), ['100']);
  assert.deepEqual(ids(listarForaDaMontagem(PEDIDOS, CLIENTES, { ...TODOS, busca: '102' })), ['102']);
  assert.deepEqual(ids(listarForaDaMontagem(PEDIDOS, CLIENTES, { ...TODOS, busca: '5363101' })), ['101']);
});

test('liberados: só o que ainda dá para desfazer, com a origem de antes', () => {
  const r = listarForaDaMontagem(PEDIDOS, CLIENTES, { ...TODOS, vista: 'liberados', tipo: 'entregue_no_erp' });
  assert.deepEqual(ids(r), ['103'], 'o tipo não filtra a vista de liberados; o em_rota não entra');
  assert.equal(r.linhas[0]!.origem, 'retirada');
});
