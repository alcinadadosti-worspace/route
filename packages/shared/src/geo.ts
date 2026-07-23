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

/** Rumo inicial de `de` para `para` — graus a partir do norte, sentido horário. */
export function rumoEmGraus(de: GeoPonto, para: GeoPonto): number {
  const lat1 = grausParaRad(de.lat);
  const lat2 = grausParaRad(para.lat);
  const dLng = grausParaRad(para.lng - de.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function grausParaRad(graus: number): number {
  return (graus * Math.PI) / 180;
}
