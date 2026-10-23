import { voltaParaAFila, type Pedido, type Rota } from '@rota/shared';
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

/** Para onde volta o pedido que sai da rota — a regra pura mora no shared
 * (`voltaParaAFila`: ponto do cliente ou override de entrega, e a revisão de
 * endereço aberta); aqui só se busca o cliente. */
async function voltaDoPedido(repo: Repositorio, pedido: Pedido): Promise<Partial<Pedido>> {
  const cliente = await repo.obterCliente(pedido.clienteId);
  const volta = voltaParaAFila(pedido, cliente);
  return { status: volta.status, ...(volta.enderecoAnterior ? { enderecoAnterior: volta.enderecoAnterior } : {}) };
}

/** Pedidos de uma rota que deixou de existir voltam ao estado de antes da
 * publicação: pronto, ou pendente de mapeamento se ainda não têm ponto.
 *
 * Só os que AINDA são desta rota. O que teve baixa "não entregue" já voltou à
 * fila e pode estar noutra rota agora; devolvê-lo de novo o soltaria de lá —
 * reproduzido: o pedido ficava livre com a rota nova ainda o levando, e uma
 * terceira publicação o punha em duas rotas vivas. */
async function devolverAFila(repo: Repositorio, rotaId: string, pedidoIds: string[]): Promise<void> {
  for (const id of pedidoIds) {
    const pedido = await repo.obterPedido(id);
    if (!pedido || pedido.status !== 'em_rota' || pedido.rotaId !== rotaId) continue;
    await repo.salvarPedido(id, { ...pedido, ...(await voltaDoPedido(repo, pedido)), rotaId: null });
  }
}

const executada = (p: { status: Pedido['status'] }) => p.status === 'entregue' || p.status === 'insucesso';

/**
 * Apaga o pedido. Estando numa rota publicada, a parada dele sai da rota junto
 * — senão o motorista veria no celular uma parada cujo pedido não existe mais,
 * e a confirmação de entrega falharia em campo, longe de quem entenderia.
 *
 * A rota fica com o traçado e os totais da forma ANTIGA: a linha ainda passa
 * pelo lugar da parada removida e a quilometragem segue a da rota original. É
 * assumido de propósito — recalcular exigiria o OSRM e rede, e o motorista pode
 * estar na estrada. A lista de paradas, que é o que ele executa, fica correta.
 *
 * Apagar UM pedido nunca solta os OUTROS. Antes, tirar a última parada com
 * ponto desfazia a rota e devolvia à fila as exceções dela — numa rota rural,
 * dezenas de caixas que já estavam no caminhão e no PDF impresso, sem mais
 * rota onde dar baixa, e sugeridas de novo para o caminhão seguinte. Agora a
 * rota só some quando não sobra nada nela; para soltar tudo, existe o
 * "Desfazer a rota", que é uma decisão explícita.
 *
 * Tudo numa transação na rota: a baixa também é, e as duas lado a lado sem
 * isso deixavam a baixa recém-gravada ser sobrescrita pela rota lida antes
 * dela (parada de volta a "em rota" com o pedido já entregue).
 */
export async function removerPedido(
  repo: Repositorio,
  pedidoId: string,
  registro: { motivo: string } = { motivo: 'apagado no painel' },
): Promise<ResultadoRemocao> {
  const pedido = await repo.obterPedido(pedidoId);
  if (!pedido) return { ok: false, status: 404, erro: 'Pedido não encontrado' };
  if (executada(pedido)) return historico(pedido);

  if (pedido.rotaId) {
    const rotaId = pedido.rotaId;
    const r = await repo.transacaoNaRota<ResultadoRemocao>(rotaId, async (rota, ler) => {
      // Relido dentro da transação: uma baixa pode ter chegado depois da
      // primeira leitura.
      const atual = await ler.pedido(pedidoId);
      if (!atual) return { gravar: false, resultado: { ok: false, status: 404, erro: 'Pedido não encontrado' } };
      if (executada(atual)) return { gravar: false, resultado: historico(atual) };

      const paradas = rota.paradas.filter((p) => p.pedidoId !== pedidoId);
      const excecoes = (rota.excecoes ?? []).filter((e) => e.pedidoId !== pedidoId);
      // Rota sem parada E sem exceção não é rota: vai embora com o último pedido.
      if (paradas.length === 0 && excecoes.length === 0) {
        return { gravar: true, rota: null, pedidos: {}, apagarPedidos: [pedidoId], resultado: { ok: true, rotaApagada: rotaId } };
      }
      const restantes = [...paradas, ...excecoes];
      const saiu = [...rota.paradas, ...(rota.excecoes ?? [])].find((p) => p.pedidoId === pedidoId);
      const ehExcecao = (rota.excecoes ?? []).some((e) => e.pedidoId === pedidoId);
      // O que sobrou já tem resultado: a rota acabou. Sem isto ela ficava "em
      // execução" para sempre, sem nada a baixar nem como desfazer.
      const acabou = rota.status !== 'rascunho' && restantes.every(executada);
      const nova: Rota = {
        ...rota,
        paradas,
        ...(rota.excecoes ? { excecoes } : {}),
        // Fica escrito NA ROTA quem saiu e por quê: o PDF impresso ainda tem a
        // parada, e o aviso da importação some na próxima.
        ...(saiu
          ? {
              removidos: [
                ...(rota.removidos ?? []),
                {
                  pedidoId,
                  ...(saiu.numero !== undefined ? { numero: `${ehExcecao ? 'E' : ''}${saiu.numero}` } : {}),
                  nome: saiu.nome,
                  ...(saiu.numeroNota !== undefined ? { numeroNota: saiu.numeroNota } : {}),
                  motivo: registro.motivo,
                  em: new Date().toISOString(),
                },
              ],
            }
          : {}),
        ...(acabou ? { status: 'concluida' as const, concluidaEm: rota.concluidaEm ?? new Date().toISOString() } : {}),
      };
      return { gravar: true, rota: nova, pedidos: {}, apagarPedidos: [pedidoId], resultado: { ok: true } };
    });
    // r === null: a rota não existe mais — o pedido apontava para o nada.
    if (r) {
      if (r.resultado.ok && r.resultado.rotaApagada) await repo.apagarPosicao(rotaId);
      return r.resultado;
    }
  }

  await repo.apagarPedido(pedidoId);
  return { ok: true };
}

function historico(pedido: Pedido): ResultadoRemocao {
  return {
    ok: false,
    status: 409,
    erro: `Nota ${pedido.numeroNota} já foi executada em campo — é histórico da operação`,
  };
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

  const executadas = [...rota.paradas, ...(rota.excecoes ?? [])].filter(executada).length;
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
  await devolverAFila(repo, rotaId, [
    ...rota.paradas.map((p) => p.pedidoId),
    ...(rota.excecoes ?? []).map((e) => e.pedidoId),
  ]);

  await repo.apagarRota(rotaId);
  // A posição compartilhada morre com a rota: dado de localização não pode
  // sobreviver ao motivo que o justificava, e sem isto ele viraria lixo
  // permanente numa coleção que ninguém mais lê.
  await repo.apagarPosicao(rotaId);
  return { ok: true, rotaApagada: rotaId };
}
