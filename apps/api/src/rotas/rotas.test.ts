import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarClienteOsrm } from './osrm.js';
import { coletarParadas, previaDeRota } from './previa.js';
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

test('prévia recusa misturar pedidos de CDs diferentes na mesma rota', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('c1', clienteCom({ lat: -10.28, lng: -36.56 }, 'CLIENTE UM'));
  await repo.salvarCliente('c2', clienteCom({ lat: -9.42, lng: -36.64 }, 'CLIENTE DOIS'));
  await repo.salvarPedido('p1', { ...pedidoDe('c1'), cdId: 'penedo' });
  await repo.salvarPedido('p2', { ...pedidoDe('c2'), cdId: 'palmeira' });

  const osrm = criarClienteOsrm('http://osrm.local', fetchFalso(RESPOSTA_TRIP))!;
  const r = await previaDeRota({ pedidoIds: ['p1', 'p2'], cdId: 'penedo' }, repo, osrm);

  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 422);
    assert.match(r.erro, /CDs diferentes/);
  }
});

test('pedido sem CD reconhecido não bloqueia a montagem da rota', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('c1', clienteCom({ lat: -10.28, lng: -36.56 }, 'CLIENTE UM'));
  await repo.salvarCliente('c2', clienteCom({ lat: -10.27, lng: -36.55 }, 'CLIENTE DOIS'));
  await repo.salvarPedido('p1', { ...pedidoDe('c1'), cdId: 'penedo' });
  await repo.salvarPedido('p2', { ...pedidoDe('c2'), cdId: null });

  const osrm = criarClienteOsrm('http://osrm.local', fetchFalso(RESPOSTA_TRIP))!;
  const r = await previaDeRota({ pedidoIds: ['p1', 'p2'], cdId: 'penedo' }, repo, osrm);

  assert.ok(r.ok, 'nota de emitente desconhecido não pode travar a operação');
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
    { distanciaKm: 100, duracaoSeg: 4800 },
    { distanciaKm: 50, duracaoSeg: 2400 },
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

test('override de entrega: a parada usa a coordenada e o endereço da entrega, não os do cliente', async () => {
  const repo = new RepositorioMemoria();
  // Cliente mapeado num ponto; o override aponta para OUTRO ponto e endereço.
  await repo.salvarCliente('c1', clienteCom({ lat: -9.42, lng: -36.64 }, 'CLIENTE UM'));
  await repo.salvarPedido('p1', {
    ...pedidoDe('c1'),
    usarEnderecoEntrega: true,
    coordenadaEntrega: { lat: -9.99, lng: -36.99 },
    enderecoEntrega: {
      logradouro: 'RUA DA ENTREGA',
      numero: '500',
      bairro: 'CENTRO',
      municipio: 'MACEIO',
      uf: 'AL',
      cep: '57000-000',
    },
  });

  const coleta = await coletarParadas(['p1'], repo);
  assert.ok(coleta.ok);
  const parada = coleta.candidatas[0]!;
  assert.deepEqual(parada.coordenada, { lat: -9.99, lng: -36.99 }); // override, não a do cliente
  assert.match(parada.endereco, /RUA DA ENTREGA/); // endereço de entrega, não o fiscal (Rua A)
});

test('pedido pendente_de_decisao é bloqueado na coleta (não entra em rota)', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('c1', clienteCom({ lat: -9.42, lng: -36.64 }, 'CLIENTE UM'));
  await repo.salvarPedido('p1', { ...pedidoDe('c1'), status: 'pendente_de_decisao' });

  const coleta = await coletarParadas(['p1'], repo);
  assert.equal(coleta.ok, false);
  if (!coleta.ok) assert.equal(coleta.status, 422);
});

test('pedido JÁ em outra rota é recusado na coleta — prévia velha não republica', async () => {
  // O painel só oferece os `pronto_para_rota`, mas uma prévia montada ANTES da
  // seleção mudar manda os ids do mesmo jeito. Sem esta guarda, publicar
  // reescreveria o rotaId do pedido e a rota antiga ficaria com uma parada que
  // já não é dela.
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('c1', clienteCom({ lat: -9.42, lng: -36.64 }, 'CLIENTE UM'));
  await repo.salvarPedido('p1', { ...pedidoDe('c1'), status: 'em_rota', rotaId: '2026-07-30_aaaaaaaa' });

  const r = await coletarParadas(['p1'], repo);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 409);
    assert.match(r.erro, /já está na rota 2026-07-30_aaaaaaaa/);
  }
});

test('pedido já executado não volta para uma rota nova', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('c1', clienteCom({ lat: -9.42, lng: -36.64 }, 'CLIENTE UM'));
  for (const status of ['entregue', 'insucesso'] as const) {
    await repo.salvarPedido('p1', { ...pedidoDe('c1'), status });
    const r = await coletarParadas(['p1'], repo);
    assert.equal(r.ok, false, `${status} deveria ser recusado`);
    if (!r.ok) assert.equal(r.status, 409);
  }
});
