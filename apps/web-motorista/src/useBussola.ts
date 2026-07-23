import { useEffect, useState } from 'react';

/**
 * Bússola do aparelho via `deviceorientationabsolute` (seção 11.3) — rumo em
 * graus a partir do norte. Null quando o aparelho não expõe orientação
 * absoluta; a navegação cai no rumo derivado do deslocamento GPS.
 */
export function useBussola(): number | null {
  const [rumo, setRumo] = useState<number | null>(null);

  useEffect(() => {
    function aoOrientar(evento: DeviceOrientationEvent) {
      if (!evento.absolute || evento.alpha == null || !Number.isFinite(evento.alpha)) return;
      // alpha cresce no sentido anti-horário; rumo de bússola é o inverso.
      setRumo((360 - evento.alpha) % 360);
    }
    window.addEventListener('deviceorientationabsolute', aoOrientar as EventListener);
    return () =>
      window.removeEventListener('deviceorientationabsolute', aoOrientar as EventListener);
  }, []);

  return rumo;
}
