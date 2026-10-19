import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { alterarLiberacao } from './liberacao.js';
import { coletarParadas } from './previa.js';
import { decidirMudancaEndereco } from '../importacao/servico.js';
import { localizarEnderecos } from '../importacao/geocodificacao-lote.js';
import { importarPlanilha } from '../importacao/servico-planilha.js';
import { RepositorioMemoria } from '../db/repositorio.js';

/** Planilha mínima no formato do export real (strings inline, namespace `x:`). */
function xlsx(linhas: Array<Record<string, string>>): Uint8Array {
  const colunas = [...new Set(linhas.flatMap((l) => Object.keys(l)))];
  const letra = (i: number) => String.fromCharCode(65 + (i % 26)).repeat(1 + Math.floor(i / 26));
  const linha = (n: number, vs: string[]) =>
    `<x:row r="${n}">${vs.map((v, i) => `<x:c t="str" r="${letra(i)}${n}"><x:v>${v}</x:v></x:c>`).join('')}</x:row>`;
  const sheet =
    '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>' +
    linha(1, colunas) +
    linhas.map((l, i) => linha(i + 2, colunas.map((c) => l[c] ?? ''))).join('') +
    '</x:sheetData></x:worksheet>';
  return zipSync({ 'xl/worksheets/sheet1.xml': strToU8(sheet) });
}

const BASE = {
  NotaFiscal: '302856',
  NomePessoa: 'CLIENTE TESTE',
  'SituaçãoComercial': 'Entregue',
  DataEntrega: '16/10/2026',
  Logradouro: 'RUA A',
  Complemento: '10',
  Bairro: 'CENTRO',
  Cidade: 'PENEDO',
  UF: 'AL',
  LogradouroEntrega: 'RUA A',
  ComplementoEntregaRetirada: '10 -10.404108,-36.431132',
  BairroEntregaRetirada: 'CENTRO',
  CidadeEntregaRetirada: 'PENEDO',
  UFEntregaRetirada: 'AL',
  'Cód Estrutura Pai': '1.048',
  DataFaturamento: '15/10/2026',
};

async function cenario() {
  const repo = new RepositorioMemoria();
  const planilha = xlsx([
    // Entrega que o ERP já deu como entregue (talvez pelos 6 dias, talvez não).
    { ...BASE, CodigoPedido: '536361204', Pessoa: '1', 'Tipo de Entrega': 'No endereço de entrega' },
    // Retirada que, na prática, vai no caminhão. Sem pin: o cadastro não tem GPS.
    { ...BASE, CodigoPedido: '536361205', Pessoa: '2', 'Tipo de Entrega': 'Retirar na central de serviços' },
  ]);
  await importarPlanilha('d.xlsx', planilha, repo);
  return { repo, planilha };
}

test('liberar põe na montagem: com ponto pronto, sem ponto pendente; e a reimportação não desfaz', async () => {
  const { repo, planilha } = await cenario();
  assert.equal((await repo.obterPedido('536361204'))!.status, 'entregue_no_erp');
  assert.equal((await repo.obterPedido('536361205'))!.status, 'retirada');

  const r = await alterarLiberacao(repo, ['536361204', '536361205'], 'liberar', 'admin-1', new Date('2026-10-19T12:00:00Z'));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.alterados, [
    { id: '536361204', status: 'pronto_para_rota' },
    { id: '536361205', status: 'pendente_de_mapeamento' },
  ]);
  const entrega = (await repo.obterPedido('536361204'))!;
  assert.deepEqual(entrega.liberadoParaRota, { de: 'entregue_no_erp', em: '2026-10-19T12:00:00.000Z', por: 'admin-1' });
  // A retirada liberada entra na fila da busca de endereço (paga, por isso só agora).
  assert.deepEqual([...(await repo.clientesComEntregaPendente())], ['2']);

  const de_novo = await importarPlanilha('d.xlsx', planilha, repo);
  assert.equal(de_novo.duplicados, 2);
  assert.equal((await repo.obterPedido('536361204'))!.status, 'pronto_para_rota');
  assert.equal((await repo.obterPedido('536361205'))!.modoEntrega, 'rota');
});

test('devolver desfaz a liberação; o que já saiu em rota é recusado com motivo', async () => {
  const { repo } = await cenario();
  await alterarLiberacao(repo, ['536361204', '536361205'], 'liberar', 'admin-1');
  const p = (await repo.obterPedido('536361205'))!;
  await repo.salvarPedido('536361205', { ...p, status: 'em_rota', rotaId: '2026-10-19_abcdef01' });

  const r = await alterarLiberacao(repo, ['536361204', '536361205', '999999999'], 'devolver', 'admin-1');
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.alterados, [{ id: '536361204', status: 'entregue_no_erp' }]);
  assert.deepEqual(
    r.recusados.map((x) => x.id),
    ['999999999', '536361205'],
  );
  assert.match(r.recusados[1]!.motivo, /em_rota/);
  assert.equal((await repo.obterPedido('536361204'))!.liberadoParaRota, undefined);
  assert.equal((await repo.obterPedido('536361205'))!.status, 'em_rota', 'nada mexe no que está na rota');
});

test('entrada inválida é 400, sem gravar nada', async () => {
  const { repo } = await cenario();
  for (const [ids, acao] of [
    [[], 'liberar'],
    [['536361204'], 'apagar'],
    ['536361204', 'liberar'],
    [['pedidos/x'], 'liberar'],
  ] as const) {
    const r = await alterarLiberacao(repo, ids, acao, 'admin-1');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  }
  assert.equal((await repo.obterPedido('536361204'))!.status, 'entregue_no_erp');
});

