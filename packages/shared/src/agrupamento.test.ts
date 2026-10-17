import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agruparPorRegiao, type PontoAgrupavel } from './agrupamento.js';

/** Municípios reais da operação, com as coordenadas de verdade. */
const PENEDO = { lat: -10.2808, lng: -36.5595 };
const CORURIPE = { lat: -10.1254, lng: -36.1755 };
const IGREJA_NOVA = { lat: -10.1123, lng: -36.6597 };
const SAO_SEBASTIAO = { lat: -9.9294, lng: -36.5642 };
const PIACABUCU = { lat: -10.4056, lng: -36.4339 };
const FELIZ_DESERTO = { lat: -10.2935, lng: -36.3028 };

/** N pontos espalhados em ~2 km em volta de um centro. */
function perto(municipio: string, centro: { lat: number; lng: number }, n: number, prefixo = ''): PontoAgrupavel[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefixo}${municipio}-${i}`,
    municipio,
    coordenada: {
      lat: centro.lat + (i % 5) * 0.004,
      lng: centro.lng + Math.floor(i / 5) * 0.004,
    },
  }));
}

test('cada município vira um grupo — é o vocabulário da operação', () => {
  const grupos = agruparPorRegiao(
    [...perto('CORURIPE', CORURIPE, 12), ...perto('IGREJA NOVA', IGREJA_NOVA, 10)],
    { origem: PENEDO },
  );
  assert.equal(grupos.length, 2);
  // Mais longe primeiro: é a região que precisa do dia inteiro.
  assert.equal(grupos[0]!.municipio, 'CORURIPE');
  assert.equal(grupos[0]!.ids.length, 12);
  assert.equal(grupos[0]!.parte, null);
  assert.ok(grupos[0]!.distanciaDoCdKm! > grupos[1]!.distanciaDoCdKm!);
});

test('cidade pequena NUNCA é fundida com a vizinha — juntar é escolha do operador', () => {
  // O que o usuário viu com a planilha real: "PIAÇABUÇU · FELIZ DESERTO ·
  // PENEDO" num bloco só, e não havia como levar Piaçabuçu sem as outras.
  const grupos = agruparPorRegiao(
    [
      ...perto('PIAÇABUÇU', PIACABUCU, 14),
      ...perto('FELIZ DESERTO', FELIZ_DESERTO, 6),
      ...perto('PENEDO', PENEDO, 6),
      ...perto('IGREJA NOVA', IGREJA_NOVA, 1),
    ],
    { origem: PENEDO },
  );
  assert.deepEqual(
    grupos.map((g) => [g.municipio, g.ids.length]).sort(),
    [['FELIZ DESERTO', 6], ['IGREJA NOVA', 1], ['PENEDO', 6], ['PIAÇABUÇU', 14]],
  );
});

test('a mesma cidade com e sem acento é UM cartão, com o nome mais usado', () => {
  // Planilha, NF-e e endereço de entrega escrevem a cidade de jeitos diferentes.
  const grupos = agruparPorRegiao([
    ...perto('TEOTÔNIO VILELA', CORURIPE, 4),
    ...perto('Teotonio  Vilela', CORURIPE, 1, 'b'),
  ]);
  assert.equal(grupos.length, 1);
  assert.equal(grupos[0]!.municipio, 'TEOTÔNIO VILELA');
  assert.equal(grupos[0]!.ids.length, 5);
});

test('município grande demais para um dia é DIVIDIDO, e cada pedaço diz de quantos', () => {
  // 70 paradas num município só: não fecha num dia.
  const grupos = agruparPorRegiao(
    [...perto('PENEDO', PENEDO, 70), ...perto('CORURIPE', CORURIPE, 5)],
    { maximoPorRota: 30, origem: IGREJA_NOVA },
  );
  const penedo = grupos.filter((g) => g.municipio === 'PENEDO');
  assert.ok(penedo.length >= 3, `esperava 3+ pedaços, veio ${penedo.length}`);
  for (const g of penedo) assert.ok(g.ids.length <= 30, `pedaço com ${g.ids.length} paradas`);
  assert.deepEqual(
    penedo.map((g) => g.parte),
    penedo.map((_, i) => ({ indice: i + 1, total: penedo.length })),
  );
  // Os pedaços da mesma cidade saem juntos na lista, não espalhados entre as outras.
  const posicoes = grupos.flatMap((g, i) => (g.municipio === 'PENEDO' ? [i] : []));
  assert.equal(posicoes.at(-1)! - posicoes[0]!, penedo.length - 1);
  // Nenhuma parada se perde nem se duplica na divisão.
  const todos = penedo.flatMap((g) => g.ids);
  assert.equal(todos.length, 70);
  assert.equal(new Set(todos).size, 70);
});

test('a extensão denuncia agrupamento ruim melhor que a contagem', () => {
  const grupos = agruparPorRegiao(perto('SAO SEBASTIAO', SAO_SEBASTIAO, 10));
  // ~2 km de espalhamento: região compacta.
  assert.ok(grupos[0]!.extensaoKm < 3, `extensão ${grupos[0]!.extensaoKm} km`);
});

test('lista vazia, um ponto só, e pontos no MESMO lugar não quebram', () => {
  assert.deepEqual(agruparPorRegiao([]), []);

  const um = agruparPorRegiao(perto('PENEDO', PENEDO, 1));
  assert.equal(um.length, 1);
  assert.equal(um[0]!.extensaoKm, 0);

  // Divisão degenerada: 40 pedidos na MESMA coordenada (prédio, condomínio)
  // não podem fazer a divisão pela mediana repetir para sempre.
  const empilhados: PontoAgrupavel[] = Array.from({ length: 40 }, (_, i) => ({
    id: `x${i}`,
    municipio: 'PENEDO',
    coordenada: PENEDO,
  }));
  const grupos = agruparPorRegiao(empilhados, { maximoPorRota: 10 });
  assert.equal(grupos.flatMap((g) => g.ids).length, 40);
  for (const g of grupos) assert.ok(g.ids.length <= 10);
});

test('sem CD informado ainda agrupa (só não ordena por distância)', () => {
  const grupos = agruparPorRegiao([...perto('CORURIPE', CORURIPE, 12), ...perto('PENEDO', PENEDO, 9)]);
  assert.equal(grupos.length, 2);
  for (const g of grupos) assert.equal(g.distanciaDoCdKm, null);
});

test('teto fracionário não pendura o processo — vira inteiro', () => {
  // `?maximoPorRota=0.5` na URL derrubava a API: a divisão repete enquanto o
  // grupo não cabe no teto, e um grupo de UMA parada nunca cabe em meia. O
  // ramo degenerado cortava em 1 + 0 e devolvia o mesmo grupo à fila, para
  // sempre. Laço síncrono: a API não ficava lenta, PARAVA — e numa instância
  // só, isso derruba o serviço para todo mundo, motorista incluído.
  //
  // CUIDADO ao mexer: se a guarda voltar a deixar passar fracionário, este
  // teste não falha — ele PENDURA a suíte. É o preço de exercitar a função de
  // verdade em vez de testar a guarda por dentro.
  const pontos: PontoAgrupavel[] = [
    { id: 'a', municipio: 'PENEDO', coordenada: PENEDO },
    { id: 'b', municipio: 'PENEDO', coordenada: CORURIPE },
  ];
  for (const teto of [0.5, 0.9, 1.4]) {
    const grupos = agruparPorRegiao(pontos, { maximoPorRota: teto });
    assert.equal(grupos.flatMap((g) => g.ids).length, 2, `teto ${teto}`);
    // Nenhum grupo vazio: centro de grupo vazio é NaN, que vaza como null no
    // JSON e desenharia um marcador em lugar nenhum.
    for (const g of grupos) assert.ok(g.ids.length >= 1, `grupo vazio com teto ${teto}`);
  }
});
