import { FileSource, PMTiles, Protocol } from 'pmtiles';
import { addProtocol } from 'maplibre-gl';
import { getDownloadURL, ref } from 'firebase/storage';
import type { MapaOffline } from '@rota/shared';
import { storage } from './firebase';

/**
 * Basemap embarcado (seção 12, camada 3): o PMTiles de Alagoas mora no OPFS
 * e o MapLibre lê dele por acesso aleatório (FileSource → slice), sem rede.
 * O download vem do Storage, apenas por decisão explícita do motorista na
 * base (egress é custo — seção 17); a versão instalada fica num meta-arquivo
 * gravado por último, então instalação sem meta íntegro não existe.
 */

const PASTA_MAPA = 'mapa';
const PREFIXO_MAPA = 'alagoas-';
const SUFIXO_MAPA = '.pmtiles';
const ARQUIVO_META = 'versao.json';

/**
 * O arquivo do OPFS é versionado (`alagoas-AAAAMMDD.pmtiles`): a atualização
 * baixa para um nome novo sem tocar no anterior, e só o meta-arquivo (escrita
 * atômica) promove a versão corrente. Assim uma atualização interrompida
 * nunca destrói o mapa que já funcionava. A chave da fonte no MapLibre é o
 * nome do arquivo, então ela também muda por versão.
 */
function nomeArquivo(versao: string): string {
  return `${PREFIXO_MAPA}${versao}${SUFIXO_MAPA}`;
}
export function urlFonte(versao: string): string {
  return `pmtiles://${nomeArquivo(versao)}`;
}

interface MetaInstalacao {
  versao: string;
  tamanhoBytes: number;
}

/** Rejeita config corrompida (tamanho ausente/zero/NaN) antes de virar NaN na UI. */
function tamanhoValido(bytes: unknown): bytes is number {
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0;
}
export function mapaConfigValido(mapa: MapaOffline | undefined | null): mapa is MapaOffline {
  return (
    mapa != null &&
    typeof mapa.versao === 'string' &&
    mapa.versao.length > 0 &&
    typeof mapa.path === 'string' &&
    tamanhoValido(mapa.tamanhoBytes)
  );
}

let protocolo: Protocol | null = null;
function garantirProtocolo(): Protocol {
  if (!protocolo) {
    const instancia = new Protocol();
    protocolo = instancia;
    addProtocol('pmtiles', instancia.tile);
  }
  return protocolo;
}

async function pastaMapa(): Promise<FileSystemDirectoryHandle> {
  const raiz = await navigator.storage.getDirectory();
  return raiz.getDirectoryHandle(PASTA_MAPA, { create: true });
}

async function lerMeta(pasta: FileSystemDirectoryHandle): Promise<MetaInstalacao | null> {
  try {
    const arquivo = await (await pasta.getFileHandle(ARQUIVO_META)).getFile();
    const meta = JSON.parse(await arquivo.text()) as MetaInstalacao;
    return typeof meta.versao === 'string' && typeof meta.tamanhoBytes === 'number' ? meta : null;
  } catch {
    return null;
  }
}

/** Versão instalada + a URL de fonte a usar no estilo. */
export interface MapaInstalado {
  versao: string;
  urlFonte: string;
}

/**
 * Registra o protocolo pmtiles e aponta a fonte para o arquivo corrente do
 * OPFS (o que o meta indica). Retorna a versão instalada + a URL da fonte, ou
 * null quando não há mapa íntegro (aí o estilo cai no basemap online).
 */
export async function ativarMapaOffline(): Promise<MapaInstalado | null> {
  try {
    const pasta = await pastaMapa();
    const meta = await lerMeta(pasta);
    if (!meta) return null;
    const arquivo = await (await pasta.getFileHandle(nomeArquivo(meta.versao))).getFile();
    // Tamanho divergente = download interrompido de um jeito que o meta não
    // capturou (ex.: eviction do OPFS): trata como não instalado.
    if (arquivo.size !== meta.tamanhoBytes) return null;
    garantirProtocolo().add(new PMTiles(new FileSource(arquivo)));
    return { versao: meta.versao, urlFonte: urlFonte(meta.versao) };
  } catch {
    return null;
  }
}

