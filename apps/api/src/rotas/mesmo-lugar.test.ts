import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agruparMesmoLugar, mesmoPercurso } from './mesmo-lugar.js';

/** Parada inventada: pedido, cliente e um ponto (só a latitude varia). */
const p = (pedido: string, cliente: string, lat: number) => ({ pedido, cliente, coordenada: { lat, lng: -36.6 } });
const agrupar = (itens: ReturnType<typeof p>[]) =>
  agruparMesmoLugar(itens, (i) => i.coordenada, (i) => i.cliente).map((i) => i.pedido);

test('a cliente com vários pedidos sai em sequência, onde apareceu primeiro', () => {
  // O caso do campo: pontos iguais (centro da cidade) e a cliente X partida
  // em duas — 07, 08 e depois 17, 18, 19.
  const centro = -9.5376;
  const ordem = [
    p('a', 'X', centro),
    p('b', 'X', centro),
    p('c', 'Y', centro),
    p('d', 'Z', centro),
    p('e', 'X', centro),
    p('f', 'X', centro),
  ];
  assert.deepEqual(agrupar(ordem), ['a', 'b', 'e', 'f', 'c', 'd']);
});

test('o mesmo ponto não é visitado duas vezes; os outros pontos não mudam de ordem', () => {
  const ordem = [p('a', 'X', 1), p('b', 'Y', 2), p('c', 'W', 1), p('d', 'Z', 3), p('e', 'X', 1)];
  // O ponto 1 junta tudo na primeira passagem; dentro dele, a X antes da W.
  assert.deepEqual(agrupar(ordem), ['a', 'e', 'c', 'b', 'd']);
});

test('mesma cliente em outro ponto (entrega em local diverso) não é puxada', () => {
  const ordem = [p('a', 'X', 1), p('b', 'Y', 2), p('c', 'X', 3)];
  assert.deepEqual(agrupar(ordem), ['a', 'b', 'c']);
});

test('sem nada repetido, a ordem é a mesma; nada se perde nem se duplica', () => {
  const ordem = [p('a', 'X', 4), p('b', 'Y', 2), p('c', 'Z', 9)];
  assert.deepEqual(agrupar(ordem), ['a', 'b', 'c']);
  assert.deepEqual(agrupar([]), []);
});

test('mesmo percurso: só troca entre paradas do mesmo ponto não muda o caminho', () => {
  const ponto = (i: ReturnType<typeof p>) => i.coordenada;
  const a = [p('a', 'X', 1), p('b', 'Y', 1), p('c', 'X', 1), p('d', 'Z', 2)];
  const trocada = [a[0]!, a[2]!, a[1]!, a[3]!];
  assert.equal(mesmoPercurso(trocada, a, ponto), true);
  assert.equal(mesmoPercurso([a[3]!, a[0]!, a[1]!, a[2]!], a, ponto), false);
});
