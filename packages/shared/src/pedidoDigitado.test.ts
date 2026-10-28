import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validarPedidoDigitado } from './pedidoDigitado.js';

const valido = {
  cdId: 'palmeira',
  notaFiscal: '165.330',
  cep: '57750-000',
  nome: '  maria  do teste ',
  pedido: ' 537733613 ',
  bairro: 'centro',
  cidade: 'quebrangulo',
  endereco: 'rua das flores, 43, casa-perto do mercado',
};

test('pedido digitado: as colunas da folha viram a linha do romaneio, limpas', () => {
  const r = validarPedidoDigitado(valido);
  assert.ok(r.ok);
  assert.deepEqual(r.pedido, {
    cdId: 'palmeira',
    notaFiscal: 165330,
    cep: '57750000',
    nome: 'MARIA DO TESTE',
    pedido: '537733613',
    bairro: 'CENTRO',
    cidade: 'QUEBRANGULO',
    uf: 'AL',
    endereco: 'RUA DAS FLORES, 43, CASA-PERTO DO MERCADO',
  });
});

test('pedido digitado: CEP em branco entra; pedido do site com o traço também', () => {
  const r = validarPedidoDigitado({ ...valido, cep: '', pedido: '160000001-1' });
  assert.ok(r.ok);
  assert.equal(r.pedido.cep, '');
  assert.equal(r.pedido.pedido, '160000001-1');
});

test('pedido digitado: cada campo errado diz o que falta — e nada passa', () => {
  const r = validarPedidoDigitado({ cep: '577', nome: 'MARIA 123.456.789-00', pedido: '12' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.deepEqual(Object.keys(r.erros).sort(), ['bairro', 'cdId', 'cep', 'cidade', 'endereco', 'nome', 'notaFiscal', 'pedido']);
  assert.match(r.erros.nome!, /CPF/);
  // Nenhuma mensagem com placeholder vazando.
  for (const m of Object.values(r.erros)) assert.doesNotMatch(m!, /\{|undefined|NaN/);
});

test('pedido digitado: corpo que não é objeto não quebra', () => {
  assert.equal(validarPedidoDigitado(null).ok, false);
  assert.equal(validarPedidoDigitado('x').ok, false);
});
