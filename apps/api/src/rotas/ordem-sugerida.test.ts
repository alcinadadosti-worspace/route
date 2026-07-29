import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GeoPonto, ParadaRota, Rota } from '@rota/shared';
import { sugerirOrdemDeParadas } from './ordem-sugerida.js';
import { RepositorioMemoria } from '../db/repositorio.js';
import type { ClienteOsrm } from './osrm.js';

const ROTA_ID = '2026-07-29_a1b2c3d4';
const ORIGEM = { lat: -10.28, lng: -36.56 };

function parada(pedidoId: string, status: ParadaRota['status'], lat: number): ParadaRota {
  return {
    pedidoId,
    clienteId: `cliente-${pedidoId}`,
    nome: `Cliente ${pedidoId}`,
    endereco: 'Rua X, 1',
    telefone: null,
    itens: [],
    volumes: 1,
    pesoBrutoKg: 1,
    coordenada: { lat, lng: -36.56 },
    etaMin: 10,
    distanciaKm: 1,
    status,
  };
}

async function repoComRota(paradas: ParadaRota[], motoristaId = 'motorista-1') {
  const repo = new RepositorioMemoria();
  const rota: Rota = {
    data: '2026-07-29',
    motoristaId,
    origemCdId: 'penedo',
    origemNome: 'CD Penedo',
    origemCoordenada: ORIGEM,
    retornaAoCd: true,
    paradas,
    polylinePlanejada: '',
    distanciaTotalKm: 10,
    duracaoTotalMin: 30,
    status: 'em_execucao',
    publicadaEm: '2026-07-29T08:00:00-03:00',
    concluidaEm: null,
  };
  await repo.salvarRota(ROTA_ID, rota);
  return repo;
}

/**
 * OSRM de teste: devolve a matriz de durações das paradas (que o teste põe
 * numa reta de latitude), e registra os pontos recebidos. `trip` explode de
 * propósito — rota aberta NÃO pode passar por lá, o serviço real responde
 * NotImplemented.
 */
function osrmFake(): ClienteOsrm & { chamadas: GeoPonto[][] } {
  const chamadas: GeoPonto[][] = [];
  return {
    chamadas,
    async table(pontos) {
      chamadas.push(pontos);
      return pontos.map((a) => pontos.map((b) => Math.abs(a.lat - b.lat) * 100_000));
    },
    async trip() {
      throw new Error('rota aberta não pode usar /trip (NotImplemented no OSRM real)');
    },
    async route() {
      throw new Error('não usado');
    },
    async match() {
      throw new Error('não usado');
    },
  };
}

test('sugere a ordem das paradas que faltam a partir da posição atual', async () => {
  const repo = await repoComRota([
    parada('p1', 'em_rota', -10.27),
    parada('p2', 'em_rota', -10.26),
    parada('p3', 'em_rota', -10.25),
  ]);
  const osrm = osrmFake();

  const r = await sugerirOrdemDeParadas({ rotaId: ROTA_ID, origem: ORIGEM, uid: 'motorista-1' }, repo, osrm);

  assert.ok(r.ok);
  // Paradas numa reta afastando-se da origem: visita da mais perto à mais longe.
  assert.deepEqual(r.ordem, ['p1', 'p2', 'p3']);
  // A matriz parte de ONDE O MOTORISTA ESTÁ, não do CD.
  assert.deepEqual(osrm.chamadas[0]![0], ORIGEM);
  assert.equal(osrm.chamadas[0]!.length, 4); // origem + 3 paradas
});

test('paradas já resolvidas ficam de fora da sugestão', async () => {
  const repo = await repoComRota([
    parada('p1', 'entregue', -10.27),
    parada('p2', 'em_rota', -10.26),
    parada('p3', 'insucesso', -10.25),
    parada('p4', 'em_rota', -10.24),
  ]);
  const osrm = osrmFake();

  const r = await sugerirOrdemDeParadas({ rotaId: ROTA_ID, origem: ORIGEM, uid: 'motorista-1' }, repo, osrm);

  assert.ok(r.ok);
  assert.deepEqual(r.ordem, ['p2', 'p4']);
  assert.equal(osrm.chamadas[0]!.length, 3); // origem + só as 2 pendentes
});

test('com uma parada só não chama o OSRM (que dorme e custa cold start)', async () => {
  const repo = await repoComRota([parada('p1', 'entregue', -10.27), parada('p2', 'em_rota', -10.26)]);
  const osrm = osrmFake();

  const r = await sugerirOrdemDeParadas({ rotaId: ROTA_ID, origem: ORIGEM, uid: 'motorista-1' }, repo, osrm);

  assert.ok(r.ok);
  assert.deepEqual(r.ordem, ['p2']);
  assert.equal(osrm.chamadas.length, 0);
});

test('a sugestão NÃO grava nada: a rota publicada continua na ordem original', async () => {
  const paradas = [parada('p1', 'em_rota', -10.27), parada('p2', 'em_rota', -10.26)];
  const repo = await repoComRota(paradas);

  await sugerirOrdemDeParadas({ rotaId: ROTA_ID, origem: ORIGEM, uid: 'motorista-1' }, repo, osrmFake());

  const rota = await repo.obterRota(ROTA_ID);
  assert.deepEqual(
    rota!.paradas.map((p) => p.pedidoId),
    ['p1', 'p2'],
  );
  assert.equal(rota!.status, 'em_execucao');
});

test('rota de outro motorista é recusada (403)', async () => {
  const repo = await repoComRota([parada('p1', 'em_rota', -10.27), parada('p2', 'em_rota', -10.26)]);

  const r = await sugerirOrdemDeParadas({ rotaId: ROTA_ID, origem: ORIGEM, uid: 'outro' }, repo, osrmFake());

  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 403);
});

test('rotaId com barra não vira caminho de documento (404, sem consultar)', async () => {
  const repo = await repoComRota([parada('p1', 'em_rota', -10.27)]);

  const r = await sugerirOrdemDeParadas(
    { rotaId: '2026-07-29_a1b2c3d4/../outra', origem: ORIGEM, uid: 'motorista-1' },
    repo,
    osrmFake(),
  );

  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 404);
});

test('posição inválida é recusada antes de qualquer consulta', async () => {
  const repo = await repoComRota([parada('p1', 'em_rota', -10.27)]);

  for (const origem of [null, { lat: NaN, lng: -36.5 }, { lat: 200, lng: -36.5 }]) {
    const r = await sugerirOrdemDeParadas(
      { rotaId: ROTA_ID, origem: origem as never, uid: 'motorista-1' },
      repo,
      osrmFake(),
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  }
});

test('OSRM dormindo devolve 503 com mensagem, não 500 cru', async () => {
  const repo = await repoComRota([parada('p1', 'em_rota', -10.27), parada('p2', 'em_rota', -10.26)]);
  const osrm = osrmFake();
  osrm.table = async () => {
    throw new Error('Roteirizador indisponível (pode estar acordando)');
  };

  const r = await sugerirOrdemDeParadas({ rotaId: ROTA_ID, origem: ORIGEM, uid: 'motorista-1' }, repo, osrm);

  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 503);
    assert.match(r.erro, /acordando/);
  }
});
