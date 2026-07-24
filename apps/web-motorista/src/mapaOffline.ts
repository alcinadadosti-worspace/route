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
const ARQUIVO_MAPA = 'alagoas.pmtiles';
const ARQUIVO_META = 'versao.json';

/** URL de source no estilo — a chave é o nome do arquivo no OPFS. */
export const URL_FONTE_PMTILES = `pmtiles://${ARQUIVO_MAPA}`;

interface MetaInstalacao {
  versao: string;
  tamanhoBytes: number;
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

/**
 * Registra o protocolo pmtiles e aponta a fonte para o arquivo do OPFS.
 * Retorna a versão instalada, ou null quando não há mapa íntegro (aí o
 * estilo cai no basemap online).
 */
export async function ativarMapaOffline(): Promise<string | null> {
  try {
    const pasta = await pastaMapa();
    const meta = await lerMeta(pasta);
    if (!meta) return null;
    const arquivo = await (await pasta.getFileHandle(ARQUIVO_MAPA)).getFile();
    // Tamanho divergente = download interrompido de um jeito que o meta não
    // capturou (ex.: eviction do OPFS): trata como não instalado.
    if (arquivo.size !== meta.tamanhoBytes) return null;
    garantirProtocolo().add(new PMTiles(new FileSource(arquivo)));
    return meta.versao;
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
 * Baixa a versão publicada em config/geral para o OPFS. A escrita do OPFS só
 * troca o conteúdo no close: falha no meio preserva a instalação anterior.
 * O meta é gravado por último, somente com o tamanho conferido.
 */
export async function baixarMapa(
  mapa: MapaOffline,
  aoProgredir?: (fracao: number) => void,
): Promise<void> {
  const url = await getDownloadURL(ref(storage, mapa.path));
  const resposta = await fetch(url);
  if (!resposta.ok || !resposta.body) {
    throw new Error(`Download falhou (HTTP ${resposta.status})`);
  }

  const pasta = await pastaMapa();
  const escrita = await (await pasta.getFileHandle(ARQUIVO_MAPA, { create: true })).createWritable();
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
    throw erro;
  }

  const meta: MetaInstalacao = { versao: mapa.versao, tamanhoBytes: mapa.tamanhoBytes };
  const escritaMeta = await (await pasta.getFileHandle(ARQUIVO_META, { create: true })).createWritable();
  await escritaMeta.write(JSON.stringify(meta));
  await escritaMeta.close();
}
