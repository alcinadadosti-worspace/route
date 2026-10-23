import type { ParadaRota, StatusPedido, StatusRota } from './tipos.js';

/**
 * Execução da rota em campo (RF-18): aplicar o resultado de uma parada e
 * derivar o status da rota. Primeira parada resolvida → `em_execucao`;
 * todas resolvidas (entregue ou insucesso) → `concluida`.
 */
export function aplicarResultadoParada(
  paradas: ParadaRota[],
  pedidoId: string,
  resultado: 'entregue' | 'insucesso',
  excecoes: Array<{ status: StatusPedido }> = [],
): { paradas: ParadaRota[]; statusRota: Extract<StatusRota, 'em_execucao' | 'concluida'> } {
  const novas = paradas.map((p) =>
    p.pedidoId === pedidoId ? { ...p, status: resultado } : p,
  );
  // As exceções (sem ponto, baixa pelo escritório) também contam: confirmar a
  // última PARADA concluía a rota com exceções ainda no caminhão.
  const todasResolvidas = [...novas, ...excecoes].every(
    (p) => p.status === 'entregue' || p.status === 'insucesso',
  );
  return { paradas: novas, statusRota: todasResolvidas ? 'concluida' : 'em_execucao' };
}
