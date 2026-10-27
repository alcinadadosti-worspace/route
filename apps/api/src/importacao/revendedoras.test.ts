import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Cliente } from '@rota/shared';
import type { LinhaPlanilha } from './planilha.js';
import { guardarRevendedoras, mesclarRevendedora, revendedorasDosPedidos } from './revendedoras.js';
import { relatorioVazio } from './servico-planilha.js';
import { RepositorioMemoria, type Revendedora } from '../db/repositorio.js';

function rev(extra: Partial<Revendedora> = {}): Revendedora {
  return {
    nome: 'JOANA BATISTA DA SILVA',
    chave: 'JOANA BATISTA DA SILVA|QUEBRANGULO',
    telefone: '+5582911110000',
    papel: 'Ouro',
    endereco: { logradouro: 'RUA VELHA', numero: '1', bairro: 'CENTRO', municipio: 'QUEBRANGULO', uf: 'AL', cep: '57750000' },
    referencia: 'PERTO DA PRAÇA',
    pin: null,
    situacao: 'Ativo',
    dadosDe: null,
    ...extra,
  };
}

const NOVO = { logradouro: 'RUA NOVA', numero: '9', bairro: 'CENTRO', municipio: 'QUEBRANGULO', uf: 'AL', cep: '57750000' };

test('pedido de 2026 vence o cadastro sem data no ENDEREÇO — em qualquer ordem de chegada', () => {
  const cadastro = rev();
  const pedido = rev({ endereco: NOVO, telefone: '+5582922220000', situacao: null, dadosDe: '2026-03-10T00:00:00-03:00' });
  // pedido chega depois do cadastro
  assert.equal(mesclarRevendedora(cadastro, pedido)?.endereco.logradouro, 'RUA NOVA');
  // cadastro chega depois do pedido: NÃO volta para a rua velha
  const depois = mesclarRevendedora(pedido, cadastro);
  assert.equal((depois ?? pedido).endereco.logradouro, 'RUA NOVA');
  // a situação, que só o cadastro tem, entra mesmo assim
  assert.equal(depois?.situacao, 'Ativo');
  // O telefone não é "o mais novo": o do cadastro (que escolhe o celular) fica.
  assert.equal(mesclarRevendedora(cadastro, pedido)?.telefone, '+5582911110000');
  assert.equal((depois ?? pedido).telefone, '+5582911110000');
});

test('telefone: o FIXO do pedido não toma o lugar do celular do cadastro — o WhatsApp é no celular', () => {
  // A coluna Telefone da planilha de pedidos traz o residencial primeiro.
  const cadastro = rev({ telefone: '+5582999991234' });
  const pedidoComFixo = rev({ telefone: '+558233334444', situacao: null, dadosDe: '2026-09-01T00:00:00-03:00' });
  assert.equal(mesclarRevendedora(cadastro, pedidoComFixo)?.telefone ?? cadastro.telefone, '+5582999991234');
  assert.equal(mesclarRevendedora(pedidoComFixo, cadastro)?.telefone, '+5582999991234');
  // Sem telefone no cadastro, o do pedido entra; celular do pedido vence fixo do cadastro.
  assert.equal(mesclarRevendedora(rev({ telefone: null }), pedidoComFixo)?.telefone, '+558233334444');
  const cadastroFixo = rev({ telefone: '+558233334444' });
  const pedidoCelular = rev({ telefone: '+5582988887777', situacao: null, dadosDe: '2026-09-01T00:00:00-03:00' });
  assert.equal(mesclarRevendedora(cadastroFixo, pedidoCelular)?.telefone, '+5582988887777');
});

