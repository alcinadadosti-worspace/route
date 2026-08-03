import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { importarPlanilha } from './servico-planilha.js';
import { extrairCoordenada, lerPlanilha } from './planilha.js';
import { RepositorioMemoria } from '../db/repositorio.js';
import type { Cliente } from '@rota/shared';

/**
 * Monta um .xlsx no MESMO formato do export real do ERP (verificado byte a
 * byte no ciclo 11): sem sharedStrings, strings inline, namespace `x:`.
 * Testar contra outro formato provaria nada.
 */
function xlsxDe(linhas: Array<Record<string, string>>): Uint8Array {
  const COLUNAS = [
    'CodigoPedido',
    'NotaFiscal',
    'Pessoa',
    'NomePessoa',
    'Papel',
    'QtdeMateriais',
    'ValorPraticado',
    'Tipo de Entrega',
    'SituaçãoComercial',
    'Logradouro',
    'Complemento',
    'Bairro',
    'Cidade',
    'UF',
    'CEP',
    'Referência',
    'LogradouroEntrega',
    'ComplementoEntregaRetirada',
    'BairroEntregaRetirada',
    'CidadeEntregaRetirada',
    'UFEntregaRetirada',
    'CEPEntregaRetirada',
    'ReferênciaEntregaRetirada',
    'Telefone',
    'Cód Estrutura Pai',
    'Lote de separação',
    'Volume',
    'Peso Real',
    'Peso Estimado',
    'DataFaturamento',
  ];
  const letra = (i: number) => {
    let s = '';
    i += 1;
    while (i) {
      const r = (i - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  };
  const esc = (t: string) =>
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const row = (n: number, valores: string[]) =>
    `<x:row r="${n}">${valores
      .map((v, i) => `<x:c t="str" r="${letra(i)}${n}"><x:v>${esc(v)}</x:v></x:c>`)
      .join('')}</x:row>`;
  const corpo = [
    row(1, COLUNAS),
    ...linhas.map((l, i) => row(i + 2, COLUNAS.map((c) => l[c] ?? ''))),
  ].join('');
  const sheet =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<x:sheetData>${corpo}</x:sheetData></x:worksheet>`;
  return zipSync({
    'xl/workbook.xml': strToU8('<workbook/>'),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  });
}

/** Linha realista de ROTA (espelho da nota 293604 que foi para rota). */
function linhaRota(extra: Record<string, string> = {}): Record<string, string> {
  return {
    CodigoPedido: '523636997',
    NotaFiscal: '293604',
    Pessoa: '1260943',
    NomePessoa: 'CLAUDEANE ROSA FERREIRA',
    Papel: 'Diamante GB',
    QtdeMateriais: '7',
    ValorPraticado: '662.82',
    'Tipo de Entrega': 'No endereço de entrega',
    'SituaçãoComercial': 'Entregue',
    Logradouro: 'RUA DA PROVIDENCIA',
    Complemento: '149',
    Bairro: 'CENTRO',
    Cidade: 'IGREJA NOVA',
    UF: 'AL',
    CEP: '57280-000',
    'Referência': 'PROX A PISCINA DO VAL',
    LogradouroEntrega: 'RUA DA PROVIDENCIA',
    ComplementoEntregaRetirada: '149',
    BairroEntregaRetirada: 'CENTRO',
    CidadeEntregaRetirada: 'IGREJA NOVA',
    UFEntregaRetirada: 'AL',
    CEPEntregaRetirada: '57280-000',
    'ReferênciaEntregaRetirada': 'PROX A PISCINA DO VAL',
    Telefone: '82999310976',
    'Cód Estrutura Pai': '1.048',
    'Lote de separação': '48312281',
    Volume: '1',
    'Peso Real': '12047',
    'Peso Estimado': '12047',
    DataFaturamento: '20/07/2026',
    ...extra,
  };
}

function linhaRetirada(extra: Record<string, string> = {}): Record<string, string> {
  return linhaRota({
    CodigoPedido: '521670637',
    NotaFiscal: '291985',
    Pessoa: '35789',
    NomePessoa: 'ROSENILDA FARIAS DOS SANTOS',
    'Tipo de Entrega': 'Retirar na central de serviços',
    // Retirada: o bloco de ENTREGA traz o endereço do PRÓPRIO CD.
    LogradouroEntrega: 'AV WANDERLEY',
    ComplementoEntregaRetirada: '874',
    BairroEntregaRetirada: 'SANTA LUZIA',
    CidadeEntregaRetirada: 'PENEDO',
    Logradouro: 'RUA DA REVENDEDORA',
    Complemento: '10',
    Bairro: 'CENTRO',
    Cidade: 'PENEDO',
    ...extra,
  });
}

test('linha de ROTA vira pedido com modoEntrega=rota, Pessoa como cliente e quantidade da planilha', async () => {
  const repo = new RepositorioMemoria();
  const rel = await importarPlanilha('c.xlsx', xlsxDe([linhaRota()]), repo);

  assert.equal(rel.total, 1);
  assert.equal(rel.importados, 1);
  const pedido = (await repo.listarPedidos())[0]!;
  assert.equal(pedido.id, '523636997'); // CodigoPedido é o ID
  assert.equal(pedido.clienteId, '1260943'); // Pessoa é a identidade
  assert.equal(pedido.modoEntrega, 'rota');
  assert.equal(pedido.quantidadeMateriais, 7);
  assert.equal(pedido.valorTotal, 662.82);
  assert.equal(pedido.pesoBrutoKg, 12.047); // Peso Real vem em gramas
  assert.equal(pedido.serie, 1); // estrutura 1048 = Penedo = série 1
  assert.equal(pedido.cdId, 'penedo');
  assert.equal(pedido.status, 'pendente_de_mapeamento'); // sem geocodificador

  const cliente = (await repo.listarClientes())[0]!;
  assert.equal(cliente.id, '1260943');
  assert.equal(cliente.papel, 'Diamante GB');
  assert.equal(cliente.telefone, '+5582999310976');
  assert.equal(cliente.observacoes, 'PROX A PISCINA DO VAL'); // referência → dossiê
});

test('RETIRADA nasce classificada, SEM aba Decisões — e o cliente NÃO herda o endereço do CD', async () => {
  const repo = new RepositorioMemoria();
  const rel = await importarPlanilha('c.xlsx', xlsxDe([linhaRetirada()]), repo);

  assert.equal(rel.retiradas, 1);
  assert.equal(rel.pendentesDeDecisao, 0); // decisão do usuário: automático
  const pedido = (await repo.listarPedidos())[0]!;
  assert.equal(pedido.status, 'retirada');
  assert.equal(pedido.modoEntrega, 'retirada');

  // O bloco de entrega da linha era o CD (AV WANDERLEY); o cliente fica com o
  // endereço DELE — senão toda entrega futura apontaria para o galpão.
  const cliente = (await repo.listarClientes())[0]!;
  assert.equal(cliente.enderecoFiscal.logradouro, 'RUA DA REVENDEDORA');
});

test('cancelada NOVA é ignorada; cancelada JÁ IMPORTADA vira alerta com ação manual', async () => {
  const repo = new RepositorioMemoria();
  // 1º dia: pedido entra normal.
  await importarPlanilha('d1.xlsx', xlsxDe([linhaRota()]), repo);
  // 2º dia: o MESMO pedido vem cancelado, e um novo já-cancelado vem junto.
  const rel = await importarPlanilha(
    'd2.xlsx',
    xlsxDe([
      linhaRota({ 'SituaçãoComercial': 'Cancelado' }),
      linhaRetirada({ CodigoPedido: '999999999', 'SituaçãoComercial': 'Cancelado' }),
    ]),
    repo,
  );

  assert.equal(rel.canceladas, 2);
  assert.equal(rel.importados, 0);
  // o novo cancelado nunca virou pedido
  assert.equal((await repo.listarPedidos()).length, 1);
  // o existente NÃO foi apagado sozinho (nada decide sozinho) — virou alerta
  const alerta = rel.alertas.find((a) => /CANCELADO/i.test(a.mensagem));
  assert.ok(alerta);
  assert.match(alerta!.mensagem, /523636997/);
});

test('UF fora de AL é rejeitada com motivo; Tipo de Entrega desconhecido também', async () => {
  const repo = new RepositorioMemoria();
  const rel = await importarPlanilha(
    'c.xlsx',
    xlsxDe([
      linhaRota({ UFEntregaRetirada: 'SP', CodigoPedido: '111111111' }),
      linhaRota({ 'Tipo de Entrega': 'Entrega expressa drone', CodigoPedido: '222222222' }),
    ]),
    repo,
  );
  assert.equal(rel.importados, 0);
  assert.equal(rel.rejeitados.length, 2);
  assert.match(rel.rejeitados[0]!.motivo, /atende só AL/);
  assert.match(rel.rejeitados[1]!.motivo, /desconhecido/);
});

test('reimportar a planilha é inócuo (dedupe pelo CodigoPedido)', async () => {
  const repo = new RepositorioMemoria();
  await importarPlanilha('c.xlsx', xlsxDe([linhaRota(), linhaRetirada()]), repo);
  const rel = await importarPlanilha('c.xlsx', xlsxDe([linhaRota(), linhaRetirada()]), repo);
  assert.equal(rel.importados, 0);
  assert.equal(rel.duplicados, 2);
  assert.equal((await repo.listarPedidos()).length, 2);
});

test('coordenada GPS digitada no cadastro vira pin exato — e pula a fila do mapeamento', async () => {
  const repo = new RepositorioMemoria();
  const rel = await importarPlanilha(
    'c.xlsx',
    xlsxDe([linhaRota({ Complemento: '67 -10.404108,-36.431132', CodigoPedido: '333333333' })]),
    repo,
  );
  const cliente = (await repo.listarClientes())[0]!;
  assert.deepEqual(cliente.coordenada, { lat: -10.404108, lng: -36.431132 });
  assert.equal(cliente.statusMapeamento, 'geocodificado');
  // com pin, o pedido nasce DESPACHÁVEL mesmo sem Google
  assert.equal((await repo.listarPedidos())[0]!.status, 'pronto_para_rota');
  assert.ok(rel.alertas.some((a) => /pin exato/.test(a.mensagem)));
});

test('sem telefone na planilha, o telefone que o cliente JÁ TINHA fica', async () => {
  // 413 de 2019 linhas do ciclo real vêm sem telefone — e o ERP tem o número
  // (ele vai na NF-e). A política: o telefone mora no CLIENTE; a planilha
  // preenche quando traz, e nunca apaga o que existe.
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('1260943', {
    nome: 'CLAUDEANE ROSA FERREIRA',
    documentoMascarado: 'cód. 1260943',
    telefone: '+5582988887777',
    email: null,
    enderecoFiscal: {
      logradouro: 'RUA DA PROVIDENCIA',
      numero: '149',
      bairro: 'CENTRO',
      municipio: 'IGREJA NOVA',
      uf: 'AL',
      cep: '57280000',
    },
    coordenada: null,
    statusMapeamento: 'nao_mapeado',
    trilhaAtivaId: null,
    mapeadoPor: null,
    mapeadoEm: null,
    fotoReferenciaPath: null,
    observacoes: '',
  } satisfies Cliente);

  await importarPlanilha('c.xlsx', xlsxDe([linhaRota({ Telefone: '' })]), repo);
  assert.equal((await repo.listarClientes())[0]!.telefone, '+5582988887777');
});

test('observação escrita pelo motorista em campo NUNCA é sobrescrita pela referência', async () => {
  const repo = new RepositorioMemoria();
  await importarPlanilha('c.xlsx', xlsxDe([linhaRota()]), repo);
  // motorista escreve o que aprendeu no local
  const cliente = (await repo.listarClientes())[0]!;
  await repo.atualizarCliente('1260943', { observacoes: 'portão azul, entrar pela lateral' });
  void cliente;

  await importarPlanilha(
    'c2.xlsx',
    xlsxDe([linhaRota({ CodigoPedido: '444444444', 'Referência': 'OUTRA REFERENCIA' })]),
    repo,
  );
  assert.equal(
    (await repo.listarClientes())[0]!.observacoes,
    'portão azul, entrar pela lateral',
  );
});

test('lerPlanilha recusa zip corrompido e planilha sem as colunas esperadas', () => {
  assert.equal(lerPlanilha(new Uint8Array([1, 2, 3])).ok, false);
  const semColunas = zipSync({
    'xl/worksheets/sheet1.xml': strToU8(
      '<x:worksheet xmlns:x="a"><x:sheetData>' +
        '<x:row r="1"><x:c t="str" r="A1"><x:v>Qualquer</x:v></x:c></x:row>' +
        '<x:row r="2"><x:c t="str" r="A2"><x:v>x</x:v></x:c></x:row>' +
        '</x:sheetData></x:worksheet>',
    ),
  });
  const r = lerPlanilha(semColunas);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.motivo, /sem as colunas/);
});

test('extrairCoordenada: os formatos reais do cadastro, e lixo fora de AL não passa', () => {
  assert.deepEqual(extrairCoordenada(['67 -10.404108,-36.431132']), {
    lat: -10.404108,
    lng: -36.431132,
  });
  assert.deepEqual(extrairCoordenada(['-9.915996; -36.611081']), {
    lat: -9.915996,
    lng: -36.611081,
  });
  // DMS de celular: 10°07'30.1"S 36°10'11.9"W
  const dms = extrairCoordenada([`10°07'30.1"S36°10'11.9"W`]);
  assert.ok(dms && Math.abs(dms.lat - -10.125028) < 0.001 && Math.abs(dms.lng - -36.169972) < 0.001);
  // coordenada válida no MUNDO mas fora de Alagoas = lixo de digitação
  assert.equal(extrairCoordenada(['-23.55052, -46.633308']), null);
  assert.equal(extrairCoordenada(['PROX A PISCINA DO VAL', null, undefined]), null);
});

test('coordenada digitada junto do número não vaza para o endereço', async () => {
  // "67 -10.404108,-36.431132" no complemento: o texto inteiro iria para a
  // busca do Google e para a tela do motorista. Fica só o número.
  const repo = new RepositorioMemoria();
  await importarPlanilha(
    'c.xlsx',
    xlsxDe([
      linhaRota({ Complemento: '67 -10.404108,-36.431132', LogradouroEntrega: 'POVOADO SERRA',
        ComplementoEntregaRetirada: '67 -10.404108,-36.431132', CodigoPedido: '555555555' }),
    ]),
    repo,
  );
  const cliente = (await repo.listarClientes())[0]!;
  assert.equal(cliente.enderecoFiscal.numero, '67');
  assert.deepEqual(cliente.coordenada, { lat: -10.404108, lng: -36.431132 });
});

test('o mesmo cliente em várias linhas gera UMA escrita, não uma por linha', async () => {
  // 2019 pedidos para 1366 clientes no ciclo real: uma escrita por linha seriam
  // ~650 gravações redundantes, e misturaria `set` completo com `merge` parcial
  // do mesmo doc no mesmo lote.
  const repo = new RepositorioMemoria();
  const original = repo.gravarEmLote.bind(repo);
  let escritasDeCliente = 0;
  repo.gravarEmLote = async (escritas) => {
    escritasDeCliente += escritas.filter((e) => e.colecao === 'clientes').length;
    return original(escritas);
  };

  await importarPlanilha(
    'c.xlsx',
    xlsxDe([
      linhaRota({ CodigoPedido: '600000001' }),
      linhaRota({ CodigoPedido: '600000002' }),
      linhaRota({ CodigoPedido: '600000003' }),
    ]),
    repo,
  );
  assert.equal((await repo.listarPedidos()).length, 3);
  assert.equal((await repo.listarClientes()).length, 1);
  assert.equal(escritasDeCliente, 1);
});
