import {
  chaveDePonto,
  ehEnderecoRural,
  enderecosDivergem,
  formatarDia,
  normalizarTelefone,
  pontosRepetidos,
  type Cliente,
  type Pedido,
  type RelatorioImportacao,
  type StatusPedido,
} from '@rota/shared';
import {
  enderecoDeBloco,
  extrairCoordenada,
  lerPlanilha,
  type LinhaPlanilha,
} from './planilha.js';
import type { Repositorio } from '../db/repositorio.js';
import { removerPedido } from '../rotas/remover.js';
import { FORMATO_CODIGO_PEDIDO } from '../rotas/comum.js';

/**
 * Importação pela PLANILHA do ERP (`ConsultaPedidos_*.xlsx`) — o caminho que
 * substitui o XML no dia a dia (decisão de 01/08/2026).
 *
 * O que a planilha tem e a NF-e não tem: `Tipo de Entrega` explícito (rota ×
 * retirada, sem inferência), `SituaçãoComercial` (cancelamento, que na nota
 * mora num documento que o ERP não exporta), coordenada GPS digitada no
 * cadastro de ~50 revendedoras e os pontos de referência da entrega.
 *
 * ESCALA MANDOU NO DESENHO. A primeira versão fazia como o fluxo de XML — um
 * `get`/`set` por documento e geocodificação embutida — e não terminava: com
 * 2019 linhas × ~5 idas ao Firestore a 134 ms cada (medido em produção), eram
 * ~67 s só de banco, mais ~20 s de Google. O proxy do Render cortava a
 * requisição antes do fim e o navegador reportava "erro de CORS", que despista
 * completamente. Agora:
 *
 * 1. UMA consulta traz os ids de pedidos (dedupe) e UMA traz os clientes;
 * 2. tudo é decidido em memória;
 * 3. as escritas vão num `BulkWriter` só;
 * 4. a GEOCODIFICAÇÃO SAI DAQUI — vira passo próprio, em lotes, com progresso
 *    na tela (`/api/geocodificacoes`). Além de caber no tempo, dá ao Admin Estoque
 *    controle sobre uma chamada que é PAGA.
 */

/** Estrutura comercial do ERP → CD da operação. Códigos dados pelo usuário em
 * 01/08/2026 e conferidos no ciclo 11 (1.048 = 1337 pedidos, 1.515 = 664;
 * 18 "Consumidor Final" vêm sem estrutura). A série da NF-e acompanha o CD —
 * medido nas 3507 notas: Penedo emite série 1, Palmeira série 0. */
const CD_POR_ESTRUTURA: Record<string, { cdId: string; serie: number }> = {
  '1048': { cdId: 'penedo', serie: 1 },
  '1515': { cdId: 'palmeira', serie: 0 },
};
/** `CodCD` → CD. Conferido no ciclo 11: 542 acompanha a estrutura 1.048 em
 * 1337/1337 linhas e 684 a 1.515 em 664/664. É o que identifica o CD do
 * "Consumidor Final" (18 por ciclo), que vem sem estrutura — e entrava sem
 * CD, com série 0, aparecendo nas cidades do outro galpão. */
const CD_POR_CODCD: Record<string, { cdId: string; serie: number }> = {
  '542': { cdId: 'penedo', serie: 1 },
  '684': { cdId: 'palmeira', serie: 0 },
};

export function relatorioVazio(): RelatorioImportacao {
  return {
    total: 0,
    importados: 0,
    duplicados: 0,
    rejeitados: [],
    prontosParaRota: 0,
    pendentesDeMapeamento: 0,
    pendentesDeDecisao: 0,
    retiradas: 0,
    canceladas: 0,
    geocodificados: 0,
    aproximados: 0,
    alertas: [],
    porCd: {},
    semCarga: 0,
  };
}

export async function importarPlanilha(
  nomeArquivo: string,
  conteudo: Uint8Array,
  repo: Repositorio,
): Promise<RelatorioImportacao> {
  const relatorio = relatorioVazio();
  const leitura = lerPlanilha(conteudo);
  if (!leitura.ok) {
    relatorio.total = 1;
    relatorio.rejeitados.push({ arquivo: nomeArquivo, motivo: leitura.motivo });
    return relatorio;
  }
  await importarLinhas(leitura.linhas, repo, relatorio);
  return relatorio;
}

