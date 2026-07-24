import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { importarXmls, type ArquivoXml } from './importacao/servico.js';
import { previaDeRota, type EntradaPrevia } from './rotas/previa.js';
import { publicarRota, type EntradaPublicacao } from './rotas/publicar.js';
import { processarTrilhasBrutas, type RelatorioProcessamento } from './trilhas/processar.js';
import type { Repositorio } from './db/repositorio.js';
import type { Geocodificador } from './geocodificacao/google.js';
import type { ClienteOsrm } from './rotas/osrm.js';
import type { Autenticador } from './auth/autenticador.js';

export interface OpcoesApp {
  repo: Repositorio;
  geocodificador?: Geocodificador | null;
  osrm?: ClienteOsrm | null;
  /** Verificador de ID token. Ausente = API aberta (dev/CI sem credenciais). */
  autenticador?: Autenticador | null;
}

/** Papel exigido por rota (custom claim). Ausente = qualquer usuário logado. */
interface ConfigRota {
  papeis?: string[];
}
const ESCRITORIO = ['admin', 'operador'];
const TODOS = ['admin', 'operador', 'motorista'];
/** Rotas públicas (sem token). O resto é deny-by-default. */
const ROTAS_PUBLICAS = new Set(['/health']);

function extrairBearer(cabecalho: string | undefined): string | null {
  if (!cabecalho) return null;
  const [tipo, valor] = cabecalho.split(' ');
  return tipo === 'Bearer' && valor ? valor : null;
}

export async function criarApp({
  repo,
  geocodificador = null,
  osrm = null,
  autenticador = null,
}: OpcoesApp): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(multipart, {
    // Uma remessa de importação é dezenas de notas, não centenas; teto menor
    // reduz o pico de memória de um upload malicioso na instância pequena.
    limits: { fileSize: 5 * 1024 * 1024, files: 60 },
  });

  // Autenticação (seção 13): verifica o ID token do Firebase. Deny-by-default
  // — só as ROTAS_PUBLICAS dispensam token; todo o resto exige. A decisão é
  // pela ROTA CASADA (`routeOptions.url`, já normalizada pelo find-my-way), e
  // NÃO por `req.url` cru: um alvo em forma absoluta (`GET http://host/api/x`,
  // válido em HTTP/1.1) deixa `req.url` sem começar por `/api/` e furaria um
  // gate por prefixo, embora case o handler — seria bypass total da auth.
  // OPTIONS passa (preflight CORS não leva Authorization). Sem autenticador a
  // API segue aberta — só em dev/CI sem credenciais, avisado no log da subida.
  if (autenticador) {
    app.addHook('onRequest', async (req, reply) => {
      if (req.method === 'OPTIONS') return;
      const rota = req.routeOptions?.url;
      if (rota && ROTAS_PUBLICAS.has(rota)) return;
      const token = extrairBearer(req.headers.authorization);
      if (!token) return reply.code(401).send({ erro: 'Autenticação necessária' });
      const usuario = await autenticador.verificar(token);
      if (!usuario) return reply.code(401).send({ erro: 'Token inválido ou expirado' });
      const papeis = (req.routeOptions?.config as ConfigRota | undefined)?.papeis;
      if (papeis && !papeis.includes(usuario.papel)) {
        return reply.code(403).send({ erro: 'Sem permissão para esta operação' });
      }
    });
  }

  app.get('/health', async () => ({ ok: true, servico: 'rota-api' }));

  // RF-01: upload múltiplo de XMLs procNFe, com relatório de importação (RF-04).
  // Streaming: lê e parseia uma nota por vez (pico de memória ~1 arquivo, não
  // a remessa toda), passando um gerador para o serviço.
  app.post('/api/importacoes', { config: { papeis: ESCRITORIO } }, async (req, reply) => {
    async function* lerArquivos(): AsyncIterable<ArquivoXml> {
      for await (const parte of req.files()) {
        const buffer = await parte.toBuffer();
        yield { nome: parte.filename, conteudo: buffer.toString('utf8') };
      }
    }
    const relatorio = await importarXmls(lerArquivos(), repo, geocodificador);
    if (relatorio.total === 0) {
      return reply.code(400).send({ erro: 'Nenhum arquivo XML enviado' });
    }
    return relatorio;
  });

  app.get('/api/pedidos', { config: { papeis: ESCRITORIO } }, async () => repo.listarPedidos());

  app.get('/api/clientes', { config: { papeis: ESCRITORIO } }, async () => repo.listarClientes());

  app.get('/api/cds', { config: { papeis: ESCRITORIO } }, async () => repo.obterCds());

  app.get('/api/usuarios', { config: { papeis: ESCRITORIO } }, async () => repo.listarUsuarios());

  app.get('/api/rotas', { config: { papeis: ESCRITORIO } }, async () => repo.listarRotas());

  // RF-13: publicação da rota na ordem final, movendo os pedidos para em_rota.
  app.post('/api/rotas', { config: { papeis: ESCRITORIO } }, async (req, reply) => {
    if (!osrm) {
      return reply.code(503).send({ erro: 'Roteirizador indisponível (OSRM_URL não configurada)' });
    }
    const resultado = await publicarRota(req.body as EntradaPublicacao, repo, osrm);
    if (!resultado.ok) {
      return reply
        .code(resultado.status)
        .send({ erro: resultado.erro, pendentes: resultado.pendentes });
    }
    return { rotaId: resultado.rotaId, rota: resultado.rota };
  });

  app.get('/api/trilhas', { config: { papeis: ESCRITORIO } }, async () => repo.listarTrilhas());

  // RF-08 (seção 11.2): pós-processa as trilhas brutas que o campo sincronizou.
  // Idempotente e barato quando não há pendências — o app do motorista chama
  // ao religar a rede e o painel pode chamar quando quiser.
  //
  // Chamadas simultâneas compartilham a MESMA execução: o evento `online` do
  // app e o `.then` do sync da bruta disparam juntos, e duas execuções
  // concorrentes processariam a mesma bruta duas vezes (duas trilhas ativas
  // para o mesmo cliente). Vale para uma instância — o plano atual do Render.
  // Qualquer usuário PROVISIONADO (o motorista dispara ao religar a rede).
  // Exige um papel conhecido — barra token sem papel (ex.: conta de signup
  // avulso, caso o projeto Firebase permita), que não deveria existir.
  let processamentoEmAndamento: Promise<RelatorioProcessamento> | null = null;
  app.post('/api/trilhas/processar', { config: { papeis: TODOS } }, async (req, reply) => {
    if (!osrm) {
      return reply.code(503).send({ erro: 'Roteirizador indisponível (OSRM_URL não configurada)' });
    }
    processamentoEmAndamento ??= processarTrilhasBrutas(repo, osrm).finally(() => {
      processamentoEmAndamento = null;
    });
    return processamentoEmAndamento;
  });

  // RF-11: prévia de rota — ordem otimizada, traçado e estimativas via OSRM.
  app.post('/api/rotas/previa', { config: { papeis: ESCRITORIO } }, async (req, reply) => {
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
