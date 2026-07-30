import { collection, doc, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
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
  uid: string,
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
      gravadaPor: uid,
    };
    setDoc(doc(collection(db, 'entregas')), entrega).catch((erro) =>
      console.error('Falha na sincronização da entrega', erro),
    );
  })();
}

/**
 * Marca na parada que o cliente foi avisado (seção 11.8). O WhatsApp não
 * devolve nada ao app, então este registro é o único rastro: diante de um
 * "ausente", o escritório vê se o cliente tinha sido avisado.
 *
 * Escreve o array de paradas inteiro, como a confirmação de entrega — e pelo
 * mesmo motivo é síncrono a partir do snapshot atual.
 */
export function registrarAviso(rota: { id: string } & Rota, pedidoId: string): void {
  const paradas = rota.paradas.map((p) =>
    p.pedidoId === pedidoId ? { ...p, avisadoEm: new Date().toISOString() } : p,
  );
  updateDoc(doc(db, 'rotas', rota.id), { paradas }).catch((erro) =>
    console.error('Falha ao registrar o aviso', erro),
  );
}

/**
 * Fecha a rota por decisão do motorista — não só quando a última parada é
 * confirmada. Quem sabe que o dia acabou é ele: deu a hora, o tempo fechou, a
 * estrada do povoado alagou. Paradas não resolvidas ficam como estão, e o
 * escritório vê no acompanhamento.
 *
 * Vai pela fila offline como o resto: fechar a rota sem sinal, no fim da linha,
 * é o caso NORMAL aqui, não a exceção.
 */
export function fecharRota(rotaId: string): void {
  updateDoc(doc(db, 'rotas', rotaId), {
    status: 'concluida',
    concluidaEm: new Date().toISOString(),
  }).catch((erro) => console.error('Falha ao fechar a rota', erro));
}

/**
 * Desfaz o fechamento. Existe porque a alternativa é um beco: fechada por
 * engano com paradas por entregar, o motorista não teria como voltar a
 * entregá-las — e as regras já permitem `em_execucao`.
 */
export function reabrirRota(rotaId: string): void {
  updateDoc(doc(db, 'rotas', rotaId), { status: 'em_execucao', concluidaEm: null }).catch((erro) =>
    console.error('Falha ao reabrir a rota', erro),
  );
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
