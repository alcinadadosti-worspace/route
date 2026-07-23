import { useEffect, useState } from 'react';

export interface LeituraGps {
  lat: number;
  lng: number;
  precisaoM: number;
  /** Epoch ms da leitura. */
  t: number;
  /** Rumo reportado pelo GPS (graus a partir do norte) — null parado. */
  rumoGps: number | null;
}

/**
 * Posição contínua durante a navegação (RF-17): `watchPosition` com alta
 * precisão enquanto `ativo`. O receptor GNSS não depende de internet
 * (seção 11.4) — isto funciona integralmente offline.
 */
export function usePosicao(ativo: boolean): LeituraGps | null {
  const [leitura, setLeitura] = useState<LeituraGps | null>(null);

  useEffect(() => {
    if (!ativo || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (p) =>
        setLeitura({
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          precisaoM: p.coords.accuracy,
          t: p.timestamp,
          rumoGps: Number.isFinite(p.coords.heading ?? NaN) ? p.coords.heading : null,
        }),
      () => {},
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [ativo]);

  return leitura;
}
