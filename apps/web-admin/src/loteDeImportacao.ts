import type { ClienteACompletar, RelatorioImportacao } from '@rota/shared';

/**
 * O LOTE da tela de Importação: tudo o que foi enviado desde "começar outra
 * rota". Uma rota do Boticário às vezes vem em mais de um romaneio, mandados
 * um de cada vez; cada envio substituía o relatório do anterior (e os
 * formulários de completar dados dele), e o Admin perdia de vista o que já
 * tinha entrado antes de localizar e montar.
 */
export interface Envio {
  /** Hora do envio, ISO. */
  quando: string;
  arquivos: string[];
  /** O que a lista mostra quando não é arquivo (o pedido digitado à mão). */
  descricao?: string;
  relatorio: RelatorioImportacao;
}

const SOMAVEIS = [
  'total',
  'importados',
  'duplicados',
  'prontosParaRota',
  'pendentesDeMapeamento',
  'pendentesDeDecisao',
  'geocodificados',
  'aproximados',
  'semCarga',
] as const;

const OPCIONAIS = [
  'retiradaAConfirmar',
  'retiradas',
  'canceladas',
  'canceladasApagadas',
  'jaEntregues',
  'romaneios',
  'digitados',
  'semCadastro',
  'revendedoras',
  'clientesAtualizados',
] as const;

/**
 * Avisos que a tela do lote refaz por conta própria: "Endereços a localizar"
 * é o ESTADO da fila, e o botão Localizar já mostra o total (o aviso do último
 * envio dizia "2 sem ponto" ao lado do botão com 11); "Fora da base" a tela
 * recalcula com o lote inteiro.
 */
const REFEITOS_NA_TELA = new Set(['Endereços a localizar', 'Fora da base de revendedoras']);

/** O relatório do lote inteiro, somando os envios na ordem. */
export function somarEnvios(envios: Envio[]): RelatorioImportacao | null {
  if (envios.length === 0) return null;
  const soma: RelatorioImportacao = {
    total: 0,
    importados: 0,
    duplicados: 0,
    rejeitados: [],
    prontosParaRota: 0,
    pendentesDeMapeamento: 0,
    pendentesDeDecisao: 0,
    geocodificados: 0,
    aproximados: 0,
    alertas: [],
    porCd: {},
    semCarga: 0,
  };
  const aCompletar = new Map<string, ClienteACompletar>();
  const folhas = new Map<string, NonNullable<RelatorioImportacao['folhas']>[number]>();
  for (const { relatorio: r } of envios) {
    for (const campo of SOMAVEIS) soma[campo] += r[campo] ?? 0;
    for (const campo of OPCIONAIS) {
      if (r[campo] !== undefined) soma[campo] = (soma[campo] ?? 0) + (r[campo] ?? 0);
    }
    soma.rejeitados.push(...(r.rejeitados ?? []));
    for (const [cd, n] of Object.entries(r.porCd ?? {})) soma.porCd[cd] = (soma.porCd[cd] ?? 0) + n;
    // A mesma folha mandada duas vezes (o "+" com o arquivo de antes) conta
    // UMA: o cabeçalho dizia "2 romaneios" e o Admin achava que tinha mandado
    // os dois da rota. Vale a versão mais nova, no lugar da primeira.
    for (const f of r.folhas ?? []) folhas.set(f.rota, f);
    // O mais recente de cada cliente (pode ter sido completado num envio e
    // voltado noutro), na posição em que apareceu primeiro.
    for (const c of r.clientesACompletar ?? []) aCompletar.set(c.id, c);
    for (const a of r.alertas ?? []) {
      if (REFEITOS_NA_TELA.has(a.nome)) continue;
      soma.alertas.push(a);
    }
  }
  if (folhas.size > 0) {
    soma.folhas = [...folhas.values()];
    soma.romaneios = folhas.size;
  }
  if (aCompletar.size > 0) soma.clientesACompletar = [...aCompletar.values()];
  return soma;
}

/**
 * Dos clientes que o lote pede para completar, os que já foram resolvidos FORA
 * desta tela (aba Clientes, outro computador): o servidor diz quem ainda
 * espera, e quem não está na resposta sai da lista.
 */
export function resolvidosFora(
  aCompletar: ClienteACompletar[],
  aindaEsperam: string[],
  completados: Record<string, string>,
): string[] {
  const esperam = new Set(aindaEsperam);
  return aCompletar.filter((c) => !(c.id in completados) && !esperam.has(c.id)).map((c) => c.id);
}

/** O que a lista do lote mostra de cada envio. */
export function descricaoDoEnvio(envio: Envio): string[] {
  if (envio.descricao) return [envio.descricao];
  const folhas = envio.relatorio.folhas ?? [];
  if (folhas.length > 0) {
    return folhas.map((f) => `Rota ${f.rota} · ${f.motorista || 'sem motorista'} · ${f.pacotes} pacote(s)`);
  }
  return envio.arquivos.length > 0 ? envio.arquivos : ['(sem arquivo)'];
}

/**
 * A linha de cima do cartão do lote. Romaneio conta folhas e pacotes (para
 * conferir com o papel); o digitado conta à parte; planilha e XML, que não
 * têm folha, contam os envios — "Romaneios: 0" com pedidos na tela confundia.
 */
export function cabecalhoDoLote(relatorio: RelatorioImportacao | null, envios: number): string {
  const folhas = relatorio?.folhas ?? [];
  const digitados = relatorio?.digitados ?? 0;
  const partes: string[] = [];
  if (folhas.length > 0) {
    const pacotes = folhas.reduce((soma, f) => soma + f.pacotes, 0);
    partes.push(`Romaneios desta rota: ${relatorio?.romaneios ?? folhas.length}`, `${pacotes} pacote(s)`);
    if (digitados > 0) partes.push(`${digitados} digitado(s)`);
  } else if (digitados > 0) {
    partes.push(`Pedidos digitados: ${digitados}`);
  } else {
    partes.push(`Envios: ${envios}`);
  }
  partes.push(`${relatorio?.importados ?? 0} pedido(s) novo(s)`);
  return partes.join(' · ');
}

/**
 * O que o formulário diz depois de salvar um pedido digitado. Entrou também
 * diz PARA ONDE foi — pronto, à espera do Localizar, ou em Decisões — porque
 * o Admin não vê o relatório ali, só esta frase. Repetido não entra no lote.
 */
export function mensagemDoDigitado(r: RelatorioImportacao, pedido: string): { entrou: boolean; texto: string } {
  if (r.importados > 0) {
    if (r.pendentesDeDecisao > 0) {
      return {
        entrou: true,
        texto: `Pedido ${pedido} entrou, mas espera decisão: o endereço mudou e a cliente já tinha ponto no mapa — veja a aba Decisões.`,
      };
    }
    const onde =
      r.prontosParaRota > 0
        ? 'pronto para a rota'
        : 'falta o ponto no mapa (use Localizar endereços, ou o motorista mapeia em campo)';
    const fora = (r.semCadastro ?? 0) > 0 ? ' A destinatária não está na base: complete o telefone logo abaixo.' : '';
    return { entrou: true, texto: `Pedido ${pedido} entrou — ${onde}.${fora} Digite o próximo, ou feche.` };
  }
  if (r.duplicados > 0) {
    return { entrou: false, texto: `O pedido ${pedido} já está no sistema — nada foi gravado.` };
  }
  return { entrou: false, texto: r.rejeitados[0]?.motivo ?? `O pedido ${pedido} não entrou.` };
}
