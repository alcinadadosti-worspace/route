import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarClienteOsrm } from './osrm.js';
import { previaDeRota } from './previa.js';
import { RepositorioMemoria } from '../db/repositorio.js';
import type { Cliente, Pedido } from '@rota/shared';

// Resposta real (reduzida) do OSRM /trip: CD + 2 paradas, visita invertida.
const RESPOSTA_TRIP = {
  code: 'Ok',
  trips: [{ geometry: 'abc123', distance: 232500, duration: 13740 }],
  waypoints: [
    { waypoint_index: 0 }, // entrada 0 (CD) é a partida
    { waypoint_index: 2 }, // entrada 1 visitada por último
    { waypoint_index: 1 }, // entrada 2 visitada primeiro
  ],
};

function fetchFalso(corpo: unknown, ok = true, status = 200): typeof fetch {
  return (async () => ({ ok, status, json: async () => corpo })) as unknown as typeof fetch;
}

test('cliente OSRM ordena paradas pelo waypoint_index e converte unidades', async () => {
  const osrm = criarClienteOsrm('http://osrm.local', fetchFalso(RESPOSTA_TRIP))!;
  const resultado = await osrm.trip(
    { lat: -10.28, lng: -36.56 },
    [
      { lat: -9.42, lng: -36.64 },
      { lat: -9.75, lng: -36.65 },
    ],
    true,
  );

  assert.deepEqual(resultado.ordem, [1, 0]); // entrada 2 antes da entrada 1
  assert.equal(resultado.polyline, 'abc123');
  assert.equal(resultado.distanciaKm, 232.5);
  assert.equal(resultado.duracaoMin, 229);
});

test('cliente OSRM propaga falha de rota como erro', async () => {
  const osrm = criarClienteOsrm('http://osrm.local', fetchFalso({ code: 'NoTrips' }))!;
  await assert.rejects(
    () => osrm.trip({ lat: 0, lng: 0 }, [{ lat: 1, lng: 1 }], true),
    /NoTrips/,
  );
});

test('sem OSRM_URL o cliente não é criado', () => {
  assert.equal(criarClienteOsrm(undefined), null);
});

function clienteCom(coordenada: Cliente['coordenada'], nome: string): Cliente {
  return {
    nome,
    documentoMascarado: '***.***.***-00',
    telefone: null,
    email: null,
    enderecoFiscal: {
      logradouro: 'Rua A',
      numero: '1',
      bairro: 'Centro',
      municipio: 'Penedo',
      uf: 'AL',
      cep: '57200-010',
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

function pedidoDe(clienteId: string): Pedido {
  return {
    numeroNota: 1,
    serie: 1,
    numeroPedido: '1',
    lote: '1',
    clienteId,
    emitidoEm: '2026-07-22T08:00:00-03:00',
    itens: [],
    valorTotal: 100,
    volumes: 1,
    pesoBrutoKg: 2,
    status: 'pronto_para_rota',
    rotaId: null,
    xmlStoragePath: null,
  };
}

test('prévia de rota ordena as paradas e monta o resumo', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('c1', clienteCom({ lat: -9.42, lng: -36.64 }, 'CLIENTE UM'));
  await repo.salvarCliente('c2', clienteCom({ lat: -9.75, lng: -36.65 }, 'CLIENTE DOIS'));
  await repo.salvarPedido('p1', pedidoDe('c1'));
  await repo.salvarPedido('p2', pedidoDe('c2'));

  const osrm = criarClienteOsrm('http://osrm.local', fetchFalso(RESPOSTA_TRIP))!;
  const resultado = await previaDeRota({ pedidoIds: ['p1', 'p2'], cdId: 'penedo' }, repo, osrm);

  assert.ok(resultado.ok);
  const previa = resultado.previa;
  assert.equal(previa.cd.nome, 'CD Penedo');
  assert.equal(previa.retornaAoCd, true);
  assert.deepEqual(
    previa.paradas.map((p) => [p.posicao, p.nome]),
    [
      [1, 'CLIENTE DOIS'],
      [2, 'CLIENTE UM'],
    ],
  );
  assert.equal(previa.distanciaTotalKm, 232.5);
  assert.equal(previa.duracaoTotalMin, 229);
});

test('prévia recusa pedido com destino sem coordenada, listando as pendências', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('c1', clienteCom(null, 'SEM COORDENADA'));
  await repo.salvarPedido('p1', pedidoDe('c1'));

  const osrm = criarClienteOsrm('http://osrm.local', fetchFalso(RESPOSTA_TRIP))!;
  const resultado = await previaDeRota({ pedidoIds: ['p1'], cdId: 'penedo' }, repo, osrm);

  assert.equal(resultado.ok, false);
  if (!resultado.ok) {
    assert.equal(resultado.status, 422);
    assert.deepEqual(resultado.pendentes, [{ pedidoId: 'p1', nome: 'SEM COORDENADA' }]);
  }
});

test('prévia valida CD e lista de pedidos', async () => {
  const repo = new RepositorioMemoria();
  const osrm = criarClienteOsrm('http://osrm.local', fetchFalso(RESPOSTA_TRIP))!;

  const semPedidos = await previaDeRota({ pedidoIds: [], cdId: 'penedo' }, repo, osrm);
  assert.equal(semPedidos.ok, false);

  const cdErrado = await previaDeRota({ pedidoIds: ['p1'], cdId: 'inexistente' }, repo, osrm);
  assert.equal(cdErrado.ok, false);
});
