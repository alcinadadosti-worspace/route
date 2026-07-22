import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { importarXmls, type ArquivoXml } from './importacao/servico.js';
import type { Repositorio } from './db/repositorio.js';
import type { Geocodificador } from './geocodificacao/google.js';

export interface OpcoesApp {
  repo: Repositorio;
  geocodificador?: Geocodificador | null;
}

export async function criarApp({ repo, geocodificador = null }: OpcoesApp): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 200 },
  });

  app.get('/health', async () => ({ ok: true, servico: 'rota-api' }));

  // RF-01: upload múltiplo de XMLs procNFe, com relatório de importação (RF-04).
  app.post('/api/importacoes', async (req, reply) => {
    const arquivos: ArquivoXml[] = [];
    for await (const parte of req.files()) {
      const buffer = await parte.toBuffer();
      arquivos.push({ nome: parte.filename, conteudo: buffer.toString('utf8') });
    }
    if (arquivos.length === 0) {
      return reply.code(400).send({ erro: 'Nenhum arquivo XML enviado' });
    }
    return importarXmls(arquivos, repo, geocodificador);
  });

  app.get('/api/pedidos', async () => repo.listarPedidos());

  app.get('/api/clientes', async () => repo.listarClientes());

  return app;
}
