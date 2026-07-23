import { addDoc, collection, doc, updateDoc } from 'firebase/firestore';
import type { GeoPonto, PontoTrilha, TrilhaBruta } from '@rota/shared';
import { db } from './firebase';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

/**
 * Pin confirmado em campo (RF-07): a coordenada exata da entrega fica no
 * cliente, com autoria e data. Sem await — a fila offline do Firestore
 * sincroniza quando houver rede, e o cache local reflete na hora.
 */
export function confirmarPin(clienteId: string, coordenada: GeoPonto, uid: string): void {
  updateDoc(doc(db, 'clientes', clienteId), {
    coordenada,
    statusMapeamento: 'mapeado',
    mapeadoPor: uid,
    mapeadoEm: new Date().toISOString(),
  }).catch((erro) => console.error('Falha ao sincronizar pin', erro));
  navigator.vibrate?.(120);
}

/**
 * Rastro cru para a fila de sincronização (seção 11.1). O pós-processamento
 * (Douglas-Peucker + /match) acontece no backend quando o documento chega lá.
 */
export function salvarTrilhaBruta(dados: {
  clienteId: string;
  rotaId: string | null;
  uid: string;
  pontos: PontoTrilha[];
  iniciadaEm: string;
  finalizadaEm: string;
}): void {
  const bruta: TrilhaBruta = {
    clienteId: dados.clienteId,
    rotaId: dados.rotaId,
    pontos: dados.pontos,
    gravadaPor: dados.uid,
    iniciadaEm: dados.iniciadaEm,
    finalizadaEm: dados.finalizadaEm,
    status: 'pendente',
    processadaEm: null,
    motivoDescarte: null,
    trilhaGerada: null,
  };
  addDoc(collection(db, 'trilhasBrutas'), bruta)
    .then(() => dispararProcessamento())
    .catch((erro) => console.error('Falha ao sincronizar trilha', erro));
}

/**
 * Cutuca o pós-processamento na API — melhor esforço: se estiver offline
 * agora, a próxima abertura do app com rede tenta de novo (o endpoint é
 * idempotente e barato sem pendências).
 */
export function dispararProcessamento(): void {
  fetch(`${API}/api/trilhas/processar`, { method: 'POST' }).catch(() => {});
}
