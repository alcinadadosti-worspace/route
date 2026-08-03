import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import {
  importarXmls,
  decidirEnderecoEntrega,
  decidirModoEntrega,
  decidirMudancaEndereco,
  refazerPontoDoCliente,
  mesclarRelatorios,
  type ArquivoXml,
} from './importacao/servico.js';
import { importarPlanilha } from './importacao/servico-planilha.js';
import { localizarEnderecos } from './importacao/geocodificacao-lote.js';
import { removerPedido, removerRota } from './rotas/remover.js';
import { agruparPorRegiao } from '@rota/shared';
import { FORMATO_ROTA_ID } from './rotas/comum.js';
import { calcularProdutividade } from './produtividade.js';
import { previaDeRota, type EntradaPrevia } from './rotas/previa.js';
import { publicarRota, type EntradaPublicacao } from './rotas/publicar.js';
import { sugerirOrdemDeParadas } from './rotas/ordem-sugerida.js';
import { recalcularTracado } from './rotas/rerota.js';
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
    // O teto de 60 nasceu da premissa "uma remessa é dezenas de notas" — e a
    // realidade a derrubou: o lote diário do ERP é ~125 notas e o escritório
    // importa até um CICLO inteiro de uma vez (2046 arquivos, medido). Com
    // streaming o pico de memória é ~1 arquivo independente da contagem, então
    // o teto protege contra abuso, não contra a remessa real: 4000 cobre um
    // ciclo com folga e continua sendo um limite.
    // `parts` TAMBÉM, e maior que files: o default do plugin é 1000 partes e
    // ele conta arquivos + campos — sem isto, um ciclo de 2046 arquivos parava
    // em 1000 mesmo com `files` folgado (pego por teste, não por sorte).
    limits: { fileSize: 5 * 1024 * 1024, files: 4000, parts: 4200 },
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
    // Erro NO MEIO do stream (limite de arquivos/tamanho estourado): como a
    // importação é streaming, o que veio antes JÁ FOI GRAVADO. Deixar o erro
    // virar 500 esconderia a importação parcial — o operador não saberia que
    // metade entrou. O erro vira uma linha no relatório, e reenviar a remessa
    // inteira é seguro (dedupe pela chave de acesso).
    let erroDeStream: string | null = null;
    // A planilha do ERP (xlsx) entra pela MESMA porta dos XMLs: o operador
    // solta o que tiver. Os XMLs seguem em streaming; a planilha e bufferizada
    // (e UM arquivo de poucos MB) e processada depois que o stream termina.
    const planilhas: Array<{ nome: string; conteudo: Buffer }> = [];
    async function* lerArquivos(): AsyncIterable<ArquivoXml> {
      try {
        for await (const parte of req.files()) {
          const buffer = await parte.toBuffer();
          if (parte.filename.toLowerCase().endsWith('.xlsx')) {
            planilhas.push({ nome: parte.filename, conteudo: buffer });
            continue;
          }
          yield { nome: parte.filename, conteudo: buffer.toString('utf8') };
        }
      } catch (e) {
        erroDeStream = e instanceof Error ? e.message : 'falha na leitura do upload';
      }
    }
    const relatorio = await importarXmls(lerArquivos(), repo, geocodificador);
    for (const planilha of planilhas) {
      mesclarRelatorios(
        relatorio,
        await importarPlanilha(planilha.nome, planilha.conteudo, repo),
      );
    }
    if (relatorio.total === 0) {
      return reply
        .code(400)
        .send({ erro: erroDeStream ?? 'Nenhum arquivo XML enviado' });
    }
    if (erroDeStream) {
      relatorio.rejeitados.push({
        arquivo: '(remessa interrompida)',
        motivo: `Upload interrompido (${erroDeStream}) — o que aparece acima FOI importado; reenvie a remessa completa, os repetidos são ignorados.`,
      });
    }
    return relatorio;
  });

  // Localiza no mapa os endereços que a importação deixou pendentes. É passo
  // SEPARADO porque a busca é paga e lenta: com ~1300 endereços novos por
  // ciclo, fazer isso dentro da importação estourava o tempo da requisição (o
  // navegador reportava como erro de CORS). O painel chama em lotes e mostra
  // progresso; `restantes` diz quando parar.
  app.post('/api/geocodificacoes', { config: { papeis: ESCRITORIO } }, async (req) => {
    // `pular` acumula as FALHAS das chamadas anteriores: endereço que a Google
    // não localiza continua sem coordenada e voltaria à frente da fila. Sem
    // saltar, o painel repetiria o mesmo lote para sempre — pagando por ele.
    const corpo = (req.body ?? {}) as { pular?: number };
    const pular = Number.isFinite(corpo.pular) ? Number(corpo.pular) : 0;
    return localizarEnderecos(repo, geocodificador, { pular });
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
      if (!/^(\d{9}|\d{44})$/.test(chave)) {
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
      if (!/^(\d{9}|\d{44})$/.test(chave)) {
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

  // Rota × retirada: metade das notas do dia não sai no caminhão porque a
  // revendedora vem buscar no CD. O `modFrete` da nota sugere, o escritório
  // decide, e a escolha é reversível enquanto o pedido não saiu.
  app.post(
    '/api/pedidos/:chave/modo-entrega',
    { config: { papeis: ESCRITORIO } },
    async (req, reply) => {
      const { chave } = req.params as { chave: string };
      if (!/^(\d{9}|\d{44})$/.test(chave)) {
        return reply.code(404).send({ erro: 'Pedido não encontrado' });
      }
      const corpo = (req.body ?? {}) as { escolha?: 'rota' | 'retirada' };
      const resultado = await decidirModoEntrega(
        repo,
        chave,
        corpo.escolha as 'rota' | 'retirada',
      );
      if (!resultado.ok) return reply.code(resultado.status).send({ erro: resultado.erro });
      return { status: resultado.status };
    },
  );

  // Apagar nota. Se ela estiver numa rota publicada, a parada sai da rota
  // junto; só o que já foi executado em campo é intocável (ver remover.ts).
  app.delete('/api/pedidos/:chave', { config: { papeis: ESCRITORIO } }, async (req, reply) => {
    const { chave } = req.params as { chave: string };
    if (!/^(\d{9}|\d{44})$/.test(chave)) {
      return reply.code(404).send({ erro: 'Pedido não encontrado' });
    }
    const resultado = await removerPedido(repo, chave);
    if (!resultado.ok) return reply.code(resultado.status).send({ erro: resultado.erro });
    return { apagado: chave, rotaApagada: resultado.rotaApagada ?? null };
  });

  // Desfazer uma rota publicada: os pedidos voltam a ficar disponíveis e a rota
  // desaparece do celular do motorista.
  app.delete('/api/rotas/:rotaId', { config: { papeis: ESCRITORIO } }, async (req, reply) => {
    const { rotaId } = req.params as { rotaId: string };
    const resultado = await removerRota(repo, rotaId);
    if (!resultado.ok) return reply.code(resultado.status).send({ erro: resultado.erro });
    return { apagada: rotaId };
  });

  app.get('/api/clientes', { config: { papeis: ESCRITORIO } }, async () => repo.listarClientes());

  // RF-23: descarta o ponto do cliente e reclassifica pelo endereço atual.
  // Fecha o beco sem saída do pin errado — uma vez `mapeado`, o app do
  // motorista não oferece mais o ajuste (ver refazerPontoDoCliente).
  app.post(
    '/api/clientes/:clienteId/refazer-ponto',
    { config: { papeis: ESCRITORIO } },
    async (req, reply) => {
      const { clienteId } = req.params as { clienteId: string };
      // O clienteId é hash hex de 64 e vira caminho de documento: validar aqui
      // fecha a injeção de caminho, como no rotaId e na chave do pedido.
      if (!/^[0-9a-f]{64}$/.test(clienteId)) {
        return reply.code(404).send({ erro: 'Cliente não encontrado' });
      }
      const resultado = await refazerPontoDoCliente(repo, clienteId, geocodificador);
      if (!resultado.ok) return reply.code(resultado.status).send({ erro: resultado.erro });
      return { status: resultado.status };
    },
  );

  app.get('/api/cds', { config: { papeis: ESCRITORIO } }, async () => repo.obterCds());

  app.get('/api/usuarios', { config: { papeis: ESCRITORIO } }, async () => repo.listarUsuarios());

  app.get('/api/rotas', { config: { papeis: ESCRITORIO } }, async () => repo.listarRotas());

  /**
   * Última posição dos motoristas nas rotas em execução (seção 11.4). Endpoint
   * próprio, e não embutido em `/api/rotas`: o painel busca isto de tempos em
   * tempos enquanto acompanha o dia, e a lista de rotas é pesada (carrega o
   * array inteiro de paradas de cada uma).
   */
  app.get('/api/posicoes', { config: { papeis: ESCRITORIO } }, async () => {
    // Consulta filtrada, e não `listarRotas()` inteiro: o painel bate aqui a
    // cada 20 s enquanto acompanha o dia — ler a coleção de rotas a cada volta
    // esgotaria a cota diária sozinha.
    const emExecucao = await repo.idsDeRotasEmExecucao();
    return { posicoes: await repo.posicoesDasRotas(emExecucao) };
  });

  // O que a parada NÃO guarda: por que falhou, a que horas e de onde o motorista
  // confirmou. Isso vive só no registro de entrega, e sem este endpoint o
  // escritório via "insucesso" sem motivo — nada com que ligar para o cliente.
  app.get('/api/rotas/:rotaId/entregas', { config: { papeis: ESCRITORIO } }, async (req, reply) => {
    const { rotaId } = req.params as { rotaId: string };
    // O rotaId vira consulta e, em outros caminhos, caminho de documento: valida
    // antes, como na remoção de rota.
    if (!FORMATO_ROTA_ID.test(rotaId)) return reply.code(400).send({ erro: 'rotaId inválido' });
    return repo.listarEntregasDaRota(rotaId);
  });

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

  // Traçado novo da posição atual até a parada em curso (seção 11.6): o app
  // detecta o desvio sozinho (geometria, offline) e pede isto quando há sinal.
  // O destino vem do servidor — o corpo manda só onde o motorista está.
  app.post('/api/rotas/:rotaId/rerota', { config: { papeis: TODOS } }, async (req, reply) => {
    if (!osrm) {
      return reply.code(503).send({ erro: 'Roteirizador indisponível (OSRM_URL não configurada)' });
    }
    const { rotaId } = req.params as { rotaId: string };
    const corpo = (req.body ?? {}) as { origem?: { lat: number; lng: number }; pedidoId?: string };
    const resultado = await recalcularTracado(
      { rotaId, pedidoId: corpo.pedidoId ?? '', origem: corpo.origem, uid: req.usuario?.uid ?? null },
      repo,
      osrm,
    );
    if (!resultado.ok) return reply.code(resultado.status).send({ erro: resultado.erro });
    return resultado;
  });

  // RF-25: produtividade por motorista na janela pedida. Calculado aqui e não
  // no painel: os registros de entrega carregam posição GPS, e somar no
  // navegador exigiria despejar tudo isso no browser sem necessidade.
  app.get('/api/produtividade', { config: { papeis: ESCRITORIO } }, async (req, reply) => {
    const { desde, ate } = req.query as { desde?: string; ate?: string };
    const [rotas, entregas, clientes, trilhas] = await Promise.all([
      repo.listarRotas(),
      repo.listarEntregas(),
      repo.listarClientes(),
      repo.listarTrilhas(),
    ]);
    const resultado = calcularProdutividade(
      { desde: desde ?? '', ate: ate ?? '' },
      { rotas, entregas, clientes, trilhas },
    );
    if (!resultado.ok) return reply.code(resultado.status).send({ erro: resultado.erro });
    return resultado.relatorio;
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
  /**
   * Sugestão de agrupamento geográfico dos pedidos prontos de um CD — o passo
   * ANTES de otimizar a ordem. O `/trip` responde "em que ordem visitar estes
   * N"; alguém precisa escolher QUAIS são os N, e no olho isso só funciona com
   * meia dúzia de pedidos. Não grava nada: devolve grupos, e o operador
   * seleciona o que quiser montar.
   */
  app.get('/api/rotas/agrupamento', { config: { papeis: ESCRITORIO } }, async (req) => {
    const { cdId, maximoPorRota, minimoPorRota } = req.query as {
      cdId?: string;
      maximoPorRota?: string;
      minimoPorRota?: string;
    };
    const [pedidos, clientes, cds] = await Promise.all([
      repo.listarPedidos(),
      repo.listarClientes(),
      repo.obterCds(),
    ]);
    const porCliente = new Map(clientes.map((c) => [c.id, c]));
    const pontos = [];
    for (const pedido of pedidos) {
      if (pedido.status !== 'pronto_para_rota') continue;
      // Pedido de outro CD não entra: misturar galpões numa rota é erro de
      // seleção que a montagem já barra — sugerir isso seria oferecer o erro.
      if (cdId && pedido.cdId && pedido.cdId !== cdId) continue;
      const cliente = porCliente.get(pedido.clienteId);
      // Override de entrega (8.4) manda sobre o cadastro, como na coleta.
      const coordenada =
        pedido.usarEnderecoEntrega === true
          ? (pedido.coordenadaEntrega ?? null)
          : (cliente?.coordenada ?? null);
      const municipio =
        pedido.usarEnderecoEntrega === true && pedido.enderecoEntrega
          ? pedido.enderecoEntrega.municipio
          : (cliente?.enderecoFiscal.municipio ?? '');
      if (!coordenada) continue;
      pontos.push({ id: pedido.id, coordenada, municipio });
    }

    const origem = cdId ? (cds[cdId]?.coordenada ?? null) : null;
    const grupos = agruparPorRegiao(pontos, {
      origem,
      maximoPorRota: Number(maximoPorRota) || undefined,
      minimoPorRota: Number(minimoPorRota) || undefined,
    });
    return { grupos, totalProntos: pontos.length };
  });

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
