import type { PontoTrilha } from '@rota/shared';

/**
 * Douglas-Peucker com tolerância em metros (seção 11.2, passo 1): reduz o
 * rastro bruto sem deformar o caminho antes do `/match`. A projeção
 * equiretangular local basta — nos poucos km de uma trilha o erro é
 * centimétrico, bem abaixo da tolerância de 10 m.
 *
 * `espacamentoMaximoM` impede o efeito colateral do DP no `/match`: uma reta
 * de 5 km viraria só 2 pontos, e com raio de busca de ~25 m o OSRM não casa
 * pontos tão esparsos nem em estrada mapeada — o rastro inteiro viraria
 * "trilha" falsa. Pontos intermediários a cada ≤100 m mantêm o casamento.
 */
export function simplificarTrilha(
  pontos: PontoTrilha[],
  toleranciaM = 10,
  espacamentoMaximoM = 100,
): PontoTrilha[] {
  if (pontos.length <= 2) return [...pontos];

  const latMediaRad = (pontos[0]!.lat * Math.PI) / 180;
  const mPorGrauLat = 111_320;
  const mPorGrauLng = 111_320 * Math.cos(latMediaRad);
  const x = (p: PontoTrilha) => p.lng * mPorGrauLng;
  const y = (p: PontoTrilha) => p.lat * mPorGrauLat;

  const manter = new Array<boolean>(pontos.length).fill(false);
  manter[0] = manter[pontos.length - 1] = true;

  const pilha: Array<[number, number]> = [[0, pontos.length - 1]];
  while (pilha.length > 0) {
    const [inicio, fim] = pilha.pop()!;
    let maiorDistancia = 0;
    let indiceMaior = -1;

    for (let i = inicio + 1; i < fim; i++) {
      const d = distanciaAoSegmento(
        x(pontos[i]!),
        y(pontos[i]!),
        x(pontos[inicio]!),
        y(pontos[inicio]!),
        x(pontos[fim]!),
        y(pontos[fim]!),
      );
      if (d > maiorDistancia) {
        maiorDistancia = d;
        indiceMaior = i;
      }
    }

    if (maiorDistancia > toleranciaM && indiceMaior > 0) {
      manter[indiceMaior] = true;
      pilha.push([inicio, indiceMaior], [indiceMaior, fim]);
    }
  }

  let ultimoMantido = 0;
  for (let i = 1; i < pontos.length - 1; i++) {
    if (manter[i]) {
      ultimoMantido = i;
      continue;
    }
    const dx = x(pontos[i]!) - x(pontos[ultimoMantido]!);
    const dy = y(pontos[i]!) - y(pontos[ultimoMantido]!);
    if (Math.hypot(dx, dy) >= espacamentoMaximoM) {
      manter[i] = true;
      ultimoMantido = i;
    }
  }

  return pontos.filter((_, i) => manter[i]);
}

function distanciaAoSegmento(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const quadrado = abx * abx + aby * aby;
  const t = quadrado === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / quadrado));
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  return Math.hypot(px - cx, py - cy);
}
