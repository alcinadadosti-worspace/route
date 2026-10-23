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
import { enfileirarComprovante } from './servicoFotos';

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
/**
 * Escrita recusada pelo servidor ao voltar a rede. O caso real: o escritório
 * tirou um pedido da rota (cancelado no ERP) enquanto o motorista estava sem
 * sinal, e as rules recusam o array de paradas com o tamanho antigo — a
 * confirmação voltava para "a entregar" com um `console.error` e mais nada.
 * Quem ouve (o App) avisa o motorista e pede ao servidor para conferir pelos
 * registros de entrega, que foram aceitos.
 */
export interface FalhaDeSincronizacao {
  rotaId: string;
  oQue: string;
}
const ouvintesDeFalha = new Set<(f: FalhaDeSincronizacao) => void>();
export function aoFalharSincronizacao(ouvinte: (f: FalhaDeSincronizacao) => void): () => void {
  ouvintesDeFalha.add(ouvinte);
  return () => ouvintesDeFalha.delete(ouvinte);
}
function falhou(rotaId: string, oQue: string, erro: unknown): void {
  console.error(`Falha na sincronização (${oQue})`, erro);
  for (const ouvinte of ouvintesDeFalha) ouvinte({ rotaId, oQue });
}

export function registrarResultado(
  rota: { id: string } & Rota,
  parada: ParadaRota,
  resultado: ResultadoEntrega,
  uid: string,
  comprovante: { recebidoPor?: string | null; foto?: Blob | null } = {},
): void {
  const statusPedido = resultado === 'entregue' ? 'entregue' : 'insucesso';
  const confirmadaEm = new Date().toISOString();
  const { paradas: aplicadas, statusRota } = aplicarResultadoParada(
    rota.paradas,
    parada.pedidoId,
    statusPedido,
    rota.excecoes ?? [],
  );
  const nomeRecebedor = (comprovante.recebidoPor ?? '').trim() || null;
  // O nome vai TAMBÉM para a parada: o registro de entrega é a fonte de
  // verdade, mas é o card que precisa exibi-lo e citá-lo no recibo.
  const paradas = aplicadas.map((p) =>
    p.pedidoId === parada.pedidoId
      ? { ...p, recebidoPor: nomeRecebedor, confirmadaEm }
      : p,
  );

  const batch = writeBatch(db);
  batch.update(doc(db, 'rotas', rota.id), {
    paradas,
    status: statusRota,
    concluidaEm: statusRota === 'concluida' ? confirmadaEm : null,
  });
  batch.update(doc(db, 'pedidos', parada.pedidoId), { status: statusPedido });
  batch.commit().catch((erro) => falhou(rota.id, 'confirmação', erro));
  navigator.vibrate?.(120);

  // O id sai AQUI, antes de gravar: o Firestore o gera no cliente. Isso permite
  // escrever o caminho do comprovante no próprio registro — que é imutável e não
  // aceitaria um `update` depois que a foto subisse.
  const referencia = doc(collection(db, 'entregas'));
  const comprovantePath = comprovante.foto
    ? `entregas/${referencia.id}/comprovante.jpg`
    : null;
  if (comprovante.foto) void enfileirarComprovante(referencia.id, comprovante.foto);

  void (async () => {
    const entrega: Entrega = {
      pedidoId: parada.pedidoId,
      rotaId: rota.id,
      clienteId: parada.clienteId,
      resultado,
      confirmadaEm,
      posicaoConfirmacao: await posicaoAtual(),
      gravadaPor: uid,
      recebidoPor: nomeRecebedor,
      comprovantePath,
    };
    setDoc(referencia, entrega).catch((erro) =>
      console.error('Falha na sincronização da entrega', erro),
    );
  })();
}

/**
 * Grava a chegada detectada na parada (seção 11.9). Mesma mecânica do aviso:
 * escreve o array de paradas a partir do snapshot atual, pela fila offline.
 * Idempotente por fora: quem já tem `chegouEm` não é reescrito — a PRIMEIRA
 * chegada é a que vale, senão reabrir a navegação na porta moveria o tempo.
 */
export function registrarChegada(rota: { id: string } & Rota, pedidoId: string): void {
  if (rota.paradas.find((p) => p.pedidoId === pedidoId)?.chegouEm) return;
  const paradas = rota.paradas.map((p) =>
    p.pedidoId === pedidoId ? { ...p, chegouEm: new Date().toISOString() } : p,
  );
  updateDoc(doc(db, 'rotas', rota.id), { paradas }).catch((erro) => falhou(rota.id, 'chegada', erro));
}

/**
 * Marca na parada que o RECIBO da entrega foi mandado ao cliente. Mesma
 * mecânica do aviso de chegada, e pelo mesmo motivo: `entregas` é imutável, e
 * o recibo é mandado depois de confirmar.
 */
export function registrarRecibo(rota: { id: string } & Rota, pedidoId: string): void {
  const paradas = rota.paradas.map((p) =>
    p.pedidoId === pedidoId ? { ...p, reciboEnviadoEm: new Date().toISOString() } : p,
  );
  updateDoc(doc(db, 'rotas', rota.id), { paradas }).catch((erro) => falhou(rota.id, 'recibo', erro));
}

/**
 * Marca na parada que o cliente foi avisado (seção 11.8). O WhatsApp não
 * devolve nada ao app, então este registro é o único rastro: diante de um
 * "ausente", o Admin Estoque vê se o cliente tinha sido avisado.
 *
 * Escreve o array de paradas inteiro, como a confirmação de entrega — e pelo
 * mesmo motivo é síncrono a partir do snapshot atual.
 */
export function registrarAviso(rota: { id: string } & Rota, pedidoId: string): void {
  const paradas = rota.paradas.map((p) =>
    p.pedidoId === pedidoId ? { ...p, avisadoEm: new Date().toISOString() } : p,
  );
  updateDoc(doc(db, 'rotas', rota.id), { paradas }).catch((erro) => falhou(rota.id, 'aviso', erro));
}

/**
 * Fecha a rota por decisão do motorista — não só quando a última parada é
 * confirmada. Quem sabe que o dia acabou é ele: deu a hora, o tempo fechou, a
 * estrada do povoado alagou. Paradas não resolvidas ficam como estão, e o
 * Admin Estoque vê no acompanhamento.
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

/**
 * Posição de agora, melhor esforço: null quando o GPS falha ou demora — quem
 * chama decide o que fazer sem posição. Exportada porque a guarda de distância
 * da confirmação usa a mesma leitura (com `maximumAge`, a segunda chamada sai
 * do cache do aparelho — não custa outra espera).
 */
export function posicaoAtual(): Promise<GeoPonto | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      // Leitura imprecisa é "sem posição": ela gerava o falso "você está a
      // 1,8 km do ponto" na guarda e ia para o registro de entrega, onde o
      // painel a mostra como prova ("ausente a 3 km da porta"). As rules só
      // guardam lat/lng — a precisão não teria onde ficar.
      (p) =>
        resolve(
          p.coords.accuracy <= PRECISAO_MAXIMA_CONFIRMACAO_M
            ? { lat: p.coords.latitude, lng: p.coords.longitude }
            : null,
        ),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    );
  });
}

/** Acima disto a leitura é de rede, não de satélite: não serve de prova. */
export const PRECISAO_MAXIMA_CONFIRMACAO_M = 100;
