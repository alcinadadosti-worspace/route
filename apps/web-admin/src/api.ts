import type {
  CentroDistribuicao,
  Cliente,
  Pedido,
  PreviaRota,
  RelatorioImportacao,
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
}): Promise<PreviaRota> {
  const resposta = await fetch(`${BASE}/api/rotas/previa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entrada),
  });
  const corpo = await resposta.json();
  if (!resposta.ok) {
    const pendentes = corpo?.pendentes?.length
      ? ` — pendentes: ${corpo.pendentes.map((p: { nome: string }) => p.nome).join(', ')}`
      : '';
    throw new Error(`${corpo?.erro ?? `HTTP ${resposta.status}`}${pendentes}`);
  }
  return corpo;
}
