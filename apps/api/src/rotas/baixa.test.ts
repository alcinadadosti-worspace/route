import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Cliente, Pedido } from '@rota/shared';
import { criarClienteOsrm } from './osrm.js';
import { publicarRota } from './publicar.js';
import { enderecoEmLinha } from './previa.js';
import { removerPedido, removerRota } from './remover.js';
import { darBaixa } from './baixa.js';
import { reconciliarComEntregas } from './reconciliar.js';
import { previaDeRota } from './previa.js';
import { calcularProdutividade } from '../produtividade.js';
import { RepositorioMemoria } from '../db/repositorio.js';

const ROUTE = {
  code: 'Ok',
  routes: [
    {
      geometry: 'xyz',
      distance: 20000,
      duration: 1800,
      legs: [
        { distance: 10000, duration: 900 },
        { distance: 10000, duration: 900 },
        { distance: 10000, duration: 900 },
      ],
    },
  ],
};

/** OSRM que demora como no cold-start: é nessa janela que a corrida acontece. */
function osrmLento(ms = 50) {
  const f = (async () => {
    await new Promise((r) => setTimeout(r, ms));
    return { ok: true, status: 200, json: async () => ROUTE };
  }) as unknown as typeof fetch;
  return criarClienteOsrm('http://osrm.local', f)!;
}

function cliente(nome: string, coordenada: Cliente['coordenada']): Cliente {
  return {
    nome,
    documentoMascarado: '***',
    telefone: '+5582999990000',
    email: null,
    enderecoFiscal: {
      logradouro: 'SITIO BOA VISTA',
      numero: '',
      bairro: 'ZONA RURAL',
      municipio: 'TEOTONIO VILELA',
      uf: 'AL',
      cep: '57265-000',
    },
    coordenada,
    statusMapeamento: coordenada ? 'geocodificado' : 'nao_mapeado',
    trilhaAtivaId: null,
    mapeadoPor: null,
    mapeadoEm: null,
    fotoReferenciaPath: null,
    observacoes: 'depois da igreja',
  };
}

function pedido(clienteId: string, numeroNota: number, status: Pedido['status']): Pedido {
  return {
    numeroNota,
    serie: 1,
    numeroPedido: String(numeroNota),
    lote: null,
    clienteId,
    emitidoEm: '2026-10-16T08:00:00-03:00',
    itens: [],
    valorTotal: 100,
    volumes: 1,
    pesoBrutoKg: 2,
    status,
    rotaId: null,
    xmlStoragePath: null,
    cdId: 'penedo',
  };
}

/** Dois pedidos com ponto (p1, p2) e um rural sem ponto (r1). */
async function cenario() {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('c1', cliente('MARIA', { lat: -9.9, lng: -36.3 }));
  await repo.salvarCliente('c2', cliente('JOANA', { lat: -9.91, lng: -36.31 }));
  await repo.salvarCliente('c3', cliente('SITIO DA ANA', null));
  await repo.salvarPedido('p1', pedido('c1', 101, 'pronto_para_rota'));
  await repo.salvarPedido('p2', pedido('c2', 102, 'pronto_para_rota'));
  await repo.salvarPedido('r1', pedido('c3', 201, 'pendente_de_mapeamento'));
  return repo;
}

const ENTRADA = { cdId: 'penedo', motoristaId: 'motorista-demo' };

test('corrida: duas publicações simultâneas com o mesmo pedido — só uma grava', async () => {
  const repo = await cenario();
  const osrm = osrmLento();
  const [a, b] = await Promise.all([
    publicarRota({ ...ENTRADA, pedidoIds: ['p1'] }, repo, osrm),
    publicarRota({ ...ENTRADA, pedidoIds: ['p1', 'p2'] }, repo, osrm),
  ]);

  assert.equal([a.ok, b.ok].filter(Boolean).length, 1, 'exatamente uma publicação passa');
  const perdedora = a.ok ? b : a;
  assert.ok(!perdedora.ok);
  if (!perdedora.ok) {
    assert.equal(perdedora.status, 409);
    assert.match(perdedora.erro, /101 acabou de entrar na rota .* nada foi gravado/);
  }
  const rotas = await repo.listarRotas();
  assert.equal(rotas.length, 1, 'a rota perdedora não é gravada');
  const vencedora = a.ok ? a : b;
  assert.ok(vencedora.ok);
  if (vencedora.ok) assert.equal((await repo.obterPedido('p1'))!.rotaId, vencedora.rotaId);
  // A perdedora não reservou nada: p2 continua livre se a vencedora foi a de p1 só.
  if (a.ok) assert.equal((await repo.obterPedido('p2'))!.status, 'pronto_para_rota');
});

