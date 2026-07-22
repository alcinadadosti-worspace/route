import type { GeoPonto } from './tipos.js';

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
