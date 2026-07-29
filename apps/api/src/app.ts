import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import {
  importarXmls,
  decidirEnderecoEntrega,
  decidirMudancaEndereco,
  type ArquivoXml,
} from './importacao/servico.js';
import { previaDeRota, type EntradaPrevia } from './rotas/previa.js';
import { publicarRota, type EntradaPublicacao } from './rotas/publicar.js';
import { sugerirOrdemDeParadas } from './rotas/ordem-sugerida.js';
import { processarTrilhasBrutas, type RelatorioProcessamento } from './trilhas/processar.js';
import type { Repositorio } from './db/repositorio.js';
import type { Geocodificador } from './geocodificacao/google.js';
import type { ClienteOsrm } from './rotas/osrm.js';
import type { Autenticador, UsuarioAutenticado } from './auth/autenticador.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Preenchido pelo hook de autenticação; null quando a API roda sem ela. */
    usuario: UsuarioAutenticado | null;
  }
}

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
  app.decorateRequest('usuario', null);
  if (autenticador) {
    app.addHook('onRequest', async (req, reply) => {
      if (req.method === 'OPTIONS') return;
      const rota = req.routeOptions?.url;
      if (rota && ROTAS_PUBLICAS.has(rota)) return;
      const token = extrairBearer(req.headers.authorization);
      if (!token) return reply.code(401).send({ erro: 'Autenticação necessária' });
      const usuario = await autenticador.verificar(token);
      if (!usuario) return reply.code(401).send({ erro: 'Token inválido ou expirado' });
      // Handlers que decidem por DONO (não só por papel) leem daqui.
      req.usuario = usuario;
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

  // Seção 8.4: escritório resolve a ambiguidade de endereço (entrega em local
  // diverso). Escolhe fiscal ou entrega; a escolha vira override no pedido, sem
  // tocar o cadastro do cliente. `coordenada` (opcional) é o pin ajustado no mapa.
  app.post(
    '/api/pedidos/:chave/endereco-entrega',
    { config: { papeis: ESCRITORIO } },
    async (req, reply) => {
      const { chave } = req.params as { chave: string };
      // Todo pedido tem por ID a chave de acesso (44 dígitos). Validar aqui evita
      // que uma chave malformada vire caminho inválido no Firestore (500 cru).
      if (!/^\d{44}$/.test(chave)) {
        return reply.code(404).send({ erro: 'Pedido não encontrado' });
      }
      const corpo = (req.body ?? {}) as {
        escolha?: 'fiscal' | 'entrega';
        coordenada?: { lat: number; lng: number } | null;
      };
      const resultado = await decidirEnderecoEntrega(
        repo,
        chave,
        corpo.escolha as 'fiscal' | 'entrega',
        corpo.coordenada ?? null,
      );
      if (!resultado.ok) return reply.code(resultado.status).send({ erro: resultado.erro });
      return { status: resultado.status };
    },
  );

  // Seção 8.3: o cadastro do cliente mudou de endereço e ele já tinha ponto. O
  // escritório confirma se o ponto atual sobrevive à mudança ou manda refazer —
  // 'remapear' descarta pin/trilha e reclassifica pelo endereço novo.
  app.post(
    '/api/pedidos/:chave/mudanca-endereco',
    { config: { papeis: ESCRITORIO } },
    async (req, reply) => {
      const { chave } = req.params as { chave: string };
      if (!/^\d{44}$/.test(chave)) {
        return reply.code(404).send({ erro: 'Pedido não encontrado' });
      }
      const corpo = (req.body ?? {}) as { escolha?: 'manter' | 'remapear' };
      const resultado = await decidirMudancaEndereco(
        repo,
        chave,
        corpo.escolha as 'manter' | 'remapear',
        geocodificador,
      );
      if (!resultado.ok) return reply.code(resultado.status).send({ erro: resultado.erro });
      return { status: resultado.status };
    },
  );

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

  // Ordem sugerida das paradas que faltam, a partir de onde o motorista ESTÁ
  // (o app usa como visão; a ordem publicada não muda — ver ordem-sugerida.ts).
  // Qualquer papel conhecido: quem chama é o motorista, e o handler confere que
  // a rota é dele.
  app.post('/api/rotas/:rotaId/ordem-sugerida', { config: { papeis: TODOS } }, async (req, reply) => {
    if (!osrm) {
      return reply.code(503).send({ erro: 'Roteirizador indisponível (OSRM_URL não configurada)' });
    }
    const { rotaId } = req.params as { rotaId: string };
    const corpo = (req.body ?? {}) as { origem?: { lat: number; lng: number } };
    const resultado = await sugerirOrdemDeParadas(
      { rotaId, origem: corpo.origem, uid: req.usuario?.uid ?? null },
      repo,
      osrm,
    );
    if (!resultado.ok) return reply.code(resultado.status).send({ erro: resultado.erro });
    return { ordem: resultado.ordem };
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