test('pedido repetido na mesma rota é recusado (parada ou exceção)', async () => {
  const repo = await cenario();
  const osrm = osrmLento(0);
  const dupla = await publicarRota({ ...ENTRADA, pedidoIds: ['p1', 'p1'] }, repo, osrm);
  assert.equal(dupla.ok, false);
  const cruzada = await publicarRota({ ...ENTRADA, pedidoIds: ['p1'], excecaoIds: ['p1'] }, repo, osrm);
  assert.equal(cruzada.ok, false);
  if (!cruzada.ok) assert.equal(cruzada.status, 400);
  assert.equal((await repo.listarRotas()).length, 0);
});

test('exceção: pedido sem ponto entra na rota fora da ordem e fica reservado', async () => {
  const repo = await cenario();
  const r = await publicarRota({ ...ENTRADA, pedidoIds: ['p1', 'p2'], excecaoIds: ['r1'] }, repo, osrmLento(0));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.rota.paradas.map((p) => p.pedidoId), ['p1', 'p2']);
  assert.equal(r.rota.excecoes!.length, 1);
  const e = r.rota.excecoes![0]!;
  assert.equal(e.nome, 'SITIO DA ANA');
  // Sem número, sem vírgula pendurada.
  assert.equal(e.endereco, 'SITIO BOA VISTA — ZONA RURAL, TEOTONIO VILELA/AL');
  assert.equal(e.status, 'em_rota');
  const r1 = (await repo.obterPedido('r1'))!;
  assert.equal(r1.status, 'em_rota');
  assert.equal(r1.rotaId, r.rotaId);
});

test('exceção só aceita pedido pendente de mapeamento', async () => {
  const repo = await cenario();
  const comPonto = await publicarRota({ ...ENTRADA, pedidoIds: ['p1'], excecaoIds: ['p2'] }, repo, osrmLento(0));
  assert.equal(comPonto.ok, false);
  if (!comPonto.ok) assert.match(comPonto.erro, /já tem ponto no mapa/);

  await repo.salvarPedido('r1', { ...(await repo.obterPedido('r1'))!, status: 'retirada' });
  const retirada = await publicarRota({ ...ENTRADA, pedidoIds: ['p1'], excecaoIds: ['r1'] }, repo, osrmLento(0));
  assert.equal(retirada.ok, false);
  assert.equal((await repo.listarRotas()).length, 0);
});

test('exceção de outro CD é recusada, como parada de outro CD', async () => {
  const repo = await cenario();
  await repo.salvarPedido('r1', { ...(await repo.obterPedido('r1'))!, cdId: 'palmeira' });
  const r = await publicarRota({ ...ENTRADA, pedidoIds: ['p1'], excecaoIds: ['r1'] }, repo, osrmLento(0));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.erro, /outro CD/);
});

test('desfazer a rota devolve paradas E exceções, cada uma ao seu status', async () => {
  const repo = await cenario();
  const r = await publicarRota({ ...ENTRADA, pedidoIds: ['p1'], excecaoIds: ['r1'] }, repo, osrmLento(0));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok((await removerRota(repo, r.rotaId)).ok);
  assert.equal((await repo.obterPedido('p1'))!.status, 'pronto_para_rota');
  assert.equal((await repo.obterPedido('r1'))!.status, 'pendente_de_mapeamento');
  assert.equal((await repo.obterPedido('r1'))!.rotaId, null);
});

