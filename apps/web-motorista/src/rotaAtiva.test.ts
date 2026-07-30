import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Rota } from '@rota/shared';
import { escolherRotaAtiva, paradasPorResolver, separarRotas } from './rotaAtiva.js';

function rota(
  id: string,
  data: string,
  status: Rota['status'],
  publicadaEm: string | null,
): { id: string } & Rota {
  return {
    id,
    data,
    motoristaId: 'm1',
    origemCdId: 'penedo',
    origemNome: 'CD Penedo',
    origemCoordenada: { lat: -10.28, lng: -36.56 },
    retornaAoCd: true,
    paradas: [],
    polylinePlanejada: '',
    distanciaTotalKm: 10,
    duracaoTotalMin: 30,
    status,
    publicadaEm,
    concluidaEm: status === 'concluida' ? `${data}T17:00:00-03:00` : null,
  };
}

test('sem rota nenhuma, nada é escolhido', () => {
  assert.equal(escolherRotaAtiva([]), null);
});

test('rota JÁ INICIADA ganha da publicada depois no mesmo dia', () => {
  // O caso que mais importa: o escritório publica a segunda rota do dia com o
  // motorista no meio da primeira. Ele não pode perder o que está executando.
  const emExecucao = rota('r1', '2026-07-30', 'em_execucao', '2026-07-30T07:00:00-03:00');
  const nova = rota('r2', '2026-07-30', 'publicada', '2026-07-30T11:00:00-03:00');
  assert.equal(escolherRotaAtiva([nova, emExecucao])!.id, 'r1');
});

test('duas publicadas e nenhuma iniciada: a MAIS NOVA toma a tela', () => {
  // Consequência real: a primeira some do aparelho, com os pedidos ainda em
  // `em_rota`. É por isso que o painel avisa antes de publicar a segunda.
  const primeira = rota('r1', '2026-07-30', 'publicada', '2026-07-30T07:00:00-03:00');
  const segunda = rota('r2', '2026-07-30', 'publicada', '2026-07-30T11:00:00-03:00');
  assert.equal(escolherRotaAtiva([primeira, segunda])!.id, 'r2');
});

test('concluída a de hoje, a rota aberta que sobrou volta a aparecer', () => {
  const esquecida = rota('r1', '2026-07-30', 'publicada', '2026-07-30T07:00:00-03:00');
  const feita = rota('r2', '2026-07-30', 'concluida', '2026-07-30T11:00:00-03:00');
  assert.equal(escolherRotaAtiva([esquecida, feita])!.id, 'r1', 'não some para sempre');
});

test('data manda antes de tudo: a de ontem em execução não segura a de hoje', () => {
  const ontem = rota('r1', '2026-07-29', 'em_execucao', '2026-07-29T07:00:00-03:00');
  const hoje = rota('r2', '2026-07-30', 'publicada', '2026-07-30T07:00:00-03:00');
  assert.equal(escolherRotaAtiva([ontem, hoje])!.id, 'r2');
});

test('só concluídas: mostra a mais recente, para ele ver o resumo do dia', () => {
  const antiga = rota('r1', '2026-07-28', 'concluida', '2026-07-28T07:00:00-03:00');
  const recente = rota('r2', '2026-07-30', 'concluida', '2026-07-30T07:00:00-03:00');
  assert.equal(escolherRotaAtiva([antiga, recente])!.id, 'r2');
});

test('rascunho nunca chega ao motorista', () => {
  const rascunho = rota('r1', '2026-07-30', 'rascunho', null);
  assert.equal(escolherRotaAtiva([rascunho]), null);
  assert.deepEqual(separarRotas([rascunho]), { abertas: [], fechadas: [] });
});

test('abas: abertas e fechadas, cada uma da mais recente para a mais antiga', () => {
  const lista = [
    rota('r1', '2026-07-28', 'concluida', '2026-07-28T07:00:00-03:00'),
    rota('r2', '2026-07-30', 'publicada', '2026-07-30T07:00:00-03:00'),
    rota('r3', '2026-07-29', 'concluida', '2026-07-29T07:00:00-03:00'),
    rota('r4', '2026-07-30', 'em_execucao', '2026-07-30T06:00:00-03:00'),
    rota('r5', '2026-07-30', 'rascunho', null),
  ];
  const { abertas, fechadas } = separarRotas(lista);
  assert.deepEqual(abertas.map((r) => r.id), ['r2', 'r4'], 'rascunho fica de fora');
  assert.deepEqual(fechadas.map((r) => r.id), ['r3', 'r1'], 'histórico: o último dia no topo');
});

test('paradas por resolver ignora o que já foi entregue ou deu insucesso', () => {
  const r = rota('r1', '2026-07-30', 'em_execucao', '2026-07-30T07:00:00-03:00');
  r.paradas = [
    { status: 'entregue' },
    { status: 'insucesso' },
    { status: 'em_rota' },
    { status: 'em_rota' },
  ] as never;
  assert.equal(paradasPorResolver(r), 2, 'é o número que o aviso de fechar precisa dizer');
});

test('rota inteira resolvida não tem nada por resolver', () => {
  const r = rota('r1', '2026-07-30', 'em_execucao', '2026-07-30T07:00:00-03:00');
  r.paradas = [{ status: 'entregue' }, { status: 'insucesso' }] as never;
  assert.equal(paradasPorResolver(r), 0);
});

test('sem rota aberta, a escolha automática é uma FECHADA — quem chama tem de saber', () => {
  // Isto não é defeito daqui: ao fim do dia o motorista continua vendo o resumo
  // do que fez. Mas a tela usava esse valor na aba ABERTAS e mostrava uma rota
  // fechada embaixo de "nenhuma rota aberta agora". O teste fixa o contrato para
  // que a aba confira contra `separarRotas` antes de usar.
  const feita = rota('r1', '2026-07-30', 'concluida', '2026-07-30T07:00:00-03:00');
  const escolhida = escolherRotaAtiva([feita]);
  assert.equal(escolhida!.id, 'r1');
  const { abertas } = separarRotas([feita]);
  // `equal(length, 0)` e não `deepEqual(abertas, [])`: o segundo estreita o tipo
  // para never[] (o assert do node declara `asserts actual is T`) e o `.some`
  // abaixo deixaria de compilar.
  assert.equal(abertas.length, 0, 'e ela NÃO pertence à aba de abertas');
  assert.equal(abertas.some((r) => r.id === escolhida!.id), false);
});
