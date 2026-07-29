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
  const dados = await postApi<{ ordem?: string[] }>(
    `/api/rotas/${encodeURIComponent(rotaId)}/ordem-sugerida`,
    { origem },
  );
  if (!Array.isArray(dados.ordem)) throw new Error('Resposta inesperada do servidor');
  return dados.ordem;
}

/**
 * Traçado novo da posição atual até a parada em curso (seção 11.6) — pedido
 * quando o app detecta que o motorista saiu do caminho desenhado. Exige rede:
 * quem sabe traçar por estrada é o OSRM, e ele mora no servidor.
 */
export async function recalcularTracado(
  rotaId: string,
  pedidoId: string,
  origem: GeoPonto,
): Promise<{ polyline: string; distanciaKm: number; duracaoMin: number }> {
  const dados = await postApi<{ polyline?: string; distanciaKm?: number; duracaoMin?: number }>(
    `/api/rotas/${encodeURIComponent(rotaId)}/rerota`,
    { origem, pedidoId },
  );
  if (typeof dados.polyline !== 'string' || !dados.polyline) {
    throw new Error('Resposta inesperada do servidor');
  }
  return {
    polyline: dados.polyline,
    distanciaKm: Number(dados.distanciaKm ?? 0),
    duracaoMin: Number(dados.duracaoMin ?? 0),
  };
}

/** POST autenticado na API, tolerante a resposta que não é JSON. */
async function postApi<T>(caminho: string, corpo: unknown): Promise<T> {
  const token = await auth.currentUser?.getIdToken();
  const resposta = await fetch(`${API}${caminho}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(corpo),
  });
  // O corpo pode não ser JSON (página 502/504 do gateway no cold start do
  // Render): lê como texto e tenta parsear, sem esconder o status real.
  const texto = await resposta.text();
  let dados: (T & { erro?: string }) | null = null;
  try {
    dados = texto ? JSON.parse(texto) : null;
  } catch {
    dados = null;
  }
  if (!resposta.ok || !dados) {
    throw new Error(dados?.erro ?? `Não deu para calcular agora (HTTP ${resposta.status})`);
  }
  return dados;
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
