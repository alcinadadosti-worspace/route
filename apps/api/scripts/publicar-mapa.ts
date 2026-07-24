import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import type { MapaOffline } from '@rota/shared';

/**
 * Publica o basemap PMTiles no Storage e registra a versão em config/geral
 * (seção 12, camada 3). Roda no job mensal do GitHub Actions e também
 * localmente. O caminho no Storage é versionado (alagoas-AAAAMMDD.pmtiles):
 * um download em andamento da versão anterior nunca mistura conteúdo com a
 * nova. Arquivos antigos são removidos, preservando o anterior ainda
 * referenciado por aparelhos que não atualizaram.
 *
 * Uso:
 *   FIREBASE_SERVICE_ACCOUNT=... (ou GOOGLE_APPLICATION_CREDENTIALS=caminho.json)
 *   npm run publicar-mapa -w @rota/api -- <arquivo.pmtiles> <versao AAAAMMDD>
 */

const [arquivo, versao] = process.argv.slice(2);

if (!arquivo || !versao || !/^\d{8}$/.test(versao)) {
  console.error('Uso: publicar-mapa <arquivo.pmtiles> <versao AAAAMMDD>');
  process.exit(1);
}

const conteudo = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!conteudo && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('Defina FIREBASE_SERVICE_ACCOUNT ou GOOGLE_APPLICATION_CREDENTIALS.');
  process.exit(1);
}

const sa = conteudo ? JSON.parse(conteudo) : null;
const app = initializeApp({
  credential: sa ? cert(sa) : applicationDefault(),
  storageBucket: `${sa?.project_id ?? 'rota-grupo-alcina-maria'}.firebasestorage.app`,
});
const db = getFirestore(app);
const bucket = getStorage(app).bucket();

const destino = `mapas/alagoas-${versao}.pmtiles`;
const { size } = await stat(arquivo);
console.log(`Enviando ${basename(arquivo)} (${(size / 1e6).toFixed(1)} MB) → ${destino}…`);

await bucket.upload(arquivo, {
  destination: destino,
  resumable: true,
  metadata: { contentType: 'application/octet-stream', cacheControl: 'public, max-age=86400' },
});

const docConfig = db.collection('config').doc('geral');
const anterior = ((await docConfig.get()).data()?.mapa ?? null) as MapaOffline | null;

const mapa: MapaOffline = {
  path: destino,
  versao,
  tamanhoBytes: size,
  atualizadoEm: new Date().toISOString(),
};
await docConfig.set({ mapa }, { merge: true });
console.log(`config/geral.mapa → versão ${versao} (${destino}).`);

// Limpeza: mantém a versão nova e a imediatamente anterior (aparelhos que
// ainda não atualizaram continuam conseguindo baixar pelo path antigo).
const [arquivos] = await bucket.getFiles({ prefix: 'mapas/' });
const manter = new Set([destino, anterior?.path].filter(Boolean));
for (const f of arquivos) {
  if (!manter.has(f.name)) {
    await f.delete();
    console.log(`Removido: ${f.name}`);
  }
}

console.log('Mapa publicado ✔');
process.exit(0);
