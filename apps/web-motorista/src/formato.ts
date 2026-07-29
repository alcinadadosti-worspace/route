/** Formata metros para a tela do motorista: `840 m`, `12,3 km`, `— m` sem valor. */
export function formatarDistancia(metros: number | null): string {
  if (metros == null) return '— m';
  if (metros < 1000) return `${Math.round(metros)} m`;
  return `${(metros / 1000).toFixed(1).replace('.', ',')} km`;
}
