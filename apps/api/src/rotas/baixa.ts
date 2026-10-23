import { aplicarBaixas, voltaParaAFila, type BaixaPedida, type Pedido, type Rota } from '@rota/shared';
import { FORMATO_ROTA_ID } from './comum.js';
import type { Repositorio } from '../db/repositorio.js';

/**
 * Baixa da rota pelo painel (rota em PDF, motorista sem o app). A regra de
 * quais paradas mudam é pura (`aplicarBaixas`, no shared); aqui fica o que
 * depende do banco: conferir que cada pedido ainda é desta rota e decidir para
 * onde volta o que não foi entregue.
 *
 * Tudo numa transação: a rota e os pedidos mudam juntos ou não mudam. Uma
 * baixa pela metade deixaria a parada "entregue" com o pedido ainda `em_rota`,
 * e a montagem e o acompanhamento passariam a contar histórias diferentes.
 */

export type ResultadoDaBaixa =
  | { ok: true; rota: Rota; entregues: string[]; devolvidos: string[] }
  | { ok: false; status: number; erro: string };

export async function darBaixa(
  repo: Repositorio,
  rotaId: string,
  baixas: BaixaPedida[],
  quem: string,
  agora: Date = new Date(),
): Promise<ResultadoDaBaixa> {
  if (!FORMATO_ROTA_ID.test(rotaId ?? '')) {
    return { ok: false, status: 404, erro: 'Rota não encontrada' };
  }

  const r = await repo.transacaoNaRota<ResultadoDaBaixa>(rotaId, async (rota, ler) => {
    const aplicada = aplicarBaixas(rota, baixas, { em: agora.toISOString(), por: quem });
    if (!aplicada.ok) return { gravar: false, resultado: { ok: false, status: 422, erro: aplicada.erro } };

    // Leituras em paralelo: em série, a baixa de uma rota com centenas de
    // exceções seguraria a transação (e os pedidos dela) por meio minuto.
    const ids = [...aplicada.entregues, ...aplicada.naoEntregues];
    const lidos = await Promise.all(ids.map((id) => ler.pedido(id)));
    const clientes = await Promise.all(
      aplicada.naoEntregues.map((id, i) => {
        const pedido = lidos[aplicada.entregues.length + i];
        return pedido ? ler.cliente(pedido.clienteId) : null;
      }),
    );

    const pedidos: Record<string, Partial<Pedido>> = {};
    for (const [i, id] of ids.entries()) {
      const pedido = lidos[i];
      // A parada diz que o pedido é desta rota; o pedido tem de concordar. Se
      // não concorda (apagado, ou movido por um caminho que esqueceu a parada),
      // gravar seria mexer no pedido de OUTRA rota — recusa tudo.
      if (!pedido || pedido.status !== 'em_rota' || pedido.rotaId !== rotaId) {
        return {
          gravar: false,
          resultado: {
            ok: false,
            status: 409,
            erro: `Pedido ${pedido?.numeroNota ?? id} não está mais nesta rota — atualize a tela`,
          },
        };
      }
      if (i < aplicada.entregues.length) {
        pedidos[id] = { status: 'entregue' };
      } else {
        const cliente = clientes[i - aplicada.entregues.length];
        // Com o endereço em revisão (o cliente mudou com o caminhão na rua),
        // volta para a aba Decisões — "pronto" otimizava a próxima rota no
        // ponto do endereço ANTIGO e imprimia o NOVO.
        const volta = voltaParaAFila(pedido, cliente);
        pedidos[id] = {
          status: volta.status,
          ...(volta.enderecoAnterior ? { enderecoAnterior: volta.enderecoAnterior } : {}),
          rotaId: null,
          voltouDeRota: { rotaId, data: rota.data },
        };
      }
    }

    return {
      gravar: true,
      rota: aplicada.rota,
      pedidos,
      resultado: {
        ok: true,
        rota: aplicada.rota,
        entregues: aplicada.entregues,
        devolvidos: aplicada.naoEntregues,
      },
    };
  });

  return r ? r.resultado : { ok: false, status: 404, erro: 'Rota não encontrada' };
}
