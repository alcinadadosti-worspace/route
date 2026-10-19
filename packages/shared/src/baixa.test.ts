import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aplicarBaixas, paradasEmAberto, rotasSemBaixa } from './baixa.js';
import { excecoesDaSelecao, municipioDoPedido } from './excecoes.js';
import type { ExcecaoRota, ParadaRota, Rota } from './tipos.js';

const MARCA = { em: '2026-10-16T18:00:00.000Z', por: 'admin-1' };

function parada(pedidoId: string, status: ParadaRota['status'] = 'em_rota'): ParadaRota {
  return {
    pedidoId,
    clienteId: `c-${pedidoId}`,
    nome: `CLIENTE ${pedidoId}`,
    endereco: 'Rua A, 1',
    telefone: null,
    itens: [],
    volumes: 1,
    pesoBrutoKg: 2,
    coordenada: { lat: -9.7, lng: -36.3 },
    etaMin: 10,
    distanciaKm: 5,
    status,
  };
}

function excecao(pedidoId: string, status: ExcecaoRota['status'] = 'em_rota'): ExcecaoRota {
  return {
    pedidoId,
    clienteId: `c-${pedidoId}`,
    nome: `RURAL ${pedidoId}`,
    endereco: 'Sítio Tal',
    telefone: null,
    volumes: 1,
    pesoBrutoKg: 2,
    status,
  };
}

function rota(paradas: ParadaRota[], excecoes?: ExcecaoRota[]): Rota {
  return {
    data: '2026-10-16',
    motoristaId: 'm1',
    origemCdId: 'penedo',
    origemNome: 'CD Penedo',
    origemCoordenada: { lat: -10.28, lng: -36.56 },
    retornaAoCd: true,
    paradas,
    ...(excecoes ? { excecoes } : {}),
    polylinePlanejada: '',
    distanciaTotalKm: 10,
    duracaoTotalMin: 30,
    status: 'publicada',
    publicadaEm: '2026-10-16T07:00:00.000Z',
    concluidaEm: null,
  };
}

test('baixa parcial: marca as paradas, a rota passa a em_execucao e não conclui', () => {
  const r = aplicarBaixas(rota([parada('a'), parada('b')]), [{ pedidoId: 'a', resultado: 'entregue' }], MARCA);
  assert.ok(r.ok);
  assert.deepEqual(r.rota.paradas.map((p) => p.status), ['entregue', 'em_rota']);
  assert.deepEqual(r.rota.paradas[0]!.baixaNoPainel, MARCA);
  assert.equal(r.rota.paradas[1]!.baixaNoPainel, undefined);
  assert.equal(r.rota.status, 'em_execucao');
  assert.equal(r.rota.concluidaEm, null);
  assert.deepEqual(r.entregues, ['a']);
});

test('"não entregue" vira insucesso na parada e a última baixa conclui a rota', () => {
  const r = aplicarBaixas(
    rota([parada('a')], [excecao('x')]),
    [
      { pedidoId: 'a', resultado: 'nao_entregue' },
      { pedidoId: 'x', resultado: 'entregue' },
    ],
    MARCA,
  );
  assert.ok(r.ok);
  assert.equal(r.rota.paradas[0]!.status, 'insucesso');
  assert.equal(r.rota.excecoes![0]!.status, 'entregue');
  assert.equal(r.rota.status, 'concluida');
  assert.equal(r.rota.concluidaEm, MARCA.em);
  assert.deepEqual(r.naoEntregues, ['a']);
});

test('exceção pendente segura a rota aberta: conclui só com TODAS as paradas e exceções', () => {
  const r = aplicarBaixas(rota([parada('a')], [excecao('x')]), [{ pedidoId: 'a', resultado: 'entregue' }], MARCA);
  assert.ok(r.ok);
  assert.equal(r.rota.status, 'em_execucao');
});

test('não sobrescreve resultado já registrado (pelo app ou por baixa anterior)', () => {
  const r = aplicarBaixas(rota([parada('a', 'entregue')]), [{ pedidoId: 'a', resultado: 'nao_entregue' }], MARCA);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.erro, /já tem resultado/);
});

test('recusa pedido de fora da rota, repetido, resultado inválido e lista vazia', () => {
  const base = rota([parada('a')]);
  assert.equal(aplicarBaixas(base, [{ pedidoId: 'z', resultado: 'entregue' }], MARCA).ok, false);
  assert.equal(
    aplicarBaixas(
      base,
      [
        { pedidoId: 'a', resultado: 'entregue' },
        { pedidoId: 'a', resultado: 'nao_entregue' },
      ],
      MARCA,
    ).ok,
    false,
  );
  assert.equal(
    aplicarBaixas(base, [{ pedidoId: 'a', resultado: 'insucesso' as never }], MARCA).ok,
    false,
  );
  assert.equal(aplicarBaixas(base, [], MARCA).ok, false);
});

