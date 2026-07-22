import { criarApp } from './app.js';
import { RepositorioMemoria } from './db/repositorio.js';

/**
 * Entrada da API (Render web service — seção 15).
 * Fase 0/1: persistência em memória. A troca para Firestore (Admin SDK) acontece
 * quando o projeto Firebase estiver provisionado — basta implementar Repositorio.
 */
const porta = Number(process.env.PORT ?? 3000);

const app = await criarApp({ repo: new RepositorioMemoria() });

app.listen({ port: porta, host: '0.0.0.0' }).catch((erro) => {
  app.log.error(erro);
  process.exit(1);
});
