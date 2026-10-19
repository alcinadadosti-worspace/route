import { chaveDeMunicipio } from './endereco.js';
import { distanciaEmMetros } from './geo.js';
import type { GeoPonto } from './tipos.js';

/**
 * Agrupamento geográfico dos pedidos prontos, ANTES de otimizar a ordem.
 *
 * O `/trip` do OSRM responde "em que ordem visitar estes N" — mas alguém tem
 * que escolher QUAIS são os N, e hoje isso é seleção manual na tela. Com quatro
 * pedidos dá para fazer no olho; com um ciclo inteiro espalhado por 11
 * municípios, não dá — e o custo do erro é um caminhão cruzando o estado duas
 * vezes.
 *
 * O agrupamento parte do MUNICÍPIO, e não de um k-means sobre coordenadas, por
 * três razões práticas:
 * - é o vocabulário da operação ("a rota de Coruripe"), então o operador lê a
 *   sugestão e sabe na hora se faz sentido;
 * - é determinístico: a mesma seleção sempre dá o mesmo agrupamento, sem
 *   semente aleatória para explicar quando alguém perguntar;
 * - o município já reflete a malha viária real — dois pontos a 15 km em linha
 *   reta com um rio no meio não são vizinhos, e o k-means não saberia disso.
 *
 * Um grupo é UM município, inteiro — nunca mais de um, nunca um pedaço. A
 * primeira versão fundia o município pequeno (menos de 8 paradas) com o
 * vizinho, e a tela mostrava "PIAÇABUÇU · FELIZ DESERTO · PENEDO" como um
 * bloco só. A segunda ainda partia o grande (mais de 30) em "TEOTÔNIO VILELA
 * (1/2)" e "(2/2)", a mesma cidade duas vezes no meio das outras. O usuário
 * pediu um cartão por cidade, sempre: quantas cidades cabem num dia, e quais
 * pedidos de uma cidade grande ficam para amanhã, é ele quem sabe — e a lista
 * de pedidos tem a coluna Cidade para isso.
 */

export interface PontoAgrupavel {
  id: string;
  coordenada: GeoPonto;
  municipio: string;
}

export interface GrupoSugerido {
  /** Município do grupo, em caixa alta, na grafia mais usada nos pedidos. */
  municipio: string;
  ids: string[];
  /** Centro geográfico — serve para ordenar os grupos e desenhar no mapa. */
  centro: GeoPonto;
  /** Maior distância entre dois pontos do grupo, em km: o "tamanho" da região.
   * É o número que denuncia um agrupamento ruim melhor que a contagem. */
  extensaoKm: number;
  /** Distância do CD ao centro, em km (null quando a origem não foi informada). */
  distanciaDoCdKm: number | null;
}

export interface OpcoesAgrupamento {
  /** CD de origem: quando informado, as cidades saem ordenadas da mais distante
   * para a mais perto — a região longe é a que precisa do dia inteiro. */
  origem?: GeoPonto | null;
}

export function agruparPorRegiao(
  pontos: PontoAgrupavel[],
  opcoes: OpcoesAgrupamento = {},
): GrupoSugerido[] {
  const origem = opcoes.origem ?? null;
  if (pontos.length === 0) return [];

  // A chave ignora acento e pontuação: a planilha, a NF-e e o endereço de
  // entrega escrevem a mesma cidade de jeitos diferentes ("TEOTÔNIO" e
  // "TEOTONIO", "OLHO D'ÁGUA" e "OLHO DÁGUA"), e cada grafia virava um cartão.
  // Mesma chave das exceções e da busca de endereço.
  const porMunicipio = new Map<string, PontoAgrupavel[]>();
  for (const p of pontos) {
    const chave = chaveDeMunicipio(p.municipio || '—');
    const atual = porMunicipio.get(chave);
    if (atual) atual.push(p);
    else porMunicipio.set(chave, [p]);
  }

  const grupos = [...porMunicipio.values()].map((grupo) => montar(grafiaMaisComum(grupo), grupo, origem));
  // Mais longe primeiro: é a região que precisa do dia inteiro, e é a decisão
  // que o operador toma primeiro ao planejar a semana. Sem CD informado não há
  // "longe": a maior cidade vem primeiro.
  return grupos.sort(
    (a, b) => (b.distanciaDoCdKm ?? b.ids.length) - (a.distanciaDoCdKm ?? a.ids.length),
  );
}

/** O nome que o cartão mostra: a grafia que mais aparece (empate fica com a
 * primeira vista) — em geral a com acento, que é a do cadastro do ERP. */
function grafiaMaisComum(grupo: PontoAgrupavel[]): string {
  const contagem = new Map<string, number>();
  for (const p of grupo) {
    const nome = (p.municipio || '—').trim().toUpperCase();
    contagem.set(nome, (contagem.get(nome) ?? 0) + 1);
  }
  let melhor = '';
  let vezes = 0;
  for (const [nome, n] of contagem) {
    if (n > vezes) {
      melhor = nome;
      vezes = n;
    }
  }
  return melhor;
}

function montar(municipio: string, grupo: PontoAgrupavel[], origem: GeoPonto | null): GrupoSugerido {
  const centro = centroDe(grupo);
  return {
    municipio,
    ids: grupo.map((p) => p.id),
    centro,
    extensaoKm: Math.round(extensaoEmMetros(grupo) / 100) / 10,
    distanciaDoCdKm: origem ? Math.round(distanciaEmMetros(origem, centro) / 100) / 10 : null,
  };
}

/** Média simples das coordenadas. Nas dezenas de km de uma rota, a diferença
 * para o centroide esférico fica muito abaixo do erro do próprio endereço. */
function centroDe(grupo: PontoAgrupavel[]): GeoPonto {
  let lat = 0;
  let lng = 0;
  for (const p of grupo) {
    lat += p.coordenada.lat;
    lng += p.coordenada.lng;
  }
  return { lat: lat / grupo.length, lng: lng / grupo.length };
}

/** Maior distância entre dois pontos da cidade. O(n²) é aceitável: uma cidade
 * tem dezenas de paradas por ciclo, raramente centenas — nunca milhares. */
function extensaoEmMetros(grupo: PontoAgrupavel[]): number {
  let maior = 0;
  for (let i = 0; i < grupo.length; i++) {
    for (let j = i + 1; j < grupo.length; j++) {
      const d = distanciaEmMetros(grupo[i]!.coordenada, grupo[j]!.coordenada);
      if (d > maior) maior = d;
    }
  }
  return maior;
}
