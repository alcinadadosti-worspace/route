import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Cliente } from '@rota/shared';
import type { LinhaCadastro } from './cadastro.js';
import type { LinhaPlanilha } from './planilha.js';
import {
  guardarRevendedoras,
  mesclarRevendedora,
  revendedoraDoCadastro,
  revendedoraDoPedido,
  revendedorasDosPedidos,
} from './revendedoras.js';
import { relatorioVazio } from './servico-planilha.js';
import { RepositorioMemoria, type Revendedora } from '../db/repositorio.js';

/** Registro no formato antigo (sem `fontes`) — o guardar ainda o aceita. */
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

function linhaCadastro(extra: Partial<LinhaCadastro> = {}, endereco: Partial<LinhaCadastro['endereco']> = {}): LinhaCadastro {
  return {
    codigo: '70000001',
    nome: 'JOANA BATISTA DA SILVA',
    papel: 'Cobre',
    telefones: ['(82) 99111-0000'],
    situacao: 'Ativo',
    endereco: {
      logradouro: 'RUA VELHA',
      complemento: '1',
      bairro: 'CENTRO',
      cidade: 'QUEBRANGULO',
      uf: 'AL',
      cep: '57750000',
      referencia: 'PERTO DA PRAÇA',
      ...endereco,
    },
    ...extra,
  };
}

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

/** Junta, na ordem dada, como cargas sucessivas fariam. */
function emOrdem(registros: Revendedora[]): Revendedora {
  let r: Revendedora | undefined;
  for (const nova of registros) r = mesclarRevendedora(r, nova) ?? r;
  return r!;
}

/** Todas as ordens possíveis. */
function permutacoes<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutacoes([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

const CADASTRO = revendedoraDoCadastro(linhaCadastro());
const ENTREGA_MARCO = revendedoraDoPedido(linhaPedido({ codigoPedido: '537000010', emitidoEm: '2026-03-01T00:00:00-03:00', telefone: '(82) 3333-4444' }));
const ENTREGA_SETEMBRO = revendedoraDoPedido(
  linhaPedido({
    codigoPedido: '537000020',
    emitidoEm: '2026-09-01T00:00:00-03:00',
    telefone: '',
    enderecoEntrega: { ...linhaPedido().enderecoEntrega, logradouro: 'RUA DE SETEMBRO' },
  }),
);
const RETIRADA_OUTUBRO = revendedoraDoPedido(
  linhaPedido({
    codigoPedido: '537000030',
    emitidoEm: '2026-10-01T00:00:00-03:00',
    tipoEntrega: 'retirada',
    enderecoCadastro: { ...linhaPedido().enderecoCadastro, logradouro: 'RUA RESIDENCIAL', cidade: 'IGACI' },
  }),
);

test('a base é a MESMA em qualquer ordem de carga — e recarregar não grava nada', () => {
  const ordens = permutacoes([CADASTRO, ENTREGA_MARCO, ENTREGA_SETEMBRO, RETIRADA_OUTUBRO]);
  const primeira = emOrdem(ordens[0]!);
  for (const ordem of ordens) assert.deepEqual(emOrdem(ordem), primeira);
  // Cada fonte recarregada por cima da base pronta: nada muda.
  for (const r of [CADASTRO, ENTREGA_MARCO, ENTREGA_SETEMBRO, RETIRADA_OUTUBRO]) {
    assert.equal(mesclarRevendedora(primeira, r), null);
  }
  // Endereço: a entrega mais nova; a retirada (residencial) não ganha dela.
  assert.equal(primeira.endereco.logradouro, 'RUA DE SETEMBRO');
  assert.equal(primeira.dadosDe, '2026-09-01T00:00:00-03:00');
  assert.equal(primeira.situacao, 'Ativo');
});

test('igual ao guardado em OUTRA ordem de chaves (como o banco devolve): não regrava', () => {
  const ordenar = (o: unknown): unknown =>
    o && typeof o === 'object' && !Array.isArray(o)
      ? Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, ordenar(v)]))
      : o;
  const pronta = emOrdem([CADASTRO, ENTREGA_MARCO]);
  assert.equal(mesclarRevendedora(ordenar(pronta) as Revendedora, ENTREGA_MARCO), null);
});

