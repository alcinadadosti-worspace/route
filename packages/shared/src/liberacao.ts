import { statusForaDeRota } from './despacho.js';
import type { Cliente, GeoPonto, Pedido, StatusPedido } from './tipos.js';

/**
 * O que fica FORA da montagem por causa do ERP, e como volta para ela.
 *
 * Dois tipos de pedido não aparecem na montagem: o de "Retirar na central de
 * serviços" e o "No endereço de entrega" que a planilha já trouxe como
 * ENTREGUE. Nos dois o ERP pode estar errado, e o usuário explicou por quê
 * (19/10/2026): ele marca entregue SOZINHO depois de 6 dias, e há retirada que
 * acaba indo no caminhão — aparecendo como entregue sem ter sido.
 *
 * Por isso nada aqui decide pelo ERP: o pedido fica de fora por padrão, numa
 * lista própria, e o Admin Estoque marca o que ainda não foi entregue e libera.
 * Liberado, ele segue o caminho de qualquer pedido de rota (pronto, ou sem
 * ponto, ou aguardando decisão). A liberação se desfaz enquanto ele não saiu.
 */

export type OrigemForaDaMontagem = 'retirada' | 'entregue_no_erp';

export function foraDaMontagemPeloErp(pedido: Pick<Pedido, 'status'>): boolean {
  return pedido.status === 'retirada' || pedido.status === 'entregue_no_erp';
}

/** Liberado e ainda esperando rota — o único momento em que dá para desfazer. */
export function liberacaoDesfazivel(pedido: Pick<Pedido, 'status' | 'liberadoParaRota'>): boolean {
  return (
    Boolean(pedido.liberadoParaRota) &&
    (pedido.status === 'pronto_para_rota' ||
      pedido.status === 'pendente_de_mapeamento' ||
      pedido.status === 'pendente_de_decisao')
  );
}

export type ResultadoLiberacao =
  /** `pontoDoCliente`: o cliente ainda não tem ponto e a retirada trouxe o GPS
   * do cadastro — quem grava é o chamador, junto com o pedido. */
  | { ok: true; pedido: Pedido; pontoDoCliente?: GeoPonto }
  | { ok: false; motivo: string };

export function liberarParaRota(
  pedido: Pedido,
  cliente: Pick<Cliente, 'coordenada' | 'enderecoEmRevisao'> | null,
  marca: { em: string; por: string },
): ResultadoLiberacao {
  if (pedido.status !== 'retirada' && pedido.status !== 'entregue_no_erp') {
    return { ok: false, motivo: `está como ${pedido.status} — não está fora da montagem` };
  }
  const comRota: Pedido = { ...pedido, modoEntrega: 'rota' };
  const pontoDoCliente = !cliente?.coordenada && pedido.pinDoCadastro ? pedido.pinDoCadastro : undefined;
  // Pergunta de endereço em aberto vai para a aba Decisões, como na
  // importação: soltar direto mandaria o caminhão ao ponto do endereço ANTIGO.
  // O pedido leva o `enderecoAnterior`: é por ele que a aba desenha o cartão e
  // que a resposta encontra o pedido — sem ele, ficava preso numa decisão que
  // nenhuma tela mostrava.
  const revisao = cliente?.enderecoEmRevisao ?? null;
  const entregaEmAberto = Boolean(pedido.enderecoEntrega) && pedido.usarEnderecoEntrega === undefined;
  const status: StatusPedido =
    revisao || entregaEmAberto
      ? 'pendente_de_decisao'
      : statusForaDeRota(comRota, Boolean(cliente?.coordenada || pontoDoCliente));
  return {
    ok: true,
    pedido: {
      ...comRota,
      status,
      ...(revisao && !entregaEmAberto ? { enderecoAnterior: revisao } : {}),
      liberadoParaRota: { de: pedido.status, em: marca.em, por: marca.por },
    },
    ...(pontoDoCliente ? { pontoDoCliente } : {}),
  };
}

export function devolverParaForaDaMontagem(pedido: Pedido): ResultadoLiberacao {
  if (!liberacaoDesfazivel(pedido)) {
    return {
      ok: false,
      motivo: pedido.liberadoParaRota
        ? `está como ${pedido.status} — só se desfaz antes de sair numa rota`
        : 'não foi liberado por aqui',
    };
  }
  const { liberadoParaRota, ...resto } = pedido;
  const de = liberadoParaRota!.de;
  return {
    ok: true,
    pedido: { ...resto, status: de, modoEntrega: de === 'retirada' ? 'retirada' : 'rota' },
  };
}
