import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarClienteOsrm } from './osrm.js';
import { previaDeRota } from './previa.js';
import { publicarRota } from './publicar.js';
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

// Resposta /route: 2 pernas (CD→A e A→B).
const RESPOSTA_ROUTE = {
  code: 'Ok',
  routes: [
    {
      geometry: 'xyz789',
      distance: 150000,
      duration: 7200,
      legs: [
        { distance: 100000, duration: 4800 },
        { distance: 50000, duration: 2400 },
      ],
    },
  ],
};

function fetchFalso(corpo: unknown, ok = true, status = 200): typeof fetch {
  return (async () => ({ ok, status, json: async () => corpo })) as unknown as typeof fetch;
}

/** Despacha /trip e /route para respostas distintas, como o OSRM real. */
function fetchPorRota(): typeof fetch {
  return (async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes('/trip/') ? RESPOSTA_TRIP : RESPOSTA_ROUTE),
  })) as unknown as typeof fetch;
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

test('route() converte pernas, distância e duração', async () => {
  const osrm = criarClienteOsrm('http://osrm.local', fetchFalso(RESPOSTA_ROUTE))!;
  const r = await osrm.route([
    { lat: -10.28, lng: -36.56 },
    { lat: -9.75, lng: -36.65 },
    { lat: -9.42, lng: -36.64 },
  ]);
  assert.equal(r.polyline, 'xyz789');
  assert.equal(r.distanciaKm, 150);
  assert.equal(r.duracaoMin, 120);
  assert.deepEqual(r.pernas, [
    { distanciaKm: 100, duracaoMin: 80 },
    { distanciaKm: 50, duracaoMin: 40 },
  ]);
});

test('prévia com ordem manual respeita a sequência dada (RF-12)', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('c1', clienteCom({ lat: -9.42, lng: -36.64 }, 'CLIENTE UM'));
  await repo.salvarCliente('c2', clienteCom({ lat: -9.75, lng: -36.65 }, 'CLIENTE DOIS'));
  await repo.salvarPedido('p1', pedidoDe('c1'));
  await repo.salvarPedido('p2', pedidoDe('c2'));

  const osrm = criarClienteOsrm('http://osrm.local', fetchPorRota())!;
  const resultado = await previaDeRota(
    { pedidoIds: ['p1', 'p2'], cdId: 'penedo', ordemManual: true },
    repo,
    osrm,
  );

  assert.ok(resultado.ok);
  assert.deepEqual(
    resultado.previa.paradas.map((p) => p.nome),
    ['CLIENTE UM', 'CLIENTE DOIS'], // ordem de entrada, sem otimizar
  );
  assert.equal(resultado.previa.polyline, 'xyz789'); // veio do /route, não do /trip
});

test('publicar grava a rota, denormaliza paradas com ETA e move pedidos para em_rota', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('c1', clienteCom({ lat: -9.42, lng: -36.64 }, 'CLIENTE UM'));
  await repo.salvarCliente('c2', clienteCom({ lat: -9.75, lng: -36.65 }, 'CLIENTE DOIS'));
  await repo.salvarPedido('p1', pedidoDe('c1'));
  await repo.salvarPedido('p2', pedidoDe('c2'));

  const osrm = criarClienteOsrm('http://osrm.local', fetchPorRota())!;
  const resultado = await publicarRota(
    { pedidoIds: ['p1', 'p2'], cdId: 'penedo', motoristaId: 'motorista-demo' },
    repo,
    osrm,
  );

  assert.ok(resultado.ok);
  const rota = resultado.rota;
  assert.equal(rota.status, 'publicada');
  assert.equal(rota.origemNome, 'CD Penedo');
  assert.equal(rota.motoristaId, 'motorista-demo');
  assert.equal(rota.polylinePlanejada, 'xyz789');
  assert.deepEqual(
    rota.paradas.map((p) => [p.nome, p.etaMin, p.distanciaKm, p.status]),
    [
      ['CLIENTE UM', 80, 100, 'em_rota'],
      ['CLIENTE DOIS', 120, 50, 'em_rota'],
    ],
  );

  const pedidos = await repo.listarPedidos();
  assert.ok(pedidos.every((p) => p.status === 'em_rota' && p.rotaId === resultado.rotaId));
  assert.equal((await repo.listarRotas()).length, 1);
});

test('publicar recusa motorista inválido e pedido já em rota', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('c1', clienteCom({ lat: -9.42, lng: -36.64 }, 'CLIENTE UM'));
  await repo.salvarPedido('p1', pedidoDe('c1'));
  const osrm = criarClienteOsrm('http://osrm.local', fetchPorRota())!;

  const semMotorista = await publicarRota(
    { pedidoIds: ['p1'], cdId: 'penedo', motoristaId: 'nao-existe' },
    repo,
    osrm,
  );
  assert.equal(semMotorista.ok, false);

  await repo.salvarPedido('p1', { ...pedidoDe('c1'), status: 'em_rota', rotaId: 'outra' });
  const jaEmRota = await publicarRota(
    { pedidoIds: ['p1'], cdId: 'penedo', motoristaId: 'motorista-demo' },
    repo,
    osrm,
  );
  assert.equal(jaEmRota.ok, false);
  if (!jaEmRota.ok) assert.equal(jaEmRota.status, 409);
});

test('prévia valida CD e lista de pedidos', async () => {
  const repo = new RepositorioMemoria();
  const osrm = criarClienteOsrm('http://osrm.local', fetchFalso(RESPOSTA_TRIP))!;

  const semPedidos = await previaDeRota({ pedidoIds: [], cdId: 'penedo' }, repo, osrm);
  assert.equal(semPedidos.ok, false);

  const cdErrado = await previaDeRota({ pedidoIds: ['p1'], cdId: 'inexistente' }, repo, osrm);
  assert.equal(cdErrado.ok, false);
});
