import {
  distanciaEmMetros,
  PARAMETROS_TRILHA_PADRAO,
  type PontoTrilha,
} from '@rota/shared';
import type { LeituraGps } from './usePosicao';

/**
 * Gravação de trilha em campo (RF-08, seção 11.1): acumula leituras do GPS
 * aplicando só os dois filtros baratos — descarte por precisão e distância
 * mínima entre pontos. Todo o resto (simplificação, /match) é do backend:
 * celular intermediário não é lugar de algoritmo pesado.
 */
export class GravadorTrilha {
  /** ~60 km a 12 m/ponto — mantém o doc de trilha bruta longe do 1 MiB do Firestore. */
  private static readonly MAXIMO_DE_PONTOS = 5000;

  private pontos: PontoTrilha[] = [];
  readonly iniciadaEm = new Date().toISOString();

  /** Aplica os filtros da seção 11.1; retorna true se a leitura foi gravada. */
  registrar(leitura: LeituraGps): boolean {
    if (this.pontos.length >= GravadorTrilha.MAXIMO_DE_PONTOS) return false;
    if (leitura.precisaoM > PARAMETROS_TRILHA_PADRAO.precisaoMaximaM) return false;
    const anterior = this.pontos[this.pontos.length - 1];
    if (anterior && distanciaEmMetros(anterior, leitura) < PARAMETROS_TRILHA_PADRAO.distanciaMinimaM) {
      return false;
    }
    this.pontos.push({
      lat: leitura.lat,
      lng: leitura.lng,
      precisaoM: Math.round(leitura.precisaoM * 10) / 10,
      t: leitura.t,
    });
    return true;
  }

  get quantidade(): number {
    return this.pontos.length;
  }

  finalizar(): { pontos: PontoTrilha[]; iniciadaEm: string; finalizadaEm: string } {
    return {
      pontos: this.pontos,
      iniciadaEm: this.iniciadaEm,
      finalizadaEm: new Date().toISOString(),
    };
  }
}
