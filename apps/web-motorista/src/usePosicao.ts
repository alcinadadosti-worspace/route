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
 * (seção 11.4) — isto funciona integralmente offline. `erro` fica preenchido
 * quando o GPS não responde (permissão negada, sinal ausente): sem isso a
 * navegação ficava muda em "— m" e o motorista não sabia o porquê.
 */
export function usePosicao(ativo: boolean): { leitura: LeituraGps | null; erro: string | null } {
  const [leitura, setLeitura] = useState<LeituraGps | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (!ativo) return;
    if (!navigator.geolocation) {
      setErro('Este aparelho não expõe localização.');
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setErro(null);
        setLeitura({
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          precisaoM: p.coords.accuracy,
          t: p.timestamp,
          rumoGps: Number.isFinite(p.coords.heading ?? NaN) ? p.coords.heading : null,
        });
      },
      (falha) =>
        setErro(
          falha.code === falha.PERMISSION_DENIED
            ? 'Localização negada — libere a permissão nas configurações.'
            : 'Sem sinal de GPS no momento.',
        ),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [ativo]);

  return { leitura, erro };
}