test('rota antiga sem exceções continua sem o campo depois da baixa', () => {
  const r = aplicarBaixas(rota([parada('a')]), [{ pedidoId: 'a', resultado: 'entregue' }], MARCA);
  assert.ok(r.ok);
  assert.equal('excecoes' in r.rota, false);
});

test('baixa numa rota que o motorista FECHOU com parada aberta não a reabre', () => {
  // Reaberta, ela voltaria a ser a rota ativa no celular do motorista.
  const fechada = {
    ...rota([parada('a'), parada('b')], [excecao('x')]),
    status: 'concluida' as const,
    concluidaEm: '2026-10-15T20:00:00.000Z',
  };
  const r = aplicarBaixas(fechada, [{ pedidoId: 'a', resultado: 'entregue' }], MARCA);
  assert.ok(r.ok);
  assert.equal(r.rota.status, 'concluida');
  assert.equal(r.rota.concluidaEm, '2026-10-15T20:00:00.000Z');
});

test('rotasSemBaixa: só dias anteriores com parada ou exceção sem resultado — fechada ou não', () => {
  const ontem = { ...rota([parada('a')]), data: '2026-10-15' };
  const ontemSoExcecao = { ...rota([parada('b', 'entregue')], [excecao('x')]), data: '2026-10-15' };
  const ontemResolvida = { ...rota([parada('c', 'entregue')]), data: '2026-10-15', status: 'concluida' as const };
  // Fechada no app com parada por entregar: o pedido dela segue preso.
  const ontemFechadaAberta = {
    ...rota([parada('e', 'entregue'), parada('f')]),
    data: '2026-10-15',
    status: 'concluida' as const,
  };
  const hoje = rota([parada('d')]);
  const achadas = rotasSemBaixa(
    [ontem, ontemSoExcecao, ontemResolvida, ontemFechadaAberta, hoje],
    '2026-10-16',
  );
  assert.deepEqual(achadas, [ontem, ontemSoExcecao, ontemFechadaAberta]);
  assert.equal(paradasEmAberto(ontemSoExcecao), 1);
});

test('exceções sugeridas: mesmo município (sem acento/caixa) e mesmo CD', () => {
  const ids = excecoesDaSelecao(
    [{ municipio: 'Teotônio Vilela', cdId: 'penedo' }],
    [
      { id: 'mesma-cidade', municipio: 'TEOTONIO VILELA', cdId: 'penedo' },
      { id: 'sem-cd', municipio: 'teotonio  vilela', cdId: null },
      { id: 'outro-cd', municipio: 'Teotônio Vilela', cdId: 'palmeira' },
      { id: 'outra-cidade', municipio: 'Junqueiro', cdId: 'penedo' },
      { id: 'sem-municipio', municipio: null, cdId: 'penedo' },
    ],
  );
  assert.deepEqual(ids, ['mesma-cidade', 'sem-cd']);
});

test('exceção casa a cidade mesmo sem o apóstrofo ("OLHO DÁGUA" = "OLHO D\'ÁGUA")', () => {
  // Planilha real: o pedido com ponto escrito de um jeito, os rurais do outro —
  // e os rurais nunca apareciam como exceção da cidade.
  const ids = excecoesDaSelecao(
    [{ municipio: "OLHO D'ÁGUA GRANDE", cdId: 'penedo' }],
    [
      { id: 'sem-apostrofo', municipio: 'OLHO DÁGUA GRANDE', cdId: 'penedo' },
      { id: 'com-hifen', municipio: 'Olho-Dagua Grande', cdId: 'penedo' },
      { id: 'outra', municipio: "OLHO D'ÁGUA DAS FLORES", cdId: 'penedo' },
    ],
  );
  assert.deepEqual(ids, ['sem-apostrofo', 'com-hifen']);
});

test('sem pedido marcado não há exceção sugerida', () => {
  assert.deepEqual(excecoesDaSelecao([], [{ id: 'a', municipio: 'Penedo', cdId: null }]), []);
});

test('município do pedido segue o override de entrega, como a rota', () => {
  const cliente = {
    enderecoFiscal: { logradouro: '', numero: '', bairro: '', municipio: 'Penedo', uf: 'AL', cep: '' },
  };
  const entrega = { ...cliente.enderecoFiscal, municipio: 'Igreja Nova' };
  assert.equal(municipioDoPedido({}, cliente), 'Penedo');
  assert.equal(municipioDoPedido({ usarEnderecoEntrega: true, enderecoEntrega: entrega }, cliente), 'Igreja Nova');
  assert.equal(municipioDoPedido({ usarEnderecoEntrega: false, enderecoEntrega: entrega }, cliente), 'Penedo');
  assert.equal(municipioDoPedido({}, null), null);
});
