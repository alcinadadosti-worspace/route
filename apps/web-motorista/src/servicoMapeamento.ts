import { addDoc, collection, doc, updateDoc } from 'firebase/firestore';
import type { GeoPonto, PontoTrilha, TrilhaBruta } from '@rota/shared';
import { auth, db } from './firebase';

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
 * Ordem sugerida das paradas que faltam, calculada por ESTRADA a partir de
 * onde o motorista está (a ordem publicada parte do CD). Exige rede e acorda o
 * OSRM — por isso é um botão, não algo automático. A resposta é só uma
 * sugestão de exibição: nada na rota é alterado.
 */
export async function ordemSugerida(rotaId: string, origem: GeoPonto): Promise<string[]> {
  const token = await auth.currentUser?.getIdToken();
  const resposta = await fetch(`${API}/api/rotas/${encodeURIComponent(rotaId)}/ordem-sugerida`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ origem }),
  });
  // Corpo pode não ser JSON (502/504 do gateway no cold start do Render).
  const texto = await resposta.text();
  let dados: { ordem?: string[]; erro?: string } | null = null;
  try {
    dados = texto ? JSON.parse(texto) : null;
  } catch {
    dados = null;
  }
  if (!resposta.ok || !Array.isArray(dados?.ordem)) {
    throw new Error(dados?.erro ?? `Não deu para calcular agora (HTTP ${resposta.status})`);
  }
  return dados.ordem;
}

/**
 * Cutuca o pós-processamento na API — melhor esforço: se estiver offline
 * agora, a próxima abertura do app com rede tenta de novo (o endpoint é
 * idempotente e barato sem pendências). Vai com o ID token do Firebase, que
 * a API exige; sem usuário logado, simplesmente não dispara.
 */
export function dispararProcessamento(): void {
  void (async () => {
    const token = await auth.currentUser?.getIdToken().catch(() => null);
    if (!token) return;
    fetch(`${API}/api/trilhas/processar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  })();
}
