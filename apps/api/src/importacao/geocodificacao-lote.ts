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
 *    escritório ver quanto vai gastar e parar no meio se quiser.
 */

export interface ResultadoLote {
  /** Quantos clientes ainda esperam ponto DEPOIS deste lote. */
  restantes: number;
  processados: number;
  geocodificados: number;
  aproximados: number;
  semResultado: number;
}

/** Tamanho do lote: cabe folgado numa requisição (~20 s no pior caso) e dá
 * progresso visível de verdade. Não é para maximizar — é para nunca estourar. */
export const TAMANHO_DO_LOTE = 100;

export async function localizarEnderecos(
  repo: Repositorio,
  geocodificador: Geocodificador | null,
  limite = TAMANHO_DO_LOTE,
): Promise<ResultadoLote> {
  if (!geocodificador) {
    return { restantes: 0, processados: 0, geocodificados: 0, aproximados: 0, semResultado: 0 };
  }

  const [clientes, pedidos] = await Promise.all([repo.listarClientes(), repo.listarPedidos()]);

  // Só clientes SEM ponto que têm pedido esperando entrega. Sem o segundo
  // filtro, a operação pagaria para localizar quem só faz retirada — que é
  // metade da base e nunca recebe visita.
  const esperandoEntrega = new Set(
    pedidos
      .filter((p) => p.status === 'pendente_de_mapeamento')
      .map((p) => p.clienteId),
  );
  const pendentes = clientes.filter((c) => !c.coordenada && esperandoEntrega.has(c.id));
  const lote = pendentes.slice(0, limite);

  const resultado: ResultadoLote = {
    restantes: Math.max(0, pendentes.length - lote.length),
    processados: lote.length,
    geocodificados: 0,
    aproximados: 0,
    semResultado: 0,
  };
  if (lote.length === 0) return resultado;

  // Concorrência modesta: a Google limita taxa, e estourar o limite devolve
  // erro para TODOS os endereços do lote — perder o lote inteiro é pior do que
  // demorar mais alguns segundos.
  const CONCORRENCIA = 10;
  const escritas: Array<{ colecao: 'clientes'; id: string; dados: Partial<Cliente>; merge: true }> =
    [];
  const comPonto = new Map<string, Cliente['coordenada']>();

  for (let i = 0; i < lote.length; i += CONCORRENCIA) {
    const fatia = lote.slice(i, i + CONCORRENCIA);
    await Promise.all(
      fatia.map(async ({ id, ...cliente }) => {
        const r = await geocodificador.geocodificar(cliente.enderecoFiscal).catch(() => null);
        if (!r) {
          resultado.semResultado += 1;
          return;
        }
        // Ponto preciso, ou aproximado NO MUNICÍPIO CERTO (rural): os dois
        // servem de partida — o motorista entrega e o app aprende a trilha na
        // primeira viagem. Fora do município é ponto errado com cara de certo.
        if (r.precisa) {
          resultado.geocodificados += 1;
          comPonto.set(id, r.coordenada);
          escritas.push({
            colecao: 'clientes',
            id,
            dados: { coordenada: r.coordenada, statusMapeamento: 'geocodificado' },
            merge: true,
          });
        } else if (r.municipioConfere) {
          resultado.aproximados += 1;
          comPonto.set(id, r.coordenada);
          escritas.push({
            colecao: 'clientes',
            id,
            dados: { coordenada: r.coordenada, statusMapeamento: 'aproximado' },
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
  for (const { id, ...pedido } of pedidos) {
    if (pedido.status !== 'pendente_de_mapeamento') continue;
    if (!comPonto.has(pedido.clienteId)) continue;
    escritasPedidos.push({
      colecao: 'pedidos',
      id,
      dados: { ...pedido, status: statusForaDeRota(pedido, true) },
    });
  }

  await repo.gravarEmLote([...escritas, ...escritasPedidos]);
  return resultado;
}