test('sem liberar, a montagem recusa o que o ERP deixou de fora — mesmo com ponto no mapa', async () => {
  // O pedido entregue no ERP TEM pin (veio do cadastro): uma prévia velha ou
  // uma chamada direta o poria na rota sem ninguém ter liberado.
  const { repo } = await cenario();
  for (const id of ['536361204', '536361205']) {
    const r = await coletarParadas([id], repo);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 422);
      assert.match(r.erro, /fora da montagem/);
    }
  }
  await alterarLiberacao(repo, ['536361204'], 'liberar', 'admin-1');
  assert.equal((await coletarParadas(['536361204'], repo)).ok, true);
});

test('retirada com GPS no cadastro, liberada, já sai com ponto — sem a busca paga', async () => {
  // Ciclo 11: 81 das 954 retiradas tinham GPS no cadastro e iam "sem ponto".
  const repo = new RepositorioMemoria();
  await importarPlanilha(
    'd.xlsx',
    xlsx([
      { ...BASE, CodigoPedido: '536361206', Pessoa: '3', 'Tipo de Entrega': 'Retirar na central de serviços', Complemento: '61 -10.286906,-36.549603' },
      { ...BASE, CodigoPedido: '536361207', Pessoa: '3', NotaFiscal: '302857', 'Tipo de Entrega': 'Retirar na central de serviços', Complemento: '61 -10.286906,-36.549603' },
    ]),
    repo,
  );
  assert.equal((await repo.obterCliente('3'))!.coordenada, null, 'importar a retirada não grava lugar');
  const r = await alterarLiberacao(repo, ['536361206', '536361207'], 'liberar', 'admin-1');
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.alterados.map((a) => a.status), ['pronto_para_rota', 'pronto_para_rota']);
  const c = (await repo.obterCliente('3'))!;
  assert.deepEqual(c.coordenada, { lat: -10.286906, lng: -36.549603 });
  assert.equal(c.statusMapeamento, 'geocodificado');
});

test('liberado com endereço em revisão aparece na decisão e a resposta o solta', async () => {
  // Ia para "aguardando decisão" sem `enderecoAnterior`: a aba Decisões não
  // desenhava nada e a resposta recusava — preso, sem tela que o soltasse.
  const { repo } = await cenario();
  const c = (await repo.obterCliente('1'))!;
  await repo.salvarCliente('1', { ...c, enderecoEmRevisao: { ...c.enderecoFiscal, logradouro: 'RUA VELHA' } });
  const r = await alterarLiberacao(repo, ['536361204'], 'liberar', 'admin-1');
  assert.ok(r.ok);
  const p = (await repo.obterPedido('536361204'))!;
  assert.equal(p.status, 'pendente_de_decisao');
  assert.equal(p.enderecoAnterior?.logradouro, 'RUA VELHA');
  assert.ok((await decidirMudancaEndereco(repo, '536361204', 'manter')).ok);
  assert.equal((await repo.obterPedido('536361204'))!.status, 'pronto_para_rota');
});

test('pedido que muda entre a leitura e a gravação não é sobrescrito', async () => {
  // Reproduzido: devolver enquanto outro operador publicava deixava o pedido
  // "retirada" com a rota publicada ainda o levando; liberar enquanto a
  // importação apagava um cancelado o recriava pronto para sempre.
  const { repo } = await cenario();
  await alterarLiberacao(repo, ['536361204'], 'liberar', 'admin-1');
  const lerAntes = repo.pedidosPorIds.bind(repo);
  repo.pedidosPorIds = async (ids) => {
    const lidos = await lerAntes(ids);
    // No meio: um entra numa rota, o outro é apagado (cancelado no ERP).
    const p = (await repo.obterPedido('536361204'))!;
    await repo.salvarPedido('536361204', { ...p, status: 'em_rota', rotaId: '2026-10-19_abcdef01' });
    await repo.apagarPedido('536361205');
    return lidos;
  };
  const r = await alterarLiberacao(repo, ['536361204'], 'devolver', 'admin-1');
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(r.alterados, []);
    assert.match(r.recusados[0]!.motivo, /mudou enquanto era gravado/);
  }
  assert.equal((await repo.obterPedido('536361204'))!.status, 'em_rota');

  const r2 = await alterarLiberacao(repo, ['536361205'], 'liberar', 'admin-1');
  assert.ok(r2.ok);
  assert.equal(await repo.obterPedido('536361205'), null, 'o apagado não volta');
});

test('localizar endereços não paga a busca de quem JÁ tem ponto, e promove os pedidos', async () => {
  const { repo } = await cenario();
  await alterarLiberacao(repo, ['536361205'], 'liberar', 'admin-1'); // retirada sem GPS: pendente
  const c = (await repo.obterCliente('2'))!;
  await repo.salvarCliente('2', { ...c, coordenada: { lat: -10.28, lng: -36.55 }, statusMapeamento: 'mapeado' });
  let chamadas = 0;
  const geo = { async geocodificar() { chamadas += 1; return null; } };
  await localizarEnderecos(repo, geo as never);
  assert.equal(chamadas, 0);
  assert.equal((await repo.obterPedido('536361205'))!.status, 'pronto_para_rota');
  assert.equal((await repo.obterCliente('2'))!.statusMapeamento, 'mapeado', 'pin de campo intocado');
});
