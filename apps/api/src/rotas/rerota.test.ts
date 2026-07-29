import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Cliente, ParadaRota, Rota } from '@rota/shared';
import { recalcularTracado } from './rerota.js';
import { RepositorioMemoria } from '../db/repositorio.js';
import type { ClienteOsrm } from './osrm.js';

const ROTA_ID = '2026-07-29_a1b2c3d4';
const ORIGEM = { lat: -10.28, lng: -36.56 };
const COORD_PARADA = { lat: -10.25, lng: -36.54 };

function parada(pedidoId: string, status: ParadaRota['status'] = 'em_rota'): ParadaRota {
  return {
    pedidoId,
    clienteId: `cliente-${pedidoId}`,
    nome: `Cliente ${pedidoId}`,
    endereco: 'Rua X, 1',
    telefone: null,
    itens: [],
    volumes: 1,
    pesoBrutoKg: 1,
    coordenada: COORD_PARADA,
    etaMin: 10,
    distanciaKm: 1,
    status,
  };
}

function cliente(coordenada: Cliente['coordenada']): Cliente {
  return {
    nome: 'Cliente',
    documentoMascarado: '***',
    telefone: null,
    email: null,
    enderecoFiscal: {
      logradouro: 'Rua X',
      numero: '1',
      bairro: 'Centro',
      municipio: 'Penedo',
      uf: 'AL',
      cep: '57200000',
    },
    coordenada,
    statusMapeamento: coordenada ? 'mapeado' : 'nao_mapeado',
    trilhaAtivaId: null,
    mapeadoPor: null,
    mapeadoEm: null,
    fotoReferenciaPath: null,
    observacoes: '',
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
    polylinePlanejada: 'planejada',
    distanciaTotalKm: 10,
    duracaoTotalMin: 30,
    status: 'em_execucao',
    publicadaEm: '2026-07-29T08:00:00-03:00',
    concluidaEm: null,
  };
  await repo.salvarRota(ROTA_ID, rota);
  return repo;
}

/** OSRM de teste: registra os pontos recebidos e devolve um traçado fixo. */
function osrmFake(): ClienteOsrm & { pontos: Array<Array<{ lat: number; lng: number }>> } {
  const pontos: Array<Array<{ lat: number; lng: number }>> = [];
  return {
    pontos,
    async route(p) {
      pontos.push(p);
      return { polyline: 'nova', distanciaKm: 4.2, duracaoMin: 9, pernas: [] };
    },
    async trip() {
      throw new Error('não usado');
    },
    async match() {
      throw new Error('não usado');
    },
  };
}

test('recalcula da posição atual até o destino e devolve o traçado novo', async () => {
  const repo = await repoComRota([parada('p1')]);
  const osrm = osrmFake();

  const r = await recalcularTracado(
    { rotaId: ROTA_ID, pedidoId: 'p1', origem: ORIGEM, uid: 'motorista-1' },
    repo,
    osrm,
  );

  assert.ok(r.ok);
  assert.equal(r.polyline, 'nova');
  assert.equal(r.distanciaKm, 4.2);
  // Dois pontos: de ONDE ESTOU até o destino — não do CD.
  assert.deepEqual(osrm.pontos[0], [ORIGEM, COORD_PARADA]);
});

test('o destino é o pin do cliente quando ele foi confirmado depois da publicação', async () => {
  const repo = await repoComRota([parada('p1')]);
  const pinNovo = { lat: -10.2555, lng: -36.5444 };
  await repo.salvarCliente('cliente-p1', cliente(pinNovo));
  const osrm = osrmFake();

  const r = await recalcularTracado(
    { rotaId: ROTA_ID, pedidoId: 'p1', origem: ORIGEM, uid: 'motorista-1' },
    repo,
    osrm,
  );

  assert.ok(r.ok);
  assert.deepEqual(osrm.pontos[0]![1], pinNovo);
});

test('cliente sem coordenada cai na coordenada denormalizada da parada', async () => {
  const repo = await repoComRota([parada('p1')]);
  await repo.salvarCliente('cliente-p1', cliente(null));
  const osrm = osrmFake();

  const r = await recalcularTracado(
    { rotaId: ROTA_ID, pedidoId: 'p1', origem: ORIGEM, uid: 'motorista-1' },
    repo,
    osrm,
  );

  assert.ok(r.ok);
  assert.deepEqual(osrm.pontos[0]![1], COORD_PARADA);
});

test('recalcular NÃO grava: a polyline publicada continua a mesma', async () => {
  const repo = await repoComRota([parada('p1')]);

  await recalcularTracado(
    { rotaId: ROTA_ID, pedidoId: 'p1', origem: ORIGEM, uid: 'motorista-1' },
    repo,
    osrmFake(),
  );

  const rota = await repo.obterRota(ROTA_ID);
  assert.equal(rota!.polylinePlanejada, 'planejada');
});

test('parada já resolvida é recusada (409)', async () => {
  const repo = await repoComRota([parada('p1', 'entregue')]);

  const r = await recalcularTracado(
    { rotaId: ROTA_ID, pedidoId: 'p1', origem: ORIGEM, uid: 'motorista-1' },
    repo,
    osrmFake(),
  );

  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 409);
});

test('parada de outra rota, rota alheia e posição inválida são recusadas', async () => {
  const repo = await repoComRota([parada('p1')]);
  const osrm = osrmFake();

  const inexistente = await recalcularTracado(
    { rotaId: ROTA_ID, pedidoId: 'nao-existe', origem: ORIGEM, uid: 'motorista-1' },
    repo,
    osrm,
  );
  assert.equal(inexistente.ok, false);
  if (!inexistente.ok) assert.equal(inexistente.status, 404);

  const alheia = await recalcularTracado(
    { rotaId: ROTA_ID, pedidoId: 'p1', origem: ORIGEM, uid: 'outro' },
    repo,
    osrm,
  );
  assert.equal(alheia.ok, false);
  if (!alheia.ok) assert.equal(alheia.status, 403);

  const semPosicao = await recalcularTracado(
    { rotaId: ROTA_ID, pedidoId: 'p1', origem: null, uid: 'motorista-1' },
    repo,
    osrm,
  );
  assert.equal(semPosicao.ok, false);
  if (!semPosicao.ok) assert.equal(semPosicao.status, 400);

  // Nenhuma das recusas chegou a acordar o OSRM.
  assert.equal(osrm.pontos.length, 0);
});

test('rotaId com barra não vira caminho de documento (404)', async () => {
  const repo = await repoComRota([parada('p1')]);

  const r = await recalcularTracado(
    { rotaId: `${ROTA_ID}/../outra`, pedidoId: 'p1', origem: ORIGEM, uid: 'motorista-1' },
    repo,
    osrmFake(),
  );

  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 404);
});

test('OSRM dormindo devolve 503 com mensagem, não 500 cru', async () => {
  const repo = await repoComRota([parada('p1')]);
  const osrm = osrmFake();
  osrm.route = async () => {
    throw new Error('Roteirizador indisponível (pode estar acordando)');
  };

  const r = await recalcularTracado(
    { rotaId: ROTA_ID, pedidoId: 'p1', origem: ORIGEM, uid: 'motorista-1' },
    repo,
    osrm,
  );

  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 503);
    assert.match(r.erro, /acordando/);
  }
});
