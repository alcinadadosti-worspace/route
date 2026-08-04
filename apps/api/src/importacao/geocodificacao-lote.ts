import type { Cliente, Pedido } from '@rota/shared';
import { statusForaDeRota } from '@rota/shared';
import type { Repositorio } from '../db/repositorio.js';
import type { Geocodificador } from '../geocodificacao/google.js';

/**
 * Localização de endereços em LOTES, separada da importação (seção 9).
 *
 * Nasceu de uma falha real: a importação da planilha geocodificava tudo dentro
 * da requisição HTTP e não terminava — ~1300 endereços novos por ciclo, cada um
 * uma ida à Google, e o proxy do Render cortava a requisição no meio (o
 * navegador reportava "erro de CORS", que despista de vez).
 *
 * Dois motivos para ser um passo próprio, e o segundo importa tanto quanto:
 * 1. cabe no tempo — o painel chama em lotes e mostra progresso;
 * 2. a busca é PAGA. Um passo explícito, com contagem antes e depois, deixa o
 *    Admin Estoque ver quanto vai gastar e parar no meio se quiser.
 */

export interface ResultadoLote {
  /** Quantos clientes ainda esperam ponto DEPOIS deste lote. */
  restantes: number;
  processados: number;
  geocodificados: number;
  aproximados: number;
  /**
   * Endereços que a Google não soube localizar. O painel SOMA isto em `pular`
   * na chamada seguinte — sem isso, o lote seguinte pegaria de novo os mesmos
   * primeiros da fila (eles continuam sem coordenada), o laço nunca terminaria
   * e a operação pagaria em círculos pelo endereço que não existe no mapa.
   */
  semResultado: number;
}

/** Tamanho do lote: cabe folgado numa requisição (~20 s no pior caso) e dá
 * progresso visível de verdade. Não é para maximizar — é para nunca estourar. */
export const TAMANHO_DO_LOTE = 100;

export async function localizarEnderecos(
  repo: Repositorio,
  geocodificador: Geocodificador | null,
  opcoes: { limite?: number; pular?: number } = {},
): Promise<ResultadoLote> {
  const limite = opcoes.limite ?? TAMANHO_DO_LOTE;
  const pular = Math.max(0, opcoes.pular ?? 0);

  const vazio: ResultadoLote = {
    restantes: 0,
    processados: 0,
    geocodificados: 0,
    aproximados: 0,
    semResultado: 0,
  };
  if (!geocodificador) return vazio;

  // A fila sai dos PEDIDOS que esperam ponto, não de uma varredura de clientes:
  // é a lista exata (pedido só fica `pendente_de_mapeamento` porque o cliente
  // não tem coordenada) e já exclui quem só faz retirada — metade da base, que
  // nunca recebe visita e cujo endereço seria dinheiro jogado fora.
  // Ordenado para o fatiamento ser estável entre chamadas: sem ordem definida,
  // `pular` saltaria clientes diferentes a cada lote.
  const fila = [...(await repo.clientesComEntregaPendente())].sort();
  const idsDoLote = fila.slice(pular, pular + limite);
  const lote = await repo.clientesPorIds(idsDoLote);

  const resultado: ResultadoLote = { ...vazio, processados: lote.length };
  // `restantes` conta a fila INTEIRA, não o pedaço buscado — senão o painel
  // pararia achando que acabou no primeiro lote.
  resultado.restantes = Math.max(0, fila.length - (pular + idsDoLote.length));
  if (lote.length === 0) return resultado;

  // Concorrência modesta: a Google limita taxa, e estourar o limite devolve
  // erro para TODOS os endereços do lote — perder o lote inteiro é pior do que
  // demorar mais alguns segundos.
  const CONCORRENCIA = 10;
  const escritas: Array<{ colecao: 'clientes'; id: string; dados: Partial<Cliente>; merge: true }> =
    [];
  const comPonto = new Set<string>();

  for (let i = 0; i < lote.length; i += CONCORRENCIA) {
    const fatia = lote.slice(i, i + CONCORRENCIA);
    await Promise.all(
      fatia.map(async ({ id, ...cliente }) => {
        const r = await geocodificador.geocodificar(cliente.enderecoFiscal).catch(() => null);
        // Ponto preciso, ou aproximado NO MUNICÍPIO CERTO (rural): os dois
        // servem de partida — o motorista entrega e o app aprende a trilha na
        // primeira viagem. Fora do município é ponto errado com cara de certo.
        if (r && (r.precisa || r.municipioConfere)) {
          if (r.precisa) resultado.geocodificados += 1;
          else resultado.aproximados += 1;
          comPonto.add(id);
          escritas.push({
            colecao: 'clientes',
            id,
            dados: {
              coordenada: r.coordenada,
              statusMapeamento: r.precisa ? 'geocodificado' : 'aproximado',
            },
            merge: true,
          });
        } else {
          resultado.semResultado += 1;
        }
      }),
    );
  }

  // Os pedidos que esperavam esse ponto saem de "pendente de mapeamento" na
  // mesma leva — senão ficariam parados apontando para um cliente que já tem
  // coordenada, e só a montagem da rota reclamaria.
  const escritasPedidos: Array<{ colecao: 'pedidos'; id: string; dados: Pedido }> = [];
  if (comPonto.size > 0) {
    for (const { id, ...pedido } of await repo.listarPedidos()) {
      if (pedido.status !== 'pendente_de_mapeamento') continue;
      if (!comPonto.has(pedido.clienteId)) continue;
      escritasPedidos.push({
        colecao: 'pedidos',
        id,
        dados: { ...pedido, status: statusForaDeRota(pedido, true) },
      });
    }
  }

  await repo.gravarEmLote([...escritas, ...escritasPedidos]);
  return resultado;
}
