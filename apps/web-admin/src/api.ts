import type {
  CentroDistribuicao,
  Cliente,
  Pedido,
  PreviaRota,
  RelatorioImportacao,
  Rota,
  Usuario,
} from '@rota/shared';

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export async function importarXmls(arquivos: File[]): Promise<RelatorioImportacao> {
  const form = new FormData();
  for (const arquivo of arquivos) form.append('arquivos', arquivo, arquivo.name);
  const resposta = await fetch(`${BASE}/api/importacoes`, { method: 'POST', body: form });
  if (!resposta.ok) throw new Error(`Importação falhou (HTTP ${resposta.status})`);
  return resposta.json();
}

export async function listarPedidos(): Promise<Array<{ id: string } & Pedido>> {
  const resposta = await fetch(`${BASE}/api/pedidos`);
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
  return resposta.json();
}

export async function listarClientes(): Promise<Array<{ id: string } & Cliente>> {
  const resposta = await fetch(`${BASE}/api/clientes`);
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
  return resposta.json();
}

export async function listarCds(): Promise<Record<string, CentroDistribuicao>> {
  const resposta = await fetch(`${BASE}/api/cds`);
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
  const resposta = await fetch(`${BASE}/api/usuarios`);
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
  return resposta.json();
}

export async function listarRotas(): Promise<Array<{ id: string } & Rota>> {
  const resposta = await fetch(`${BASE}/api/rotas`);
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
  const resposta = await fetch(url, {
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
