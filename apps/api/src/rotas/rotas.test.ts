import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarClienteOsrm } from './osrm.js';
import { coletarParadas, juntarMesmoLugar, previaDeRota, refinarViagem } from './previa.js';
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

test('route() mede como o /trip: deixa dar meia-volta na parada', async () => {
  // Sem isto o traçado da MESMA ordem saía mais longo que o do /trip, e a
  // prévia mostrava um km que a rota publicada não gravava.
  let pedida = '';
  const osrm = criarClienteOsrm('http://osrm.local', (async (url: string) => {
    pedida = String(url);
    return { ok: true, status: 200, json: async () => RESPOSTA_ROUTE };
  }) as unknown as typeof fetch)!;
  await osrm.route([
    { lat: -10.28, lng: -36.56 },
    { lat: -9.75, lng: -36.65 },
  ]);
  assert.match(pedida, /[?&]continue_straight=false(&|$)/);
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

/**
 * OSRM falso de 3 paradas: o /trip devolve a ordem 1-2-3 (a dele, 300 km /
 * 300 min), mas a matriz do /table diz que 1-3-2 é muito mais curta. O /route
 * da ordem nova dá `route` (km, min) — por padrão, 120 km / 120 min.
 */
function osrmComTripRuim(
  falha: { table?: boolean; route?: boolean } = {},
  route: { km: number; min: number } = { km: 120, min: 120 },
) {
  const chamadas: string[] = [];
  const fetchFalso = (async (url: string) => {
    const tipo = /\/(trip|table|route)\//.exec(String(url))?.[1] ?? '?';
    chamadas.push(tipo);
    const corpo =
      tipo === 'trip'
        ? {
            code: 'Ok',
            trips: [{ geometry: 'do-trip', distance: 300000, duration: 18000 }],
            waypoints: [0, 1, 2, 3].map((i) => ({ waypoint_index: i })),
          }
        : tipo === 'table'
          ? falha.table
            ? { code: 'TooBig' }
            : {
                code: 'Ok',
                // CD→1, 1→3, 3→2 e 2→CD custam 1; todo o resto, 100.
                durations: [
                  [0, 1, 100, 100],
                  [100, 0, 100, 1],
                  [1, 100, 0, 100],
                  [100, 100, 1, 0],
                ],
              }
          : falha.route
            ? { code: 'NoRoute' }
            : {
                code: 'Ok',
                routes: [
                  { geometry: 'do-route', distance: route.km * 1000, duration: route.min * 60, legs: [] },
                ],
              };
    return { ok: true, status: 200, json: async () => corpo };
  }) as unknown as typeof fetch;
  return { osrm: criarClienteOsrm('http://osrm.local', fetchFalso)!, chamadas };
}

async function repoDeTresParadas() {
  const repo = new RepositorioMemoria();
  for (const [i, nome] of ['CLIENTE UM', 'CLIENTE DOIS', 'CLIENTE TRÊS'].entries()) {
    await repo.salvarCliente(`c${i + 1}`, clienteCom({ lat: -10.2 - i / 100, lng: -36.5 }, nome));
    await repo.salvarPedido(`p${i + 1}`, pedidoDe(`c${i + 1}`));
  }
  return repo;
}

test('prévia de rota fechada refina a ordem do /trip, e o traçado é o da ordem nova', async () => {
  const repo = await repoDeTresParadas();
  const { osrm, chamadas } = osrmComTripRuim();
  const r = await previaDeRota({ pedidoIds: ['p1', 'p2', 'p3'], cdId: 'penedo' }, repo, osrm);

  assert.ok(r.ok);
  // É esta a ordem que a publicação grava e que sai no PDF.
  assert.deepEqual(
    r.previa.paradas.map((p) => [p.posicao, p.nome]),
    [
      [1, 'CLIENTE UM'],
      [2, 'CLIENTE TRÊS'],
      [3, 'CLIENTE DOIS'],
    ],
  );
  assert.equal(r.previa.polyline, 'do-route');
  assert.equal(r.previa.distanciaTotalKm, 120);
  assert.equal(r.previa.duracaoTotalMin, 120);
  assert.deepEqual(chamadas, ['trip', 'table', 'route']);
});

test('prévia de rota fechada: sem o /table ou sem o /route, fica a ordem do /trip em vez de dar erro', async () => {
  for (const falha of [{ table: true }, { route: true }]) {
    const repo = await repoDeTresParadas();
    const { osrm } = osrmComTripRuim(falha);
    const r = await previaDeRota({ pedidoIds: ['p1', 'p2', 'p3'], cdId: 'penedo' }, repo, osrm);

    assert.ok(r.ok, JSON.stringify(falha));
    assert.deepEqual(
      r.previa.paradas.map((p) => p.nome),
      ['CLIENTE UM', 'CLIENTE DOIS', 'CLIENTE TRÊS'],
    );
    assert.equal(r.previa.polyline, 'do-trip');
    assert.equal(r.previa.distanciaTotalKm, 300);
  }
});

test('prévia de rota fechada: a ordem nova só fica se o traçado dela não perde em km nem em minutos', async () => {
  // A matriz mede tempo e não é o caminho exato do /route: no traçado de
  // verdade a ordem "melhor" pode sair mais longa ou mais demorada.
  for (const route of [
    { km: 310, min: 100 }, // mais rápida, mas mais longa
    { km: 100, min: 310 }, // mais curta, mas mais demorada
    { km: 300, min: 300 }, // empate: trocar a ordem não ganha nada
  ]) {
    const repo = await repoDeTresParadas();
    const { osrm } = osrmComTripRuim({}, route);
    const r = await previaDeRota({ pedidoIds: ['p1', 'p2', 'p3'], cdId: 'penedo' }, repo, osrm);
    assert.ok(r.ok);
    assert.equal(r.previa.polyline, 'do-trip', JSON.stringify(route));
    assert.deepEqual(r.previa.paradas.map((p) => p.nome), ['CLIENTE UM', 'CLIENTE DOIS', 'CLIENTE TRÊS']);
  }
  // Ganha em uma e empata na outra: fica a nova.
  const repo = await repoDeTresParadas();
  const { osrm } = osrmComTripRuim({}, { km: 300, min: 250 });
  const r = await previaDeRota({ pedidoIds: ['p1', 'p2', 'p3'], cdId: 'penedo' }, repo, osrm);
  assert.ok(r.ok);
  assert.equal(r.previa.polyline, 'do-route');
});

/**
 * OSRM falso que devolve a ordem de entrada no /trip, recusa o /table (para o
 * refino não mexer) e responde o /route — e conta as chamadas.
 */
function osrmNaOrdemDada(n: number) {
  const chamadas: string[] = [];
  const fetchFalso = (async (url: string) => {
    const tipo = /\/(trip|table|route)\//.exec(String(url))?.[1] ?? '?';
    chamadas.push(tipo);
    const corpo =
      tipo === 'trip'
        ? {
            code: 'Ok',
            trips: [{ geometry: 'do-trip', distance: 50000, duration: 3000 }],
            waypoints: Array.from({ length: n + 1 }, (_, i) => ({ waypoint_index: i })),
          }
        : tipo === 'table'
          ? { code: 'TooBig' }
          : { code: 'Ok', routes: [{ geometry: 'do-route', distance: 40000, duration: 2400, legs: [] }] };
    return { ok: true, status: 200, json: async () => corpo };
  }) as unknown as typeof fetch;
  return { osrm: criarClienteOsrm('http://osrm.local', fetchFalso)!, chamadas };
}

test('prévia junta os pedidos da mesma cliente no mesmo ponto, mesmo com o /trip separando', async () => {
  // Três paradas no MESMO ponto (centro da cidade): a cliente X tem dois
  // pedidos, e o /trip pôs a Y entre eles.
  const centro = { lat: -9.5376, lng: -36.6306 };
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('cx', clienteCom(centro, 'CLIENTE X'));
  await repo.salvarCliente('cy', clienteCom(centro, 'CLIENTE Y'));
  await repo.salvarPedido('p1', pedidoDe('cx'));
  await repo.salvarPedido('p2', pedidoDe('cy'));
  await repo.salvarPedido('p3', pedidoDe('cx'));

  const { osrm, chamadas } = osrmNaOrdemDada(3);
  const r = await previaDeRota({ pedidoIds: ['p1', 'p2', 'p3'], cdId: 'penedo' }, repo, osrm);
  assert.ok(r.ok);
  assert.deepEqual(r.previa.paradas.map((p) => p.pedidoId), ['p1', 'p3', 'p2']);
  // Só trocaram de lugar paradas do mesmo ponto: o caminho é o mesmo, sem /route.
  assert.equal(r.previa.polyline, 'do-trip');
  assert.deepEqual(chamadas, ['trip', 'table']);
});

test('prévia não volta ao mesmo ponto: o pedido da mesma casa sobe e o traçado é refeito', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('cx', clienteCom({ lat: -9.53, lng: -36.63 }, 'CLIENTE X'));
  await repo.salvarCliente('cy', clienteCom({ lat: -9.42, lng: -36.64 }, 'CLIENTE Y'));
  await repo.salvarPedido('p1', pedidoDe('cx'));
  await repo.salvarPedido('p2', pedidoDe('cy'));
  await repo.salvarPedido('p3', pedidoDe('cx'));

  const { osrm, chamadas } = osrmNaOrdemDada(3);
  const r = await previaDeRota({ pedidoIds: ['p1', 'p2', 'p3'], cdId: 'penedo' }, repo, osrm);
  assert.ok(r.ok);
  assert.deepEqual(r.previa.paradas.map((p) => p.pedidoId), ['p1', 'p3', 'p2']);
  assert.equal(r.previa.polyline, 'do-route');
  assert.equal(r.previa.distanciaTotalKm, 40);
  assert.deepEqual(chamadas, ['trip', 'table', 'route']);
});

test('ordem manual com a mesma cliente separada é respeitada (o operador sabe o porquê)', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('cx', clienteCom({ lat: -9.53, lng: -36.63 }, 'CLIENTE X'));
  await repo.salvarCliente('cy', clienteCom({ lat: -9.42, lng: -36.64 }, 'CLIENTE Y'));
  await repo.salvarPedido('p1', pedidoDe('cx'));
  await repo.salvarPedido('p2', pedidoDe('cy'));
  await repo.salvarPedido('p3', pedidoDe('cx'));

  const { osrm } = osrmNaOrdemDada(3);
  const r = await previaDeRota({ pedidoIds: ['p1', 'p2', 'p3'], cdId: 'penedo', ordemManual: true }, repo, osrm);
  assert.ok(r.ok);
  assert.deepEqual(r.previa.paradas.map((p) => p.pedidoId), ['p1', 'p2', 'p3']);
});

