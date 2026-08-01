import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusForaDeRota } from './despacho.js';

const PIN = { lat: -9.9, lng: -36.5 };

test('cliente com ponto → pronto; sem ponto → mapeamento (o caso comum)', () => {
  assert.equal(statusForaDeRota({}, true), 'pronto_para_rota');
  assert.equal(statusForaDeRota({}, false), 'pendente_de_mapeamento');
});

test('override do pedido (8.4) é ponto: despachável mesmo com cliente nunca mapeado', () => {
  // O bug que motivou este módulo: quatro lugares consultavam só o cliente e
  // mandavam para mapeamento em campo um pedido cujo pin o escritório já deu.
  assert.equal(
    statusForaDeRota({ usarEnderecoEntrega: true, coordenadaEntrega: PIN }, false),
    'pronto_para_rota',
  );
});

test('escolha "fiscal" (override recusado) volta a depender do cliente', () => {
  assert.equal(
    statusForaDeRota({ usarEnderecoEntrega: false, coordenadaEntrega: PIN }, false),
    'pendente_de_mapeamento',
  );
});

test('override marcado mas sem coordenada não vale como ponto (defensivo)', () => {
  // Não deveria existir — a decisão de entrega exige o pin — mas um doc torto
  // não pode virar "pronto" sem ter para onde ir.
  assert.equal(
    statusForaDeRota({ usarEnderecoEntrega: true, coordenadaEntrega: null }, false),
    'pendente_de_mapeamento',
  );
});
