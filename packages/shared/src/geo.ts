import type { GeoPonto } from './tipos.js';

/**
 * Geometria sobre coordenadas (seção 11): filtro de distância na gravação,
 * raios de handoff/chegada na navegação e comprimento de trilhas. Haversine
 * basta — nos poucos km de uma rota, o erro fica abaixo do ruído do GPS.
 */

const RAIO_TERRA_M = 6_371_000;

export function distanciaEmMetros(a: GeoPonto, b: GeoPonto): number {
  const dLat = grausParaRad(b.lat - a.lat);
  const dLng = grausParaRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(grausParaRad(a.lat)) * Math.cos(grausParaRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * RAIO_TERRA_M * Math.asin(Math.sqrt(h));
}

/**
 * Deslocamento mínimo para o rumo ser considerado direção, e não ruído.
 * 5 m serve para GPS preciso; abaixo disso, duas leituras seguidas do mesmo
 * lugar já dariam um ângulo qualquer.
 */
export const DESLOCAMENTO_MINIMO_RUMO_M = 5;

/**
 * O deslocamento entre duas leituras diz mesmo a DIREÇÃO do movimento?
 *
 * Comparar contra um limiar fixo não basta: com precisão de ±20 m (comum sob
 * árvore, em rua estreita ou logo depois de ligar o GPS), duas leituras do
 * motorista PARADO diferem 10–30 m só de ruído. Isso passava de qualquer
 * limiar pequeno e virava um rumo aleatório — a seta da navegação girando
 * sozinha com o carro parado.
 *
 * E é o pior caso possível: o rumo por deslocamento é o ÚLTIMO fallback, usado
 * só quando não há bússola nem rumo do GPS — ou seja, exatamente no iOS parado.
 *
 * O deslocamento precisa superar o erro do aparelho para significar movimento.
 */
export function deslocamentoDizDirecao(distanciaM: number, precisaoM: number): boolean {
  if (!Number.isFinite(distanciaM)) return false;
  const exigido = Number.isFinite(precisaoM)
    ? Math.max(DESLOCAMENTO_MINIMO_RUMO_M, precisaoM)
    : DESLOCAMENTO_MINIMO_RUMO_M;
  return distanciaM >= exigido;
}

/** Rumo inicial de `de` para `para` — graus a partir do norte, sentido horário. */
export function rumoEmGraus(de: GeoPonto, para: GeoPonto): number {
  const lat1 = grausParaRad(de.lat);
  const lat2 = grausParaRad(para.lat);
  const dLng = grausParaRad(para.lng - de.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Menor distância do ponto até uma polilinha (o traçado planejado), em metros —
 * é assim que o app sabe que o motorista saiu do caminho desenhado. Projeção
 * equiretangular local: o que se compara aqui é ordem de grandeza (dezenas ou
 * centenas de metros), não medida topográfica.
 *
 * Traçado vazio devolve null — "não sei", que é diferente de "está no
 * traçado" e não pode virar desvio zero.
 */
export function distanciaAoTracadoEmMetros(ponto: GeoPonto, tracado: GeoPonto[]): number | null {
  if (tracado.length === 0) return null;
  if (tracado.length === 1) return distanciaEmMetros(ponto, tracado[0]!);

  const mPorGrauLat = 111_320;
  const mPorGrauLng = 111_320 * Math.cos(grausParaRad(ponto.lat));
  const px = ponto.lng * mPorGrauLng;
  const py = ponto.lat * mPorGrauLat;

  let menor = Infinity;
  for (let i = 1; i < tracado.length; i++) {
    const ax = tracado[i - 1]!.lng * mPorGrauLng;
    const ay = tracado[i - 1]!.lat * mPorGrauLat;
    const bx = tracado[i]!.lng * mPorGrauLng;
    const by = tracado[i]!.lat * mPorGrauLat;
    const abx = bx - ax;
    const aby = by - ay;
    const quadrado = abx * abx + aby * aby;
    // Projeta no segmento e prende em [0,1]: fora disso o mais perto é a ponta.
    const t =
      quadrado === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / quadrado));
    const d = Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
    if (d < menor) menor = d;
  }
  return menor;
}

/** Coordenada utilizável? Barra null, NaN e faixa impossível de uma vez só. */
export function validarGeoPonto(c: GeoPonto | null | undefined): GeoPonto | null {
  if (!c || typeof c.lat !== 'number' || typeof c.lng !== 'number') return null;
  if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) return null;
  if (c.lat < -90 || c.lat > 90 || c.lng < -180 || c.lng > 180) return null;
  return { lat: c.lat, lng: c.lng };
}

function grausParaRad(graus: number): number {
  return (graus * Math.PI) / 180;
}
