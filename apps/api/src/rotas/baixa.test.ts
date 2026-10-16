import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Cliente, Pedido } from '@rota/shared';
import { criarClienteOsrm } from './osrm.js';
import { publicarRota } from './publicar.js';
import { enderecoEmLinha } from './previa.js';
import { removerPedido, removerRota } from './remover.js';
import { darBaixa } from './baixa.js';
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

test('apagar a última parada leva a rota e devolve a exceção que sobrou', async () => {
  const repo = await cenario();
  const r = await publicarRota({ ...ENTRADA, pedidoIds: ['p1'], excecaoIds: ['r1'] }, repo, osrmLento(0));
  assert.ok(r.ok);
  if (!r.ok) return;
  const rem = await removerPedido(repo, 'p1');
  assert.ok(rem.ok);
  if (rem.ok) assert.equal(rem.rotaApagada, r.rotaId);
  assert.equal((await repo.obterPedido('r1'))!.status, 'pendente_de_mapeamento');
});

test('apagar a última parada NÃO leva a rota quando uma exceção já teve baixa', async () => {
  // Levava, e devolvia à fila como pendente o pedido que já tinha sido ENTREGUE.
  const repo = await cenario();
  const r = await publicarRota({ ...ENTRADA, pedidoIds: ['p1'], excecaoIds: ['r1'] }, repo, osrmLento(0));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok((await darBaixa(repo, r.rotaId, [{ pedidoId: 'r1', resultado: 'entregue' }], 'admin')).ok);
  const rem = await removerPedido(repo, 'p1');
  assert.equal(rem.ok, false);
  if (!rem.ok) assert.equal(rem.status, 409);
  assert.ok(await repo.obterRota(r.rotaId), 'a rota continua');
  assert.equal((await repo.obterPedido('r1'))!.status, 'entregue');
  assert.equal((await repo.obterPedido('p1'))!.status, 'em_rota');
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

test('produtividade ignora rota com baixa pelo painel (não é medição de campo)', async () => {
  const repo = await cenario();
  const r = await publicarRota({ ...ENTRADA, pedidoIds: ['p1'] }, repo, osrmLento(0));
  assert.ok(r.ok);
  if (!r.ok) return;
  await darBaixa(repo, r.rotaId, [{ pedidoId: 'p1', resultado: 'entregue' }], 'admin-1');
  const rota = (await repo.obterRota(r.rotaId))!;
  const prod = calcularProdutividade(
    { desde: rota.data, ate: rota.data },
    { rotas: [rota], entregas: [], clientes: [], trilhas: [] } as never,
  );
  assert.ok(prod.ok);
  if (prod.ok) assert.equal(prod.relatorio.motoristas.length, 0);
});
