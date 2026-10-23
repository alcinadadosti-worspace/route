import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { importarPlanilha } from './servico-planilha.js';
import { importarXmls, refazerPontoDoCliente, decidirMudancaEndereco } from './servico.js';
import { localizarEnderecos } from './geocodificacao-lote.js';
import { extrairCoordenada } from './planilha.js';
import { RepositorioMemoria } from '../db/repositorio.js';
import type { Geocodificador } from '../geocodificacao/google.js';

/**
 * Bugs achados na varredura de 21/10/2026, um teste por cenário reproduzido.
 */

function xlsx(linhas: Array<Record<string, string>>): Uint8Array {
  const colunas = [...new Set(linhas.flatMap((l) => Object.keys(l)))];
  const letra = (i: number) => (i < 26 ? '' : String.fromCharCode(64 + Math.floor(i / 26))) + String.fromCharCode(65 + (i % 26));
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const linha = (n: number, vs: string[]) =>
    `<x:row r="${n}">${vs.map((v, i) => `<x:c t="str" r="${letra(i)}${n}"><x:v>${esc(v)}</x:v></x:c>`).join('')}</x:row>`;
  const sheet =
    '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>' +
    linha(1, colunas) +
    linhas.map((l, i) => linha(i + 2, colunas.map((c) => l[c] ?? ''))).join('') +
    '</x:sheetData></x:worksheet>';
  return zipSync({ 'xl/worksheets/sheet1.xml': strToU8(sheet) });
}

/** A nota real da fixture: pedido 499450697. */
const XML = readFileSync(new URL('../../test/fixtures/nfe-276165.xml', import.meta.url), 'utf8');

function linha(extra: Record<string, string> = {}): Record<string, string> {
  return {
    CodigoPedido: '499450697',
    NotaFiscal: '276165',
    Pessoa: '1001',
    NomePessoa: 'CLIENTE TESTE',
    'Tipo de Entrega': 'No endereço de entrega',
    'SituaçãoComercial': 'Transporte',
    Logradouro: 'RUA A',
    Complemento: '10',
    Bairro: 'CENTRO',
    Cidade: 'PENEDO',
    UF: 'AL',
    LogradouroEntrega: 'RUA A',
    ComplementoEntregaRetirada: '10',
    BairroEntregaRetirada: 'CENTRO',
    CidadeEntregaRetirada: 'PENEDO',
    UFEntregaRetirada: 'AL',
    'Cód Estrutura Pai': '1.048',
    CodCD: '542',
    DataFaturamento: '15/10/2026',
    ...extra,
  };
}

test('XML e planilha do MESMO pedido não duplicam, nos dois sentidos', async () => {
  // Medido: planilha do ciclo 11 + os XMLs do mesmo ciclo davam 2030 pedidos em
  // dobro, e os "entregues no ERP" e cancelados voltavam prontos para a rota.
  const r1 = new RepositorioMemoria();
  await importarPlanilha('p.xlsx', xlsx([linha()]), r1);
  const x = await importarXmls([{ nome: 'n.xml', conteudo: XML }], r1);
  assert.equal(x.duplicados, 1);
  assert.equal((await r1.listarPedidos()).length, 1);

  const r2 = new RepositorioMemoria();
  await importarXmls([{ nome: 'n.xml', conteudo: XML }], r2);
  const p = await importarPlanilha('p.xlsx', xlsx([linha()]), r2);
  assert.equal(p.duplicados, 1);
  assert.equal((await r2.listarPedidos()).length, 1);
  // Cancelado na planilha apaga o pedido que veio do XML (id = chave de 44).
  const c = await importarPlanilha('c.xlsx', xlsx([linha({ 'SituaçãoComercial': 'Cancelado' })]), r2);
  assert.equal(c.canceladasApagadas, 1);
  assert.equal((await r2.listarPedidos()).length, 0);
  // ...e o XML dele, solto de novo, não o ressuscita.
  await importarXmls([{ nome: 'n.xml', conteudo: XML }], r2);
  assert.equal((await r2.listarPedidos()).length, 0);
});

test('Consumidor Final (sem estrutura) ganha o CD pelo CodCD, com a série certa', async () => {
  const repo = new RepositorioMemoria();
  await importarPlanilha('p.xlsx', xlsx([linha({ 'Cód Estrutura Pai': '', CodCD: '684' })]), repo);
  const p = (await repo.obterPedido('499450697'))!;
  assert.equal(p.cdId, 'palmeira');
  assert.equal(p.serie, 0);
});