test('telefone: o CELULAR do cadastro, nunca o fixo do pedido; sem celular no cadastro, o do pedido', () => {
  // O pedido de março traz um fixo (a coluna da planilha é o residencial primeiro).
  assert.equal(emOrdem([ENTREGA_MARCO, CADASTRO]).telefone, '+5582991110000');
  assert.equal(emOrdem([CADASTRO, ENTREGA_MARCO]).telefone, '+5582991110000');
  // Coluna do celular com um FIXO e a do residencial com o celular (182 no real): o celular.
  const trocadas = revendedoraDoCadastro(linhaCadastro({ telefones: ['(82) 3333-4444', '(82) 98888-7777'] }));
  assert.equal(trocadas.telefone, '+5582988887777');
  // Coluna do celular inválida (sem DDD) e residencial boa (12 no real): não perde.
  assert.equal(revendedoraDoCadastro(linhaCadastro({ telefones: ['9999-1234', '(82) 98888-7777'] })).telefone, '+5582988887777');
  // Cadastro sem telefone: vale o do pedido.
  assert.equal(emOrdem([revendedoraDoCadastro(linhaCadastro({ telefones: [] })), ENTREGA_MARCO]).telefone, '+558233334444');
  // Pedido sem telefone não apaga nada.
  assert.equal(emOrdem([CADASTRO, ENTREGA_SETEMBRO]).telefone, '+5582991110000');
});

test('GPS e referência são do LUGAR: os da casa velha não vão para o endereço novo', () => {
  const cadastroComPin = revendedoraDoCadastro(linhaCadastro({}, { referencia: 'GPS -9.3112, -36.4634 PERTO DA PRAÇA' }));
  assert.ok(cadastroComPin.pin);
  const mudou = emOrdem([cadastroComPin, ENTREGA_SETEMBRO]);
  assert.equal(mudou.endereco.logradouro, 'RUA DE SETEMBRO');
  assert.equal(mudou.pin, null);
  assert.equal(mudou.referencia, '');
  // Pedido no MESMO endereço do cadastro, sem referência: a do cadastro fica.
  const mesmoLugar = revendedoraDoPedido(
    linhaPedido({ enderecoEntrega: { ...linhaPedido().enderecoEntrega, logradouro: 'RUA VELHA', complemento: '1' } }),
  );
  const junto = emOrdem([cadastroComPin, mesmoLugar]);
  assert.deepEqual(junto.pin, cadastroComPin.pin);
  assert.match(junto.referencia, /PERTO DA PRAÇA/);
});

test('linha de entrega: a referência do bloco do CADASTRO só vale se for o mesmo lugar', () => {
  const r = revendedoraDoPedido(
    linhaPedido({
      enderecoCadastro: { ...linhaPedido().enderecoCadastro, logradouro: 'RUA DE CASA', referencia: 'AO LADO DA IGREJA' },
    }),
  );
  assert.equal(r.endereco.logradouro, 'RUA NOVA');
  assert.equal(r.referencia, '');
});

test('entre dois pedidos vence o de data maior; no mesmo dia, o de código maior — em qualquer ordem', () => {
  const a = revendedoraDoPedido(linhaPedido({ codigoPedido: '537000040', emitidoEm: '2026-06-01T00:00:00-03:00', enderecoEntrega: { ...linhaPedido().enderecoEntrega, logradouro: 'RUA A' } }));
  const b = revendedoraDoPedido(linhaPedido({ codigoPedido: '537000041', emitidoEm: '2026-06-01T00:00:00-03:00', enderecoEntrega: { ...linhaPedido().enderecoEntrega, logradouro: 'RUA B' } }));
  assert.equal(emOrdem([a, b]).endereco.logradouro, 'RUA B');
  assert.equal(emOrdem([b, a]).endereco.logradouro, 'RUA B');
});

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

test('retirada não vence a ENTREGA mais velha nem o cadastro: o bloco dela é o residencial', () => {
  const entrega = linhaPedido({
    emitidoEm: '2026-09-01T00:00:00-03:00',
    enderecoEntrega: { ...linhaPedido().enderecoEntrega, logradouro: 'RUA DA ENTREGA' },
  });
  const retirada = linhaPedido({
    codigoPedido: '537000099',
    emitidoEm: '2026-10-01T00:00:00-03:00',
    tipoEntrega: 'retirada',
    enderecoCadastro: { ...linhaPedido().enderecoCadastro, logradouro: 'RUA DO CADASTRO', cidade: 'IGACI' },
  });
  for (const ordem of [[entrega, retirada], [retirada, entrega]]) {
    assert.equal(revendedorasDosPedidos(ordem).get('70000001')?.endereco.logradouro, 'RUA DA ENTREGA');
  }
  // Só retirada e cadastro: vale o cadastro (endereço de ENTREGA dele).
  const soRetirada = revendedorasDosPedidos([retirada]).get('70000001')!;
  assert.equal(emOrdem([soRetirada, CADASTRO]).endereco.logradouro, 'RUA VELHA');
  assert.equal(emOrdem([CADASTRO, soRetirada]).endereco.logradouro, 'RUA VELHA');
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