/**
 * O miolo da importação, a partir de linhas JÁ LIDAS: é o mesmo para a
 * planilha do ERP e para o romaneio do Boticário (que vira `LinhaPlanilha`
 * depois de casar cada destinatária com o cadastro). Assim o romaneio herda,
 * sem cópia, o dedupe, a revisão de endereço, o ponto repetido e a fila da
 * localização paga.
 *
 * `clientesExistentes` evita reler a coleção quando quem chama já leu (o
 * romaneio lê para casar os nomes).
 */
export async function importarLinhas(
  linhas: LinhaPlanilha[],
  repo: Repositorio,
  relatorio: RelatorioImportacao,
  opcoes: { clientesExistentes?: Array<{ id: string } & Cliente> } = {},
): Promise<void> {
  // Três consultas para a remessa inteira, em vez de duas por linha.
  const [chaves, clientesExistentes, cancelados] = await Promise.all([
    repo.chavesDePedidos(),
    opcoes.clientesExistentes ?? repo.listarClientes(),
    repo.idsDeCancelados(),
  ]);
  /** Id do pedido que já existe para este código: o da própria planilha, ou o
   * do XML do mesmo pedido (id = chave de 44 dígitos, `numeroPedido` = código). */
  const idExistente = (codigo: string): string | undefined =>
    chaves.ids.has(codigo) ? codigo : chaves.idPorNumero.get(codigo);
  const clientes = new Map<string, Cliente>(
    clientesExistentes.map(({ id, ...c }) => [id, c as Cliente]),
  );

  const escritasDePedido: Array<{ colecao: 'pedidos'; id: string; dados: Pedido }> = [];
  /**
   * UMA escrita por cliente, não uma por linha. A mesma revendedora costuma ter
   * várias notas no ciclo (2019 pedidos para 1366 clientes): empilhar uma
   * escrita por linha mandaria ~650 gravações redundantes ao banco e — pior —
   * misturaria um `set` do doc inteiro (1ª linha, cliente novo) com `merge`s
   * parciais (linhas seguintes) do MESMO documento no mesmo lote, cuja ordem
   * relativa não vale a pena depender. Acumular o estado final aqui resolve os
   * dois de uma vez.
   */
  const escritasDeCliente = new Map<
    string,
    { dados: Partial<Cliente>; merge: boolean }
  >();
  const vistos = new Set<string>();
  /** Um alerta de revisão POR CLIENTE, não por linha: a mesma revendedora tem
   * várias notas no ciclo, e repetir o aviso a cada uma afogaria os alertas
   * raros — a mesma inundação já consertada no aviso de retirada. */
  const revisaoAlertada = new Set<string>();
  const canceladosJaImportados: Array<{ linha: LinhaPlanilha; id: string }> = [];
  /** Cancelados vistos pela PRIMEIRA vez nesta remessa — viram marca no banco. */
  const canceladosNovos: LinhaPlanilha[] = [];
  /** Cancelados desta planilha: a linha ativa do MESMO código mais abaixo não
   * pode entrar — ela entraria e ficaria marcada como cancelada, e nunca mais
   * seria apagada. */
  const canceladosAqui = new Set<string>();
  let pinsDoCadastro = 0;
  let aGeocodificar = 0;

  for (const linha of linhas) {
    relatorio.total += 1;
    const rotulo = `pedido ${linha.codigoPedido}`;

    // Fora de Alagoas não se atende (decisão do usuário): rejeita com motivo,
    // em vez de importar um destino que nenhuma rota alcança.
    if (linha.enderecoEntrega.uf.trim().toUpperCase() !== 'AL') {
      relatorio.rejeitados.push({
        arquivo: rotulo,
        motivo: `UF ${linha.enderecoEntrega.uf || '?'} — a operação atende só AL`,
      });
      continue;
    }

    // Código do pedido e da pessoa viram ID de documento: no ERP são só dígitos
    // (9 no pedido, em 100% das linhas reais). Qualquer outra coisa ("__1__" é
    // id reservado do banco) era recusada na gravação — e derrubava a remessa.
    // Duas exceções, ambas do ROMANEIO: pedido do site vem como "160000001-1",
    // e a destinatária fora do cadastro ganha id de 64 hex (`idSemCadastro`).
    if (
      !FORMATO_CODIGO_PEDIDO.test(linha.codigoPedido) ||
      !/^(\d{1,20}|[0-9a-f]{64})$/.test(linha.pessoa)
    ) {
      relatorio.rejeitados.push({
        arquivo: rotulo,
        motivo: 'CodigoPedido ou Pessoa fora do formato do ERP (só dígitos)',
      });
      continue;
    }

    // `Tipo de Entrega` desconhecido: rejeitar, nunca chutar. Um rótulo novo do
    // ERP classificado no palpite mandaria caminhão para quem retira (ou o
    // contrário) sem ninguém perceber.
    if (linha.tipoEntrega === null) {
      relatorio.rejeitados.push({
        arquivo: rotulo,
        motivo: `Tipo de Entrega desconhecido ("${linha.tipoEntregaBruto}") — atualizar o importador`,
      });
      continue;
    }

    // Já cancelado numa importação anterior: uma planilha mais velha, de quando
    // ele ainda estava ativo, conta como repetida — não o traz de volta.
    // O pedido do site responde também pelo código da folha do romaneio
    // (`codigoExterno`): soltado pelas duas fontes, entrava duas vezes.
    const idJa = idExistente(linha.codigoPedido) ?? (linha.codigoExterno ? idExistente(linha.codigoExterno) : undefined);
    const jaExiste =
      idJa !== undefined ||
      vistos.has(linha.codigoPedido) ||
      (!!linha.codigoExterno && vistos.has(linha.codigoExterno)) ||
      cancelados.has(linha.codigoPedido);

    // Cancelado no ERP: não entra, e o que JÁ tinha entrado numa importação
    // anterior é apagado depois das gravações (ver `apagarCancelado`).
    if (linha.cancelada) {
      relatorio.canceladas = (relatorio.canceladas ?? 0) + 1;
      // Já tratado antes (apagado, ou alertado): repetir o alerta a cada
      // planilha que o traz afogaria os novos.
      if (cancelados.has(linha.codigoPedido)) continue;
      if (idJa !== undefined) {
        canceladosAqui.add(linha.codigoPedido);
        canceladosJaImportados.push({ linha, id: idJa });
        canceladosNovos.push(linha);
      } else if (!vistos.has(linha.codigoPedido)) {
        canceladosAqui.add(linha.codigoPedido);
        canceladosNovos.push(linha);
      } else {
        // Ativo numa linha e cancelado noutra da MESMA planilha: não dá para
        // saber qual vale, e o ativo já está na fila de gravação. Fica e avisa.
        relatorio.alertas.push({
          clienteId: linha.pessoa,
          nome: linha.nome,
          mensagem: `Pedido ${linha.codigoPedido} aparece ativo E cancelado na mesma planilha — ficou importado. Confira no ERP e, se estiver cancelado, apague pela aba Pedidos.`,
        });
      }
      continue;
    }

    if (canceladosAqui.has(linha.codigoPedido)) {
      relatorio.alertas.push({
        clienteId: linha.pessoa,
        nome: linha.nome,
        mensagem: `Pedido ${linha.codigoPedido} aparece cancelado E ativo na mesma planilha — ficou como cancelado. Confira no ERP.`,
      });
      continue;
    }

    if (jaExiste) {
      // Nem o "Entregue" do ERP mexe no que já está aqui: ele marca sozinho
      // depois de 6 dias, e um pedido esperando rota sairia da montagem sem
      // ter sido entregue. O estado daqui (baixa, liberação) é o que vale.
      relatorio.duplicados += 1;
      continue;
    }
    vistos.add(linha.codigoPedido);
    if (linha.codigoExterno) vistos.add(linha.codigoExterno);

    const cd =
      (linha.estrutura ? CD_POR_ESTRUTURA[linha.estrutura] : undefined) ??
      (linha.codCd ? CD_POR_CODCD[linha.codCd] : undefined);
    relatorio.porCd[cd?.cdId ?? '—'] = (relatorio.porCd[cd?.cdId ?? '—'] ?? 0) + 1;

    // Retirada usa o endereço do CADASTRO: o bloco de entrega dessas linhas
    // traz o endereço do PRÓPRIO CD (é para lá que a revendedora vai), e
    // gravá-lo no cliente apontaria toda entrega futura para o galpão.
    const linhaDeRota = linha.tipoEntrega === 'rota';
    const endereco = enderecoDeBloco(
      linhaDeRota ? linha.enderecoEntrega : linha.enderecoCadastro,
    );
    const telefone = normalizarTelefone(linha.telefone);
    // Numa linha de retirada o bloco de entrega descreve o CD: referência e
    // coordenada de lá não podem virar dado do CLIENTE — um pin no galpão é o
    // "ponto errado com cara de certo" que esta base mais teme.
    const referencia = (
      linhaDeRota
        ? linha.enderecoEntrega.referencia || linha.enderecoCadastro.referencia
        : linha.enderecoCadastro.referencia
    ).trim();
    // A linha de retirada não estabelece o LUGAR do cliente: nem o endereço,
    // nem o pin. O bloco de entrega dela descreve o CD (pin no galpão mandaria
    // toda entrega futura para lá), mas o GPS do CADASTRO também não pode
    // entrar por aqui: quem só retirou ainda não tem lugar de ENTREGA
    // estabelecido, e um pin gravado agora faz a PRIMEIRA linha de rota da
    // revendedora parecer mudança de endereço — cliente com pin + endereço
    // divergente abre revisão — prendendo na aba Decisões um pedido que nunca
    // mudou de lugar. Dava para reproduzir só reordenando duas linhas do mesmo
    // arquivo. O GPS não se perde: a primeira linha de rota lê a MESMA coluna
    // do cadastro.
    const pinDoCadastro = linhaDeRota
      ? (linha.pin ??
        extrairCoordenada([
          linha.enderecoCadastro.complemento,
          linha.enderecoCadastro.referencia,
          linha.enderecoEntrega.complemento,
          linha.enderecoEntrega.referencia,
        ]))
      : null;
    const gpsDoCadastroNaRetirada = linhaDeRota
      ? null
      : extrairCoordenada([linha.enderecoCadastro.complemento, linha.enderecoCadastro.referencia]);

    const existente = clientes.get(linha.pessoa);
    let cliente: Cliente;
    let enderecoAnterior: Cliente['enderecoFiscal'] | null = null;

    if (!existente) {
      cliente = {
        nome: linha.nome,
        // Sem CPF na planilha (de propósito — LGPD agradece): o código do ERP
        // identifica a revendedora em qualquer conversa com o Admin Estoque.
        // Fora da base não há código: o id é um hash de 64 letras, que na
        // coluna "Documento" só confundia.
        documentoMascarado: linha.foraDoCadastro ? 'fora da base' : `cód. ${linha.pessoa}`,
        telefone,
        email: null,
        enderecoFiscal: endereco,
        coordenada: pinDoCadastro,
        statusMapeamento: pinDoCadastro ? 'geocodificado' : 'nao_mapeado',
        trilhaAtivaId: null,
        mapeadoPor: null,
        mapeadoEm: null,
        fotoReferenciaPath: null,
        observacoes: referencia,
        enderecoEmRevisao: null,
        papel: linha.papel,
        // Só linha de rota estabelece o endereço de ENTREGA (a de retirada traz
        // o do cadastro): a primeira de rota que vier depois ainda o grava.
        enderecoDe: linhaDeRota ? linha.emitidoEm || null : null,
        // Só na CRIAÇÃO: o cliente que o Admin Estoque já completou (ou
        // dispensou) não volta para a lista no romaneio seguinte.
        ...(linha.foraDoCadastro ? { completarDados: true } : {}),
      };
      if (pinDoCadastro) pinsDoCadastro += 1;
      escritasDeCliente.set(linha.pessoa, { dados: cliente, merge: false });
    } else {
      // Mudança de endereço com ponto estabelecido (seção 8.3): o ponto foi
      // fixado para o endereço ANTIGO e pode não valer mais — o Admin Estoque
      // confirma. Revisão já aberta prevalece (o "antes" é o da primeira).
      //
      // SÓ linha de ROTA mexe no endereço. A de retirada carrega o endereço do
      // CADASTRO, que legitimamente diverge do de entrega em parte da base (42
      // casos no ciclo 11): deixá-la escrever fazia o cliente que alterna
      // rota/retirada trocar de endereço a cada remessa — e, tendo pin, cada
      // troca abria uma revisão falsa que TRAVAVA o pedido seguinte na aba
      // Decisões por uma mudança que nunca existiu.
      //
      // Nem a linha "Entregue" do ERP: ela não vai para o caminhão por padrão,
      // e abria uma revisão CALADA (sem alerta, sem cartão), deixando o pedido
      // pronto anterior com o pin velho e o texto do endereço novo.
      //
      // E só o endereço MAIS NOVO: com planilhas soltas fora de ordem, a mais
      // velha processada por último fazia o endereço regredir.
      const maisNova = !existente.enderecoDe || (linha.emitidoEm ?? '') >= existente.enderecoDe;
      const atualizaEndereco = linhaDeRota && !linha.entregueNoErp && maisNova;
      const mudouDeLugar =
        atualizaEndereco &&
        existente.coordenada !== null &&
        enderecosDivergem(existente.enderecoFiscal, endereco);
      const revisao = existente.enderecoEmRevisao ?? (mudouDeLugar ? existente.enderecoFiscal : null);
      enderecoAnterior = revisao;

      const campos: Partial<Cliente> = {
        nome: linha.nome,
        // Telefone: preenche quando a planilha traz; NUNCA apaga o que existe.
        // 413 de 2019 linhas do ciclo real vêm sem telefone e o ERP tem o
        // número (ele vai na NF-e) — a coluna é que fica em branco.
        telefone: telefone ?? existente.telefone,
      };
      if (atualizaEndereco) {
        campos.enderecoFiscal = endereco;
        campos.enderecoEmRevisao = revisao;
        if (linha.emitidoEm) campos.enderecoDe = linha.emitidoEm;
      }
      if (linha.papel && linha.papel !== existente.papel) campos.papel = linha.papel;
      // Pin do cadastro só entra em quem AINDA não tem ponto: nunca por cima do
      // pin que o motorista confirmou em campo.
      //
      // Nem o ponto que o Admin Estoque DESCARTOU ("refazer ponto"/"remapear"):
      // o mesmo GPS errado do cadastro voltava na planilha do dia seguinte.
      const descartado =
        pinDoCadastro !== null &&
        existente.pontoDescartado != null &&
        chaveDePonto(existente.pontoDescartado) === chaveDePonto(pinDoCadastro);
      if (!existente.coordenada && pinDoCadastro && !descartado) {
        campos.coordenada = pinDoCadastro;
        campos.statusMapeamento = 'geocodificado';
        pinsDoCadastro += 1;
      }
      // Referência alimenta o dossiê, mas NUNCA por cima do que o motorista
      // escreveu: o conhecimento de quem foi lá vale mais que o cadastro.
      if (referencia && !existente.observacoes) campos.observacoes = referencia;

      cliente = { ...existente, ...campos };
      // Cliente que NASCEU nesta remessa continua com a escrita completa: só
      // acumula os campos por cima, sem virar `merge` de um doc que ainda não
      // existe no banco.
      const anterior = escritasDeCliente.get(linha.pessoa);
      escritasDeCliente.set(linha.pessoa, {
        dados: anterior ? { ...anterior.dados, ...campos } : campos,
        merge: anterior ? anterior.merge : true,
      });
    }
    clientes.set(linha.pessoa, cliente);

    // "No endereço de entrega" que o ERP JÁ DÁ COMO ENTREGUE fica fora da
    // montagem, numa lista de onde o Admin Estoque libera o que não foi (ver
    // `liberacao.ts`). Entrava pronto para rota: no ciclo 11 eram 756 dos 1060.
    // Mas o ERP marca entregue sozinho depois de 6 dias, então não dá para
    // tratar como entregue de verdade — por isso status próprio, e não
    // `entregue`, que é o que a rota daqui confirmou e não se desfaz.
    const status: StatusPedido =
      linhaDeRota && linha.entregueNoErp
        ? 'entregue_no_erp'
        : statusDaLinha(linha, cliente, enderecoAnterior);
    if (status === 'pendente_de_mapeamento' && !cliente.coordenada) aGeocodificar += 1;
    if (status === 'pendente_de_decisao' && enderecoAnterior && !revisaoAlertada.has(linha.pessoa)) {
      revisaoAlertada.add(linha.pessoa);
      relatorio.alertas.push({
        clienteId: linha.pessoa,
        nome: linha.nome,
        mensagem:
          'Endereço do cadastro mudou — confirme na aba Decisões se o ponto atual ainda vale.',
      });
    }

    escritasDePedido.push({
      colecao: 'pedidos',
      id: linha.codigoPedido,
      dados: {
        numeroNota: linha.notaFiscal,
        serie: cd?.serie ?? 0,
        numeroPedido: linha.codigoPedido,
        lote: linha.lote,
        clienteId: linha.pessoa,
        emitidoEm: linha.emitidoEm,
        itens: [],
        valorTotal: linha.valor,
        volumes: linha.volumes,
        pesoBrutoKg: linha.pesoBrutoKg,
        quantidadeMateriais: linha.quantidadeMateriais,
        status,
        rotaId: null,
        xmlStoragePath: null,
        modoEntrega: linha.tipoEntrega,
        cdId: cd?.cdId ?? null,
        // A aba Decisões desenha o cartão — e a resposta acha o pedido — por
        // este campo, como no fluxo do XML. Sem ele, o pedido da planilha com
        // endereço em revisão ficava preso numa decisão que nenhuma tela mostrava.
        ...(status === 'pendente_de_decisao' && enderecoAnterior ? { enderecoAnterior } : {}),
        // Retirada não grava lugar no cliente, mas guarda o GPS do cadastro:
        // se for liberada para a rota, o ponto vem daqui (ver `liberacao.ts`).
        ...(!linhaDeRota && gpsDoCadastroNaRetirada ? { pinDoCadastro: gpsDoCadastroNaRetirada } : {}),
        // Também na retirada: a lista de liberação mostra o que o ERP afirma.
        ...(linha.entregueNoErp ? { entregueNoErp: { data: linha.dataEntrega } } : {}),
        ...(linha.romaneio ? { romaneio: linha.romaneio } : {}),
        ...(linha.codigoExterno ? { codigoExterno: linha.codigoExterno } : {}),
      },
    });
    relatorio.importados += 1;

    if (status === 'retirada') relatorio.retiradas = (relatorio.retiradas ?? 0) + 1;
    else if (status === 'entregue_no_erp') relatorio.jaEntregues = (relatorio.jaEntregues ?? 0) + 1;
    else if (status === 'pronto_para_rota') relatorio.prontosParaRota += 1;
    else if (status === 'pendente_de_decisao') relatorio.pendentesDeDecisao += 1;
    else relatorio.pendentesDeMapeamento += 1;

    // Peso zerado só importa para quem VAI NO CAMINHÃO (mesma régua do XML).
    if (status !== 'entregue_no_erp' && linhaDeRota && linha.volumes <= 0 && linha.pesoBrutoKg <= 0) {
      relatorio.semCarga += 1;
    }
  }

  // Ponto "exato" dividido com outro cliente de endereço diferente é o centro
  // da cidade/rua, não a porta (ver `pontoRepetido.ts`): vira aproximado, e o
  // PDF passa a pedir "confirme o local". Roda sobre TODOS os clientes, os de
  // importações anteriores também — é assim que os que já estão no banco se
  // corrigem. Pin confirmado em campo (`mapeado`) nunca é tocado.
  const repetidos = pontosRepetidos([...clientes].map(([id, c]) => ({ ...c, id })));
  let rebaixados = 0;
  for (const id of repetidos) {
    const c = clientes.get(id)!;
    if (c.statusMapeamento !== 'geocodificado') continue;
    clientes.set(id, { ...c, statusMapeamento: 'aproximado' });
    const anterior = escritasDeCliente.get(id);
    escritasDeCliente.set(id, {
      dados: { ...(anterior?.dados ?? {}), statusMapeamento: 'aproximado' },
      merge: anterior ? anterior.merge : true,
    });
    rebaixados += 1;
  }
  if (rebaixados > 0) {
    relatorio.alertas.push({
      clienteId: '',
      nome: 'Ponto repetido',
      mensagem: `${rebaixados} cliente(s) estavam com o MESMO ponto de outro endereço (é o centro da cidade ou da rua, não a porta) — passaram a "aproximado", e o PDF pede para confirmar o local.`,
    });
  }

  await repo.gravarEmLote([
    ...[...escritasDeCliente].map(([id, e]) => ({
      colecao: 'clientes' as const,
      id,
      dados: e.dados,
      merge: e.merge,
    })),
    ...escritasDePedido,
  ]);

  // Um a um e depois das gravações: são poucos por remessa (9 no ciclo 11
  // inteiro), e cada um pode mexer numa rota — o mesmo caminho do botão Apagar.
  for (const { linha, id } of canceladosJaImportados) {
    const resultado = await apagarCancelado(repo, linha, id);
    if (resultado.apagado) {
      relatorio.canceladasApagadas = (relatorio.canceladasApagadas ?? 0) + 1;
    }
    relatorio.alertas.push({ clienteId: linha.pessoa, nome: linha.nome, mensagem: resultado.mensagem });
  }
  // A marca vem DEPOIS de apagar: se a importação cair no meio, a próxima
  // planilha ainda encontra o pedido e o apaga — marcado antes, ele ficaria.
  const registradoEm = new Date().toISOString();
  await repo.registrarCancelados(
    canceladosNovos.map((l) => ({
      id: l.codigoPedido,
      dados: { notaFiscal: l.notaFiscal, clienteId: l.pessoa, registradoEm },
    })),
  );

  if (pinsDoCadastro > 0) {
    relatorio.alertas.push({
      clienteId: '',
      nome: 'Pin do cadastro',
      mensagem: `${pinsDoCadastro} cliente(s) tinham coordenada GPS digitada no cadastro do ERP — viraram pin exato, sem geocodificar nem mapear em campo.`,
    });
  }
  if (aGeocodificar > 0) {
    relatorio.alertas.push({
      clienteId: '',
      nome: 'Endereços a localizar',
      mensagem: `${aGeocodificar} entrega(s) ainda sem ponto no mapa. Use o botão "Localizar endereços", acima do relatório — a busca é paga e roda em lotes, por isso não vai junto com a importação.`,
    });
  }
}

