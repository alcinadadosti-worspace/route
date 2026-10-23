import { criarApp } from './app.js';
import { RepositorioMemoria } from './db/repositorio.js';
import { criarRepositorioFirestore } from './db/firestore.js';
import { criarGeocodificadorGoogle } from './geocodificacao/google.js';
import { criarClienteOsrm } from './rotas/osrm.js';
import { criarAutenticador } from './auth/autenticador.js';
import { origemDoPepper } from './pepper.js';

/**
 * Entrada da API (Render web service — seção 15).
 * Com credenciais do Firebase presentes, os dados vivem no Firestore;
 * sem elas (dev sem chave, CI), cai no repositório em memória.
 */
const porta = Number(process.env.PORT ?? 3000);

// Uma promessa rejeitada que ninguém esperou ENCERRA o Node — numa instância
// só, isso é a API fora do ar para todos, motorista na estrada incluído, até o
// Render subir de novo (~1 min). Registra e segue: o erro já é um bug a
// corrigir, não um motivo para derrubar o resto.
process.on('unhandledRejection', (erro) => {
  console.error('Promessa rejeitada sem tratamento (a API segue no ar):', erro);
});

const firestore = criarRepositorioFirestore();
const geocodificador = criarGeocodificadorGoogle();
const osrm = criarClienteOsrm();
const autenticador = criarAutenticador();
const app = await criarApp({
  repo: firestore ?? new RepositorioMemoria(),
  geocodificador,
  osrm,
  autenticador,
});
app.log.info(firestore ? 'Persistência: Firestore' : 'Persistência: memória (sem credenciais Firebase)');
app.log.info(geocodificador ? 'Geocodificação: Google' : 'Geocodificação: desativada (sem GOOGLE_MAPS_API_KEY)');
app.log.info(osrm ? 'Roteirizador: OSRM configurado' : 'Roteirizador: desativado (sem OSRM_URL)');
app.log.warn(
  autenticador
    ? 'Auth: exigindo ID token do Firebase em /api/*'
    : 'Auth: DESATIVADA (sem credenciais) — /api/* aberto, use só em dev',
);
const origemPepper = origemDoPepper();
app.log.warn(
  origemPepper === 'explicito'
    ? 'CPF: clienteId com pepper explícito (HMAC) — id não reversível'
    : origemPepper === 'derivado'
      ? 'CPF: clienteId com pepper derivado do service account (HMAC) — id não reversível'
      : 'CPF: SEM pepper (sem credenciais) — clienteId é SHA-256 reversível; use só em dev',
);

app.listen({ port: porta, host: '0.0.0.0' }).catch((erro) => {
  app.log.error(erro);
  process.exit(1);
});
