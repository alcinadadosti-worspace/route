import type {
  CentroDistribuicao,
  Cliente,
  Pedido,
  PreviaRota,
  RelatorioImportacao,
  Rota,
  Usuario,
} from '@rota/shared';
import { auth } from './firebase';

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

/**
 * fetch com o ID token do Firebase (a API exige `Authorization: Bearer` em
 * /api/*). `getIdToken()` devolve um token válido, renovando sozinho quando
 * perto de expirar — não precisamos gerir validade aqui.
 */
async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await auth.currentUser?.getIdToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

export async function importarXmls(arquivos: File[]): Promise<RelatorioImportacao> {
  const form = new FormData();
  for (const arquivo of arquivos) form.append('arquivos', arquivo, arquivo.name);
  const resposta = await apiFetch(`${BASE}/api/importacoes`, { method: 'POST', body: form });
  if (!resposta.ok) throw new Error(`Importação falhou (HTTP ${resposta.status})`);
  return resposta.json();
}

export async function listarPedidos(): Promise<Array<{ id: string } & Pedido>> {
  const resposta = await apiFetch(`${BASE}/api/pedidos`);
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
  return resposta.json();
}

export async function listarClientes(): Promise<Array<{ id: string } & Cliente>> {
  const resposta = await apiFetch(`${BASE}/api/clientes`);
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
  return resposta.json();
}

export async function listarCds(): Promise<Record<string, CentroDistribuicao>> {
  const resposta = await apiFetch(`${BASE}/api/cds`);
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
  return resposta.json();
}

export async function previaDeRota(entrada: {
  pedidoIds: string[];
  cdId: string;
  retornaAoCd: boolean;
  ordemManual?: boolean;
}): Promise<PreviaRota> {
  return post(`${BASE}/api/rotas/previa`, entrada);
}

export async function listarUsuarios(): Promise<Array<{ id: string } & Usuario>> {
  const resposta = await apiFetch(`${BASE}/api/usuarios`);
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
  return resposta.json();
}

export async function listarRotas(): Promise<Array<{ id: string } & Rota>> {
  const resposta = await apiFetch(`${BASE}/api/rotas`);
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
  return resposta.json();
}

export async function publicarRota(entrada: {
  pedidoIds: string[];
  cdId: string;
  retornaAoCd: boolean;
  motoristaId: string;
}): Promise<{ rotaId: string; rota: Rota }> {
  return post(`${BASE}/api/rotas`, entrada);
}

async function post<T>(url: string, corpo: unknown): Promise<T> {
  const resposta = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
  const dados = await resposta.json();
  if (!resposta.ok) {
    const pendentes = dados?.pendentes?.length
      ? ` — pendentes: ${dados.pendentes.map((p: { nome: string }) => p.nome).join(', ')}`
      : '';
    throw new Error(`${dados?.erro ?? `HTTP ${resposta.status}`}${pendentes}`);
  }
  return dados;
}