test('o GPS e a referência da casa velha não vão junto para o endereço novo', () => {
  const cadastro = rev({ pin: { lat: -9.31, lng: -36.46 } });
  const mudou = rev({ endereco: NOVO, referencia: '', situacao: null, dadosDe: '2026-03-10T00:00:00-03:00' });
  const junta = mesclarRevendedora(cadastro, mudou)!;
  assert.equal(junta.endereco.logradouro, 'RUA NOVA');
  assert.equal(junta.pin, null);
  assert.equal(junta.referencia, '');
  // Mesmo endereço: o GPS e a referência que o dado novo não tem continuam.
  const mesmo = mesclarRevendedora(cadastro, rev({ situacao: null, referencia: '', dadosDe: '2026-03-10T00:00:00-03:00' }));
  assert.deepEqual((mesmo ?? cadastro).pin, { lat: -9.31, lng: -36.46 });
  assert.equal((mesmo ?? cadastro).referencia, 'PERTO DA PRAÇA');
});

test('igual ao guardado em OUTRA ordem de chaves (como o banco devolve): não regrava', () => {
  const guardada = Object.fromEntries(Object.entries(rev()).sort(([a], [b]) => a.localeCompare(b))) as unknown as Revendedora;
  assert.equal(mesclarRevendedora(guardada, rev()), null);
});

test('entre dois pedidos vence o de data maior; o vazio nunca apaga o que existe', () => {
  const marco = rev({ endereco: NOVO, dadosDe: '2026-03-10T00:00:00-03:00' });
  const janeiroSemFone = rev({ telefone: null, dadosDe: '2026-01-05T00:00:00-03:00' });
  assert.equal(mesclarRevendedora(marco, janeiroSemFone), null, 'mais velho não muda nada');
  const outubroSemFone = rev({ endereco: { ...NOVO, logradouro: 'RUA MAIS NOVA' }, telefone: null, dadosDe: '2026-10-01T00:00:00-03:00' });
  const junta = mesclarRevendedora(marco, outubroSemFone)!;
  assert.equal(junta.endereco.logradouro, 'RUA MAIS NOVA');
  assert.equal(junta.telefone, '+5582911110000', 'pedido sem telefone não apaga o telefone');
});

test('igual ao que está guardado: null (não regrava)', () => {
  assert.equal(mesclarRevendedora(rev(), rev()), null);
});

function linhaPedido(extra: Partial<LinhaPlanilha> = {}): LinhaPlanilha {
  const bloco = { logradouro: 'RUA NOVA', complemento: '9 CASA', bairro: 'CENTRO', cidade: 'QUEBRANGULO', uf: 'AL', cep: '57750000', referencia: '' };
  return {
    codigoPedido: '537000001',
    notaFiscal: 1,
    pessoa: '70000001',
    nome: 'JOANA BATISTA DA SILVA',
    papel: 'Ouro',
    quantidadeMateriais: 3,
    valor: 100,
    tipoEntrega: 'rota',
    tipoEntregaBruto: 'No endereço de entrega',
    cancelada: false,
    entregueNoErp: false,
    dataEntrega: null,
    enderecoCadastro: bloco,
    enderecoEntrega: bloco,
    telefone: '(82) 99999-1234',
    estrutura: '1515',
    codCd: '684',
    lote: null,
    volumes: 1,
    pesoBrutoKg: 1,
    emitidoEm: '2026-05-01T00:00:00-03:00',
    ...extra,
  };
}

test('pedidos do ano como dado de cliente: um por pessoa, o do pedido mais novo; retirada usa o cadastro', () => {
  const cd = { logradouro: 'AV DO CD', complemento: '874', bairro: 'X', cidade: 'PENEDO', uf: 'AL', cep: '', referencia: '' };
  const porCodigo = revendedorasDosPedidos([
    linhaPedido({ emitidoEm: '2026-09-01T00:00:00-03:00', enderecoEntrega: { ...linhaPedido().enderecoEntrega, logradouro: 'RUA SETEMBRO' } }),
    linhaPedido({ emitidoEm: '2026-02-01T00:00:00-03:00', enderecoEntrega: { ...linhaPedido().enderecoEntrega, logradouro: 'RUA FEVEREIRO' } }),
    // Retirada: o bloco de entrega é o endereço do CD — não pode virar o da pessoa.
    linhaPedido({
      pessoa: '999',
      tipoEntrega: 'retirada',
      enderecoEntrega: { ...cd, referencia: 'GPS -9.66, -36.44' },
    }),
  ]);
  assert.equal(porCodigo.size, 2);
  assert.equal(porCodigo.get('70000001')?.endereco.logradouro, 'RUA SETEMBRO');
  assert.equal(porCodigo.get('70000001')?.telefone, '+5582999991234');
  assert.equal(porCodigo.get('999')?.endereco.logradouro, 'RUA NOVA');
  // Nem o GPS do CD.
  assert.equal(porCodigo.get('999')?.pin, null);
});