/**
 * Rede atual para a decisão de download (seção 12: "apenas em Wi-Fi").
 * Navegadores sem a Network Information API retornam 'desconhecida' — a UI
 * pede confirmação em vez de bloquear.
 */
export function tipoDeRede(): 'wifi' | 'celular' | 'desconhecida' {
  const conexao = (navigator as { connection?: { type?: string } }).connection;
  const tipo = conexao?.type;
  if (tipo === 'wifi' || tipo === 'ethernet') return 'wifi';
  if (tipo == null || tipo === 'unknown') return 'desconhecida';
  return 'celular';
}

/**
 * Baixa a versão publicada em config/geral para o OPFS, num arquivo com o
 * nome da nova versão. A instalação anterior (arquivo antigo + meta antigo)
 * fica intacta o tempo todo; só a escrita atômica do meta, ao final, promove
 * a nova versão. Interromper o download (crash, aba fechada, quota) nunca
 * perde o mapa que já funcionava — reverte à versão anterior.
 */
export async function baixarMapa(
  mapa: MapaOffline,
  aoProgredir?: (fracao: number) => void,
): Promise<void> {
  if (!tamanhoValido(mapa.tamanhoBytes)) {
    throw new Error('Configuração do mapa sem tamanho válido');
  }
  const url = await getDownloadURL(ref(storage, mapa.path));
  const resposta = await fetch(url);
  if (!resposta.ok || !resposta.body) {
    throw new Error(`Download falhou (HTTP ${resposta.status})`);
  }

  const pasta = await pastaMapa();
  // Limpa restos de tentativas anteriores (outras versões), preservando a que
  // está instalada agora — ela ainda pode estar sendo lida pelo mapa montado.
  const metaAtual = await lerMeta(pasta);
  await removerArquivosExceto(pasta, metaAtual ? nomeArquivo(metaAtual.versao) : null);

  const nomeNovo = nomeArquivo(mapa.versao);
  const escrita = await (await pasta.getFileHandle(nomeNovo, { create: true })).createWritable();
  const leitor = resposta.body.getReader();
  let recebido = 0;
  try {
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      await escrita.write(value);
      recebido += value.byteLength;
      aoProgredir?.(Math.min(1, recebido / mapa.tamanhoBytes));
    }
    if (recebido !== mapa.tamanhoBytes) {
      throw new Error(`Download incompleto (${recebido} de ${mapa.tamanhoBytes} bytes)`);
    }
    await escrita.close();
  } catch (erro) {
    await escrita.abort().catch(() => {});
    await pasta.removeEntry(nomeNovo).catch(() => {});
    throw erro;
  }

  // Commit: a partir daqui o meta aponta para a nova versão. O arquivo antigo
  // vira órfão (deixa de ser lido quando o mapa reativa) e é removido na
  // próxima chamada de download.
  const meta: MetaInstalacao = { versao: mapa.versao, tamanhoBytes: mapa.tamanhoBytes };
  const escritaMeta = await (await pasta.getFileHandle(ARQUIVO_META, { create: true })).createWritable();
  await escritaMeta.write(JSON.stringify(meta));
  await escritaMeta.close();
}

/** Remove todo `alagoas-*.pmtiles` do OPFS exceto `preservar` (nome ou null). */
async function removerArquivosExceto(
  pasta: FileSystemDirectoryHandle,
  preservar: string | null,
): Promise<void> {
  const remover: string[] = [];
  for await (const item of valores(pasta)) {
    if (
      item.kind === 'file' &&
      item.name.startsWith(PREFIXO_MAPA) &&
      item.name.endsWith(SUFIXO_MAPA) &&
      item.name !== preservar
    ) {
      remover.push(item.name);
    }
  }
  for (const nome of remover) {
    await pasta.removeEntry(nome).catch(() => {});
  }
}

/** `FileSystemDirectoryHandle.values()` ainda não está no lib.dom do TS. */
function valores(pasta: FileSystemDirectoryHandle): AsyncIterableIterator<FileSystemHandle> {
  return (
    pasta as FileSystemDirectoryHandle & {
      values(): AsyncIterableIterator<FileSystemHandle>;
    }
  ).values();
}
