import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agruparPorRegiao, type PontoAgrupavel } from './agrupamento.js';

/** Municípios reais da operação, com as coordenadas de verdade. */
const PENEDO = { lat: -10.2808, lng: -36.5595 };
const CORURIPE = { lat: -10.1254, lng: -36.1755 };
const IGREJA_NOVA = { lat: -10.1123, lng: -36.6597 };
const SAO_SEBASTIAO = { lat: -9.9294, lng: -36.5642 };

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
  assert.equal(grupos[0]!.municipios[0], 'CORURIPE');
  assert.equal(grupos[0]!.ids.length, 12);
  assert.ok(grupos[0]!.distanciaDoCdKm! > grupos[1]!.distanciaDoCdKm!);
});

test('município grande demais para um dia é DIVIDIDO, não empurrado inteiro', () => {
  // 70 paradas num município só: não fecha num dia.
  const grupos = agruparPorRegiao(perto('PENEDO', PENEDO, 70), { maximoPorRota: 30 });
  assert.ok(grupos.length >= 3, `esperava 3+ grupos, veio ${grupos.length}`);
  for (const g of grupos) assert.ok(g.ids.length <= 30, `grupo com ${g.ids.length} paradas`);
  // Nenhuma parada se perde nem se duplica na divisão.
  const todos = grupos.flatMap((g) => g.ids);
  assert.equal(todos.length, 70);
  assert.equal(new Set(todos).size, 70);
});

test('município pequeno demais se JUNTA ao vizinho próximo', () => {
  // Igreja Nova com 3 paradas não paga a viagem sozinha; Penedo está a ~20 km.
  const grupos = agruparPorRegiao(
    [...perto('PENEDO', PENEDO, 14), ...perto('IGREJA NOVA', IGREJA_NOVA, 3)],
    { minimoPorRota: 8, raioDeFusaoKm: 25 },
  );
  assert.equal(grupos.length, 1);
  assert.equal(grupos[0]!.ids.length, 17);
  assert.deepEqual(grupos[0]!.municipios, ['PENEDO', 'IGREJA NOVA']);
});

test('ilha distante NÃO é fundida — juntar atravessaria o estado no meio da rota', () => {
  // Coruripe fica a ~42 km de Penedo: além do raio de fusão. Um grupo de 3
  // paradas lá continua sendo 3 paradas lá, e o operador decide o que fazer.
  const grupos = agruparPorRegiao(
    [...perto('PENEDO', PENEDO, 14), ...perto('CORURIPE', CORURIPE, 3)],
    { minimoPorRota: 8, raioDeFusaoKm: 25 },
  );
  assert.equal(grupos.length, 2);
  const coruripe = grupos.find((g) => g.municipios.includes('CORURIPE'))!;
  assert.equal(coruripe.ids.length, 3);
});

test('fusão não estoura o teto de paradas do dia', () => {
  const grupos = agruparPorRegiao(
    [...perto('PENEDO', PENEDO, 29), ...perto('IGREJA NOVA', IGREJA_NOVA, 5)],
    { maximoPorRota: 30, minimoPorRota: 8, raioDeFusaoKm: 100 },
  );
  // 29 + 5 = 34 estouraria: os dois ficam separados mesmo com raio folgado.
  assert.equal(grupos.length, 2);
  for (const g of grupos) assert.ok(g.ids.length <= 30);
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
