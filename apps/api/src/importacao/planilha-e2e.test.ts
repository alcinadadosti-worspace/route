import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { mensagemDeRecibo, PARAMETROS_AVISO_PADRAO, quantidadeDeItens } from '@rota/shared';
import { importarPlanilha } from './servico-planilha.js';
import { localizarEnderecos } from './geocodificacao-lote.js';
import { publicarRota } from '../rotas/publicar.js';
import { criarClienteOsrm } from '../rotas/osrm.js';
import { RepositorioMemoria } from '../db/repositorio.js';
import type { Geocodificador } from '../geocodificacao/google.js';

/**
 * Fluxo INTEIRO do pivô, ponta a ponta: planilha do ERP → localização em
 * lotes → rota publicada → o que o motorista vê na porta do cliente e o que o
 * cliente recebe no WhatsApp.
 *
 * Existe porque cada peça tinha teste e a COSTURA não tinha — e foi exatamente
 * na costura que apareceu a família de bugs mais cara: como a planilha não traz
 * lista de itens, tudo que contava `itens.length` lia ZERO. O relatório de
 * produtividade dizia "0 itens entregues" com o caminhão cheio.
 */

function xlsx(linhas: Array<Record<string, string>>): Uint8Array {
  const COLUNAS = [
    'CodigoPedido', 'NotaFiscal', 'Pessoa', 'NomePessoa', 'Papel', 'QtdeMateriais',
    'ValorPraticado', 'Tipo de Entrega', 'SituaçãoComercial', 'Logradouro', 'Complemento',
    'Bairro', 'Cidade', 'UF', 'CEP', 'Referência', 'LogradouroEntrega',
    'ComplementoEntregaRetirada', 'BairroEntregaRetirada', 'CidadeEntregaRetirada',
    'UFEntregaRetirada', 'CEPEntregaRetirada', 'ReferênciaEntregaRetirada', 'Telefone',
    'Cód Estrutura Pai', 'Lote de separação', 'Volume', 'Peso Real', 'DataFaturamento',
  ];
  const letra = (i: number) => {
    let s = '';
    let n = i + 1;
    while (n) {
      s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  };
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const linha = (n: number, vs: string[]) =>
    `<x:row r="${n}">${vs.map((v, i) => `<x:c t="str" r="${letra(i)}${n}"><x:v>${esc(v)}</x:v></x:c>`).join('')}</x:row>`;
  const sheet =
    '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>' +
    linha(1, COLUNAS) +
    linhas.map((l, i) => linha(i + 2, COLUNAS.map((c) => l[c] ?? ''))).join('') +
    '</x:sheetData></x:worksheet>';
  return zipSync({ 'xl/worksheets/sheet1.xml': strToU8(sheet) });
}

const PEDIDO_DE_ROTA = {
  CodigoPedido: '523636997',
  NotaFiscal: '293604',
  Pessoa: '1260943',
  NomePessoa: 'CLAUDEANE ROSA FERREIRA',
  Papel: 'Diamante GB',
  QtdeMateriais: '7',
  ValorPraticado: '662.82',
  'Tipo de Entrega': 'No endereço de entrega',
  'SituaçãoComercial': 'Entregue',
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
  DataFaturamento: '20/07/2026',
};

const geocodificador: Geocodificador = {
  async geocodificar() {
    return {
      coordenada: { lat: -10.15, lng: -36.65 },
      precisa: true,
      municipioConfere: true,
    } as Awaited<ReturnType<Geocodificador['geocodificar']>>;
  },
};

/** OSRM falso: uma parada, traçado fixo. */
function osrmFalso() {
  const fetchFalso = async () =>
    new Response(
      JSON.stringify({
        code: 'Ok',
        routes: [
          {
            geometry: 'xyz789',
            distance: 100000,
            duration: 4800,
            legs: [{ distance: 100000, duration: 4800 }],
          },
        ],
        waypoints: [{ waypoint_index: 0 }, { waypoint_index: 1 }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  return criarClienteOsrm('http://osrm.local', fetchFalso as unknown as typeof fetch)!;
}

/** O repositório em memória já traz o CD `penedo` e o motorista `motorista-demo`. */
function repoComCd() {
  return new RepositorioMemoria();
}

test('planilha → localizar → publicar: a parada leva a quantidade, e o recibo diz a mercadoria', async () => {
  const repo = repoComCd();

  // 1. Importa a planilha (sem geocodificar — é passo separado por desenho).
  const rel = await importarPlanilha('ciclo.xlsx', xlsx([PEDIDO_DE_ROTA]), repo);
  assert.equal(rel.importados, 1);
  assert.equal(rel.pendentesDeMapeamento, 1); // sem ponto ainda

  // 2. Localiza os endereços em lote.
  const loc = await localizarEnderecos(repo, geocodificador, { limite: 10 });
  assert.equal(loc.geocodificados, 1);
  assert.equal((await repo.listarPedidos())[0]!.status, 'pronto_para_rota');

  // 3. Publica a rota.
  const publicacao = await publicarRota(
    { pedidoIds: ['523636997'], cdId: 'penedo', motoristaId: 'motorista-demo' },
    repo,
    osrmFalso(),
  );
  assert.ok(publicacao.ok);
  const parada = publicacao.rota.paradas[0]!;

  // 4. O que o MOTORISTA vê na porta. Sem `quantidadeMateriais` denormalizado
  //    até aqui, a tela diria "0 itens" com a caixa cheia.
  assert.equal(parada.quantidadeMateriais, 7);
  assert.equal(quantidadeDeItens(parada), 7);
  assert.equal(parada.volumes, 1);
  assert.equal(parada.pesoBrutoKg, 12.047);
  assert.equal(parada.telefone, '+5582999310976');
  assert.match(parada.endereco, /RUA DA PROVIDENCIA, 149/);
  assert.equal(parada.numeroPedido, '523636997');
  assert.equal(parada.numeroNota, 293604);

  // 5. O que o CLIENTE recebe no WhatsApp.
  const recibo = mensagemDeRecibo(
    new Date('2026-08-03T14:05:00-03:00'),
    'Maria',
    PARAMETROS_AVISO_PADRAO,
    {
      numeroPedido: parada.numeroPedido,
      numeroNota: parada.numeroNota,
      itens: parada.itens,
      quantidadeMateriais: parada.quantidadeMateriais,
    },
  );
  assert.match(recibo, /7 produto/); // não omite a mercadoria
  assert.match(recibo, /523636997/);
  assert.doesNotMatch(recibo, /\{/); // nenhum placeholder vaza
});

test('pedido de RETIRADA da planilha nunca entra na rota', async () => {
  const repo = repoComCd();
  await importarPlanilha(
    'ciclo.xlsx',
    xlsx([
      { ...PEDIDO_DE_ROTA, CodigoPedido: '111111111', 'Tipo de Entrega': 'Retirar na central de serviços' },
    ]),
    repo,
  );
  const publicacao = await publicarRota(
    { pedidoIds: ['111111111'], cdId: 'penedo', motoristaId: 'motorista-demo' },
    repo,
    osrmFalso(),
  );
  assert.equal(publicacao.ok, false);
  if (!publicacao.ok) assert.match(publicacao.erro, /retirada/i);
});