test('GPS colado com 15 casas decimais vira pin (e sai do número da casa)', () => {
  const p = extrairCoordenada(['61 -10.286906123456789,-36.549603987654321']);
  assert.ok(p);
  assert.ok(Math.abs(p!.lat + 10.286906) < 1e-5);
});

test('planilha MAIS VELHA processada depois não faz o endereço regredir', async () => {
  const repo = new RepositorioMemoria();
  await importarPlanilha(
    'nova.xlsx',
    xlsx([linha({ CodigoPedido: '500000002', LogradouroEntrega: 'RUA NOVA', DataFaturamento: '20/10/2026' })]),
    repo,
  );
  await importarPlanilha(
    'velha.xlsx',
    xlsx([linha({ CodigoPedido: '500000001', LogradouroEntrega: 'RUA VELHA', DataFaturamento: '10/10/2026' })]),
    repo,
  );
  assert.equal((await repo.obterCliente('1001'))!.enderecoFiscal.logradouro, 'RUA NOVA');
});

test('complemento escrito de outro jeito no MESMO número não abre revisão falsa', async () => {
  const repo = new RepositorioMemoria();
  await importarPlanilha('a.xlsx', xlsx([linha({ ComplementoEntregaRetirada: '10 -10.404108,-36.431132' })]), repo);
  const r = await importarPlanilha(
    'b.xlsx',
    xlsx([linha({ CodigoPedido: '500000003', ComplementoEntregaRetirada: '10 CASA PRÓXIMO AO MERCADINHO' })]),
    repo,
  );
  assert.equal(r.pendentesDeDecisao, 0);
  assert.equal((await repo.obterPedido('500000003'))!.status, 'pronto_para_rota');
});

test('ponto descartado ("refazer ponto") não volta com a planilha do dia seguinte', async () => {
  const repo = new RepositorioMemoria();
  await importarPlanilha('a.xlsx', xlsx([linha({ ComplementoEntregaRetirada: '10 -10.404108,-36.431132' })]), repo);
  assert.ok((await repo.obterCliente('1001'))!.coordenada);
  await refazerPontoDoCliente(repo, '1001', null);
  await importarPlanilha(
    'b.xlsx',
    xlsx([linha({ CodigoPedido: '500000004', ComplementoEntregaRetirada: '10 -10.404108,-36.431132' })]),
    repo,
  );
  assert.equal((await repo.obterCliente('1001'))!.coordenada, null);
  assert.equal((await repo.obterPedido('500000004'))!.status, 'pendente_de_mapeamento');
});

test('"remapear" sem resultado não deixa o pedido anterior preso como pronto', async () => {
  const repo = new RepositorioMemoria();
  await importarPlanilha('a.xlsx', xlsx([linha({ ComplementoEntregaRetirada: '10 -10.404108,-36.431132' })]), repo);
  await importarPlanilha('b.xlsx', xlsx([linha({ CodigoPedido: '500000005', LogradouroEntrega: 'RUA NOVA' })]), repo);
  assert.equal((await repo.obterPedido('500000005'))!.status, 'pendente_de_decisao');
  const r = await decidirMudancaEndereco(repo, '500000005', 'remapear', null);
  assert.ok(r.ok);
  // O cliente ficou sem ponto: os DOIS pedidos esperam mapeamento — nenhum
  // "pronto" de cliente sem coordenada, preso fora de todas as telas.
  assert.equal((await repo.obterPedido('499450697'))!.status, 'pendente_de_mapeamento');
  assert.equal((await repo.obterPedido('500000005'))!.status, 'pendente_de_mapeamento');
});

test('cancelado ANTES do ativo na mesma planilha: fica cancelado, não entra', async () => {
  const repo = new RepositorioMemoria();
  const r = await importarPlanilha(
    'a.xlsx',
    xlsx([linha({ 'SituaçãoComercial': 'Cancelado' }), linha()]),
    repo,
  );
  assert.equal(r.importados, 0);
  assert.equal(await repo.obterPedido('499450697'), null);
  assert.ok(r.alertas.some((a) => /cancelado E ativo/.test(a.mensagem)));
});

function geocodificadorQueConta(responde: (logradouro: string) => { lat: number; lng: number } | null) {
  const chamadas: string[] = [];
  const g: Geocodificador = {
    async geocodificar(e) {
      chamadas.push(e.logradouro);
      const p = responde(e.logradouro);
      return p ? ({ coordenada: p, precisa: true, municipioConfere: true } as never) : null;
    },
  };
  return { g, chamadas };
}

