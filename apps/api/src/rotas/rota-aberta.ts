import { refinarOrdem } from './refinar-ordem.js';

/**
 * Ordem de visita de uma rota ABERTA: começa num ponto fixo (o CD, ou onde o
 * motorista está) e termina onde terminar.
 *
 * Por que não o `/trip` do OSRM: ele não implementa essa combinação. Aceita
 * `roundtrip=true`, ou `roundtrip=false` com o FIM também fixo
 * (`destination=last`) — verificado contra o serviço real, que responde
 * `NotImplemented` para o resto. Fixar o fim seria eleger a última parada por
 * acidente (a ordem em que o operador clicou nos pedidos), o que engessa a
 * otimização sem que ninguém entenda o porquê. Então resolvemos aqui, sobre a
 * matriz de durações do `/table`: vizinho mais próximo + busca local
 * (refinar-ordem.ts, a mesma que refina a rota fechada do `/trip`).
 *
 * Para as dezenas de paradas de um dia isso fica a milissegundos do ótimo — e
 * o problema real de uma rota rural não é o último 1% do caixeiro-viajante, é
 * o caminho que o mapa não conhece (seção 11).
 */

/**
 * `duracoes` é a matriz NxN do `/table`, com o índice 0 na ORIGEM e 1..n nas
 * paradas. Devolve os índices das PARADAS (0-based, já sem a origem) na ordem
 * de visita — mesma convenção do `ResultadoTrip.ordem`.
 */
export function ordemRotaAberta(duracoes: number[][]): number[] {
  const n = duracoes.length - 1;
  if (n <= 0) return [];
  if (n === 1) return [0];

  // 1. Vizinho mais próximo a partir da origem.
  const visitados = new Set<number>();
  const ordem: number[] = [];
  let atual = 0;
  for (let passo = 0; passo < n; passo++) {
    let melhor = -1;
    let melhorCusto = Infinity;
    for (let j = 1; j <= n; j++) {
      if (visitados.has(j)) continue;
      const custo = duracoes[atual]?.[j] ?? Infinity;
      if (custo < melhorCusto) {
        melhorCusto = custo;
        melhor = j;
      }
    }
    // Todos os candidatos restantes inalcançáveis (Infinity): anexa na ordem
    // dada em vez de perder paradas — quem decide o que fazer é o operador.
    if (melhor < 0) {
      for (let j = 1; j <= n; j++) if (!visitados.has(j)) ordem.push(j);
      break;
    }
    visitados.add(melhor);
    ordem.push(melhor);
    atual = melhor;
  }

  // 2. Busca local sobre o caminho ABERTO — sem aresta de retorno, que é
  // justamente o que o /trip não sabe otimizar.
  return refinarOrdem(
    duracoes,
    ordem.map((indice) => indice - 1),
    { fechada: false },
  );
}
