import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';

/**
 * CORS do bucket do Storage: o fetch() do PMTiles no navegador (seção 12,
 * camada 3) precisa de CORS. Origem restrita aos dois PWAs + localhost (dev)
 * — não `*`: as fotos de local (LGPD) são lidas por URL com token de download
 * que ignora as rules; restringir a origem impede que um site de terceiro
 * leia os bytes de uma URL vazada via fetch. GET/HEAD só.
 * Rodar de novo se o bucket for recriado ou as origens mudarem.
 *
 * Uso: GOOGLE_APPLICATION_CREDENTIALS=... npm run configurar-cors -w @rota/api
 */

const ORIGENS = [
  'https://rota-motorista.onrender.com',
  'https://rota-admin.onrender.com',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:4173',
];

const app = initializeApp({
  credential: applicationDefault(),
  storageBucket: 'rota-grupo-alcina-maria.firebasestorage.app',
});
const bucket = getStorage(app).bucket();

await bucket.setMetadata({
  cors: [
    {
      origin: ORIGENS,
      method: ['GET', 'HEAD'],
      responseHeader: ['Content-Type', 'Content-Length', 'Range'],
      maxAgeSeconds: 3600,
    },
  ],
});

const [meta] = await bucket.getMetadata();
console.log('CORS aplicado:', JSON.stringify(meta.cors));
process.exit(0);