test('"Localizar" não paga de novo pelo endereço que já não achou; endereço novo tenta', async () => {
  const repo = new RepositorioMemoria();
  await importarPlanilha('a.xlsx', xlsx([linha({ LogradouroEntrega: 'SITIO NENHUM' })]), repo);
  const { g, chamadas } = geocodificadorQueConta(() => null);
  const a = await localizarEnderecos(repo, g);
  const b = await localizarEnderecos(repo, g);
  assert.equal(chamadas.length, 1, 'o 2º clique não chamou a busca paga');
  assert.equal(a.semResultado, 1);
  assert.equal(b.semResultado, 1, 'mas conta como sem resultado, para o painel saltar');
  // Planilha com o endereço corrigido: muda a chave, e aí tenta.
  await importarPlanilha(
    'b.xlsx',
    xlsx([linha({ CodigoPedido: '500000006', LogradouroEntrega: 'RUA CERTA', DataFaturamento: '16/10/2026' })]),
    repo,
  );
  await localizarEnderecos(repo, g);
  assert.equal(chamadas.length, 2);
});

test('busca que devolve o MESMO ponto para endereços diferentes vira aproximado (centro da cidade)', async () => {
  const repo = new RepositorioMemoria();
  await importarPlanilha(
    'a.xlsx',
    xlsx([
      linha({ Pessoa: '1', CodigoPedido: '500000010', LogradouroEntrega: 'POVOADO RETIRO' }),
      linha({ Pessoa: '2', CodigoPedido: '500000011', LogradouroEntrega: 'CHA DA PONTE' }),
      linha({ Pessoa: '3', CodigoPedido: '500000012', LogradouroEntrega: 'RUA DA CASA' }),
    ]),
    repo,
  );
  const CENTRO = { lat: -9.92078, lng: -36.47393 };
  const { g } = geocodificadorQueConta((l) => (l === 'RUA DA CASA' ? { lat: -9.9, lng: -36.4 } : CENTRO));
  const r = await localizarEnderecos(repo, g);
  assert.equal(r.geocodificados, 1);
  assert.equal(r.aproximados, 2);
  assert.equal((await repo.obterCliente('1'))!.statusMapeamento, 'aproximado');
  assert.equal((await repo.obterCliente('3'))!.statusMapeamento, 'geocodificado');
  // E os pedidos saem prontos mesmo assim — ponto aproximado ainda roteiriza.
  assert.equal((await repo.obterPedido('500000010'))!.status, 'pronto_para_rota');
});

test('pin confirmado em campo durante o lote não é trocado pelo palpite da busca', async () => {
  const repo = new RepositorioMemoria();
  await importarPlanilha('a.xlsx', xlsx([linha()]), repo);
  const g: Geocodificador = {
    async geocodificar() {
      // No meio da busca, o motorista confirma o pin.
      const c = (await repo.obterCliente('1001'))!;
      await repo.salvarCliente('1001', { ...c, coordenada: { lat: -10.3, lng: -36.6 }, statusMapeamento: 'mapeado' });
      return { coordenada: { lat: -9.9, lng: -36.4 }, precisa: true, municipioConfere: true } as never;
    },
  };
  await localizarEnderecos(repo, g);
  const c = (await repo.obterCliente('1001'))!;
  assert.equal(c.statusMapeamento, 'mapeado');
  assert.deepEqual(c.coordenada, { lat: -10.3, lng: -36.6 });
});

test('importação rebaixa os "exatos" que já estavam no banco com ponto repetido', async () => {
  // Os 23 de produção: na próxima importação, saem de "geocodificado".
  const repo = new RepositorioMemoria();
  await importarPlanilha(
    'a.xlsx',
    xlsx([
      linha({ Pessoa: '1', CodigoPedido: '500000020', LogradouroEntrega: 'POVOADO X' }),
      linha({ Pessoa: '2', CodigoPedido: '500000021', LogradouroEntrega: 'POVOADO Y' }),
    ]),
    repo,
  );
  for (const id of ['1', '2']) {
    const c = (await repo.obterCliente(id))!;
    await repo.salvarCliente(id, { ...c, coordenada: { lat: -9.92078, lng: -36.47393 }, statusMapeamento: 'geocodificado' });
  }
  const r = await importarPlanilha('b.xlsx', xlsx([linha({ Pessoa: '9', CodigoPedido: '500000022' })]), repo);
  assert.equal((await repo.obterCliente('1'))!.statusMapeamento, 'aproximado');
  assert.equal((await repo.obterCliente('2'))!.statusMapeamento, 'aproximado');
  assert.ok(r.alertas.some((a) => a.nome === 'Ponto repetido'));
});
