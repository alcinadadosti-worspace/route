import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarDetectorChegada } from './chegada.js';

const s = (n: number) => n * 1000;

test('dispara depois de permanência contínua dentro do raio — não no primeiro contato', () => {
  const d = criarDetectorChegada(100, 30_000);
  assert.equal(d.registrar(80, 10, s(0)), false, 'primeiro contato não é chegada');
  assert.equal(d.registrar(60, 10, s(15)), false, '15 s ainda não fecham a permanência');
  assert.equal(d.registrar(70, 10, s(30)), true, '30 s dentro = chegou');
});

test('passar de carro na frente da casa não é chegada: sair zera a contagem', () => {
  const d = criarDetectorChegada(100, 30_000);
  d.registrar(80, 10, s(0));
  assert.equal(d.registrar(400, 10, s(10)), false, 'saiu do raio');
  assert.equal(d.registrar(90, 10, s(20)), false, 'voltou: contagem recomeça do zero');
  assert.equal(d.registrar(90, 10, s(45)), false, '25 s da nova contagem');
  assert.equal(d.registrar(90, 10, s(50)), true, '30 s da nova contagem');
});

test('leitura com precisão ruim não conta nem zera — pico de GPS não reinicia contagem legítima', () => {
  const d = criarDetectorChegada(100, 30_000);
  d.registrar(80, 10, s(0));
  // Leitura a 500 m mas com precisão de 80 m: não dá para confiar. Se zerasse,
  // toda sombra de árvore reiniciaria a espera.
  assert.equal(d.registrar(500, 80, s(10)), false);
  assert.equal(d.registrar(85, 10, s(30)), true, 'a contagem original continuou valendo');
});

test('sem posição (null) não conta nem zera', () => {
  const d = criarDetectorChegada(100, 30_000);
  d.registrar(80, 10, s(0));
  assert.equal(d.registrar(null, 10, s(10)), false);
  assert.equal(d.registrar(80, 10, s(30)), true);
});

test('dispara uma vez só — quem grava é o chamador, e grava uma vez', () => {
  const d = criarDetectorChegada(100, 30_000);
  d.registrar(50, 10, s(0));
  assert.equal(d.registrar(50, 10, s(30)), true);
  assert.equal(d.registrar(50, 10, s(60)), false, 'já disparou');
  assert.equal(d.registrar(50, 10, s(90)), false);
});

test('longe do raio nunca dispara, por mais tempo que passe', () => {
  const d = criarDetectorChegada(100, 30_000);
  for (let t = 0; t <= 300; t += 10) {
    assert.equal(d.registrar(150, 10, s(t)), false);
  }
});
