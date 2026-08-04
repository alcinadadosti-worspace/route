import { statusForaDeRota, type Pedido, type Rota } from '@rota/shared';
import { FORMATO_ROTA_ID } from './comum.js';
import type { Repositorio } from '../db/repositorio.js';

/**
 * Remoção de pedido e de rota depois da publicação (RF-23).
 *
 * O que existia antes era um beco sem saída: pedido `em_rota` não podia ser
 * apagado, e rota publicada não podia ser desfeita. Uma nota importada por
 * engano que entrasse numa rota ficava lá para sempre.
 *
 * A regra que sobrou é uma só, e é sobre HISTÓRICO: o que já foi entregue ou
 * teve insucesso não se apaga. Aquilo aconteceu, tem registro de entrega
 * apontando para ele, e é a memória da operação. Todo o resto é corrigível.
 */

export type ResultadoRemocao =
  | { ok: true; rotaApagada?: string }
  | { ok: false; status: number; erro: string };

/** Ponto do pedido fora de rota: o do cliente OU o override de entrega (8.4) —
 * a regra pura mora no shared (`statusForaDeRota`), aqui só se busca o cliente. */
async function statusDeVolta(repo: Repositorio, pedido: Pedido): Promise<Pedido['status']> {
  const cliente = await repo.obterCliente(pedido.clienteId);
  return statusForaDeRota(pedido, Boolean(cliente?.coordenada));
}

/**
 * Apaga o pedido. Estando numa rota publicada, a parada dele sai da rota junto
 * — senão o motorista veria no celular uma parada cujo pedido não existe mais,
 * e a confirmação de entrega falharia em campo, longe de quem entenderia.
 *
 * A rota fica com o traçado e os totais da forma ANTIGA: a linha ainda passa
 * pelo lugar da parada removida e a quilometragem segue a da rota original. É
 * assumido de propósito — recalcular exigiria o OSRM e rede, e o motorista pode
 * estar na estrada. A lista de paradas, que é o que ele executa, fica correta.
 */
export async function removerPedido(repo: Repositorio, pedidoId: string): Promise<ResultadoRemocao> {
  const pedido = await repo.obterPedido(pedidoId);
  if (!pedido) return { ok: false, status: 404, erro: 'Pedido não encontrado' };

  if (pedido.status === 'entregue' || pedido.status === 'insucesso') {
    return {
      ok: false,
      status: 409,
      erro: `Nota ${pedido.numeroNota} já foi executada em campo — é histórico da operação`,
    };
  }

  let rotaApagada: string | undefined;
  if (pedido.rotaId) {
    const rota = await repo.obterRota(pedido.rotaId);
    if (rota) {
      const paradas = rota.paradas.filter((p) => p.pedidoId !== pedidoId);
      if (paradas.length === 0) {
        // Rota sem parada nenhuma não é rota: ela vai embora com o último pedido.
        await repo.apagarRota(rota.id);
        await repo.apagarPosicao(rota.id);
        rotaApagada = rota.id;
      } else {
        await repo.salvarRota(rota.id, { ...(rota as Rota), paradas });
      }
    }
  }

  await repo.apagarPedido(pedidoId);
  return { ok: true, rotaApagada };
}

/**
 * Desfaz uma rota publicada: os pedidos voltam a ficar disponíveis para montar
 * outra, e a rota desaparece do celular do motorista.
 *
 * Recusa se alguma parada já foi executada. Não é preciosismo: apagar a rota
 * deixaria os registros de entrega apontando para uma rota que não existe, e o
 * Admin Estoque perderia a memória do dia. Quando há entrega, o que se quer é
 * remover UMA parada (removerPedido), não a rota.
 */
export async function removerRota(repo: Repositorio, rotaId: string): Promise<ResultadoRemocao> {
  if (!FORMATO_ROTA_ID.test(rotaId ?? '')) {
    return { ok: false, status: 404, erro: 'Rota não encontrada' };
  }
  const rota = await repo.obterRota(rotaId);
  if (!rota) return { ok: false, status: 404, erro: 'Rota não encontrada' };

  const executadas = rota.paradas.filter(
    (p) => p.status === 'entregue' || p.status === 'insucesso',
  ).length;
  if (executadas > 0) {
    return {
      ok: false,
      status: 409,
      erro: `A rota já tem ${executadas} parada(s) executada(s) — apagá-la perderia o histórico do dia. Remova o pedido específico, se for o caso.`,
    };
  }

  // Os pedidos voltam ao estado de antes da publicação. Sem isso ficariam
  // `em_rota` para sempre, apontando para uma rota inexistente, e nunca mais
  // entrariam numa rota nova.
  for (const parada of rota.paradas) {
    const pedido = await repo.obterPedido(parada.pedidoId);
    if (!pedido) continue;
    await repo.salvarPedido(parada.pedidoId, {
      ...pedido,
      status: await statusDeVolta(repo, pedido),
      rotaId: null,
    });
  }

  await repo.apagarRota(rotaId);
  // A posição compartilhada morre com a rota: dado de localização não pode
  // sobreviver ao motivo que o justificava, e sem isto ele viraria lixo
  // permanente numa coleção que ninguém mais lê.
  await repo.apagarPosicao(rotaId);
  return { ok: true, rotaApagada: rotaId };
}
