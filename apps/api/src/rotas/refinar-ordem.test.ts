import { test } from 'node:test';
import assert from 'node:assert/strict';
import { custoDaOrdem, refinarOrdem } from './refinar-ordem.js';

/** Matriz de durações por distância no plano (pontos inventados, em minutos). */
function matrizDoPlano(pontos: Array<[number, number]>): number[][] {
  return pontos.map(([x1, y1]) => pontos.map(([x2, y2]) => Math.hypot(x1 - x2, y1 - y2)));
}

/** Gerador determinístico: os casos aleatórios são os mesmos em toda rodada. */
function sorteador(semente: number): () => number {
  let s = semente;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

test('desfaz o vai e volta: a parada da cidade sai do meio do trecho rural', () => {
  // O caso que chegou do campo, com pontos inventados: CD na origem, um
  // povoado no caminho, a cidade com seis paradas e um povoado rural a 20 km
  // da cidade. A ordem de entrada é a do /trip: entrega UMA na cidade, vai ao
  // povoado rural e volta à cidade para as outras cinco.
  const pontos: Array<[number, number]> = [
    [0, 0], // CD
    [30, 10], // 0: povoado no caminho
    [40, 2], // 1: cidade, entrada
    [40, -20], // 2: povoado rural
    [41, 0], // 3..7: cidade
    [42, 0],
    [42, 1],
    [43, 0],
    [43, 1],
  ];
  const duracoes = matrizDoPlano(pontos);
  const doTrip = [0, 1, 2, 3, 4, 5, 6, 7];
  const refinada = refinarOrdem(duracoes, doTrip, { fechada: true });

  assert.ok(custoDaOrdem(duracoes, refinada, true) < custoDaOrdem(duracoes, doTrip, true));
  // A cidade inteira de uma vez: as seis paradas dela ficam seguidas.
  const naCidade = refinada.map((p) => [1, 3, 4, 5, 6, 7].includes(p));
  const inicio = naCidade.indexOf(true);
  assert.deepEqual(naCidade.slice(inicio, inicio + 6), [true, true, true, true, true, true]);
});

test('mão única: o mover trecho põe no lugar a parada que o 2-opt deixa solta', () => {
  // Quadras inventadas, distância em L, e andar para oeste custa 3x (mão
  // única). Partindo da ordem crua, o 2-opt sozinho para em 58: todo trecho
  // que ele inverte passa a andar para oeste. Tirar uma parada e encaixá-la
  // adiante chega ao ótimo, 52 (conferido por força bruta abaixo).
  const pontos: Array<[number, number]> = [[0, 0], [5, 4], [2, 8], [6, 3], [7, 5], [3, 5], [2, 0]];
  const duracoes = pontos.map(([x1, y1]) =>
    pontos.map(([x2, y2]) => (x2 < x1 ? 3 : 1) * (Math.abs(x1 - x2) + Math.abs(y1 - y2))),
  );
  const permutacoes = (a: number[]): number[][] =>
    a.length <= 1
      ? [a]
      : a.flatMap((x, i) => permutacoes([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));
  const otimo = Math.min(...permutacoes([0, 1, 2, 3, 4, 5]).map((o) => custoDaOrdem(duracoes, o, true)));

  const refinada = refinarOrdem(duracoes, [0, 1, 2, 3, 4, 5], { fechada: true });
  assert.equal(otimo, 52);
  assert.equal(custoDaOrdem(duracoes, refinada, true), otimo);
});

test('nunca devolve ordem pior e não perde nem duplica parada', () => {
  const sortear = sorteador(20261028);
  for (let caso = 0; caso < 200; caso++) {
    const n = 2 + Math.floor(sortear() * 14);
    // Assimétrica de propósito: mão única e retorno distante existem.
    const duracoes = Array.from({ length: n + 1 }, (_, a) =>
      Array.from({ length: n + 1 }, (_, b) => (a === b ? 0 : 1 + Math.floor(sortear() * 500))),
    );
    const entrada = Array.from({ length: n }, (_, i) => i).sort(() => sortear() - 0.5);
    for (const fechada of [true, false]) {
      const saida = refinarOrdem(duracoes, entrada, { fechada });
      assert.deepEqual([...saida].sort((a, b) => a - b), [...entrada].sort((a, b) => a - b));
      assert.ok(custoDaOrdem(duracoes, saida, fechada) <= custoDaOrdem(duracoes, entrada, fechada));
    }
  }
});

test('nunca sai pior que o 2-opt que a rota aberta usava antes', () => {
  // O 2-opt antigo (custo recalculado inteiro), para comparar. A busca nova
  // chegou a cair noutro ótimo local e sair pior em ~5% das rotas do plano.
  const doisOptAntigo = (duracoes: number[][], entrada: number[], fechada: boolean): number[] => {
    let ordem = [...entrada];
    let custoAtual = custoDaOrdem(duracoes, ordem, fechada);
    for (let passada = 0; passada < 50; passada++) {
      let melhorou = false;
      for (let i = 0; i < ordem.length - 1; i++) {
        for (let j = i + 1; j < ordem.length; j++) {
          const candidato = [...ordem.slice(0, i), ...ordem.slice(i, j + 1).reverse(), ...ordem.slice(j + 1)];
          const custo = custoDaOrdem(duracoes, candidato, fechada);
          if (custo < custoAtual - 1e-9) {
            ordem = candidato;
            custoAtual = custo;
            melhorou = true;
          }
        }
      }
      if (!melhorou) break;
    }
    return ordem;
  };
  const sortear = sorteador(5);
  for (let caso = 0; caso < 400; caso++) {
    const n = 4 + (caso % 17);
    // Quadras inteiras (distância em L): é onde os empates confundem a busca.
    const pontos = Array.from({ length: n + 1 }, () => [Math.floor(sortear() * 20), Math.floor(sortear() * 20)]);
    const duracoes = pontos.map(([x1, y1]) => pontos.map(([x2, y2]) => Math.abs(x1! - x2!) + Math.abs(y1! - y2!)));
    const entrada = Array.from({ length: n }, (_, i) => i).sort(() => sortear() - 0.5);
    for (const fechada of [true, false]) {
      const nova = custoDaOrdem(duracoes, refinarOrdem(duracoes, entrada, { fechada }), fechada);
      const antiga = custoDaOrdem(duracoes, doisOptAntigo(duracoes, entrada, fechada), fechada);
      assert.ok(nova <= antiga, `caso ${caso} (${fechada ? 'fechada' : 'aberta'}): ${nova} > ${antiga}`);
    }
  }
});

test('rota fechada conta a volta ao CD: a última parada é a que fica no caminho de casa', () => {
  // CD em 0; paradas numa reta em 10 e 20, e uma terceira em 5 que custa
  // muito para alcançar indo, mas é de graça na volta (mão única).
  const duracoes = [
    [0, 10, 20, 90],
    [10, 0, 10, 90],
    [20, 10, 0, 15],
    [5, 90, 90, 0],
  ];
  assert.deepEqual(refinarOrdem(duracoes, [2, 1, 0], { fechada: true }), [0, 1, 2]);
});

test('parada inalcançável continua na ordem', () => {
  const duracoes = [
    [0, 5, Infinity, 7],
    [5, 0, Infinity, 2],
    [Infinity, Infinity, 0, Infinity],
    [7, 2, Infinity, 0],
  ];
  for (const fechada of [true, false]) {
    const saida = refinarOrdem(duracoes, [2, 0, 1], { fechada });
    assert.deepEqual([...saida].sort(), [0, 1, 2]);
  }
});

test('com 0 ou 1 parada devolve igual, sem mexer na entrada', () => {
  assert.deepEqual(refinarOrdem([[0]], [], { fechada: true }), []);
  const entrada = [0];
  const saida = refinarOrdem([[0, 3], [3, 0]], entrada, { fechada: true });
  assert.deepEqual(saida, [0]);
  assert.notEqual(saida, entrada);
});
