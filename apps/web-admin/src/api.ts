import type {
  CentroDistribuicao,
  Cliente,
  Entrega,
  Pedido,
  PosicaoMotorista,
  PreviaRota,
  RelatorioImportacao,
  GrupoSugerido,
  RelatorioProdutividade,
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

export async function importarArquivos(arquivos: File[]): Promise<RelatorioImportacao> {
  const form = new FormData();
  for (const arquivo of arquivos) form.append('arquivos', arquivo, arquivo.name);
  const resposta = await apiFetch(`${BASE}/api/importacoes`, { method: 'POST', body: form });
  // Era a ÚNICA chamada que não passava por `erroHttp`: um 403 aparecia como
  // "Importação falhou (HTTP 403)", que não diz que o problema é a conta.
  if (!resposta.ok) throw new Error(erroHttp(resposta.status));
  return resposta.json();
}

export async function listarPedidos(): Promise<Array<{ id: string } & Pedido>> {
  const resposta = await apiFetch(`${BASE}/api/pedidos`);
  if (!resposta.ok) throw new Error(erroHttp(resposta.status));
  return resposta.json();
}

export async function listarClientes(): Promise<Array<{ id: string } & Cliente>> {
  const resposta = await apiFetch(`${BASE}/api/clientes`);
  if (!resposta.ok) throw new Error(erroHttp(resposta.status));
  return resposta.json();
}

/** RF-25: produtividade por motorista na janela pedida (calculada no servidor). */
export async function obterProdutividade(
  desde: string,
  ate: string,
): Promise<RelatorioProdutividade> {
  const resposta = await apiFetch(
    `${BASE}/api/produtividade?desde=${encodeURIComponent(desde)}&ate=${encodeURIComponent(ate)}`,
  );
  if (!resposta.ok) {
    const texto = await resposta.text();
    let erro: string | undefined;
    try {
      erro = texto ? JSON.parse(texto).erro : undefined;
    } catch {
      erro = undefined;
    }
    throw new Error(erro ?? erroHttp(resposta.status));
  }
  return resposta.json();
}

export async function listarCds(): Promise<Record<string, CentroDistribuicao>> {
  const resposta = await apiFetch(`${BASE}/api/cds`);
  if (!resposta.ok) throw new Error(erroHttp(resposta.status));
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
  if (!resposta.ok) throw new Error(erroHttp(resposta.status));
  return resposta.json();
}

export async function listarRotas(): Promise<Array<{ id: string } & Rota>> {
  const resposta = await apiFetch(`${BASE}/api/rotas`);
  if (!resposta.ok) throw new Error(erroHttp(resposta.status));
  return resposta.json();
}

/** Motivo, hora e posição de cada confirmação — o que a parada não guarda. */
export async function listarEntregasDaRota(rotaId: string): Promise<Entrega[]> {
  const resposta = await apiFetch(`${BASE}/api/rotas/${encodeURIComponent(rotaId)}/entregas`);
  if (!resposta.ok) throw new Error(erroHttp(resposta.status));
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

/** Seção 8.4: escritório escolhe qual endereço vale quando a nota traz entrega
 * em local diverso. `coordenada` é o pin ajustado no mapa (só para 'entrega'). */
export async function decidirEnderecoEntrega(
  pedidoId: string,
  escolha: 'fiscal' | 'entrega',
  coordenada?: { lat: number; lng: number } | null,
): Promise<{ status: string }> {
  return post(`${BASE}/api/pedidos/${encodeURIComponent(pedidoId)}/endereco-entrega`, {
    escolha,
    coordenada: coordenada ?? null,
  });
}

/** Seção 8.3: o cadastro mudou de endereço e o cliente já tinha ponto. 'manter'
 * mantém o ponto; 'remapear' descarta pin/trilha e reclassifica pelo novo. */
export async function decidirMudancaEndereco(
  pedidoId: string,
  escolha: 'manter' | 'remapear',
): Promise<{ status: string }> {
  return post(`${BASE}/api/pedidos/${encodeURIComponent(pedidoId)}/mudanca-endereco`, { escolha });
}

/**
 * Localiza no mapa um LOTE de endereços pendentes. A busca é paga e lenta —
 * ~1300 endereços num ciclo — então roda fora da importação, em lotes, com o
 * painel repetindo enquanto `restantes` for maior que zero.
 */
export async function localizarEnderecos(pular = 0): Promise<{
  restantes: number;
  processados: number;
  geocodificados: number;
  aproximados: number;
  semResultado: number;
}> {
  return post(`${BASE}/api/geocodificacoes`, { pular });
}

/**
 * Rota × retirada: o `modFrete` da nota sugere que a revendedora vem buscar no
 * CD, e o escritório confirma. Reversível enquanto o pedido não saiu.
 */
export async function decidirModoEntrega(
  pedidoId: string,
  escolha: 'rota' | 'retirada',
): Promise<{ status: string }> {
  return post(`${BASE}/api/pedidos/${encodeURIComponent(pedidoId)}/modo-entrega`, { escolha });
}

/**
 * Apaga uma nota. Estando numa rota publicada, a parada sai da rota junto (e a
 * rota some se era a última). Só o que já foi executado em campo é intocável.
 * O cliente e o que ele ensinou sobre o local ficam.
 */
export async function apagarPedido(pedidoId: string): Promise<{ rotaApagada: string | null }> {
  return apagar<{ rotaApagada: string | null }>(`${BASE}/api/pedidos/${encodeURIComponent(pedidoId)}`);
}

/** Desfaz uma rota publicada: os pedidos voltam a ficar disponíveis. */
export async function apagarRota(rotaId: string): Promise<void> {
  await apagar(`${BASE}/api/rotas/${encodeURIComponent(rotaId)}`);
}

async function apagar<T>(url: string): Promise<T> {
  const resposta = await apiFetch(url, { method: 'DELETE' });
  const texto = await resposta.text();
  let dados: any = null;
  try {
    dados = texto ? JSON.parse(texto) : null;
  } catch {
    dados = null;
  }
  if (!resposta.ok) throw new Error(dados?.erro ?? erroHttp(resposta.status));
  return dados as T;
}

/**
 * RF-23: descarta o ponto do cliente e reclassifica pelo endereço atual. É a
 * saída para pin marcado no lugar errado — depois de `mapeado`, o app do
 * motorista não oferece mais o ajuste. Preserva foto e observações do local.
 */
export async function refazerPontoDoCliente(clienteId: string): Promise<{ status: string }> {
  return post(`${BASE}/api/clientes/${encodeURIComponent(clienteId)}/refazer-ponto`, {});
}

async function post<T>(url: string, corpo: unknown): Promise<T> {
  const resposta = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
  // O corpo pode não ser JSON (ex.: página 502/504 HTML do gateway no cold-start
  // do Render): lê como texto e tenta parsear, sem estourar um SyntaxError cru
  // que esconderia o status HTTP real.
  const texto = await resposta.text();
  let dados: any = null;
  try {
    dados = texto ? JSON.parse(texto) : null;
  } catch {
    dados = null;
  }
  if (!resposta.ok) {
    const pendentes = dados?.pendentes?.length
      ? ` — pendentes: ${dados.pendentes.map((p: { nome: string }) => p.nome).join(', ')}`
      : '';
    throw new Error(`${dados?.erro ?? erroHttp(resposta.status)}${pendentes}`);
  }
  return dados as T;
}

/** Mensagem amigável por status — não culpa "a API caiu" num 401/403 de auth. */
function erroHttp(status: number): string {
  if (status === 401) return 'Sessão expirada — entre novamente.';
  if (status === 403) {
    return 'Sem permissão: esta conta não é de escritório. Saia e entre com a conta do escritório.';
  }
  if (status >= 500) return `Serviço indisponível (HTTP ${status}) — pode estar reiniciando.`;
  return `Falha na requisição (HTTP ${status}).`;
}

/**
 * Sugestão de regiões para montar as rotas do dia — o passo antes de otimizar
 * a ordem. Não grava nada: cada grupo é uma seleção pronta que o operador
 * aceita ou ignora.
 */
export async function agruparPorRegiao(
  cdId?: string,
): Promise<{ grupos: GrupoSugerido[]; totalProntos: number }> {
  const q = cdId ? `?cdId=${encodeURIComponent(cdId)}` : '';
  const resposta = await apiFetch(`${BASE}/api/rotas/agrupamento${q}`);
  if (!resposta.ok) throw new Error(erroHttp(resposta.status));
  return resposta.json();
}

/** Última posição dos motoristas nas rotas em execução (seção 11.4). */
export async function listarPosicoes(): Promise<Record<string, PosicaoMotorista>> {
  const resposta = await apiFetch(`${BASE}/api/posicoes`);
  if (!resposta.ok) throw new Error(erroHttp(resposta.status));
  const dados = (await resposta.json()) as { posicoes: Record<string, PosicaoMotorista> };
  return dados.posicoes ?? {};
}