test('apagar a última parada NÃO solta as exceções: a rota fica com elas, reservadas', async () => {
  // Levava a rota e devolvia as exceções à fila — numa rota rural, dezenas de
  // caixas já no caminhão e no PDF impresso, sem rota onde dar baixa e
  // sugeridas de novo para o caminhão seguinte. Reproduzido com a importação
  // apagando sozinha um pedido cancelado que era a única parada com ponto.
  const repo = await cenario();
  const r = await publicarRota({ ...ENTRADA, pedidoIds: ['p1'], excecaoIds: ['r1'] }, repo, osrmLento(0));
  assert.ok(r.ok);
  if (!r.ok) return;
  const rem = await removerPedido(repo, 'p1');
  assert.deepEqual(rem, { ok: true });
  const rota = (await repo.obterRota(r.rotaId))!;
  assert.deepEqual(rota.paradas, []);
  assert.deepEqual(rota.excecoes!.map((e) => [e.pedidoId, e.numero]), [['r1', 1]]);
  const r1 = (await repo.obterPedido('r1'))!;
  assert.equal(r1.status, 'em_rota');
  assert.equal(r1.rotaId, r.rotaId);

  // Sem parada nem exceção, aí sim a rota vai embora.
  const ultima = await removerPedido(repo, 'r1');
  assert.ok(ultima.ok);
  if (ultima.ok) assert.equal(ultima.rotaApagada, r.rotaId);
  assert.equal(await repo.obterRota(r.rotaId), null);
});

test('apagar a última parada em aberto FECHA a rota, e o histórico da exceção baixada fica', async () => {
  // Antes: com uma exceção já baixada, recusava (409) — e o alerta do
  // cancelado mandava dar baixa "não entregue", que devolvia o cancelado à
  // montagem. Sem recusa, sobrava a rota "em execução" para sempre, sem nada a
  // baixar nem como desfazer.
  const repo = await cenario();
  const r = await publicarRota({ ...ENTRADA, pedidoIds: ['p1'], excecaoIds: ['r1'] }, repo, osrmLento(0));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok((await darBaixa(repo, r.rotaId, [{ pedidoId: 'r1', resultado: 'entregue' }], 'admin')).ok);
  assert.equal((await repo.obterRota(r.rotaId))!.status, 'em_execucao');

  const rem = await removerPedido(repo, 'p1');
  assert.deepEqual(rem, { ok: true });
  assert.equal(await repo.obterPedido('p1'), null);
  const rota = (await repo.obterRota(r.rotaId))!;
  assert.equal(rota.status, 'concluida');
  assert.ok(rota.concluidaEm);
  assert.equal(rota.excecoes![0]!.status, 'entregue');
  assert.equal((await repo.obterPedido('r1'))!.status, 'entregue');
});

test('o número impresso não muda quando sai um pedido do meio da rota', async () => {
  // A tela renumerava pela posição: tirado o 02, o antigo 03 virava 02 e a
  // baixa feita olhando o papel caía na cliente errada.
  const repo = await cenario();
  const r = await publicarRota({ ...ENTRADA, pedidoIds: ['p1', 'p2'], excecaoIds: ['r1'] }, repo, osrmLento(0));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.rota.paradas.map((p) => p.numero), [1, 2]);
  assert.ok((await removerPedido(repo, 'p1')).ok);
  assert.deepEqual((await repo.obterRota(r.rotaId))!.paradas.map((p) => [p.pedidoId, p.numero]), [['p2', 2]]);
});

test('desfazer a rota não solta pedido que hoje aponta para OUTRA rota', async () => {
  // Estado que a corrida antiga deixou: duas rotas com o mesmo pedido, e o
  // pedido apontando só para a última. Desfazer a velha o soltava da nova.
  const repo = await cenario();
  const r = await publicarRota({ ...ENTRADA, pedidoIds: ['p1'] }, repo, osrmLento(0));
  assert.ok(r.ok);
  if (!r.ok) return;
  const outra = '2026-10-16_ffffffff';
  await repo.salvarPedido('p1', { ...(await repo.obterPedido('p1'))!, rotaId: outra });
  assert.ok((await removerRota(repo, r.rotaId)).ok);
  const p1 = (await repo.obterPedido('p1'))!;
  assert.equal(p1.status, 'em_rota');
  assert.equal(p1.rotaId, outra);
});

