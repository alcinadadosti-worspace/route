import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { importarXmls, type ArquivoXml } from './importacao/servico.js';
import { previaDeRota, type EntradaPrevia } from './rotas/previa.js';
import type { Repositorio } from './db/repositorio.js';
import type { Geocodificador } from './geocodificacao/google.js';
import type { ClienteOsrm } from './rotas/osrm.js';

export interface OpcoesApp {
  repo: Repositorio;
  geocodificador?: Geocodificador | null;
  osrm?: ClienteOsrm | null;
}

export async function criarApp({
  repo,
  geocodificador = null,
  osrm = null,
}: OpcoesApp): Promise<FastifyInstance> {
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

  app.get('/api/cds', async () => repo.obterCds());

  // RF-11: prévia de rota — ordem otimizada, traçado e estimativas via OSRM.
  app.post('/api/rotas/previa', async (req, reply) => {
    if (!osrm) {
      return reply.code(503).send({ erro: 'Roteirizador indisponível (OSRM_URL não configurada)' });
    }
    const resultado = await previaDeRota(req.body as EntradaPrevia, repo, osrm);
    if (!resultado.ok) {
      return reply
        .code(resultado.status)
        .send({ erro: resultado.erro, pendentes: resultado.pendentes });
    }
    return resultado.previa;
  });

  return app;
}
