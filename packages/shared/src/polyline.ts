import type { GeoPonto } from './tipos.js';

/**
 * Codifica pontos em encoded polyline (precisão 5, formato Google/OSRM) —
 * usada no pós-processamento de trilhas (seção 11.2): o trecho fora da malha
 * vira poucos KB no documento `trilhas/{trilhaId}`.
 */
export function codificarPolyline(pontos: GeoPonto[]): string {
  let saida = '';
  let latAnterior = 0;
  let lngAnterior = 0;

  for (const p of pontos) {
    const lat = Math.round(p.lat * 1e5);
    const lng = Math.round(p.lng * 1e5);
    saida += codificarDelta(lat - latAnterior) + codificarDelta(lng - lngAnterior);
    latAnterior = lat;
    lngAnterior = lng;
  }

  return saida;
}

function codificarDelta(delta: number): string {
  let valor = delta < 0 ? ~(delta << 1) : delta << 1;
  let saida = '';
  while (valor >= 0x20) {
    saida += String.fromCharCode((0x20 | (valor & 0x1f)) + 63);
    valor >>= 5;
  }
  return saida + String.fromCharCode(valor + 63);
}

/**
 * Decodifica encoded polyline (precisão 5, formato Google/OSRM) — usada para
 * desenhar traçados de rota e trilhas no MapLibre sem dependência externa.
 */
export function decodificarPolyline(codificada: string): GeoPonto[] {
  const pontos: GeoPonto[] = [];
  let indice = 0;
  let lat = 0;
  let lng = 0;

  while (indice < codificada.length) {
    lat += proximoDelta();
    lng += proximoDelta();
    pontos.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }

  function proximoDelta(): number {
    let byte = 0;
    let deslocamento = 0;
    let resultado = 0;
    do {
      byte = codificada.charCodeAt(indice++) - 63;
      resultado |= (byte & 0x1f) << deslocamento;
      deslocamento += 5;
    } while (byte >= 0x20);
    return resultado & 1 ? ~(resultado >> 1) : resultado >> 1;
  }

  return pontos;
}