test('endereço em uma linha: número e bairro vazios não deixam separador pendurado', () => {
  const e = cliente('X', null).enderecoFiscal;
  assert.equal(enderecoEmLinha({ ...e, numero: '12' }), 'SITIO BOA VISTA, 12 — ZONA RURAL, TEOTONIO VILELA/AL');
  assert.equal(enderecoEmLinha({ ...e, bairro: '' }), 'SITIO BOA VISTA — TEOTONIO VILELA/AL');
});

test('id de pedido que não é texto (ou tem barra) é 400, não 500', async () => {
  const repo = await cenario();
  for (const entrada of [
    { pedidoIds: ['p1'], excecaoIds: [123 as unknown as string] },
    { pedidoIds: ['p1'], excecaoIds: ['pedidos/x'] },
    { pedidoIds: 'p1' as unknown as string[] },
  ]) {
    const r = await publicarRota({ ...ENTRADA, ...entrada }, repo, osrmLento(0));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  }
});

test('baixa: entregue fecha o pedido; não entregue volta à fila marcado', async () => {
  const repo = await cenario();
  const r = await publicarRota({ ...ENTRADA, pedidoIds: ['p1', 'p2'], excecaoIds: ['r1'] }, repo, osrmLento(0));
  assert.ok(r.ok);
  if (!r.ok) return;

  const b = await darBaixa(
    repo,
    r.rotaId,
    [
      { pedidoId: 'p1', resultado: 'entregue' },
      { pedidoId: 'p2', resultado: 'nao_entregue' },
      { pedidoId: 'r1', resultado: 'nao_entregue' },
    ],
    'admin-1',
    new Date('2026-10-16T21:00:00Z'),
  );
  assert.ok(b.ok);
  if (!b.ok) return;
  assert.equal(b.rota.status, 'concluida');

  const p1 = (await repo.obterPedido('p1'))!;
  assert.equal(p1.status, 'entregue');
  assert.equal(p1.rotaId, r.rotaId);

  // Não entregue volta pronto (tem ponto) ou pendente (não tem), sem rota, e
  // com a marca de onde veio — é isso que a montagem de amanhã mostra.
  const p2 = (await repo.obterPedido('p2'))!;
  assert.equal(p2.status, 'pronto_para_rota');
  assert.equal(p2.rotaId, null);
  assert.deepEqual(p2.voltouDeRota, { rotaId: r.rotaId, data: r.rota.data });
  assert.equal((await repo.obterPedido('r1'))!.status, 'pendente_de_mapeamento');

  const rota = (await repo.obterRota(r.rotaId))!;
  assert.deepEqual(rota.paradas.map((p) => p.status), ['entregue', 'insucesso']);
  assert.equal(rota.paradas[0]!.baixaNoPainel?.por, 'admin-1');
  assert.equal(rota.excecoes![0]!.status, 'insucesso');

  // O que voltou pode entrar numa rota nova — reentrega, que antes não existia.
  const nova = await publicarRota({ ...ENTRADA, pedidoIds: ['p2'] }, repo, osrmLento(0));
  assert.ok(nova.ok);
});

test('baixa recusa pedido que não pertence mais à rota, sem gravar nada', async () => {
  const repo = await cenario();
  const r = await publicarRota({ ...ENTRADA, pedidoIds: ['p1', 'p2'] }, repo, osrmLento(0));
  assert.ok(r.ok);
  if (!r.ok) return;
  // Inconsistência como a que a corrida de publicação deixava: o pedido diz
  // outra rota.
  await repo.salvarPedido('p2', { ...(await repo.obterPedido('p2'))!, rotaId: '2026-10-16_aaaaaaaa' });

  const b = await darBaixa(
    repo,
    r.rotaId,
    [
      { pedidoId: 'p1', resultado: 'entregue' },
      { pedidoId: 'p2', resultado: 'entregue' },
    ],
    'admin-1',
  );
  assert.equal(b.ok, false);
  if (!b.ok) assert.equal(b.status, 409);
  assert.equal((await repo.obterPedido('p1'))!.status, 'em_rota', 'nada gravado pela metade');
  assert.equal((await repo.obterRota(r.rotaId))!.paradas[0]!.status, 'em_rota');
});

