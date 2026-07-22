import { criarApp } from './app.js';
import { RepositorioMemoria } from './db/repositorio.js';
import { criarRepositorioFirestore } from './db/firestore.js';
import { criarGeocodificadorGoogle } from './geocodificacao/google.js';
import { criarClienteOsrm } from './rotas/osrm.js';

/**
 * Entrada da API (Render web service — seção 15).
 * Com credenciais do Firebase presentes, os dados vivem no Firestore;
 * sem elas (dev sem chave, CI), cai no repositório em memória.
 */
const porta = Number(process.env.PORT ?? 3000);

const firestore = criarRepositorioFirestore();
const geocodificador = criarGeocodificadorGoogle();
const osrm = criarClienteOsrm();
const app = await criarApp({ repo: firestore ?? new RepositorioMemoria(), geocodificador, osrm });
app.log.info(firestore ? 'Persistência: Firestore' : 'Persistência: memória (sem credenciais Firebase)');
app.log.info(geocodificador ? 'Geocodificação: Google' : 'Geocodificação: desativada (sem GOOGLE_MAPS_API_KEY)');
app.log.info(osrm ? 'Roteirizador: OSRM configurado' : 'Roteirizador: desativado (sem OSRM_URL)');

app.listen({ port: porta, host: '0.0.0.0' }).catch((erro) => {
  app.log.error(erro);
  process.exit(1);
});
