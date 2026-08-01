import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Cliente, ParadaRota, Pedido, Rota } from '@rota/shared';
import { removerPedido, removerRota } from './remover.js';
import { RepositorioMemoria } from '../db/repositorio.js';

const ROTA_ID = '2026-07-29_a1b2c3d4';

function clienteCom(coordenada: Cliente['coordenada']): Cliente {
  return {
    nome: 'CLIENTE',
    documentoMascarado: '***',
    telefone: null,
    email: null,
    enderecoFiscal: {
      logradouro: 'Rua A',
      numero: '1',
      bairro: 'Centro',
      municipio: 'Penedo',
      uf: 'AL',
      cep: '57200000',
    },
    coordenada,
    statusMapeamento: coordenada ? 'geocodificado' : 'nao_mapeado',
    trilhaAtivaId: null,
    mapeadoPor: null,
    mapeadoEm: null,
    fotoReferenciaPath: null,
    observacoes: '',
  };
}

function pedidoDe(clienteId: string, status: Pedido['status'], rotaId: string | null): Pedido {
  return {
    numeroNota: 1,
    serie: 1,
    numeroPedido: '1',
    lote: null,
    clienteId,
    emitidoEm: '2026-07-29T08:00:00-03:00',
    itens: [],
    valorTotal: 10,
    volumes: 1,
    pesoBrutoKg: 1,
    status,
    rotaId,
    xmlStoragePath: null,
  };
}

function parada(pedidoId: string, clienteId: string, status: ParadaRota['status']): ParadaRota {
  return {
    pedidoId,
    clienteId,
    nome: 'CLIENTE',
    endereco: 'Rua A, 1',
    telefone: null,
    itens: [],
    volumes: 1,
    pesoBrutoKg: 1,
    coordenada: { lat: -10.28, lng: -36.56 },
    etaMin: 10,
    distanciaKm: 1,
    status,
  };
}

/** Rota publicada com N paradas, cada uma com pedido e cliente reais no repo. */
async function cenario(statuses: Array<ParadaRota['status']>, comCoordenada = true) {
  const repo = new RepositorioMemoria();
  const paradas: ParadaRota[] = [];
  for (const [i, status] of statuses.entries()) {
    const pedidoId = `p${i + 1}`;
    const clienteId = `c${i + 1}`;
    await repo.salvarCliente(clienteId, clienteCom(comCoordenada ? { lat: -10.28, lng: -36.56 } : null));
    await repo.salvarPedido(pedidoId, pedidoDe(clienteId, status, ROTA_ID));
    paradas.push(parada(pedidoId, clienteId, status));
  }
  const rota: Rota = {
    data: '2026-07-29',
    motoristaId: 'motorista-1',
    origemCdId: 'penedo',
    origemNome: 'CD Penedo',
    origemCoordenada: { lat: -10.28, lng: -36.56 },
    retornaAoCd: true,
    paradas,
    polylinePlanejada: 'abc',
    distanciaTotalKm: 10,
    duracaoTotalMin: 30,
    status: 'publicada',
    publicadaEm: '2026-07-29T08:00:00-03:00',
    concluidaEm: null,
  };
  await repo.salvarRota(ROTA_ID, rota);
  return repo;
}

test('apagar pedido que está em rota tira a parada da rota junto', async () => {
  const repo = await cenario(['em_rota', 'em_rota', 'em_rota']);

  const r = await removerPedido(repo, 'p2');

  assert.ok(r.ok);
  assert.equal(await repo.obterPedido('p2'), null);
  const rota = await repo.obterRota(ROTA_ID);
  assert.deepEqual(
    rota!.paradas.map((p) => p.pedidoId),
    ['p1', 'p3'],
    'a parada tem de sair, senão o motorista vê parada sem pedido',
  );
});

