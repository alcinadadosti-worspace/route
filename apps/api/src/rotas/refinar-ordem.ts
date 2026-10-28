/**
 * Busca local sobre uma ordem de visita já pronta, na matriz de durações do
 * `/table`: 2-opt (inverte um trecho) e mover trecho (tira 1 a 3 paradas
 * seguidas e as encaixa noutro ponto, na mesma direção ou invertidas).
 *
 * Por que existe: o `/trip` do OSRM só acha o ótimo até 8 paradas (9 pontos
 * com o CD — medido no serviço real em 28/10/2026: com 9 ou mais, saiu acima
 * do ótimo em metade dos casos); acima disso devolve a inserção pelo mais
 * distante sem refinar. Na rota de Palmeira
 * dos Índios de 28/10/2026 (13 paradas) isso fez o motorista entrar em Major
 * Isidoro, entregar UMA parada no Centro, sair 21 km até a Capelinha e voltar
 * ao Centro para as outras nove — uns 8 km a mais, e para quem dirige (e lê o
 * PDF) a cara de "pedidos bagunçados". Aquele caso o 2-opt já desfaz; o mover
 * trecho pega o parente dele que o 2-opt só alcança invertendo um trecho
 * inteiro — o que, com mão única, sai caro e ele recusa: uma parada solta no
 * meio de outra cidade.
 *
 * Só aceita movimento que BAIXA o custo, então nunca devolve ordem pior que a
 * recebida — quem chama pode refinar o que quer que tenha sem medo.
 */

/** Teto de varreduras: converge muito antes, o limite é só barreira. */
const MAXIMO_DE_PASSADAS = 50;

/** Maior trecho que o "mover trecho" tira de uma vez (o clássico Or-opt). */
const MAIOR_TRECHO = 3;

/** Ganho mínimo, em segundos, para aceitar um movimento (evita ciclar em empate). */
const GANHO_MINIMO = 1e-6;

/** Fim de rota ABERTA: chegar nele não custa nada. */
const FIM = -1;

/**
 * `duracoes` é a matriz NxN do `/table`, com o índice 0 na ORIGEM e 1..n nas
 * paradas. `ordem` são os índices das PARADAS (0-based, sem a origem) — a
 * convenção de `ResultadoTrip.ordem`. Fechada = a rota volta à origem.
 *
 * O custo de cada movimento sai do delta das arestas trocadas, mas SEM supor
 * matriz simétrica (duração de estrada não é: mão única, retorno distante):
 * inverter um trecho soma as arestas dele no sentido contrário, uma a uma.
 */
