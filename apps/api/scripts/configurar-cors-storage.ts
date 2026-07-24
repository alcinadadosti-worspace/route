import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';

/**
 * CORS do bucket do Storage (configuração única, aplicada em 24/07/2026):
 * o download do PMTiles (seção 12, camada 3) é um fetch() do app no
 * navegador — sem CORS o browser bloqueia. GET/HEAD abertos é inofensivo:
 * a leitura continua protegida pelas storage.rules/token de download.
 * Rodar de novo apenas se o bucket for recriado.
 *
 * Uso: GOOGLE_APPLICATION_CREDENTIALS=... npm run configurar-cors -w @rota/api
 */

const app = initializeApp({
  credential: applicationDefault(),
  storageBucket: 'rota-grupo-alcina-maria.firebasestorage.app',
});
const bucket = getStorage(app).bucket();

await bucket.setMetadata({
  cors: [
    {
      origin: ['*'],
      method: ['GET', 'HEAD'],
      responseHeader: ['Content-Type', 'Content-Length', 'Range'],
      maxAgeSeconds: 3600,
    },
  ],
});

const [meta] = await bucket.getMetadata();
console.log('CORS aplicado:', JSON.stringify(meta.cors));
process.exit(0);
