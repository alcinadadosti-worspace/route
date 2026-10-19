import {
  chaveDeMunicipio,
  foraDaMontagemPeloErp,
  liberacaoDesfazivel,
  municipioDoPedido,
  type Cliente,
  type Pedido,
} from '@rota/shared';
import { casaBusca } from './buscaPedido';

/**
 * A lista "Fora da montagem" do painel: o que o ERP deixou de fora (retirada,
 * ou entregue segundo ele) e o que já foi liberado. Num ciclo são ~1700
 * pedidos (954 retiradas e 756 "entregues" no ciclo 11) — sem filtro por tipo,
 * cidade e busca, achar os cinco que vão no caminhão hoje seria rolar a tela.
 */

export type VistaForaDaMontagem = 'fora' | 'liberados';
export type TipoForaDaMontagem = 'todos' | 'entregue_no_erp' | 'retirada';

export interface FiltroForaDaMontagem {
  vista: VistaForaDaMontagem;
  tipo: TipoForaDaMontagem;
  /** `chaveDeMunicipio` da cidade, ou '' para todas. */
  cidade: string;
  busca: string;
}

export interface LinhaForaDaMontagem {
  pedido: { id: string } & Pedido;
  cliente: string;
  cidade: string;
  /** De onde veio: retirada, ou entrega que o ERP dá como entregue. */
  origem: 'retirada' | 'entregue_no_erp';
}

export interface ListaForaDaMontagem {
  linhas: LinhaForaDaMontagem[];
  /** Cidades da vista/tipo atuais, para o seletor — com quantos em cada. */
  cidades: Array<{ chave: string; nome: string; n: number }>;
  contagem: { retiradas: number; entreguesNoErp: number; liberados: number };
}

export function listarForaDaMontagem(
  pedidos: Array<{ id: string } & Pedido>,
  clientes: Record<string, Cliente>,
  filtro: FiltroForaDaMontagem,
): ListaForaDaMontagem {
  const fora = pedidos.filter(foraDaMontagemPeloErp);
  const liberados = pedidos.filter(liberacaoDesfazivel);
  const contagem = {
    retiradas: fora.filter((p) => p.status === 'retirada').length,
    entreguesNoErp: fora.filter((p) => p.status === 'entregue_no_erp').length,
    liberados: liberados.length,
  };

  const base = (filtro.vista === 'fora' ? fora : liberados)
    .filter((p) => filtro.vista === 'liberados' || filtro.tipo === 'todos' || p.status === filtro.tipo)
    .map((p): LinhaForaDaMontagem => ({
      pedido: p,
      cliente: clientes[p.clienteId]?.nome ?? p.clienteId,
      cidade: (municipioDoPedido(p, clientes[p.clienteId]) ?? '—').trim().toUpperCase(),
      origem:
        p.liberadoParaRota?.de ?? (p.status === 'retirada' ? 'retirada' : 'entregue_no_erp'),
    }));

  // A mesma cidade com e sem acento/apóstrofo é UMA opção (mesma chave do
  // agrupamento) — "OLHO D'ÁGUA GRANDE" e "OLHO DÁGUA GRANDE" estão na planilha.
  const porCidade = new Map<string, { chave: string; nome: string; n: number }>();
  for (const l of base) {
    const chave = chaveDeMunicipio(l.cidade);
    const atual = porCidade.get(chave) ?? { chave, nome: l.cidade, n: 0 };
    atual.n += 1;
    porCidade.set(chave, atual);
  }
  const cidades = [...porCidade.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

  const linhas = base
    .filter((l) => !filtro.cidade || chaveDeMunicipio(l.cidade) === filtro.cidade)
    .filter((l) => casaBusca(l.pedido, l.cliente, filtro.busca))
    // Mais recente primeiro: o que ainda não foi entregue costuma ser o da
    // semana, e o ERP só marca "entregue" sozinho o que tem mais de 6 dias.
    .sort(
      (a, b) =>
        (b.pedido.emitidoEm ?? '').localeCompare(a.pedido.emitidoEm ?? '') ||
        a.pedido.id.localeCompare(b.pedido.id),
    );

  return { linhas, cidades, contagem };
}
