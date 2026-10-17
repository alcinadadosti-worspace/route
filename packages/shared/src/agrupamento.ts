import { normalizar } from './endereco.js';
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
 * Um grupo é UM município, nunca mais de um. A primeira versão fundia o
 * município pequeno (menos de 8 paradas) com o vizinho mais próximo, e a tela
 * mostrava "PIAÇABUÇU · FELIZ DESERTO · PENEDO" como um bloco só: o operador
 * não conseguia levar Piaçabuçu sem as outras duas, nem juntar dois blocos.
 * Quem sabe quais cidades cabem num dia é ele — a tela deixa marcar quantas
 * quiser, e o agrupamento só não pode decidir isso por ele.
 *
 * O único ajuste que sobrou: município grande demais para um dia é DIVIDIDO,
 * e cada pedaço diz que é parte de quantas.
 */

export interface PontoAgrupavel {
  id: string;
  coordenada: GeoPonto;
  municipio: string;
}

export interface GrupoSugerido {
  /** Município do grupo, em caixa alta como veio do cadastro. */
  municipio: string;
  /** Município grande demais para um dia sai em pedaços: "parte 1 de 2". */
  parte: { indice: number; total: number } | null;
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
  /** Teto de paradas por rota. O padrão sai do ritmo real da operação: ~10 min
   * parado por cliente mais o deslocamento rural não fecham muito mais que
   * isso num dia. */
  maximoPorRota?: number;
  /** CD de origem: quando informado, os grupos saem ordenados do mais distante
   * para o mais perto — a região longe é a que precisa do dia inteiro. */
  origem?: GeoPonto | null;
}

const PADRAO = { maximoPorRota: 30 };

export function agruparPorRegiao(
  pontos: PontoAgrupavel[],
  opcoes: OpcoesAgrupamento = {},
): GrupoSugerido[] {
  const maximo = contagem(opcoes.maximoPorRota) ?? PADRAO.maximoPorRota;
  const origem = opcoes.origem ?? null;
  if (pontos.length === 0) return [];

  // A chave é o nome SEM acento: a planilha, a NF-e e o endereço de entrega
  // escrevem a mesma cidade de jeitos diferentes, e "TEOTÔNIO VILELA" e
  // "TEOTONIO VILELA" viravam dois cartões. Enquanto havia fusão, a vizinha
  // de 0 km escondia isso; sem ela, apareceria. Mesma regra das exceções.
  const porMunicipio = new Map<string, PontoAgrupavel[]>();
  for (const p of pontos) {
    const chave = normalizar(p.municipio || '—');
    const atual = porMunicipio.get(chave);
    if (atual) atual.push(p);
    else porMunicipio.set(chave, [p]);
  }

  const cidades = [...porMunicipio.values()].map((grupo) => {
    const municipio = grafiaMaisComum(grupo);
    const partes = dividir(grupo, maximo).map((parte) => montar(municipio, parte, origem));
    // As partes da mesma cidade saem juntas, da mais longe para a mais perto.
    partes.sort(maisLongePrimeiro);
    partes.forEach((p, i) => {
      p.parte = partes.length > 1 ? { indice: i + 1, total: partes.length } : null;
    });
    const distancia = origem ? distanciaEmMetros(origem, centroDe(grupo)) : null;
    return { distancia, tamanho: grupo.length, partes };
  });
  // Mais longe primeiro: é a região que precisa do dia inteiro, e é a decisão
  // que o operador toma primeiro ao planejar a semana. Sem CD informado não há
  // "longe": a maior cidade vem primeiro.
  cidades.sort((a, b) => (b.distancia ?? b.tamanho) - (a.distancia ?? a.tamanho));
  return cidades.flatMap((c) => c.partes);
}

function maisLongePrimeiro(a: GrupoSugerido, b: GrupoSugerido): number {
  return (b.distanciaDoCdKm ?? b.ids.length) - (a.distanciaDoCdKm ?? a.ids.length);
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

/**
 * Divide o que não cabe num dia. A divisão é pela MEDIANA do eixo mais
 * esticado (lat ou lng): determinística, sem semente, e corta a região no
 * sentido em que ela realmente se estende.
 */
function dividir(grupo: PontoAgrupavel[], maximo: number): PontoAgrupavel[][] {
  const divididos: PontoAgrupavel[][] = [];
  const fila = [grupo];
  while (fila.length > 0) {
    const atual = fila.pop()!;
    if (atual.length <= maximo) {
      divididos.push(atual);
      continue;
    }
    const [a, b] = dividirNaMediana(atual);
    // Divisão degenerada (todos no mesmo ponto): corta pela metade na ordem de
    // entrada em vez de repetir para sempre.
    if (a.length === 0 || b.length === 0) {
      const meio = Math.ceil(atual.length / 2);
      fila.push(atual.slice(0, meio), atual.slice(meio));
      continue;
    }
    fila.push(a, b);
  }
  return divididos;
}

function montar(municipio: string, grupo: PontoAgrupavel[], origem: GeoPonto | null): GrupoSugerido {
  const centro = centroDe(grupo);
  return {
    municipio,
    parte: null,
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

/** Maior distância entre dois pontos do grupo. O(n²) é aceitável: um grupo tem
 * dezenas de paradas, não milhares. */
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

/** Corta o grupo em dois pela mediana do eixo em que ele mais se estende. */
function dividirNaMediana(grupo: PontoAgrupavel[]): [PontoAgrupavel[], PontoAgrupavel[]] {
  const lats = grupo.map((p) => p.coordenada.lat);
  const lngs = grupo.map((p) => p.coordenada.lng);
  const amplitudeLat = Math.max(...lats) - Math.min(...lats);
  // Longitude encurta com o cosseno da latitude — sem corrigir, o corte
  // escolheria o eixo errado numa região mais alta que larga.
  const fator = Math.cos((grupo[0]!.coordenada.lat * Math.PI) / 180);
  const amplitudeLng = (Math.max(...lngs) - Math.min(...lngs)) * fator;

  const porLat = amplitudeLat >= amplitudeLng;
  const ordenado = [...grupo].sort((a, b) =>
    porLat ? a.coordenada.lat - b.coordenada.lat : a.coordenada.lng - b.coordenada.lng,
  );
  const meio = Math.floor(ordenado.length / 2);
  const valorMeio = porLat ? ordenado[meio]!.coordenada.lat : ordenado[meio]!.coordenada.lng;
  const a = ordenado.filter((p) => (porLat ? p.coordenada.lat : p.coordenada.lng) < valorMeio);
  const b = ordenado.filter((p) => (porLat ? p.coordenada.lat : p.coordenada.lng) >= valorMeio);
  return [a, b];
}

function positivo(n: number | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Teto e piso são CONTAGENS de paradas: inteiro, no mínimo 1.
 *
 * Meia parada trava o processo. A divisão repete enquanto `grupo.length >
 * maximo`; com `maximo = 0,5` um grupo de uma parada nunca cabe, a divisão pela
 * mediana devolve um lado vazio, o ramo degenerado corta em 1 + 0 — e o grupo
 * de uma parada volta para a fila igualzinho, para sempre. O laço é síncrono:
 * a API não fica lenta, ela PARA, e numa instância só isso derruba o serviço
 * inteiro, motorista incluído. Chegava assim de `?maximoPorRota=0.5` na URL.
 */
function contagem(n: number | undefined): number | null {
  const p = positivo(n);
  return p === null ? null : Math.max(1, Math.floor(p));
}