test('retirada não vence a ENTREGA mais velha: o bloco dela é o do cadastro, não o do pedido', () => {
  const entrega = linhaPedido({
    emitidoEm: '2026-09-01T00:00:00-03:00',
    enderecoEntrega: { ...linhaPedido().enderecoEntrega, logradouro: 'RUA DA ENTREGA' },
  });
  const retirada = linhaPedido({
    emitidoEm: '2026-10-01T00:00:00-03:00',
    tipoEntrega: 'retirada',
    enderecoCadastro: { ...linhaPedido().enderecoCadastro, logradouro: 'RUA DO CADASTRO', cidade: 'IGACI' },
  });
  for (const ordem of [[entrega, retirada], [retirada, entrega]]) {
    assert.equal(revendedorasDosPedidos(ordem).get('70000001')?.endereco.logradouro, 'RUA DA ENTREGA');
  }
});

test('guardar: cliente existente só ganha o que falta; nenhum pedido é criado', async () => {
  const repo = new RepositorioMemoria();
  const cliente: Cliente = {
    nome: 'JOANA (DOS PEDIDOS)',
    documentoMascarado: 'cód. 70000001',
    telefone: '+5582900000000',
    email: null,
    enderecoFiscal: { logradouro: 'RUA DO PEDIDO', numero: '5', bairro: 'CENTRO', municipio: 'QUEBRANGULO', uf: 'AL', cep: '' },
    coordenada: null,
    statusMapeamento: 'nao_mapeado',
    trilhaAtivaId: null,
    mapeadoPor: null,
    mapeadoEm: null,
    fotoReferenciaPath: null,
    observacoes: '',
  };
  await repo.salvarCliente('70000001', cliente);
  // Outro cliente, em OUTRO endereço: a base fala de um lugar que não é o dele.
  await repo.salvarCliente('777', { ...cliente, nome: 'OUTRA', enderecoFiscal: { ...cliente.enderecoFiscal, logradouro: 'SITIO X' } });
  const r = relatorioVazio();
  const naBase = rev({ endereco: { ...cliente.enderecoFiscal, cep: '' }, pin: { lat: -9.31, lng: -36.46 } });
  await guardarRevendedoras(
    new Map([
      ['70000001', naBase],
      ['777', { ...naBase, nome: 'OUTRA', pin: { lat: -9.5, lng: -36.6 } }],
    ]),
    repo,
    r,
  );
  const c = await repo.obterCliente('70000001');
  assert.equal(c?.telefone, '+5582900000000', 'o telefone de 2026 fica');
  assert.equal(c?.nome, 'JOANA (DOS PEDIDOS)');
  assert.equal(c?.enderecoFiscal.logradouro, 'RUA DO PEDIDO');
  assert.deepEqual(c?.coordenada, { lat: -9.31, lng: -36.46 }, 'o GPS que faltava entra');
  assert.equal(c?.observacoes, 'PERTO DA PRAÇA');
  const outra = await repo.obterCliente('777');
  assert.equal(outra?.coordenada, null, 'GPS de outro endereço não entra');
  assert.equal(outra?.observacoes, '', 'nem a referência de outro lugar');
  assert.equal((await repo.listarPedidos()).length, 0);
  // Os dois ganham o papel, que é da pessoa; só o primeiro, o lugar.
  assert.equal(outra?.papel, 'Ouro');
  assert.equal(r.clientesAtualizados, 2);
});
