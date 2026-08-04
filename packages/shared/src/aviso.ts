/**
 * Aviso ao cliente pelo WhatsApp (seção 11.8): o insucesso mais caro da
 * operação rural é o "ausente" — a revendedora não estava em casa e a viagem
 * inteira se perde. Avisar com antecedência ataca isso direto.
 *
 * A mensagem é montada aqui, como função pura, e ENTREGUE pelo link `wa.me`
 * que abre o WhatsApp do próprio motorista. Não há servidor no meio, então não
 * há custo — e o dia em que valer a pena migrar para a API oficial da Meta
 * (envio automático, sem toque), só troca quem entrega: o texto continua sendo
 * este.
 */

import type { ItemPedido } from './tipos.js';

export interface ParametrosAviso {
  /** Tempo parado em cada cliente, que empurra as paradas seguintes. */
  minutosPorParada: number;
  /** Largura mínima da janela prometida. */
  margemBaseMin: number;
  /**
   * Quanto a janela ALARGA por parada de distância. A estimativa piora ao
   * longo do dia — prometer 10h20 para a décima parada e chegar meio-dia é
   * pior do que não ter avisado.
   */
  margemPorParadaMin: number;
  /**
   * Aviso do começo do dia. O padrão NÃO promete horário — a estimativa fura ao
   * longo do dia e a promessa quebrada vira cobrança. Quem quiser de volta põe
   * `{janela}` no texto pela `config/geral.aviso`, e vira "entre 10h20 e 11h20".
   */
  textoRota: string;
  /** Aviso de aproximação. `{quando}` vira "em uns 10 minutos". */
  textoChegando: string;
  /**
   * Recibo mandado DEPOIS de confirmar. `{hora}` vira "14h05"; `{quem}` vira
   * quem recebeu (ou some, sem nome anotado); `{referencia}` vira o bloco
   * "Pedido 506203606 · Nota 280683"; `{itens}` vira a lista "· 3x PRODUTO…".
   * Blocos sem dado somem inteiros — placeholder nunca vaza para o cliente.
   */
  textoRecibo: string;
}

export const PARAMETROS_AVISO_PADRAO: ParametrosAviso = {
  minutosPorParada: 10,
  margemBaseMin: 20,
  margemPorParadaMin: 6,
  // SEM horário de propósito (decisão da operação em 03/08/2026). A janela é
  // uma estimativa que piora ao longo do dia: prometer "entre 16h40 e 18h" e
  // chegar às 19h20 gera a cobrança que o aviso queria evitar. O que o aviso
  // precisa é de UMA resposta — "tem alguém aí?" —, e isso não depende de hora.
  // O `{janela}` continua funcionando para quem quiser de volta pela
  // `config/geral.aviso`, sem deploy.
  textoRota:
    'Olá! Aqui é da entrega do Grupo Alcina Maria. Saí para a rota e passo aí hoje. ' +
    'Tem alguém no local para receber?',
  textoChegando: 'Estou chegando com a sua entrega {quando}.',
  textoRecibo: 'Entrega registrada às {hora}{quem}.{referencia}{itens}\n\nGrupo Alcina Maria.',
};

/**
 * Mescla os overrides de `config/geral.aviso`: número só entra se for finito e
 * positivo; texto só entra se não for vazio. Assim o Admin Estoque ajusta a
 * redação e o ritmo da operação sem deploy, e uma config torta não vira
 * mensagem em branco no WhatsApp do cliente.
 */
export function mesclarParametrosAviso(override?: Partial<ParametrosAviso>): ParametrosAviso {
  const parametros = { ...PARAMETROS_AVISO_PADRAO };
  if (!override) return parametros;
  for (const chave of ['minutosPorParada', 'margemBaseMin', 'margemPorParadaMin'] as const) {
    const valor = override[chave];
    if (typeof valor === 'number' && Number.isFinite(valor) && valor > 0) parametros[chave] = valor;
  }
  for (const chave of ['textoRota', 'textoChegando', 'textoRecibo'] as const) {
    const valor = override[chave];
    if (typeof valor === 'string' && valor.trim()) parametros[chave] = valor;
  }
  return parametros;
}

