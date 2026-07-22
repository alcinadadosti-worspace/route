import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clienteIdDeDocumento, mascararDocumento } from './documento.js';
import { normalizarTelefone, linkWhatsApp } from './telefone.js';
import { ehEnderecoRural } from './endereco.js';
import { extrairPedidoELote } from './infcpl.js';
import { decodificarPolyline } from './polyline.js';
import type { EnderecoFiscal } from './tipos.js';

test('clienteId é determinístico e ignora formatação do documento', async () => {
  const a = await clienteIdDeDocumento('100.000.047-82');
  const b = await clienteIdDeDocumento('10000004782');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('máscara de CPF e CNPJ mostra apenas os dois últimos dígitos', () => {
  assert.equal(mascararDocumento('10000004782'), '***.***.***-82');
  assert.equal(mascararDocumento('14750618000155'), '**.***.***/****-55');
});

test('telefone normaliza para E.164 com +55', () => {
  assert.equal(normalizarTelefone('82999887766'), '+5582999887766');
  assert.equal(normalizarTelefone('8233221100'), '+558233221100');
  assert.equal(normalizarTelefone('5582999887766'), '+5582999887766');
  assert.equal(normalizarTelefone('082999887766'), '+5582999887766');
  assert.equal(normalizarTelefone(''), null);
  assert.equal(normalizarTelefone('3322'), null);
});

test('link de WhatsApp usa apenas dígitos', () => {
  assert.equal(linkWhatsApp('+5582999887766'), 'https://wa.me/5582999887766');
});

function endereco(parcial: Partial<EnderecoFiscal>): EnderecoFiscal {
  return {
    logradouro: 'Rua das Flores',
    numero: '10',
    bairro: 'Centro',
    municipio: 'Maceió',
    uf: 'AL',
    cep: '57000-010',
    ...parcial,
  };
}

test('heurística rural: CEP genérico terminado em 000', () => {
  assert.equal(ehEnderecoRural(endereco({ cep: '57270-000' })), true);
});

test('heurística rural: bairro zona rural (com ou sem acento/caixa)', () => {
  assert.equal(ehEnderecoRural(endereco({ bairro: 'Zona Rural' })), true);
  assert.equal(ehEnderecoRural(endereco({ bairro: 'ZONA   RURAL' })), true);
});

test('heurística rural: prefixos de logradouro', () => {
  assert.equal(ehEnderecoRural(endereco({ logradouro: 'POVOADO BREJO DOS BOIS' })), true);
  assert.equal(ehEnderecoRural(endereco({ logradouro: 'Sítio Boa Vista' })), true);
  assert.equal(ehEnderecoRural(endereco({ logradouro: 'Fazenda Santa Fé' })), true);
  assert.equal(ehEnderecoRural(endereco({ logradouro: 'ROD AL-110 KM 12' })), true);
});

test('endereço urbano plausível não é rural', () => {
  assert.equal(ehEnderecoRural(endereco({})), false);
});

test('decodifica encoded polyline (exemplo canônico do formato)', () => {
  const pontos = decodificarPolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.deepEqual(pontos, [
    { lat: 38.5, lng: -120.2 },
    { lat: 40.7, lng: -120.95 },
    { lat: 43.252, lng: -126.453 },
  ]);
  assert.deepEqual(decodificarPolyline(''), []);
});

test('extração de pedido e lote tolera variações de formato', () => {
  assert.deepEqual(extrairPedidoELote('PEDIDO: 499450697  LOTE: 47097393'), {
    numeroPedido: '499450697',
    lote: '47097393',
  });
  assert.deepEqual(extrairPedidoELote('*** Pedido # 499450697 *** Lote 47097393 ***'), {
    numeroPedido: '499450697',
    lote: '47097393',
  });
  assert.deepEqual(extrairPedidoELote('texto sem os campos'), {
    numeroPedido: null,
    lote: null,
  });
  assert.deepEqual(extrairPedidoELote(null), { numeroPedido: null, lote: null });
});
