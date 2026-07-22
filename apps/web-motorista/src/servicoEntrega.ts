import { collection, doc, writeBatch } from 'firebase/firestore';
import {
  aplicarResultadoParada,
  type Entrega,
  type GeoPonto,
  type ParadaRota,
  type ResultadoEntrega,
  type Rota,
} from '@rota/shared';
import { db } from './firebase';

/**
 * Confirmação em campo (RF-18): um toque registra a entrega (ou o insucesso
 * com motivo), com timestamp e posição GPS. As três escritas vão num batch
 * para a fila offline do Firestore (Fluxo 5) — funciona sem rede e
 * sincroniza sozinho; a tela reage na hora pelo cache local.
 */
export function registrarResultado(
  rota: { id: string } & Rota,
  parada: ParadaRota,
  resultado: ResultadoEntrega,
): void {
  void (async () => {
    const posicao = await posicaoAtual();
    const statusPedido = resultado === 'entregue' ? 'entregue' : 'insucesso';
    const { paradas, statusRota } = aplicarResultadoParada(
      rota.paradas,
      parada.pedidoId,
      statusPedido,
    );

    const entrega: Entrega = {
      pedidoId: parada.pedidoId,
      rotaId: rota.id,
      clienteId: parada.clienteId,
      resultado,
      confirmadaEm: new Date().toISOString(),
      posicaoConfirmacao: posicao,
    };

    const batch = writeBatch(db);
    batch.set(doc(collection(db, 'entregas')), entrega);
    batch.update(doc(db, 'rotas', rota.id), {
      paradas,
      status: statusRota,
      concluidaEm: statusRota === 'concluida' ? new Date().toISOString() : null,
    });
    batch.update(doc(db, 'pedidos', parada.pedidoId), { status: statusPedido });

    // Sem await do servidor: o cache local aplica na hora e a fila sincroniza
    // quando houver rede — é exatamente o comportamento offline desejado.
    batch.commit().catch((erro) => console.error('Falha na sincronização', erro));
    navigator.vibrate?.(120);
  })();
}

function posicaoAtual(): Promise<GeoPonto | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    );
  });
}
