import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pontosRepetidos } from './pontoRepetido.js';
import type { EnderecoFiscal } from './tipos.js';

const end = (logradouro: string, numero = 'S/N'): EnderecoFiscal => ({
  logradouro,
  numero,
  complemento: '',
  bairro: 'ZONA RURAL',
  municipio: 'JUNQUEIRO',
  uf: 'AL',
  cep: '57270000',
});
const CENTRO = { lat: -9.92078, lng: -36.47393 };

test('endereços diferentes no mesmo ponto: os dois são suspeitos', () => {
  const r = pontosRepetidos([
    { id: 'a', coordenada: CENTRO, enderecoFiscal: end('POVOADO RETIRO') },
    { id: 'b', coordenada: { lat: -9.920781, lng: -36.473932 }, enderecoFiscal: end('CHÁ DA PONTE') },
    { id: 'c', coordenada: { lat: -9.95, lng: -36.5 }, enderecoFiscal: end('POVOADO INGÁ') },
  ]);
  assert.deepEqual([...r].sort(), ['a', 'b']);
});

test('mesmo endereço no mesmo ponto (mesma casa) não é suspeito; sem ponto é ignorado', () => {
  const r = pontosRepetidos([
    { id: 'mae', coordenada: CENTRO, enderecoFiscal: end('RUA A', '10') },
    { id: 'filha', coordenada: CENTRO, enderecoFiscal: end('Rua A', '10') },
    { id: 'sem', coordenada: null, enderecoFiscal: end('RUA B') },
  ]);
  assert.equal(r.size, 0);
});

test('mesma rua, números diferentes, mesmo ponto: é o centro da rua, não a casa', () => {
  const r = pontosRepetidos([
    { id: 'a', coordenada: CENTRO, enderecoFiscal: end('RUA A', '10') },
    { id: 'b', coordenada: CENTRO, enderecoFiscal: end('RUA A', '250') },
  ]);
  assert.equal(r.size, 2);
});
