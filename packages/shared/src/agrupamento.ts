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
 * Sobre isso vêm dois ajustes: município grande demais para um dia é DIVIDIDO,
 * e município pequeno demais para justificar a viagem é FUNDIDO com o vizinho
 * mais próximo — desde que a fusão não estoure o teto nem junte lugares
 * distantes.
 */

export interface PontoAgrupavel {
  id: string;
  coordenada: GeoPonto;
  municipio: string;
}

export interface GrupoSugerido {
  /** Municípios que caíram neste grupo, do que mais tem pedidos para o que menos. */
  municipios: string[];
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
  /** Abaixo disso a viagem raramente se paga sozinha — o grupo tenta se juntar
   * a um vizinho antes de virar rota. */
  minimoPorRota?: number;
  /** Até que distância entre centros vale fundir dois grupos pequenos. */
  raioDeFusaoKm?: number;
  /** CD de origem: quando informado, os grupos saem ordenados do mais distante
   * para o mais perto — a região longe é a que precisa do dia inteiro. */
  origem?: GeoPonto | null;
}

const PADRAO = { maximoPorRota: 30, minimoPorRota: 8, raioDeFusaoKm: 25 };

export function agruparPorRegiao(
  pontos: PontoAgrupavel[],
  opcoes: OpcoesAgrupamento = {},
): GrupoSugerido[] {
  const maximo = positivo(opcoes.maximoPorRota) ?? PADRAO.maximoPorRota;
  const minimo = positivo(opcoes.minimoPorRota) ?? PADRAO.minimoPorRota;
  const raioFusaoM = (positivo(opcoes.raioDeFusaoKm) ?? PADRAO.raioDeFusaoKm) * 1000;
  if (pontos.length === 0) return [];

  // 1. Semeia por município.
  const porMunicipio = new Map<string, PontoAgrupavel[]>();
  for (const p of pontos) {
    const chave = (p.municipio || '—').trim().toUpperCase();
    const atual = porMunicipio.get(chave);
    if (atual) atual.push(p);
    else porMunicipio.set(chave, [p]);
  }
  let grupos: PontoAgrupavel[][] = [...porMunicipio.values()];

  // 2. Divide o que não cabe num dia. A divisão é pela MEDIANA do eixo mais
  //    esticado (lat ou lng): determinística, sem semente, e corta a região no
  //    sentido em que ela realmente se estende.
  const divididos: PontoAgrupavel[][] = [];
  const fila = [...grupos];
  while (fila.length > 0) {
    const grupo = fila.pop()!;
    if (grupo.length <= maximo) {
      divididos.push(grupo);
      continue;
    }
    const [a, b] = dividirNaMediana(grupo);
    // Divisão degenerada (todos no mesmo ponto): corta pela metade na ordem de
    // entrada em vez de repetir para sempre.
    if (a.length === 0 || b.length === 0) {
      const meio = Math.ceil(grupo.length / 2);
      fila.push(grupo.slice(0, meio), grupo.slice(meio));
      continue;
    }
    fila.push(a, b);
  }
  grupos = divididos;

  // 3. Funde os pequenos com o vizinho mais próximo, enquanto valer a pena.
  //    Sempre parte do MENOR grupo: assim o que mais precisa de companhia
  //    escolhe primeiro, e o resultado não depende da ordem de entrada.
  for (;;) {
    grupos.sort((x, y) => x.length - y.length);
    const menor = grupos[0];
    if (!menor || menor.length >= minimo || grupos.length < 2) break;

    const centroMenor = centroDe(menor);
    let alvo = -1;
    let melhor = Infinity;
    for (let i = 1; i < grupos.length; i++) {
      if (menor.length + grupos[i]!.length > maximo) continue;
      const d = distanciaEmMetros(centroMenor, centroDe(grupos[i]!));
      if (d < melhor) {
        melhor = d;
        alvo = i;
      }
    }
    // Nenhum vizinho perto o bastante (ou todos estourariam o teto): o grupo
    // fica pequeno mesmo. Ilha distante é ilha distante — juntar com quem está
    // a 80 km só faria o caminhão atravessar o estado no meio da rota.
    if (alvo === -1 || melhor > raioFusaoM) break;
    grupos[alvo] = [...grupos[alvo]!, ...menor];
    grupos.splice(0, 1);
  }

  const origem = opcoes.origem ?? null;
  const sugeridos = grupos.map((grupo) => montar(grupo, origem));
  // Mais longe primeiro: é a região que precisa do dia inteiro, e é a decisão
  // que o operador toma primeiro ao planejar a semana.
  return sugeridos.sort(
    (a, b) => (b.distanciaDoCdKm ?? b.ids.length) - (a.distanciaDoCdKm ?? a.ids.length),
  );
}

function montar(grupo: PontoAgrupavel[], origem: GeoPonto | null): GrupoSugerido {
  const centro = centroDe(grupo);
  const contagem = new Map<string, number>();
  for (const p of grupo) {
    const m = (p.municipio || '—').trim().toUpperCase();
    contagem.set(m, (contagem.get(m) ?? 0) + 1);
  }
  return {
    municipios: [...contagem].sort((a, b) => b[1] - a[1]).map(([m]) => m),
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
