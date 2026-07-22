import type { Cliente, Pedido, RelatorioImportacao } from '@rota/shared';

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
