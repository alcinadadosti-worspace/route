import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aplicarOrdemSugerida,
  ordemIncerta,
  ordenarPorProximidade,
  type ParadaOrdenavel,
} from './proximidade.js';
import { formatarDistancia } from './formato.js';

/** Três paradas ao longo de uma linha, ~1 km, ~3 km e ~5 km ao norte da base. */
const BASE = { lat: -10.28, lng: -36.56 };
const PARADAS: Array<ParadaOrdenavel & { nome: string }> = [
  { nome: 'longe', pedidoId: 'c', coordenada: { lat: -10.235, lng: -36.56 }, status: 'pendente' },
  { nome: 'perto', pedidoId: 'a', coordenada: { lat: -10.271, lng: -36.56 }, status: 'pendente' },
  { nome: 'meio', pedidoId: 'b', coordenada: { lat: -10.253, lng: -36.56 }, status: 'trilha' },
];

test('sem posição, não reordena e não inventa distância', () => {
  const r = ordenarPorProximidade(PARADAS, null);
  assert.deepEqual(
    r.map((p) => p.nome),
    ['longe', 'perto', 'meio'],
  );
  assert.ok(r.every((p) => p.distanciaM === null));
});

test('com posição, a mais perto vem primeiro e a distância é anotada', () => {
  const r = ordenarPorProximidade(PARADAS, BASE);
  assert.deepEqual(
    r.map((p) => p.nome),
    ['perto', 'meio', 'longe'],
  );
  assert.ok(r[0]!.distanciaM! < r[1]!.distanciaM!);
  // ~1 km da base até a primeira: confere a ordem de grandeza do haversine.
  assert.ok(r[0]!.distanciaM! > 900 && r[0]!.distanciaM! < 1100);
});

test('parada resolvida não disputa a próxima, mesmo sendo a mais perto', () => {
  const comEntregue: Array<ParadaOrdenavel & { nome: string }> = [
    ...PARADAS,
    // Praticamente em cima do motorista, porém já entregue.
    { nome: 'entregue', pedidoId: 'd', coordenada: { lat: -10.2801, lng: -36.56 }, status: 'entregue' },
  ];
  const r = ordenarPorProximidade(comEntregue, BASE);
  assert.equal(r[r.length - 1]!.nome, 'entregue');
  assert.deepEqual(
    r.map((p) => p.nome),
    ['perto', 'meio', 'longe', 'entregue'],
  );
});

test('ordem por estrada manda quando veio da API, e anota a distância na tela', () => {
  const r = aplicarOrdemSugerida(PARADAS, ['c', 'a', 'b'], BASE);
  assert.deepEqual(
    r.map((p) => p.pedidoId),
    ['c', 'a', 'b'],
  );
  // A distância continua sendo mostrada (linha reta), só não define a ordem.
  assert.ok(r.every((p) => typeof p.distanciaM === 'number'));
});

test('entregue depois do cálculo não fica encalhada no meio da ordem por estrada', () => {
  const comEntregue: Array<ParadaOrdenavel & { nome: string }> = [
    { nome: 'a', pedidoId: 'a', coordenada: { lat: -10.271, lng: -36.56 }, status: 'pendente' },
    { nome: 'b', pedidoId: 'b', coordenada: { lat: -10.253, lng: -36.56 }, status: 'entregue' },
    { nome: 'c', pedidoId: 'c', coordenada: { lat: -10.235, lng: -36.56 }, status: 'pendente' },
  ];
  // A API tinha devolvido a, b, c — b foi entregue depois disso.
  const r = aplicarOrdemSugerida(comEntregue, ['a', 'b', 'c'], BASE);
  assert.deepEqual(
    r.map((p) => p.pedidoId),
    ['a', 'c', 'b'],
  );
});

test('parada fora da ordem sugerida vai para o fim, não some da tela', () => {
  const r = aplicarOrdemSugerida(PARADAS, ['b', 'a'], BASE);
  assert.deepEqual(
    r.map((p) => p.pedidoId),
    ['b', 'a', 'c'],
  );
});

test('formatação de distância troca para km e usa vírgula', () => {
  assert.equal(formatarDistancia(null), '— m');
  assert.equal(formatarDistancia(840), '840 m');
  assert.equal(formatarDistancia(12340), '12,3 km');
});

/* ---------- o GPS sabe mesmo qual é a mais perto? ---------- */

const pendente = (distanciaM: number) => ({
  coordenada: { lat: 0, lng: 0 },
  status: 'pendente' as const,
  distanciaM,
});

test('diferença MENOR que o erro do GPS: a ordem é incerta e quem usa precisa saber', () => {
  // 1ª a 800 m, 2ª a 850 m, aparelho com ±1200 m (leitura de rede, não GNSS):
  // o GPS não distingue as duas. Era o caso que passava despercebido — a lista
  // usava a leitura crua enquanto todo o resto do app filtra precisão.
  assert.equal(ordemIncerta([pendente(800), pendente(850)], 1200), true);
});

test('diferença MAIOR que o erro: a ordem vale, mesmo com GPS mediano', () => {
  // Numa rota rural com paradas a quilômetros, ±300 m não atrapalha nada —
  // avisar aqui seria ruído que ensina a ignorar avisos.
  assert.equal(ordemIncerta([pendente(1000), pendente(6000)], 300), false);
});

test('sem leitura de precisão, ou com menos de duas disputando, não avisa', () => {
  assert.equal(ordemIncerta([pendente(100), pendente(2000)], null), false);
  assert.equal(ordemIncerta([pendente(100)], 500), false);
  assert.equal(ordemIncerta([], 500), false);
});

test('parada resolvida não conta na disputa — ela não é candidata a próxima', () => {
  const entregue = {
    coordenada: { lat: 0, lng: 0 },
    status: 'entregue' as const,
    distanciaM: 10,
  };
  // A entregue está a 10 m, mas quem disputa são as duas pendentes (bem
  // separadas): não há incerteza.
  assert.equal(ordemIncerta([entregue, pendente(1000), pendente(9000)], 200), false);
});