test('baixa em rota inexistente ou com id torto → 404', async () => {
  const repo = await cenario();
  assert.equal((await darBaixa(repo, '2026-10-16_00000000', [], 'x')).ok, false);
  const torto = await darBaixa(repo, '../usuarios/x', [], 'x');
  assert.ok(!torto.ok && torto.status === 404);
});

test('produtividade CONTA a rota em papel pelo resultado da baixa, sem inventar ritmo', async () => {
  // Excluída inteira, toda rota em papel sumia do relatório assim que recebia
  // a baixa — e hoje toda rota é em papel: sobrava "0/N executadas".
  const repo = await cenario();
  const r = await publicarRota({ ...ENTRADA, pedidoIds: ['p1', 'p2'], excecaoIds: ['r1'] }, repo, osrmLento(0));
  assert.ok(r.ok);
  if (!r.ok) return;
  await darBaixa(
    repo,
    r.rotaId,
    [
      { pedidoId: 'p1', resultado: 'entregue' },
      { pedidoId: 'p2', resultado: 'nao_entregue' },
      { pedidoId: 'r1', resultado: 'entregue' },
    ],
    'admin-1',
  );
  const rota = { ...(await repo.obterRota(r.rotaId))!, id: r.rotaId };
  const prod = calcularProdutividade(
    { desde: rota.data, ate: rota.data },
    // Um registro de entrega de pedido que NÃO é desta rota (forjado) não conta.
    {
      rotas: [rota],
      entregas: [{ pedidoId: 'inventado', rotaId: r.rotaId, clienteId: 'x', resultado: 'ausente', confirmadaEm: '2026-10-16T10:00:00Z', posicaoConfirmacao: null, gravadaPor: 'm' }],
      clientes: [],
      trilhas: [],
    } as never,
  );
  assert.ok(prod.ok);
  if (!prod.ok) return;
  const m = prod.relatorio.motoristas[0]!;
  assert.equal(m.paradasPlanejadas, 3, 'exceção conta');
  assert.equal(m.entregues, 2);
  assert.equal(m.insucessos, 1);
  assert.deepEqual(m.porMotivo, { nao_entregue: 1 });
  assert.equal(m.minutosPorParadaMediana, null, 'sem hora do app, sem ritmo');
  assert.equal(prod.relatorio.ausenciasPorCliente.length, 0, 'o registro forjado ficou de fora');
});

// ---- varredura de 21/10/2026 ------------------------------------------------

test('publicar grava o km desde o CD e deixa o motorista ver os clientes da rota', async () => {
  const repo = await cenario();
  const r = await publicarRota({ ...ENTRADA, pedidoIds: ['p1', 'p2'], excecaoIds: ['r1'] }, repo, osrmLento(0));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.rota.paradas.map((p) => p.kmDoCd !== undefined), [true, true]);
  // As rules só deixam o motorista ler cliente com `visivelPara` dele — o id é
  // o código Pessoa, enumerável.
  for (const id of ['c1', 'c2', 'c3']) {
    assert.deepEqual((await repo.obterCliente(id))!.visivelPara, { 'motorista-demo': true }, id);
  }
});