/** Janela de chegada, em minutos a partir de agora. */
export interface JanelaChegada {
  deMin: number;
  ateMin: number;
}

/**
 * `etaMin` é o acumulado de DIRIGIR desde o CD (calculado na publicação); ele
 * ignora o tempo parado em cada cliente, que é justamente o que faz a promessa
 * furar no fim do dia. Aqui isso entra de volta, e a margem cresce junto.
 */
export function janelaDeChegada(
  etaMin: number,
  paradasAntes: number,
  parametros: ParametrosAviso,
): JanelaChegada {
  const centro = etaMin + paradasAntes * parametros.minutosPorParada;
  const margem = parametros.margemBaseMin + paradasAntes * parametros.margemPorParadaMin;
  return { deMin: Math.max(0, centro - margem), ateMin: centro + margem };
}

/**
 * "entre 10h20 e 11h20". Arredonda para 10 minutos — para baixo no início e
 * para cima no fim — porque hora quebrada em promessa soa a precisão que a
 * estimativa não tem.
 */
export function formatarJanela(agora: Date, janela: JanelaChegada): string {
  const de = arredondar(new Date(agora.getTime() + janela.deMin * 60_000), 'baixo');
  const ate = arredondar(new Date(agora.getTime() + janela.ateMin * 60_000), 'cima');
  return `entre ${hora(de)} e ${hora(ate)}`;
}

export function mensagemDeRota(
  agora: Date,
  etaMin: number,
  paradasAntes: number,
  parametros: ParametrosAviso,
): string {
  const janela = formatarJanela(agora, janelaDeChegada(etaMin, paradasAntes, parametros));
  return parametros.textoRota.replaceAll('{janela}', janela);
}

/** `minutosRestantes` nulo quando não há estimativa de estrada (sem sinal). */
export function mensagemDeChegada(
  minutosRestantes: number | null,
  parametros: ParametrosAviso,
): string {
  // ARREDONDA ANTES de decidir o texto. Com 1,4 min o teste `<= 1` não pegava e
  // a mensagem saía "em uns 1 minutos" — no WhatsApp do cliente, em português
  // torto. É o número exibido que tem de mandar na escolha da frase.
  const minutos = minutosRestantes == null ? null : Math.round(minutosRestantes);
  const quando =
    minutos == null ? 'em instantes' : minutos <= 1 ? 'agora' : `em uns ${minutos} minutos`;
  return parametros.textoChegando.replaceAll('{quando}', quando);
}

/** O que o recibo diz da nota — tudo opcional, porque rota antiga não carrega. */
export interface NotaDoRecibo {
  numeroPedido?: string | null;
  numeroNota?: number | null;
  itens?: ItemPedido[];
  /**
   * Quantidade de produtos quando não há LISTA — é o caso do pedido importado
   * pela planilha do ERP, que manda o total e não o detalhe. Sem isto o recibo
   * simplesmente omitia os itens, e a revendedora recebia um comprovante que
   * não diz quanta coisa chegou.
   */
  quantidadeMateriais?: number | null;
}

/**
 * Teto do bloco de itens no recibo, em caracteres. Medido nas 3507 notas
 * reais: p50 da mensagem inteira dá ~390 chars, p99 ~1140, máximo 2690 — só 16
 * notas passam de 1500. O teto de 1300 no BLOCO deixa a lista completa em
 * >99% dos casos e corta com "… e mais N itens" só nas extremas, porque o
 * wa.me carrega a mensagem inteira na URL e URL gigante falha calado.
 */
const TETO_BLOCO_ITENS = 1300;

