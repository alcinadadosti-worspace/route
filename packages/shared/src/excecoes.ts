import { chaveDeMunicipio } from './endereco.js';
import type { Cliente, Pedido } from './tipos.js';

/**
 * Município para onde o pedido vai: o do endereço de entrega quando o Admin
 * Estoque escolheu o override (seção 8.4), senão o do cadastro — a mesma regra
 * de `coletarParadas`, para a sugestão não discordar da rota.
 */
export function municipioDoPedido(
  pedido: Pick<Pedido, 'usarEnderecoEntrega' | 'enderecoEntrega'>,
  cliente: Pick<Cliente, 'enderecoFiscal'> | null | undefined,
): string | null {
  const e =
    pedido.usarEnderecoEntrega === true && pedido.enderecoEntrega
      ? pedido.enderecoEntrega
      : cliente?.enderecoFiscal;
  return e?.municipio ? e.municipio : null;
}

/**
 * Pedidos sem ponto no mapa que deveriam sair junto com a seleção: mesmo
 * município de algum pedido marcado e do mesmo CD. É SUGESTÃO — a tela mostra
 * marcado e o operador desmarca o que não vai.
 *
 * O casamento é por `chaveDeMunicipio` ("TEOTÔNIO VILELA" = "Teotonio
 * Vilela", "OLHO D'ÁGUA GRANDE" = "OLHO DÁGUA GRANDE"): a planilha e a NF-e
 * escrevem o mesmo lugar de jeitos diferentes. O
 * CD conta porque a mercadoria de outro galpão não está no caminhão; pedido sem
 * CD reconhecido não é barrado (a montagem também não barra).
 */
export function excecoesDaSelecao(
  selecionados: Array<{ municipio: string | null; cdId: string | null | undefined }>,
  pendentes: Array<{ id: string; municipio: string | null; cdId: string | null | undefined }>,
): string[] {
  const municipios = new Set(
    selecionados.map((s) => (s.municipio ? chaveDeMunicipio(s.municipio) : '')).filter(Boolean),
  );
  const cds = new Set(selecionados.map((s) => s.cdId).filter(Boolean));
  return pendentes
    .filter(
      (p) =>
        p.municipio !== null &&
        municipios.has(chaveDeMunicipio(p.municipio)) &&
        (!p.cdId || cds.size === 0 || cds.has(p.cdId)),
    )
    .map((p) => p.id);
}
