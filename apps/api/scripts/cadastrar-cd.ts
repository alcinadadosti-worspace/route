import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { criarGeocodificadorGoogle } from '../src/geocodificacao/google.js';
import type { EnderecoFiscal } from '@rota/shared';

/**
 * Cadastro dos CDs de partida (seção 7.6 — doc `config/cds`, um mapa com os
 * dois centros de distribuição selecionáveis na montagem de rota).
 *
 * Uso:
 *   GOOGLE_APPLICATION_CREDENTIALS=... GOOGLE_MAPS_API_KEY=...
 *   npm run cadastrar-cd -w @rota/api -- <id> "<nome>" "<logradouro>" "<numero>" "<bairro>" "<municipio>" "<uf>" "<cep>"
 *
 * A coordenada vem da geocodificação; confira o pin e ajuste com
 * --lat/--lng manuais se necessário (últimos dois argumentos opcionais).
 */

const [id, nome, logradouro, numero, bairro, municipio, uf, cep, latManual, lngManual] =
  process.argv.slice(2);

if (!id || !nome || !logradouro || !municipio) {
  console.error(
    'Uso: cadastrar-cd <id> "<nome>" "<logradouro>" "<numero>" "<bairro>" "<municipio>" "<uf>" "<cep>" [lat] [lng]',
  );
  process.exit(1);
}

const conteudo = process.env.FIREBASE_SERVICE_ACCOUNT;
const app = initializeApp({
  credential: conteudo ? cert(JSON.parse(conteudo)) : applicationDefault(),
});
const db = getFirestore(app);

let coordenada: { lat: number; lng: number };

if (latManual && lngManual) {
  coordenada = { lat: Number(latManual), lng: Number(lngManual) };
  console.log('Usando coordenada manual.');
} else {
  const geocodificador = criarGeocodificadorGoogle();
  if (!geocodificador) {
    console.error('Defina GOOGLE_MAPS_API_KEY (ou informe lat/lng manuais).');
    process.exit(1);
  }
  const endereco: EnderecoFiscal = {
    logradouro,
    numero: numero ?? '',
    bairro: bairro ?? '',
    municipio,
    uf: uf ?? 'AL',
    cep: cep ?? '',
  };
  const resultado = await geocodificador.geocodificar(endereco);
  if (!resultado) {
    console.error('Geocodificação falhou — informe lat/lng manuais.');
    process.exit(1);
  }
  coordenada = resultado.coordenada;
  console.log(`Geocodificado (${resultado.precisa ? 'preciso' : 'IMPRECISO — confira o pin!'})`);
}

await db
  .collection('config')
  .doc('cds')
  .set(
    {
      [id]: {
        nome,
        endereco: `${logradouro}, ${numero ?? 's/n'} — ${bairro ?? ''}, ${municipio}/${uf ?? 'AL'}`,
        coordenada,
      },
    },
    { merge: true },
  );

console.log(`CD '${nome}' gravado em config/cds.${id}`);
console.log(`Coordenada: ${coordenada.lat}, ${coordenada.lng}`);
console.log(`Conferir no mapa: https://www.google.com/maps?q=${coordenada.lat},${coordenada.lng}`);
process.exit(0);
