import type { Cliente, EnderecoFiscal, GeoPonto, Pedido, StatusMapeamento } from '@rota/shared';
import { chaveDeEndereco, pontosRepetidos, statusForaDeRota } from '@rota/shared';
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
  const agora = new Date().toISOString();
  const comPonto = new Set<string>();
  const achados: Array<{ id: string; coordenada: GeoPonto; precisa: boolean; endereco: EnderecoFiscal }> = [];
  const falhas: Array<{ id: string; chave: string }> = [];

  for (let i = 0; i < lote.length; i += CONCORRENCIA) {
    const fatia = lote.slice(i, i + CONCORRENCIA);
    await Promise.all(
      fatia.map(async ({ id, ...cliente }) => {
        // Já tem ponto (GPS do cadastro trazido depois, retirada liberada):
        // só falta promover os pedidos. Buscar de novo pagaria a Google para
        // TROCAR um pin exato por um palpite.
        if (cliente.coordenada) {
          comPonto.add(id);
          return;
        }
        // Este MESMO endereço já foi buscado e não achou: não paga de novo. Cada
        // clique em "Localizar" pagava outra vez por todos os rurais do ciclo.
        // Endereço que muda (planilha nova) muda a chave, e aí tenta.
        const chave = chaveDeEndereco(cliente.enderecoFiscal);
        if (cliente.buscaSemResultado?.chave === chave) {
          resultado.semResultado += 1;
          return;
        }
        const r = await geocodificador.geocodificar(cliente.enderecoFiscal).catch(() => null);
        // Ponto preciso, ou aproximado NO MUNICÍPIO CERTO (rural): os dois
        // servem de partida — o motorista entrega e o app aprende a trilha na
        // primeira viagem. Fora do município é ponto errado com cara de certo.
        if (r && (r.precisa || r.municipioConfere)) {
          achados.push({ id, coordenada: r.coordenada, precisa: r.precisa, endereco: cliente.enderecoFiscal });
        } else {
          resultado.semResultado += 1;
          falhas.push({ id, chave });
        }
      }),
    );
  }

  // Ponto "exato" que cai em cima de outro cliente de endereço diferente é o
  // centro da cidade ou da rua (ver `pontoRepetido.ts`): vai como aproximado,
  // e o outro também, se era "exato".
  const vizinhos =
    achados.length > 0 ? await repo.clientesNasLatitudes(achados.map((a) => a.coordenada.lat)) : [];
  const idsAchados = new Set(achados.map((a) => a.id));
  const repetidos = pontosRepetidos([
    ...achados.map((a) => ({ id: a.id, coordenada: a.coordenada, enderecoFiscal: a.endereco })),
    ...vizinhos.filter((v) => !idsAchados.has(v.id)),
  ]);
  const exato = (a: (typeof achados)[number]) => a.precisa && !repetidos.has(a.id);

  const alteracoes: Array<{ id: string; seStatus: StatusMapeamento[]; dados: Partial<Cliente> }> = [
    // Só em quem AINDA está sem ponto: um pin confirmado em campo nos 10–20 s do
    // lote era sobrescrito pelo palpite da busca.
    ...achados.map((a) => ({
      id: a.id,
      seStatus: ['nao_mapeado'] as StatusMapeamento[],
      dados: {
        coordenada: a.coordenada,
        statusMapeamento: exato(a) ? 'geocodificado' : 'aproximado',
        buscaSemResultado: null,
      } satisfies Partial<Cliente>,
    })),
    ...vizinhos
      .filter((v) => repetidos.has(v.id) && v.statusMapeamento === 'geocodificado')
      .map((v) => ({
        id: v.id,
        seStatus: ['geocodificado'] as StatusMapeamento[],
        dados: { statusMapeamento: 'aproximado' } satisfies Partial<Cliente>,
      })),
    ...falhas.map((f) => ({
      id: f.id,
      seStatus: ['nao_mapeado'] as StatusMapeamento[],
      dados: { buscaSemResultado: { chave: f.chave, em: agora } } satisfies Partial<Cliente>,
    })),
  ];
  const pulados = new Set(await repo.atualizarClientesSe(alteracoes));
  for (const a of achados) {
    // Pulado = ganhou ponto por outro caminho no meio; o pedido segue esse.
    comPonto.add(a.id);
    if (pulados.has(a.id)) continue;
    if (exato(a)) resultado.geocodificados += 1;
    else resultado.aproximados += 1;
  }

  // Os pedidos que esperavam esse ponto saem de "pendente de mapeamento" na
  // mesma leva — senão ficariam parados apontando para um cliente que já tem
  // coordenada, e só a montagem da rota reclamaria.
  const promovidos: Array<{ id: string; statusEsperado: 'pendente_de_mapeamento'; dados: Pedido }> = [];
  if (comPonto.size > 0) {
    for (const { id, ...pedido } of await repo.pedidosComStatus('pendente_de_mapeamento')) {
      if (!comPonto.has(pedido.clienteId)) continue;
      promovidos.push({
        id,
        statusEsperado: 'pendente_de_mapeamento',
        dados: { ...pedido, status: statusForaDeRota(pedido, true) },
      });
    }
  }

  // Condicional: entre a leitura e aqui o pedido pode ter saído como exceção
  // numa rota, ou sido apagado — um `set` cego o desfaria.
  await repo.atualizarPedidosSeStatus(promovidos);
  return resultado;
}
