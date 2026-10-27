import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RevendedoraCandidata } from '@rota/shared';
import {
  camposIniciais,
  clienteDoErp,
  corpoDoFormulario,
  formularioAlterado,
  resumoDoSalvo,
  trocarEscolhida,
} from './formularioCliente.js';

function candidata(codigo: string, extra: Partial<RevendedoraCandidata> = {}): RevendedoraCandidata {
  return {
    codigo,
    nome: 'MARIA DO SITE',
    endereco: 'RUA X, 1 — CENTRO, PENEDO/AL',
    telefone: null,
    papel: null,
    referencia: '',
    situacao: 'Ativo',
    dadosDe: null,
    ...extra,
  };
}

test('abre com o telefone legível, não "+5582…"', () => {
  assert.deepEqual(camposIniciais({ telefone: '+5582999887766', observacoes: 'casa azul' }), {
    telefone: '(82) 99988-7766',
    observacoes: 'casa azul',
  });
  assert.equal(camposIniciais({ telefone: null, observacoes: '' }).telefone, '');
});

test('só manda o que MUDOU: a referência que o motorista escreveu com a tela aberta não volta ao texto velho', () => {
  const inicial = camposIniciais({ telefone: null, observacoes: 'subida do mercadinho' });
  // O Admin só pôs o telefone.
  const corpo = corpoDoFormulario(inicial, { ...inicial, telefone: '(82) 99999-1234' }, null);
  assert.deepEqual(corpo, { telefone: '(82) 99999-1234' });
  assert.equal('observacoes' in corpo, false);
  // Nada mudou: corpo vazio ("não tenho mais dados").
  assert.deepEqual(corpoDoFormulario(inicial, inicial, null), {});
  assert.equal(formularioAlterado(inicial, inicial, null), false);
});

test('trocar da homônima A (com telefone) para a B (sem): o telefone da A SAI', () => {
  const inicial = camposIniciais({ telefone: null, observacoes: '' });
  const a = candidata('1', { telefone: '+5582900000001', referencia: 'REF DA A', papel: 'Ouro' });
  const b = candidata('2', { referencia: 'REF DA B' });
  const comA = trocarEscolhida(inicial, inicial, null, a);
  assert.deepEqual(comA, { telefone: '(82) 90000-0001', observacoes: 'REF DA A' });
  const comB = trocarEscolhida(comA, inicial, a, b);
  assert.deepEqual(comB, { telefone: '', observacoes: 'REF DA B' });
  // E o corpo leva o código da B sem o papel nulo dela por cima do que existe.
  assert.deepEqual(corpoDoFormulario(inicial, comB, b), { observacoes: 'REF DA B', codigo: '2' });
});

test('desfazer a escolha devolve o que o formulário tinha; o que o Admin digitou fica', () => {
  const inicial = camposIniciais({ telefone: '+5582911110000', observacoes: 'portão verde' });
  const a = candidata('1', { telefone: '+5582900000001', referencia: 'REF DA A' });
  const comA = trocarEscolhida(inicial, inicial, null, a);
  // A referência existente não é trocada pela da base.
  assert.deepEqual(comA, { telefone: '(82) 90000-0001', observacoes: 'portão verde' });
  assert.deepEqual(trocarEscolhida(comA, inicial, a, null), inicial);
  // Digitado à mão depois de escolher: desfazer não apaga.
  const digitado = { ...comA, telefone: '(82) 98888-7777' };
  assert.equal(trocarEscolhida(digitado, inicial, a, null).telefone, '(82) 98888-7777');
});

test('desfazer volta ao que o Admin tinha DIGITADO antes de escolher, não ao que abriu', () => {
  const inicial = camposIniciais({ telefone: null, observacoes: '' });
  const digitado = { telefone: '(82) 98888-7777', observacoes: 'portão verde' };
  const a = candidata('1', { telefone: '+5582900000001' });
  // O componente guarda os campos de antes da escolha e volta a eles.
  const comA = trocarEscolhida(digitado, digitado, null, a);
  assert.equal(comA.telefone, '(82) 90000-0001');
  assert.deepEqual(trocarEscolhida(comA, digitado, a, null), digitado);
  void inicial;
});

test('cliente do ERP (id = código) não é "fora da base"', () => {
  assert.equal(clienteDoErp('70000001'), true);
  assert.equal(clienteDoErp('a'.repeat(64)), false);
});

test('o resumo diz o que foi gravado de fato', () => {
  assert.equal(resumoDoSalvo({}, null), 'sem mais dados — a entrega segue com o nome e o endereço da folha.');
  assert.equal(resumoDoSalvo({ telefone: '82999991234' }, '+5582999991234'), 'telefone (82) 99999-1234 — salvo.');
  assert.equal(
    resumoDoSalvo({ observacoes: 'casa azul', codigo: '70000001' }, null),
    'referência, ligado ao cód. 70000001 — salvo.',
  );
  assert.equal(resumoDoSalvo({ telefone: '' }, null), 'telefone apagado — salvo.');
});
