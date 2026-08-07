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

test('cliente que ALTERNA rota/retirada não troca de endereço nem abre revisão falsa', async () => {
  // O bloco de CADASTRO diverge do de ENTREGA numa parte legítima da base (42
  // casos no ciclo 11). A linha de retirada usa o cadastro — se ela pudesse
  // escrever o endereço, cada alternância trocava o endereço do cliente e, com
  // pin, abria uma revisão "endereço mudou" que TRAVAVA o pedido seguinte na
  // aba Decisões por uma mudança que nunca existiu.
  const repo = new RepositorioMemoria();
  // 1º ciclo: entrega no POVOADO SERRA (com pin do cadastro — cliente fica com ponto).
  await importarPlanilha(
    'c1.xlsx',
    xlsxDe([
      linhaRota({
        LogradouroEntrega: 'POVOADO SERRA',
        Complemento: '67 -10.404108,-36.431132',
        CodigoPedido: '600000010',
      }),
    ]),
    repo,
  );
  // 2º ciclo: a MESMA revendedora retira no CD. O cadastro dela (RUA DA
  // PROVIDENCIA) diverge do endereço de entrega gravado (POVOADO SERRA).
  await importarPlanilha(
    'c2.xlsx',
    xlsxDe([linhaRota({
      'Tipo de Entrega': 'Retirar na central de serviços',
      LogradouroEntrega: 'AV WANDERLEY',
      ComplementoEntregaRetirada: '874',
      CidadeEntregaRetirada: 'PENEDO',
      CodigoPedido: '600000011',
    })]),
    repo,
  );

  const cliente = (await repo.listarClientes())[0]!;
  assert.equal(cliente.enderecoFiscal.logradouro, 'POVOADO SERRA', 'retirada não mexe no endereço');
  assert.equal(cliente.enderecoEmRevisao ?? null, null, 'nenhuma revisão falsa aberta');

  // 3º ciclo: volta a ser entrega, no MESMO lugar de sempre — tem de nascer
  // despachável, não preso numa pergunta.
  const rel = await importarPlanilha(
    'c3.xlsx',
    xlsxDe([linhaRota({ LogradouroEntrega: 'POVOADO SERRA', CodigoPedido: '600000012' })]),
    repo,
  );
  assert.equal(rel.pendentesDeDecisao, 0);
  const pedido = (await repo.listarPedidos()).find((p) => p.id === '600000012')!;
  assert.equal(pedido.status, 'pronto_para_rota');
});

test('quem só RETIRAVA e passa a receber em casa não nasce preso em Decisões', async () => {
  // Bug achado reordenando duas linhas do MESMO arquivo: com a retirada antes
  // da rota, o pedido de entrega saía `pendente_de_decisao`; com a rota antes,
  // `pronto_para_rota`. A linha de retirada já não mexia no endereço, mas ainda
  // gravava o PIN do cadastro — e pin + endereço divergente é exatamente o que
  // dispara a revisão de "mudou de lugar". A revendedora que sempre retirou não
  // tem lugar de ENTREGA estabelecido: a primeira rota dela não é mudança.
  const cadastroComGps = { Complemento: '149 -10.404108,-36.431132' };
  const doCiclo = (extra: Record<string, string>) => linhaRota({ ...cadastroComGps, ...extra });
  const retirada = {
    'Tipo de Entrega': 'Retirar na central de serviços',
    LogradouroEntrega: 'AV WANDERLEY',
    ComplementoEntregaRetirada: '874',
    CidadeEntregaRetirada: 'PENEDO',
  };

  // Ciclo 1: só retirou. Ciclo 2: primeira entrega em casa, endereço de entrega
  // legitimamente diferente do cadastro (42 casos reais no ciclo 11).
  const repo = new RepositorioMemoria();
  await importarPlanilha(
    'c1.xlsx',
    xlsxDe([doCiclo({ ...retirada, CodigoPedido: '900000011' })]),
    repo,
  );
  const rel = await importarPlanilha(
    'c2.xlsx',
    xlsxDe([doCiclo({ CodigoPedido: '900000012', LogradouroEntrega: 'POVOADO SERRA' })]),
    repo,
  );
  assert.equal(rel.pendentesDeDecisao, 0, 'primeira entrega não é "mudança de endereço"');
  const pedido = (await repo.listarPedidos()).find((p) => p.id === '900000012')!;
  assert.equal(pedido.status, 'pronto_para_rota');
  // O GPS do cadastro não se perdeu: a linha de rota lê a MESMA coluna.
  const cliente = (await repo.listarClientes())[0]!;
  assert.deepEqual(cliente.coordenada, { lat: -10.404108, lng: -36.431132 });

  // E o resultado não pode depender da ORDEM das linhas dentro do arquivo.
  for (const ordem of [
    ['retirada', 'rota'],
    ['rota', 'retirada'],
  ] as const) {
    const r = new RepositorioMemoria();
    const linhas = {
      retirada: doCiclo({ ...retirada, CodigoPedido: '900000021' }),
      rota: doCiclo({ CodigoPedido: '900000022', LogradouroEntrega: 'POVOADO SERRA' }),
    };
    await importarPlanilha('c.xlsx', xlsxDe(ordem.map((o) => linhas[o])), r);
    const daRota = (await r.listarPedidos()).find((p) => p.id === '900000022')!;
    assert.equal(daRota.status, 'pronto_para_rota', `ordem ${ordem.join(' → ')}`);
  }
});

