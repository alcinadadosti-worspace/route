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
  /** Aviso do começo do dia. `{janela}` vira "entre 10h20 e 11h20". */
  textoRota: string;
  /** Aviso de aproximação. `{quando}` vira "em uns 10 minutos". */
  textoChegando: string;
}

export const PARAMETROS_AVISO_PADRAO: ParametrosAviso = {
  minutosPorParada: 10,
  margemBaseMin: 20,
  margemPorParadaMin: 6,
  textoRota:
    'Olá! Aqui é da entrega do Grupo Alcina Maria. Saí para a rota e devo chegar aí {janela}. ' +
    'Tem alguém no local para receber?',
  textoChegando: 'Estou chegando com a sua entrega {quando}.',
};

/**
 * Mescla os overrides de `config/geral.aviso`: número só entra se for finito e
 * positivo; texto só entra se não for vazio. Assim o escritório ajusta a
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
  for (const chave of ['textoRota', 'textoChegando'] as const) {
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