/**
 * Recibo da entrega, mandado ao cliente pelo WhatsApp logo depois de confirmar.
 *
 * É o que dá força ao comprovante: o registro nasce no aparelho do motorista,
 * mas a CÓPIA fica no celular do cliente, com data, fora do nosso alcance.
 * O WhatsApp entrega quando ele pegar sinal — não exige que esteja online na
 * hora, o que importa numa base em que 1 em cada 5 endereços é rural.
 *
 * Com os dados da nota, vira recibo de verdade: número do pedido (o que a
 * revendedora digitou no ERP — é por ele que ela confere), número da nota e a
 * lista do que foi entregue. Sem nome anotado, a frase não inventa um: some o
 * trecho inteiro em vez de dizer "recebida por " e deixar o vazio no ar. O
 * mesmo vale para os blocos — sem dado, somem.
 */
export function mensagemDeRecibo(
  confirmadaEm: Date,
  recebidoPor: string | null,
  parametros: ParametrosAviso,
  nota: NotaDoRecibo = {},
): string {
  const nome = (recebidoPor ?? '').trim();

  /**
   * Uma LINHA ROTULADA por número, em negrito do WhatsApp (`*texto*`).
   *
   * A primeira versão era `Pedido 123 · Nota 456` numa linha só — e usava o
   * MESMO `·` que marca cada item. A linha se disfarçava de item e o número
   * passava despercebido (aconteceu na primeira leitura de quem pediu o
   * recurso). Rótulo explícito, negrito e um marcador diferente na lista
   * resolvem: são três sinais, não um.
   */
  const referencias: string[] = [];
  if (nota.numeroPedido) referencias.push(`*Pedido:* ${nota.numeroPedido}`);
  if (nota.numeroNota) referencias.push(`*Nota fiscal:* ${nota.numeroNota}`);
  const blocoReferencia = referencias.length > 0 ? `\n\n${referencias.join('\n')}` : '';

  const itens = nota.itens ?? [];
  const linhas: string[] = [];
  let usados = 0;
  // O corte é um SUFIXO: estourou o teto, para ali. A primeira versão fazia
  // `continue` — pulava o item comprido e seguia incluindo os curtos de
  // depois, e o "e mais N" mentia sobre QUAIS ficaram de fora.
  for (const item of itens) {
    const quantidade = Number.isFinite(item.quantidade) ? Math.round(item.quantidade) : 0;
    const linha = `• ${quantidade}x ${item.descricao}`;
    if (usados + linha.length > TETO_BLOCO_ITENS) break;
    linhas.push(linha);
    usados += linha.length + 1;
  }
  const cortados = itens.length - linhas.length;
  if (cortados > 0) linhas.push(`• … e mais ${cortados} item(ns)`);
  // Cabeçalho próprio: sem ele a lista começava colada na referência e as duas
  // viravam um bloco só de olho.
  //
  // Sem LISTA mas com quantidade (pedido vindo da planilha do ERP, que manda o
  // total e não o detalhe), diz o total: um comprovante que não fala da
  // mercadoria não serve de comprovante.
  const quantidade = nota.quantidadeMateriais;
  const blocoItens =
    linhas.length > 0
      ? `\n\n*Itens entregues:*\n${linhas.join('\n')}`
      : Number.isFinite(quantidade) && (quantidade as number) > 0
        ? `\n\n*Itens entregues:* ${quantidade} produto(s)`
        : '';

  return parametros.textoRecibo
    .replaceAll('{hora}', hora(confirmadaEm))
    .replaceAll('{quem}', nome ? `, recebida por ${nome}` : '')
    .replaceAll('{referencia}', blocoReferencia)
    .replaceAll('{itens}', blocoItens);
}

function arredondar(data: Date, direcao: 'baixo' | 'cima'): Date {
  const passo = 10;
  const minutos = data.getMinutes();
  const alvo =
    direcao === 'baixo' ? Math.floor(minutos / passo) * passo : Math.ceil(minutos / passo) * passo;
  const saida = new Date(data);
  saida.setMinutes(alvo, 0, 0);
  return saida;
}

function hora(data: Date): string {
  return `${data.getHours()}h${String(data.getMinutes()).padStart(2, '0')}`;
}