test('apagar a última parada apaga a rota — rota sem parada não é rota', async () => {
  const repo = await cenario(['em_rota']);

  const r = await removerPedido(repo, 'p1');

  assert.ok(r.ok);
  assert.equal(r.rotaApagada, ROTA_ID);
  assert.equal(await repo.obterRota(ROTA_ID), null);
});

test('pedido já executado em campo não se apaga — é histórico', async () => {
  const repo = await cenario(['entregue', 'insucesso']);

  for (const id of ['p1', 'p2']) {
    const r = await removerPedido(repo, id);
    assert.equal(r.ok, false, `${id} deveria ser recusado`);
    if (!r.ok) assert.equal(r.status, 409);
  }
  assert.ok(await repo.obterPedido('p1'));
  assert.ok(await repo.obterPedido('p2'));
});

test('apagar a rota devolve os pedidos para montagem', async () => {
  const repo = await cenario(['em_rota', 'em_rota']);

  const r = await removerRota(repo, ROTA_ID);

  assert.ok(r.ok);
  assert.equal(await repo.obterRota(ROTA_ID), null);
  for (const id of ['p1', 'p2']) {
    const pedido = (await repo.obterPedido(id))!;
    assert.equal(pedido.status, 'pronto_para_rota', 'sem isto o pedido fica em_rota para sempre');
    assert.equal(pedido.rotaId, null);
  }
});

test('pedido cujo cliente perdeu a coordenada volta para mapeamento, não para pronto', async () => {
  const repo = await cenario(['em_rota'], false);

  await removerRota(repo, ROTA_ID);

  assert.equal((await repo.obterPedido('p1'))!.status, 'pendente_de_mapeamento');
});

test('rota com parada já executada não se apaga, e nada é mexido', async () => {
  const repo = await cenario(['entregue', 'em_rota']);

  const r = await removerRota(repo, ROTA_ID);

  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 409);
    assert.match(r.erro, /executada/);
  }
  assert.ok(await repo.obterRota(ROTA_ID), 'a rota continua');
  assert.equal((await repo.obterPedido('p2'))!.status, 'em_rota', 'nenhum pedido foi liberado');
});

test('rotaId com barra não vira caminho de documento (404)', async () => {
  const repo = await cenario(['em_rota']);
  const r = await removerRota(repo, `${ROTA_ID}/../outra`);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 404);
  assert.ok(await repo.obterRota(ROTA_ID));
});

test('desfazer rota devolve PRONTO o pedido com override de entrega, mesmo sem ponto no cliente', async () => {
  // O ponto desse pedido é o override (8.4) — o pin que o escritório cravou no
  // mapa — e não o cadastro do cliente. Sem esta regra ele voltava para
  // "pendente de mapeamento": trabalho de campo por um ponto que já existe, e
  // o pedido sumia da lista de prontos sem ninguém entender por quê.
  const repo = await cenario(['em_rota'], false); // cliente SEM coordenada
  const pedido = (await repo.obterPedido('p1'))!;
  await repo.salvarPedido('p1', {
    ...pedido,
    usarEnderecoEntrega: true,
    coordenadaEntrega: { lat: -9.9, lng: -36.5 },
  });

  const r = await removerRota(repo, ROTA_ID);
  assert.ok(r.ok);
  assert.equal((await repo.obterPedido('p1'))!.status, 'pronto_para_rota');
});

test('pedido marcado como retirada PODE ser apagado — não é histórico de campo', async () => {
  // A trava do apagar é sobre o que já foi EXECUTADO (entregue/insucesso).
  // Retirada é decisão de escritório, reversível — apagar a nota desfaz tudo.
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('c1', clienteCom({ lat: -10.28, lng: -36.56 }));
  await repo.salvarPedido('p1', {
    ...pedidoDe('c1', 'retirada', null),
    modFrete: '9',
    modoEntrega: 'retirada',
  });

  const r = await removerPedido(repo, 'p1');
  assert.ok(r.ok);
  assert.equal(await repo.obterPedido('p1'), null);
});
