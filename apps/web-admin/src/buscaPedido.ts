import { formatarDia, normalizar, type Pedido } from '@rota/shared';

/**
 * Busca de pedido no painel (montagem e "Fora da montagem").
 *
 * Termo que é NÚMERO procura nos números — pedido, nota, o id e o número da
 * rota do romaneio do Boticário —, aceitando o
 * que se cola de outro sistema ("536.361.204", "536 361 204"); termo com
 * letras procura no nome da cliente, sem acento nem caixa.
 */
export function casaBusca(
  pedido: Pick<Pedido, 'numeroPedido' | 'numeroNota' | 'romaneio'> & { id: string; serie?: number },
  nomeCliente: string,
  termo: string,
): boolean {
  const t = termo.trim();
  if (!t) return true;
  // Nota como a tela mostra, "302856/1" (nota/série): colada da coluna Nota,
  // juntar os dígitos dava "3028561" e não achava nada.
  const notaSerie = /^(\d+)\s*\/\s*(\d+)$/.exec(t);
  if (notaSerie) {
    return (
      String(pedido.numeroNota) === notaSerie[1] &&
      (pedido.serie === undefined || String(pedido.serie) === notaSerie[2])
    );
  }
  if (/^[\d\s.\-/]+$/.test(t)) {
    const digitos = t.replace(/\D/g, '');
    if (!digitos) return true;
    // O pedido do site, como a folha imprime ("160000001-1"): juntar os
    // dígitos dava "1600000011", que não está dentro de "160000001-1".
    const comHifen = /^\d+\s*-\s*\d{1,4}$/.test(t) && pedido.id.includes(t.replace(/\s/g, ''));
    return (
      comHifen ||
      (pedido.numeroPedido ?? '').includes(digitos) ||
      pedido.id.includes(digitos) ||
      String(pedido.numeroNota).includes(digitos) ||
      // O número da rota do Boticário: inteiro, porque ele pega a folha toda —
      // "167" casando por pedaço traria pedidos de folhas que não são esta.
      pedido.romaneio === digitos
    );
  }
  return normalizar(nomeCliente).includes(normalizar(t));
}

/**
 * Onde o pedido está, quando NÃO está na lista de prontos da montagem. Sem
 * isto, buscar um número e não achar nada parece "o pedido sumiu" — e o
 * operador procura em cada aba até descobrir que ele já saiu numa rota.
 */
export function ondeEstaOPedido(pedido: Pick<Pedido, 'status' | 'rotaId'>): string {
  switch (pedido.status) {
    case 'pronto_para_rota':
      return 'pronto, na lista da montagem';
    case 'pendente_de_mapeamento':
      return 'sem ponto no mapa — entra como exceção quando a cidade dele estiver marcada (ou use "Localizar endereços" na Importação)';
    case 'pendente_de_decisao':
      return 'aguardando decisão na aba Decisões';
    case 'retirada':
      return 'fora da montagem (retirada na central) — libere em "Fora da montagem", abaixo';
    case 'entregue_no_erp':
      return 'fora da montagem (o ERP dá como entregue) — libere em "Fora da montagem", abaixo';
    case 'em_rota': {
      const dia = formatarDia(pedido.rotaId?.slice(0, 10));
      return `já está numa rota publicada${pedido.rotaId ? ` (${dia}, ${pedido.rotaId})` : ''} — veja no Acompanhamento do dia`;
    }
    case 'entregue':
      return 'já entregue (baixa registrada)';
    case 'insucesso':
      return 'registrado como não entregue numa rota';
    default:
      return `está como ${pedido.status}`;
  }
}
