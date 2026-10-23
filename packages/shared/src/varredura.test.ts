import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voltaParaAFila } from './despacho.js';
import { chaveDeEndereco, enderecosDivergem, numeroDaCasa } from './endereco.js';
import { aplicarResultadoParada } from './execucao.js';
import type { EnderecoFiscal, ParadaRota } from './tipos.js';

const E: EnderecoFiscal = { logradouro: 'RUA A', numero: '149', bairro: 'CENTRO', municipio: 'PENEDO', uf: 'AL', cep: '57200000' };

test('o número da CASA decide, não o texto do complemento da planilha', () => {
  // Na planilha o "número" é o complemento inteiro: o mesmo endereço escrito de
  // dois jeitos abria revisão falsa e prendia o pedido na aba Decisões.
  assert.equal(enderecosDivergem(E, { ...E, numero: '149 CASA PRÓXIMO AO MERCADINHO' }), false);
  assert.equal(enderecosDivergem(E, { ...E, numero: '0149' }), false);
  assert.equal(enderecosDivergem({ ...E, numero: 'S/N' }, { ...E, numero: 'SN' }), false);
  assert.equal(enderecosDivergem(E, { ...E, numero: '250' }), true);
  assert.equal(numeroDaCasa('KM 12 POVOADO'), '12');
  assert.equal(numeroDaCasa('S\N'), '');
  // A chave da busca muda quando o endereço muda (e só então se paga de novo).
  assert.notEqual(chaveDeEndereco(E), chaveDeEndereco({ ...E, logradouro: 'RUA B' }));
  assert.equal(chaveDeEndereco(E), chaveDeEndereco({ ...E, logradouro: 'Rua A' }));
});

test('volta à fila: revisão de endereço aberta manda para Decisões; override com ponto não', () => {
  const comRevisao = { coordenada: { lat: -10, lng: -36 }, enderecoEmRevisao: E };
  assert.deepEqual(voltaParaAFila({}, comRevisao), { status: 'pendente_de_decisao', enderecoAnterior: E });
  assert.deepEqual(voltaParaAFila({}, { coordenada: { lat: -10, lng: -36 }, enderecoEmRevisao: null }), {
    status: 'pronto_para_rota',
  });
  assert.deepEqual(voltaParaAFila({}, { coordenada: null, enderecoEmRevisao: null }), { status: 'pendente_de_mapeamento' });
  // Override de entrega (8.4) com ponto próprio não depende do cadastro.
  assert.deepEqual(
    voltaParaAFila({ usarEnderecoEntrega: true, coordenadaEntrega: { lat: -10, lng: -36 } }, comRevisao),
    { status: 'pronto_para_rota' },
  );
});

test('confirmar a última PARADA não conclui a rota com exceção ainda no caminhão', () => {
  const parada = { pedidoId: 'a', status: 'em_rota' } as ParadaRota;
  assert.equal(aplicarResultadoParada([parada], 'a', 'entregue', [{ status: 'em_rota' }]).statusRota, 'em_execucao');
  assert.equal(aplicarResultadoParada([parada], 'a', 'entregue', [{ status: 'entregue' }]).statusRota, 'concluida');
  assert.equal(aplicarResultadoParada([parada], 'a', 'entregue').statusRota, 'concluida');
});