test('pedido que volta da rota com o endereço em revisão vai para Decisões, não "pronto"', async () => {
  // O cliente mudou de endereço com o caminhão na rua: voltando "pronto", a
  // rota seguinte era otimizada no ponto ANTIGO e imprimia o endereço NOVO.
  const repo = await cenario();
  const r = await publicarRota({ ...ENTRADA, pedidoIds: ['p1', 'p2'] }, repo, osrmLento(0));
  assert.ok(r.ok);
  if (!r.ok) return;
  const c1 = (await repo.obterCliente('c1'))!;
  await repo.salvarCliente('c1', { ...c1, enderecoEmRevisao: { ...c1.enderecoFiscal, logradouro: 'RUA VELHA' } });
  assert.ok((await darBaixa(repo, r.rotaId, [{ pedidoId: 'p1', resultado: 'nao_entregue' }], 'admin')).ok);
  const p1 = (await repo.obterPedido('p1'))!;
  assert.equal(p1.status, 'pendente_de_decisao');
  assert.equal(p1.enderecoAnterior?.logradouro, 'RUA VELHA');
  // Desfazer a rota: o mesmo caminho.
  const c2 = (await repo.obterCliente('c2'))!;
  await repo.salvarCliente('c2', { ...c2, enderecoEmRevisao: c2.enderecoFiscal });
  assert.ok((await removerRota(repo, r.rotaId)).ok === false, 'tem parada executada');
});

test('apagar um pedido de rota publicada deixa o AVISO na rota (o PDF ainda tem a parada)', async () => {
  const repo = await cenario();
  const r = await publicarRota({ ...ENTRADA, pedidoIds: ['p1', 'p2'], excecaoIds: ['r1'] }, repo, osrmLento(0));
  assert.ok(r.ok);
  if (!r.ok) return;
  await removerPedido(repo, 'p1', { motivo: 'cancelado no ERP' });
  await removerPedido(repo, 'r1');
  const rota = (await repo.obterRota(r.rotaId))!;
  assert.deepEqual(
    rota.removidos!.map((x) => [x.pedidoId, x.numero, x.motivo]),
    [
      ['p1', '1', 'cancelado no ERP'],
      ['r1', 'E1', 'apagado no painel'],
    ],
  );
});

test('confirmação do app recusada em bloco volta para a rota pelo registro de entrega', async () => {
  // O lote do app (rota + pedido) foi recusado pelas rules — o escritório tirou
  // um pedido no meio —, mas o registro de entrega, que é outro doc, entrou.
  const repo = await cenario();
  const r = await publicarRota({ ...ENTRADA, pedidoIds: ['p1', 'p2'] }, repo, osrmLento(0));
  assert.ok(r.ok);
  if (!r.ok) return;
  repo.entregas.push(
    { pedidoId: 'p1', rotaId: r.rotaId, clienteId: 'c1', resultado: 'entregue', confirmadaEm: '2026-10-16T10:00:00Z', posicaoConfirmacao: null, gravadaPor: 'motorista-demo', recebidoPor: 'ANA' },
    { pedidoId: 'p2', rotaId: r.rotaId, clienteId: 'c2', resultado: 'ausente', confirmadaEm: '2026-10-16T10:30:00Z', posicaoConfirmacao: null, gravadaPor: 'motorista-demo' },
  );
  const rec = await reconciliarComEntregas(repo, r.rotaId);
  assert.deepEqual(rec, { ok: true, aplicadas: 2 });
  const rota = (await repo.obterRota(r.rotaId))!;
  assert.deepEqual(rota.paradas.map((p) => p.status), ['entregue', 'insucesso']);
  assert.equal(rota.paradas[0]!.recebidoPor, 'ANA');
  assert.equal(rota.status, 'concluida');
  assert.equal((await repo.obterPedido('p1'))!.status, 'entregue');
  assert.equal((await repo.obterPedido('p2'))!.status, 'insucesso');
  // De novo não faz nada: o que já tem resultado não é reescrito.
  assert.deepEqual(await reconciliarComEntregas(repo, r.rotaId), { ok: true, aplicadas: 0 });
});

test('prévia com id que não é texto (ou tem barra) é 400, não 500', async () => {
  const repo = await cenario();
  for (const pedidoIds of [[123], ['a/b'], null] as unknown as string[][]) {
    const r = await previaDeRota({ pedidoIds, cdId: 'penedo' }, repo, criarClienteOsrm('http://x', (async () => new Response('{}')) as never)!);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  }
});

