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

test('cidade grande continua UM cartão — o usuário escolhe o que fica para amanhã', () => {
  // Teotônio Vilela com 41 pedidos aparecia como (1/2) e (2/2), a mesma cidade
  // duas vezes no meio das outras.
  const grupos = agruparPorRegiao(
    [...perto('TEOTÔNIO VILELA', CORURIPE, 41), ...perto('PENEDO', PENEDO, 5)],
    { origem: IGREJA_NOVA },
  );
  assert.deepEqual(
    grupos.map((g) => [g.municipio, g.ids.length]),
    [['TEOTÔNIO VILELA', 41], ['PENEDO', 5]],
  );
  assert.equal(new Set(grupos[0]!.ids).size, 41);
});

test(`apóstrofo e hífen não separam a cidade: "OLHO D'ÁGUA" = "OLHO DÁGUA"`, () => {
  // Os dois jeitos estavam na planilha real do ciclo.
  const grupos = agruparPorRegiao([
    ...perto("OLHO D'ÁGUA GRANDE", SAO_SEBASTIAO, 2),
    ...perto('OLHO DÁGUA GRANDE', SAO_SEBASTIAO, 1, 'b'),
    ...perto('OLHO-DAGUA GRANDE', SAO_SEBASTIAO, 1, 'c'),
  ]);
  assert.equal(grupos.length, 1);
  assert.equal(grupos[0]!.municipio, "OLHO D'ÁGUA GRANDE");
  assert.equal(grupos[0]!.ids.length, 4);
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

  // 40 pedidos na MESMA coordenada (prédio, condomínio): extensão zero, um grupo.
  const empilhados: PontoAgrupavel[] = Array.from({ length: 40 }, (_, i) => ({
    id: `x${i}`,
    municipio: 'PENEDO',
    coordenada: PENEDO,
  }));
  const grupos = agruparPorRegiao(empilhados);
  assert.equal(grupos.length, 1);
  assert.equal(grupos[0]!.ids.length, 40);
  assert.equal(grupos[0]!.extensaoKm, 0);
});

test('sem CD informado ainda agrupa (só não ordena por distância)', () => {
  const grupos = agruparPorRegiao([...perto('CORURIPE', CORURIPE, 12), ...perto('PENEDO', PENEDO, 9)]);
  assert.equal(grupos.length, 2);
  for (const g of grupos) assert.equal(g.distanciaDoCdKm, null);
});
