import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
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
/**
 * Fila separada para o COMPROVANTE de entrega. Não dá para reusar a do dossiê:
 * lá o nome do arquivo é o clienteId e a foto mais nova substitui a anterior
 * (uma referência por local); aqui cada entrega tem a sua e nada substitui
 * nada — comprovante que se troca não prova.
 */
const PASTA_COMPROVANTES = 'fila-comprovantes';
const LADO_MAXIMO = 1280;

/**
 * Toda operação na fila entra numa cadeia única: sem ela, o `online` podia
 * disparar o upload no meio de uma escrita ainda aberta (o OPFS só troca o
 * conteúdo no close) e subir um arquivo vazio — apagando a foto real da fila.
 */
let cadeia: Promise<unknown> = Promise.resolve();
function serializar<T>(operacao: () => Promise<T>): Promise<T> {
  const proxima = cadeia.then(operacao, operacao);
  cadeia = proxima.catch(() => {});
  return proxima;
}

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

export function enfileirarFoto(clienteId: string, foto: Blob): Promise<void> {
  return serializar(async () => {
    const pasta = await pastaFila();
    const arquivo = await pasta.getFileHandle(`${clienteId}.jpg`, { create: true });
    const escrita = await arquivo.createWritable();
    await escrita.write(foto);
    await escrita.close();
  }).then(() => void processarFilaFotos());
}

/** Sobe o que estiver na fila — chamado ao enfileirar, ao abrir o app e ao voltar a rede. */
export function processarFilaFotos(): Promise<void> {
  if (!navigator.onLine) return Promise.resolve();
  return serializar(async () => {
    const pasta = await pastaFila();
    // Nomes primeiro, remoção depois: apagar entradas durante a iteração do
    // diretório não tem comportamento garantido no OPFS.
    const nomes: string[] = [];
    for await (const item of valores(pasta)) {
      if (item.kind === 'file' && item.name.endsWith('.jpg')) nomes.push(item.name);
    }
    for (const nome of nomes) {
      const clienteId = nome.slice(0, -'.jpg'.length);
      const caminho = `clientes/${clienteId}/referencia.jpg`;
      try {
        const arquivo = await pasta.getFileHandle(nome);
        const foto = await arquivo.getFile();
        await uploadBytes(ref(storage, caminho), foto, { contentType: 'image/jpeg' });
        // O ponteiro no cliente vai pela fila offline do Firestore (persistida em
        // IndexedDB, sobrevive a recarga) e NÃO é esperado aqui: `updateDoc` só
        // resolve com o ack do SERVIDOR, então perder o sinal entre o upload e o
        // ack deixaria esta promessa pendente para sempre — e, como toda a fila
        // roda numa cadeia única, travaria também as fotos seguintes, que nem
        // chegariam ao OPFS. É o mesmo padrão do pin e das observações.
        void updateDoc(doc(db, 'clientes', clienteId), { fotoReferenciaPath: caminho }).catch(
          (erro) => console.error('Falha ao apontar a foto no cliente', erro),
        );
        await pasta.removeEntry(nome);
      } catch {
        // Sem rede de verdade, Storage ainda não provisionado, etc.:
        // a foto continua na fila para a próxima tentativa.
      }
    }
  });
}

/** Enfileira o comprovante de UMA entrega. Nome do arquivo = entregaId. */
export function enfileirarComprovante(entregaId: string, foto: Blob): Promise<void> {
  return serializar(async () => {
    const dir = await pasta(PASTA_COMPROVANTES);
    const arquivo = await dir.getFileHandle(`${entregaId}.jpg`, { create: true });
    const escrita = await arquivo.createWritable();
    await escrita.write(foto);
    await escrita.close();
  }).then(() => void processarFilaComprovantes());
}

/**
 * Sobe os comprovantes pendentes. Diferente do dossiê, aqui NÃO há doc a
 * atualizar depois: o caminho já foi gravado no registro de entrega no momento
 * da confirmação (o registro é imutável). Subir o arquivo é tudo.
 */
export function processarFilaComprovantes(): Promise<void> {
  if (!navigator.onLine) return Promise.resolve();
  return serializar(async () => {
    const dir = await pasta(PASTA_COMPROVANTES);
    const nomes: string[] = [];
    for await (const item of valores(dir)) {
      if (item.kind === 'file' && item.name.endsWith('.jpg')) nomes.push(item.name);
    }
    for (const nome of nomes) {
      const entregaId = nome.slice(0, -'.jpg'.length);
      const destino = ref(storage, `entregas/${entregaId}/comprovante.jpg`);
      try {
        const arquivo = await dir.getFileHandle(nome);
        const foto = await arquivo.getFile();
        await uploadBytes(destino, foto, { contentType: 'image/jpeg' });
        await dir.removeEntry(nome);
      } catch {
        // O comprovante é imutável no Storage (`create` sim, sobrescrever não).
        // Então uma falha aqui tem dois significados opostos: ou não subiu, ou
        // JÁ subiu antes e a remoção local é que falhou. Sem distinguir, o
        // segundo caso ficaria tentando para sempre a cada abertura do app.
        try {
          await getDownloadURL(destino);
          await dir.removeEntry(nome);
        } catch {
          // Não está lá: continua na fila, que é o certo.
        }
      }
    }
  });
}

async function pastaFila(): Promise<FileSystemDirectoryHandle> {
  return pasta(PASTA_FILA);
}

async function pasta(nome: string): Promise<FileSystemDirectoryHandle> {
  const raiz = await navigator.storage.getDirectory();
  return raiz.getDirectoryHandle(nome, { create: true });
}

/** `FileSystemDirectoryHandle.values()` ainda não está no lib.dom do TS. */
function valores(pasta: FileSystemDirectoryHandle): AsyncIterableIterator<FileSystemHandle> {
  return (
    pasta as FileSystemDirectoryHandle & {
      values(): AsyncIterableIterator<FileSystemHandle>;
    }
  ).values();
}
