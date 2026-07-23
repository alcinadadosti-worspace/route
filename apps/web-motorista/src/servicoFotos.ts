import { ref, uploadBytes } from 'firebase/storage';
import { doc, updateDoc } from 'firebase/firestore';
import { db, storage } from './firebase';

/**
 * Fotos de referência do local (RF-21) — a exceção da estratégia offline
 * (seção 12): upload ao Storage não tem fila nativa como o Firestore, então a
 * imagem espera no OPFS numa fila própria com retry, e o cliente só recebe
 * `fotoReferenciaPath` quando o upload conclui. Nome do arquivo na fila =
 * clienteId (uma foto de referência por cliente; a mais nova vence).
 */

const PASTA_FILA = 'fila-fotos';
const LADO_MAXIMO = 1280;

/** Reduz a foto da câmera (vários MB) para o tamanho de referência (~100 KB). */
export async function redimensionarFoto(arquivo: Blob): Promise<Blob> {
  const imagem = await createImageBitmap(arquivo);
  const escala = Math.min(1, LADO_MAXIMO / Math.max(imagem.width, imagem.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(imagem.width * escala);
  canvas.height = Math.round(imagem.height * escala);
  canvas.getContext('2d')!.drawImage(imagem, 0, 0, canvas.width, canvas.height);
  imagem.close();
  return await new Promise((resolver, rejeitar) =>
    canvas.toBlob(
      (blob) => (blob ? resolver(blob) : rejeitar(new Error('Falha ao gerar JPEG'))),
      'image/jpeg',
      0.75,
    ),
  );
}

export async function enfileirarFoto(clienteId: string, foto: Blob): Promise<void> {
  const pasta = await pastaFila();
  const arquivo = await pasta.getFileHandle(`${clienteId}.jpg`, { create: true });
  const escrita = await arquivo.createWritable();
  await escrita.write(foto);
  await escrita.close();
  void processarFilaFotos();
}

let processando = false;

/** Sobe o que estiver na fila — chamado ao enfileirar, ao abrir o app e ao voltar a rede. */
export async function processarFilaFotos(): Promise<void> {
  if (processando || !navigator.onLine) return;
  processando = true;
  try {
    const pasta = await pastaFila();
    for await (const item of valores(pasta)) {
      if (item.kind !== 'file' || !item.name.endsWith('.jpg')) continue;
      const clienteId = item.name.slice(0, -'.jpg'.length);
      const foto = await (item as FileSystemFileHandle).getFile();
      const caminho = `clientes/${clienteId}/referencia.jpg`;
      try {
        await uploadBytes(ref(storage, caminho), foto, { contentType: 'image/jpeg' });
        await updateDoc(doc(db, 'clientes', clienteId), { fotoReferenciaPath: caminho });
        await pasta.removeEntry(item.name);
      } catch {
        // Sem rede de verdade, Storage ainda não provisionado, etc.:
        // a foto continua na fila para a próxima tentativa.
      }
    }
  } finally {
    processando = false;
  }
}

async function pastaFila(): Promise<FileSystemDirectoryHandle> {
  const raiz = await navigator.storage.getDirectory();
  return raiz.getDirectoryHandle(PASTA_FILA, { create: true });
}

/** `FileSystemDirectoryHandle.values()` ainda não está no lib.dom do TS. */
function valores(pasta: FileSystemDirectoryHandle): AsyncIterableIterator<FileSystemHandle> {
  return (
    pasta as FileSystemDirectoryHandle & {
      values(): AsyncIterableIterator<FileSystemHandle>;
    }
  ).values();
}
