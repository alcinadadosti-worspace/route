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
  const folhas = envio.relatorio.folhas ?? [];
  if (folhas.length > 0) {
    return folhas.map((f) => `Rota ${f.rota} · ${f.motorista || 'sem motorista'} · ${f.pacotes} pacote(s)`);
  }
  return envio.arquivos.length > 0 ? envio.arquivos : ['(sem arquivo)'];
}
