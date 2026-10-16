import type { BaixaNoPainel, Rota, StatusPedido } from './tipos.js';

/**
 * Baixa da rota pelo painel: o motorista saiu com o PDF, sem o app, e na volta
 * o Admin Estoque registra parada a parada o que foi entregue.
 *
 * Sem este passo a rota em papel não fecha nunca: os pedidos ficam `em_rota`
 * para sempre — reservados, o que é bom contra a duplicidade, mas presos, o que
 * é pior que a duplicidade. "Não entregue" devolve o pedido à fila (quem faz
 * isso é a API, que tem o cliente para decidir pronto × pendente de mapeamento).
 */

export type ResultadoBaixa = 'entregue' | 'nao_entregue';

export interface BaixaPedida {
  pedidoId: string;
  resultado: ResultadoBaixa;
}

export type BaixaAplicada =
  | { ok: true; rota: Rota; entregues: string[]; naoEntregues: string[] }
  | { ok: false; erro: string };

const RESULTADOS: readonly ResultadoBaixa[] = ['entregue', 'nao_entregue'];

const resolvida = (status: StatusPedido) => status === 'entregue' || status === 'insucesso';

export function aplicarBaixas(rota: Rota, baixas: BaixaPedida[], marca: BaixaNoPainel): BaixaAplicada {
  if (!Array.isArray(baixas) || baixas.length === 0) {
    return { ok: false, erro: 'Nenhuma baixa informada' };
  }

  const paradas = rota.paradas.map((p) => ({ ...p }));
  const excecoes = (rota.excecoes ?? []).map((e) => ({ ...e }));
  const parada = new Map<string, { nome: string; status: StatusPedido }>();
  for (const p of [...paradas, ...excecoes]) parada.set(p.pedidoId, p);

  const vistos = new Set<string>();
  const entregues: string[] = [];
  const naoEntregues: string[] = [];
  for (const b of baixas) {
    if (!RESULTADOS.includes(b?.resultado)) {
      return { ok: false, erro: `Resultado inválido: ${String(b?.resultado)}` };
    }
    if (vistos.has(b.pedidoId)) {
      return { ok: false, erro: `Pedido ${b.pedidoId} aparece duas vezes na mesma baixa` };
    }
    vistos.add(b.pedidoId);
    const alvo = parada.get(b.pedidoId);
    if (!alvo) return { ok: false, erro: `Pedido ${b.pedidoId} não está nesta rota` };
    // Baixa não sobrescreve resultado: o que já foi resolvido — pelo app ou
    // por uma baixa anterior — é histórico. Corrigir em silêncio apagaria a
    // única versão do que aconteceu.
    if (resolvida(alvo.status)) {
      return { ok: false, erro: `${alvo.nome} já tem resultado registrado (${alvo.status})` };
    }
    (b.resultado === 'entregue' ? entregues : naoEntregues).push(b.pedidoId);
  }

  const aplicar = <T extends { pedidoId: string; status: StatusPedido }>(p: T): T => {
    if (entregues.includes(p.pedidoId)) return { ...p, status: 'entregue', baixaNoPainel: marca };
    if (naoEntregues.includes(p.pedidoId)) return { ...p, status: 'insucesso', baixaNoPainel: marca };
    return p;
  };
  const novasParadas = paradas.map(aplicar);
  const novasExcecoes = excecoes.map(aplicar);
  const todas = [...novasParadas, ...novasExcecoes];
  const concluida = todas.every((p) => resolvida(p.status));
  // Rota que o motorista FECHOU no app com paradas por entregar continua
  // fechada: a baixa resolve o que ficou, não reabre o dia. Reaberta, ela
  // voltaria a ser a rota ativa no celular dele, compartilhando posição.
  const jaFechada = rota.status === 'concluida';

  const nova: Rota = {
    ...rota,
    paradas: novasParadas,
    status: concluida || jaFechada ? 'concluida' : 'em_execucao',
    concluidaEm: jaFechada ? rota.concluidaEm : concluida ? marca.em : rota.concluidaEm,
  };
  // Rota antiga (sem exceções) continua sem o campo: gravar `excecoes: []`
  // num doc que nunca o teve seria mudança sem motivo.
  if (rota.excecoes) nova.excecoes = novasExcecoes;
  return { ok: true, rota: nova, entregues, naoEntregues };
}

/** Paradas + exceções ainda sem resultado. */
export function paradasEmAberto(rota: Pick<Rota, 'paradas' | 'excecoes'>): number {
  return [...rota.paradas, ...(rota.excecoes ?? [])].filter((p) => !resolvida(p.status)).length;
}

/**
 * Rotas de dias ANTERIORES que ainda têm parada sem resultado. Com o motorista
 * no papel, ninguém fecha a rota além do Admin Estoque — e rota esquecida
 * aberta prende os pedidos dela, que nunca mais voltam para a montagem. Avisa,
 * não fecha sozinho: só quem falou com o motorista sabe o que foi entregue.
 *
 * Rota FECHADA também entra: o motorista pode fechar no app com paradas por
 * entregar ("o Admin Estoque vai ter de resolver", diz o app a ele), e o app
 * não conhece as exceções — os pedidos dela ficam presos do mesmo jeito.
 * `hoje` no formato da rota (AAAA-MM-DD, fuso de Alagoas).
 */
export function rotasSemBaixa<R extends Pick<Rota, 'data' | 'status' | 'paradas' | 'excecoes'>>(
  rotas: R[],
  hoje: string,
): R[] {
  return rotas.filter((r) => r.data < hoje && r.status !== 'rascunho' && paradasEmAberto(r) > 0);
}