test('GPS digitado no bloco do CD (linha de retirada) NUNCA vira pin do cliente', async () => {
  // Pin no galpão é o "ponto errado com cara de certo" — toda entrega futura
  // iria para o CD.
  const repo = new RepositorioMemoria();
  await importarPlanilha(
    'c.xlsx',
    xlsxDe([linhaRetirada({ ComplementoEntregaRetirada: '874 -10.280800,-36.559500' })]),
    repo,
  );
  const cliente = (await repo.listarClientes())[0]!;
  assert.equal(cliente.coordenada, null);
  assert.equal(cliente.statusMapeamento, 'nao_mapeado');
});

test('revisão de endereço gera UM alerta por cliente, não um por nota', async () => {
  // A mesma revendedora tem várias notas no ciclo (2019 pedidos para 1366
  // clientes): um alerta por linha afogaria os raros — a mesma inundação já
  // consertada no aviso de retirada.
  const repo = new RepositorioMemoria();
  await importarPlanilha(
    'c1.xlsx',
    xlsxDe([linhaRota({ Complemento: '67 -10.404108,-36.431132', CodigoPedido: '600000020' })]),
    repo,
  );
  const rel = await importarPlanilha(
    'c2.xlsx',
    xlsxDe([
      linhaRota({ LogradouroEntrega: 'RUA NOVA', CodigoPedido: '600000021' }),
      linhaRota({ LogradouroEntrega: 'RUA NOVA', CodigoPedido: '600000022' }),
      linhaRota({ LogradouroEntrega: 'RUA NOVA', CodigoPedido: '600000023' }),
    ]),
    repo,
  );
  assert.equal(rel.pendentesDeDecisao, 3, 'os TRÊS pedidos aguardam a decisão');
  const doEndereco = rel.alertas.filter((a) => /Endereço do cadastro mudou/.test(a.mensagem));
  assert.equal(doEndereco.length, 1, 'mas o aviso é um só');
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

test('entidade hexadecimal no XML é desescapada — e código inválido não vira 500', () => {
  // O export atual usa entidades decimais, mas o XML permite `&#x...;` e nada
  // obriga o ERP a continuar como está. E um código fora da faixa Unicode
  // (forjável numa planilha) não pode derrubar a importação inteira: some.
  const cel = (ref: string, v: string) => `<x:c t="str" r="${ref}"><x:v>${v}</x:v></x:c>`;
  const cabecalho = [
    'CodigoPedido', 'NotaFiscal', 'Pessoa', 'NomePessoa', 'Tipo de Entrega',
    'SituacaoComercial', 'LogradouroEntrega', 'CidadeEntregaRetirada', 'UFEntregaRetirada',
  ];
  const linha1 = cabecalho.map((c, i) => cel(`${String.fromCharCode(65 + i)}1`, c)).join('');
  const linha2 = [
    cel('A2', '523636997'), cel('B2', '1'), cel('C2', '77'),
    cel('D2', 'JOS&#xC9;&#x110000; MARIA'),
    cel('E2', 'No endere&#xE7;o de entrega'),
    cel('F2', 'Entregue'), cel('G2', 'RUA A'), cel('H2', 'PENEDO'), cel('I2', 'AL'),
  ].join('');
  const zip = zipSync({
    'xl/worksheets/sheet1.xml': strToU8(
      `<x:worksheet xmlns:x="a"><x:sheetData><x:row r="1">${linha1}</x:row>` +
        `<x:row r="2">${linha2}</x:row></x:sheetData></x:worksheet>`,
    ),
  });
  const r = lerPlanilha(zip);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.linhas[0]!.nome, 'JOSÉ MARIA');
    // O ç veio por entidade hex e a classificação ainda reconhece o rótulo.
    assert.equal(r.linhas[0]!.tipoEntrega, 'rota');
  }
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

test('lê a planilha INTEIRA, não só as primeiras linhas', async () => {
  // A varredura em fluxo (que substituiu o parser DOM para não estourar a
  // memória) já se quebrou uma vez de forma silenciosa: um `\b` virou caractere
  // de controle dentro da regex, ela deixou de casar QUALQUER linha e a
  // importação respondeu "planilha sem linhas de dados" sem erro nenhum.
  // Escala aqui é o que separa "leu" de "leu tudo".
  const repo = new RepositorioMemoria();
  const muitas = Array.from({ length: 500 }, (_, i) =>
    linhaRota({
      CodigoPedido: String(700000000 + i),
      Pessoa: String(900000 + i),
      NomePessoa: `REVENDEDORA ${i}`,
    }),
  );
  const rel = await importarPlanilha('grande.xlsx', xlsxDe(muitas), repo);

  assert.equal(rel.total, 500);
  assert.equal(rel.importados, 500);
  assert.equal((await repo.listarPedidos()).length, 500);
  assert.equal((await repo.listarClientes()).length, 500);
});

test('valor com & e acento no nome sobrevivem ao desescape', async () => {
  const repo = new RepositorioMemoria();
  await importarPlanilha(
    'c.xlsx',
    xlsxDe([linhaRota({ NomePessoa: 'MARIA & JOSÉ DA CONCEIÇÃO', CodigoPedido: '800000001' })]),
    repo,
  );
  assert.equal((await repo.listarClientes())[0]!.nome, 'MARIA & JOSÉ DA CONCEIÇÃO');
});