/**
 * Pedido CANCELADO no ERP depois de importado: sai sozinho, e o relatório diz
 * que saiu. Antes era só um alerta mandando apagar pela aba Pedidos — e até
 * alguém fazer isso, o pedido seguia na montagem, podendo entrar numa rota e
 * ir no caminhão. O usuário pediu (17/10/2026): "se o pedido está cancelado,
 * deixe um alerta nele dizendo que está cancelado e elimine".
 *
 * O caminho é o do botão Apagar (`removerPedido`), que tira a parada da rota
 * junto. O que já foi entregue ou teve insucesso NÃO se apaga — é histórico da
 * operação, e um cancelamento depois da entrega é coisa para conferir com o ERP,
 * não para sumir em silêncio.
 */
async function apagarCancelado(
  repo: Repositorio,
  linha: LinhaPlanilha,
  id: string,
): Promise<{ apagado: boolean; mensagem: string }> {
  const quem = `Pedido ${linha.codigoPedido} (nota ${linha.notaFiscal}) foi CANCELADO no ERP`;
  const pedido = await repo.obterPedido(id);
  if (!pedido) return { apagado: false, mensagem: `${quem} — já não estava no sistema.` };

  const rota = pedido.status === 'em_rota' && pedido.rotaId ? await repo.obterRota(pedido.rotaId) : null;
  // O motivo fica gravado na ROTA que sobra: o alerta da importação aparece uma
  // vez só, e com o motorista no papel o cancelado podia ser entregue.
  const r = await removerPedido(repo, id, { motivo: 'cancelado no ERP' });
  if (!r.ok) {
    return { apagado: false, mensagem: `${quem}, mas NÃO foi apagado: ${r.erro}. Confira com o ERP.` };
  }
  if (!rota) return { apagado: true, mensagem: `${quem} — apagado automaticamente.` };

  // Saiu de uma rota: o PDF dela pode já estar no caminhão, com a parada lá.
  const dia = formatarDia(rota.data);
  const desfeita = r.rotaApagada ? ', que só tinha ele e foi desfeita' : '';
  return {
    apagado: true,
    mensagem:
      `${quem} — apagado e tirado da rota ${rota.id} de ${dia}${desfeita}. ` +
      'Se o PDF dessa rota já foi impresso, avise o motorista para NÃO entregar.',
  };
}

/**
 * Status do pedido SEM tocar a rede. Retirada não precisa de ponto (ninguém
 * vai lá); rota depende do cliente já ter coordenada — quem não tem espera o
 * passo de localização, que é separado justamente por ser pago e lento.
 */
function statusDaLinha(
  linha: LinhaPlanilha,
  cliente: Cliente,
  enderecoAnterior: Cliente['enderecoFiscal'] | null,
): StatusPedido {
  if (linha.tipoEntrega === 'retirada') return 'retirada';
  if (enderecoAnterior) return 'pendente_de_decisao';
  if (cliente.coordenada) return 'pronto_para_rota';
  return 'pendente_de_mapeamento';
}

/** Endereço rural é o caso que a geocodificação mais erra — exposto para o
 * passo de localização decidir o que vale a pena tentar. */
export { ehEnderecoRural };
