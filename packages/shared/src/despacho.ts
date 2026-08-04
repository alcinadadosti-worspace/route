import type { Pedido, StatusPedido } from './tipos.js';

/**
 * Para onde vai um pedido que acabou de ficar sem pergunta pendente e sem rota
 * (decisão respondida, rota desfeita, ponto do cliente refeito): pronto para
 * rota se JÁ existe um ponto de entrega, senão mapeamento em campo.
 *
 * A regra tem duas fontes de ponto, e esquecer a segunda rendeu o mesmo bug em
 * QUATRO lugares diferentes: o cadastro do CLIENTE (pin de campo ou
 * geocodificação) e o OVERRIDE do próprio PEDIDO (seção 8.4 — o Admin Estoque
 * escolheu o endereço de entrega da nota e cravou a coordenada no mapa).
 * Pedido com override é despachável mesmo com o cliente nunca mapeado;
 * mandá-lo para "pendente de mapeamento" pede trabalho de campo por um ponto
 * que o Admin Estoque já deu — e o pedido some da lista de prontos sem ninguém
 * entender por quê.
 *
 * `clienteTemPonto` vem de quem chama porque nem sempre é `cliente.coordenada`
 * ao vivo: na liberação em lote o chamador já decidiu o status-base do cliente
 * (ex.: depois de um remapeamento que descartou o ponto).
 */
export function statusForaDeRota(
  pedido: Pick<Pedido, 'usarEnderecoEntrega' | 'coordenadaEntrega'>,
  clienteTemPonto: boolean,
): Extract<StatusPedido, 'pronto_para_rota' | 'pendente_de_mapeamento'> {
  const overrideComPonto =
    pedido.usarEnderecoEntrega === true && Boolean(pedido.coordenadaEntrega);
  return overrideComPonto || clienteTemPonto ? 'pronto_para_rota' : 'pendente_de_mapeamento';
}
