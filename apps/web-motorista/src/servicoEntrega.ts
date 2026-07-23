import { collection, doc, setDoc, writeBatch } from 'firebase/firestore';
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
 * com motivo), com timestamp e posição GPS. As escritas vão para a fila
 * offline do Firestore (Fluxo 5) — funcionam sem rede e sincronizam sozinhas;
 * a tela reage na hora pelo cache local.
 *
 * Rota e pedido são gravados SÍNCRONOS, antes de esperar o GPS: o documento
 * da rota carrega o array inteiro de paradas, e duas confirmações dentro da
 * janela do GPS (até 8 s) partiriam do mesmo array — a segunda desfazia a
 * primeira. Só o registro de entrega, que é um doc próprio e imutável,
 * espera a posição.
 */
export function registrarResultado(
  rota: { id: string } & Rota,
  parada: ParadaRota,
  resultado: ResultadoEntrega,
): void {
  const statusPedido = resultado === 'entregue' ? 'entregue' : 'insucesso';
  const confirmadaEm = new Date().toISOString();
  const { paradas, statusRota } = aplicarResultadoParada(
    rota.paradas,
    parada.pedidoId,
    statusPedido,
  );

  const batch = writeBatch(db);
  batch.update(doc(db, 'rotas', rota.id), {
    paradas,
    status: statusRota,
    concluidaEm: statusRota === 'concluida' ? confirmadaEm : null,
  });
  batch.update(doc(db, 'pedidos', parada.pedidoId), { status: statusPedido });
  batch.commit().catch((erro) => console.error('Falha na sincronização', erro));
  navigator.vibrate?.(120);

  void (async () => {
    const entrega: Entrega = {
      pedidoId: parada.pedidoId,
      rotaId: rota.id,
      clienteId: parada.clienteId,
      resultado,
      confirmadaEm,
      posicaoConfirmacao: await posicaoAtual(),
    };
    setDoc(doc(collection(db, 'entregas')), entrega).catch((erro) =>
      console.error('Falha na sincronização da entrega', erro),
    );
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