test('juntar o mesmo lugar também tem prazo: sem resposta do /route, fica a ordem agrupada', async () => {
  // X, Y, X: juntar a X muda o percurso e pede o /route — que não responde.
  const candidatas = [
    { clienteId: 'X', coordenada: { lat: 1, lng: 1 } },
    { clienteId: 'Y', coordenada: { lat: 2, lng: 2 } },
    { clienteId: 'X', coordenada: { lat: 1, lng: 1 } },
  ];
  const viagem = { ordem: [0, 1, 2], polyline: 'do-trip', distanciaKm: 10, duracaoMin: 10 };
  const parado = { route: () => new Promise(() => {}) } as unknown as Parameters<typeof juntarMesmoLugar>[3];
  const inicio = Date.now();
  const r = await juntarMesmoLugar({ lat: 0, lng: 0 }, candidatas, viagem, parado, 30);
  assert.deepEqual(r.ordem, [0, 2, 1]);
  assert.equal(r.polyline, 'do-trip');
  assert.ok(Date.now() - inicio < 2000);
});

test('refinar a viagem tem prazo: OSRM parado depois do /trip não segura a prévia', async () => {
  const viagem = { ordem: [0, 1], polyline: 'do-trip', distanciaKm: 10, duracaoMin: 10 };
  const parado = {
    table: () => new Promise<number[][]>(() => {}),
  } as unknown as Parameters<typeof refinarViagem>[3];
  const inicio = Date.now();
  const r = await refinarViagem({ lat: 0, lng: 0 }, [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }], viagem, parado, 30);
  assert.equal(r, viagem);
  assert.ok(Date.now() - inicio < 2000);
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
  assert.equal('observacao' in rota, false, 'sem observação, a rota fica com a forma de sempre');
});