export function refinarOrdem(
  duracoes: number[][],
  ordem: number[],
  opcoes: { fechada: boolean },
): number[] {
  const n = ordem.length;
  if (n < 2) return [...ordem];

  // Índices da MATRIZ (1..n); a origem é 0.
  let seq = ordem.map((i) => i + 1);
  const fim = opcoes.fechada ? 0 : FIM;
  const aresta = (a: number, b: number): number =>
    b === FIM ? 0 : (duracoes[a]?.[b] ?? Infinity);
  // Vizinhos de uma posição na sequência, com a origem e o fim nas pontas.
  const antes = (s: number[], p: number): number => (p === 0 ? 0 : s[p - 1]!);
  const depois = (s: number[], p: number): number => (p === s.length - 1 ? fim : s[p + 1]!);

  for (let passada = 0; passada < MAXIMO_DE_PASSADAS; passada++) {
    let melhorou = false;

    // 1. 2-opt até não achar mais nada: inverte seq[i..j]. Varre do mesmo jeito
    // que o 2-opt que a rota aberta usava antes (aplica e segue a varredura na
    // ordem nova), então a primeira passada para onde ele parava e o resto só
    // melhora — sem isto, a busca nova caía noutro ótimo local e saía PIOR que
    // a antiga em ~5% das rotas, mesmo sendo melhor na média.
    for (let varredura = 0; varredura < MAXIMO_DE_PASSADAS; varredura++) {
      let inverteu = false;
      for (let i = 0; i < n - 1; i++) {
        let idaInterna = 0;
        let voltaInterna = 0;
        for (let j = i + 1; j < n; j++) {
          idaInterna += aresta(seq[j - 1]!, seq[j]!);
          voltaInterna += aresta(seq[j]!, seq[j - 1]!);
          const a = antes(seq, i);
          const b = depois(seq, j);
          const atual = aresta(a, seq[i]!) + idaInterna + aresta(seq[j]!, b);
          const invertido = aresta(a, seq[j]!) + voltaInterna + aresta(seq[i]!, b);
          if (invertido - atual < -GANHO_MINIMO) {
            seq = [...seq.slice(0, i), ...seq.slice(i, j + 1).reverse(), ...seq.slice(j + 1)];
            // O trecho i..j agora está ao contrário: o que era ida virou volta.
            [idaInterna, voltaInterna] = [voltaInterna, idaInterna];
            inverteu = true;
          }
        }
      }
      if (!inverteu) break;
      melhorou = true;
    }

    // 2. Mover trecho: seq[i..i+k-1] sai e entra entre outras duas paradas.
    for (let k = 1; k <= MAIOR_TRECHO && k < n; k++) {
      for (let i = 0; i + k <= n; i++) {
        const primeiro = seq[i]!;
        const ultimo = seq[i + k - 1]!;
        let idaInterna = 0;
        let voltaInterna = 0;
        for (let t = i; t < i + k - 1; t++) {
          idaInterna += aresta(seq[t]!, seq[t + 1]!);
          voltaInterna += aresta(seq[t + 1]!, seq[t]!);
        }
        const a0 = antes(seq, i);
        const b0 = depois(seq, i + k - 1);
        // O que se ganha tirando o trecho e emendando as pontas.
        const ganhoAoTirar = aresta(a0, primeiro) + aresta(ultimo, b0) - aresta(a0, b0);

        // `resto` é a sequência sem o trecho; p = posição de encaixe nele.
        const restoEm = (p: number): number => (p < i ? seq[p]! : seq[p + k]!);
        const tamanhoResto = n - k;
        let aplicado = false;
        for (let p = 0; p <= tamanhoResto && !aplicado; p++) {
          const a = p === 0 ? 0 : restoEm(p - 1);
          const b = p === tamanhoResto ? fim : restoEm(p);
          const base = aresta(a, b);
          const reto = aresta(a, primeiro) + aresta(ultimo, b) - base;
          const virado = aresta(a, ultimo) + aresta(primeiro, b) - base + (voltaInterna - idaInterna);
          // No mesmo lugar, reto é não mexer; virado é inverter o trecho ali.
          const custoReto = p === i ? Infinity : reto - ganhoAoTirar;
          const custoVirado = k === 1 ? Infinity : virado - ganhoAoTirar;
          const melhor = Math.min(custoReto, custoVirado);
          if (melhor < -GANHO_MINIMO) {
            const trecho = seq.slice(i, i + k);
            if (custoVirado < custoReto) trecho.reverse();
            const resto = [...seq.slice(0, i), ...seq.slice(i + k)];
            seq = [...resto.slice(0, p), ...trecho, ...resto.slice(p)];
            melhorou = true;
            aplicado = true;
          }
        }
      }
    }

    if (!melhorou) break;
  }

  const refinada = seq.map((indice) => indice - 1);
  // Barreira: a busca só troca paradas de lugar. Se um dia devolver algo que
  // não é a mesma lista (ou custar mais), vale a ordem recebida — perder uma
  // parada da rota é muito pior que rodar uns quilômetros a mais.
  const mesmaLista =
    [...refinada].sort((x, y) => x - y).join() === [...ordem].sort((x, y) => x - y).join();
  if (!mesmaLista || custoDaOrdem(duracoes, refinada, opcoes.fechada) > custoDaOrdem(duracoes, ordem, opcoes.fechada)) {
    return [...ordem];
  }
  return refinada;
}

/** Soma origem→primeira, as arestas entre paradas e, se fechada, a volta. */
export function custoDaOrdem(duracoes: number[][], ordem: number[], fechada: boolean): number {
  if (ordem.length === 0) return 0;
  const seq = ordem.map((i) => i + 1);
  let total = duracoes[0]?.[seq[0]!] ?? Infinity;
  for (let i = 1; i < seq.length; i++) total += duracoes[seq[i - 1]!]?.[seq[i]!] ?? Infinity;
  if (fechada) total += duracoes[seq[seq.length - 1]!]?.[0] ?? Infinity;
  return total;
}
