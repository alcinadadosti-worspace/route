import type { Pedido } from '@rota/shared';

/**
 * Pedidos pela ORIGEM, para a aba "Romaneios e digitados": os que entraram
 * pelo romaneio em PDF, agrupados pela folha, e os digitados à mão na
 * Importação. Pedido de planilha ou XML não entra — ele tem documento de
 * origem e aparece na aba Pedidos; o que esta aba responde é "quanto do dia
 * veio pela folha do Boticário e quanto alguém teve de digitar".
 */

export type PedidoComId = { id: string } & Pedido;

export interface GrupoDeRomaneio {
  /** Número da rota impresso na folha; vazio quando o PDF não o trouxe. */
  numero: string;
  /** Dia (AAAA-MM-DD) do pedido mais recente da folha. */
  dia: string | null;
  /** CD da maioria dos pedidos da folha (todos, no normal). */
  cdId: string | null;
  pedidos: PedidoComId[];
}

export interface PedidosPorOrigem {
  romaneios: GrupoDeRomaneio[];
  totalViaRomaneio: number;
  digitados: PedidoComId[];
}

/**
 * Dia em que o pedido entrou, na hora de Alagoas. Digitado: quando foi
 * digitado. Romaneio: o `emitidoEm`, que é a impressão da folha (ou a
 * importação, se a folha não trouxe a data) — gravados com o fuso de Maceió,
 * então os 10 primeiros caracteres já são o dia local.
 */
export function diaDeEntrada(p: Pick<Pedido, 'emitidoEm' | 'digitado'>): string | null {
  const iso = p.digitado?.em ?? p.emitidoEm ?? '';
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null;
}

/**
 * Digitado vence: a linha digitada usa as colunas da folha, mas não veio dela.
 * Confere o TIPO porque é dado lido do banco: um `romaneio: null` derrubaria
 * a aba inteira no `.trim()`.
 */
function origem(p: Pedido): 'digitado' | 'romaneio' | null {
  if (p.digitado) return 'digitado';
  if (typeof p.romaneio === 'string') return 'romaneio';
  return null;
}

/** Os dias que têm pedido de romaneio ou digitado, do mais recente ao mais antigo. */
export function diasComPedidos(pedidos: Pedido[]): string[] {
  const dias = new Set<string>();
  for (const p of pedidos) {
    const dia = origem(p) ? diaDeEntrada(p) : null;
    if (dia) dias.add(dia);
  }
  return [...dias].sort().reverse();
}

/** `dia` null = todos os dias. */
export function separarPorOrigem(pedidos: PedidoComId[], dia: string | null): PedidosPorOrigem {
  const porFolha = new Map<string, PedidoComId[]>();
  const digitados: PedidoComId[] = [];
  for (const p of pedidos) {
    const de = origem(p);
    if (!de || (dia && diaDeEntrada(p) !== dia)) continue;
    if (de === 'digitado') {
      digitados.push(p);
      continue;
    }
    const numero = p.romaneio!.trim();
    porFolha.set(numero, [...(porFolha.get(numero) ?? []), p]);
  }

  const romaneios = [...porFolha.entries()].map(([numero, doRomaneio]): GrupoDeRomaneio => {
    const dias = doRomaneio.map(diaDeEntrada).filter((d): d is string => d !== null).sort();
    return {
      numero,
      dia: dias.at(-1) ?? null,
      cdId: maisComum(doRomaneio.map((p) => p.cdId ?? null)),
      // Pela nota: a folha não guarda a ordem das linhas, e a NF é o número
      // que o Admin Estoque tem na mão para conferir.
      pedidos: doRomaneio.sort((a, b) => a.numeroNota - b.numeroNota || a.id.localeCompare(b.id)),
    };
  });
  // Folha mais recente primeiro; no mesmo dia, pelo número.
  romaneios.sort((a, b) => (b.dia ?? '').localeCompare(a.dia ?? '') || a.numero.localeCompare(b.numero));
  digitados.sort((a, b) => (b.digitado!.em ?? '').localeCompare(a.digitado!.em ?? '') || a.id.localeCompare(b.id));

  return {
    romaneios,
    totalViaRomaneio: romaneios.reduce((total, r) => total + r.pedidos.length, 0),
    digitados,
  };
}

function maisComum(valores: Array<string | null>): string | null {
  const conta = new Map<string, number>();
  for (const v of valores) if (v) conta.set(v, (conta.get(v) ?? 0) + 1);
  let melhor: string | null = null;
  for (const [v, n] of conta) if (melhor === null || n > conta.get(melhor)!) melhor = v;
  return melhor;
}