test('publicar com observação: vai para a rota (sai no rodapé do PDF); longa demais recusa sem reservar', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('c1', clienteCom({ lat: -9.42, lng: -36.64 }, 'CLIENTE UM'));
  await repo.salvarPedido('p1', pedidoDe('c1'));
  const osrm = criarClienteOsrm('http://osrm.local', fetchPorRota())!;
  const entrada = { pedidoIds: ['p1'], cdId: 'penedo', motoristaId: 'motorista-demo' };

  const longa = await publicarRota({ ...entrada, observacao: 'x'.repeat(301) }, repo, osrm);
  assert.equal(longa.ok, false);
  assert.equal((await repo.obterPedido('p1'))?.status, pedidoDe('c1').status);

  const r = await publicarRota({ ...entrada, observacao: '  Levar o troco.\nVolta antes das 16h ' }, repo, osrm);
  assert.ok(r.ok);
  assert.equal(r.rota.observacao, 'Levar o troco. Volta antes das 16h');
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

  // Conta ativa, mas de escritório: rota para ela não chega a celular nenhum.
  const repoComAdmin = Object.assign(repo, {
    listarUsuarios: async () => [
      { id: 'admin-1', nome: 'Logística', papel: 'admin' as const, ativo: true },
      { id: 'motorista-demo', nome: 'Motorista Demo', papel: 'motorista' as const, ativo: true },
    ],
  });
  const paraAdmin = await publicarRota({ pedidoIds: ['p1'], cdId: 'penedo', motoristaId: 'admin-1' }, repoComAdmin, osrm);
  assert.equal(paraAdmin.ok, false);
  assert.equal((await repo.obterPedido('p1'))?.status, pedidoDe('c1').status);

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

test('pedido marcado como RETIRADA é bloqueado na coleta, com o motivo certo', async () => {
  // Não é erro de quem montou a rota: o Admin Estoque tirou este pedido da fila de
  // propósito. A mensagem precisa dizer isso e onde devolver — senão o operador
  // procura defeito no lugar errado.
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('c1', clienteCom({ lat: -9.42, lng: -36.64 }, 'CLIENTE UM'));
  await repo.salvarPedido('p1', {
    ...pedidoDe('c1'),
    status: 'retirada',
    modFrete: '9',
    modoEntrega: 'retirada',
  });

  const coleta = await coletarParadas(['p1'], repo);
  assert.equal(coleta.ok, false);
  if (!coleta.ok) {
    assert.equal(coleta.status, 422);
    assert.match(coleta.erro, /retirada/i);
  }
});

test('pedido preso na escolha de rota × retirada diz QUAL pergunta falta', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('c1', clienteCom({ lat: -9.42, lng: -36.64 }, 'CLIENTE UM'));
  await repo.salvarPedido('p1', {
    ...pedidoDe('c1'),
    status: 'pendente_de_decisao',
    modFrete: '9',
  });

  const coleta = await coletarParadas(['p1'], repo);
  assert.equal(coleta.ok, false);
  if (!coleta.ok) assert.match(coleta.erro, /rota e retirada/i);
});
