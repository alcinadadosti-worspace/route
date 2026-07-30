import {
  ehEnderecoRural,
  enderecosDivergem,
  validarGeoPonto,
  type Cliente,
  type EnderecoFiscal,
  type GeoPonto,
  type Pedido,
  type RelatorioImportacao,
  type StatusPedido,
} from '@rota/shared';
import { parseNfe, type NotaImportada } from '../nfe/parser.js';
import type { Repositorio } from '../db/repositorio.js';
import type { Geocodificador } from '../geocodificacao/google.js';

/**
 * Fluxo 1 — Importação do dia (seção 3): valida cada XML, deduplica pela chave
 * de acesso, cria/atualiza o cliente e registra o pedido. Reimportar o mesmo
 * arquivo é inócuo (RF-01).
 */

export interface ArquivoXml {
  nome: string;
  conteudo: string;
}

export type { RelatorioImportacao };

export async function importarXmls(
  // Aceita iterável assíncrono para permitir streaming: o handler HTTP lê e
  // parseia um arquivo por vez, sem bufferizar a remessa inteira em memória.
  arquivos: AsyncIterable<ArquivoXml> | Iterable<ArquivoXml>,
  repo: Repositorio,
  geocodificador: Geocodificador | null = null,
): Promise<RelatorioImportacao> {
  const relatorio: RelatorioImportacao = {
    total: 0,
    importados: 0,
    duplicados: 0,
    rejeitados: [],
    prontosParaRota: 0,
    pendentesDeMapeamento: 0,
    pendentesDeDecisao: 0,
    geocodificados: 0,
    aproximados: 0,
    alertas: [],
    porCd: {},
  };

  // Índice CNPJ → cdId, montado uma vez para a remessa toda (seção 8.5). O
  // emitente da nota é a filial que a emitiu; é ele que diz de qual CD o
  // pedido sai, sem ninguém digitar nada.
  const cds = await repo.obterCds();
  const cdPorCnpj = new Map(
    Object.entries(cds)
      .filter(([, cd]) => cd.cnpj)
      .map(([id, cd]) => [String(cd.cnpj).replace(/\D/g, ''), id]),
  );

  for await (const arquivo of arquivos) {
    relatorio.total += 1;
    const resultado = await parseNfe(arquivo.conteudo);
    if (!resultado.ok) {
      relatorio.rejeitados.push({ arquivo: arquivo.nome, motivo: resultado.motivo });
      continue;
    }
    const nota = resultado.nota;

    // Dedupe estrutural: chave de acesso é o ID do pedido (seção 7.2).
    if (await repo.obterPedido(nota.chaveAcesso)) {
      relatorio.duplicados += 1;
      continue;
    }

    const { cliente, enderecoAnterior, revisaoNova } = await upsertCliente(nota, repo);
    let status = await classificarDestino(
      nota.destinatario.clienteId,
      cliente,
      repo,
      geocodificador,
      relatorio,
    );

    // Mudança de endereço do cadastro (seção 8.3): a nota trouxe endereço fiscal
    // diferente daquele para o qual o ponto atual foi estabelecido. Roteirizar no
    // ponto velho levaria o motorista ao lugar errado (e, no rural, a trilha
    // aprendida reforçaria o engano), então o pedido espera a confirmação do
    // escritório. O pin NÃO é descartado aqui: quem decide é quem conhece.
    if (enderecoAnterior) {
      status = 'pendente_de_decisao';
      // Um alerta por cliente, não por nota: uma remessa com 5 notas dele faz a
      // mesma pergunta uma vez.
      if (revisaoNova) {
        relatorio.alertas.push({
          clienteId: nota.destinatario.clienteId,
          nome: nota.destinatario.nome,
          mensagem:
            'Endereço do cadastro mudou — confirme na aba Decisões se o ponto atual ainda vale.',
        });
      }
    }

    // Entrega em local diverso (seção 8.4): a nota traz endereço de entrega
    // diferente do fiscal. Geocodifica o candidato e deixa o pedido AGUARDANDO a
    // escolha do escritório — nunca roteiriza no palpite. O cadastro do cliente
    // segue com o endereço fiscal; o override mora no pedido.
    let enderecoEntrega: EnderecoFiscal | undefined;
    let coordenadaEntrega: GeoPonto | null | undefined;
    if (nota.enderecoEntrega) {
      enderecoEntrega = nota.enderecoEntrega;
      coordenadaEntrega = await geocodificarEntrega(nota.enderecoEntrega, geocodificador);
      status = 'pendente_de_decisao';
      relatorio.alertas.push({
        clienteId: nota.destinatario.clienteId,
        nome: nota.destinatario.nome,
        mensagem:
          'Nota com endereço de entrega diferente do fiscal — escolha qual usar na aba Decisões.',
      });
    }

    const cdId = nota.emitenteCnpj ? (cdPorCnpj.get(nota.emitenteCnpj) ?? null) : null;
    relatorio.porCd[cdId ?? '—'] = (relatorio.porCd[cdId ?? '—'] ?? 0) + 1;

    if (status === 'pronto_para_rota') relatorio.prontosParaRota += 1;
    else if (status === 'pendente_de_decisao') relatorio.pendentesDeDecisao += 1;
    else relatorio.pendentesDeMapeamento += 1;

    const pedido: Pedido = {
      numeroNota: nota.numeroNota,
      serie: nota.serie,
      numeroPedido: nota.numeroPedido,
      lote: nota.lote,
      clienteId: nota.destinatario.clienteId,
      emitidoEm: nota.emitidoEm,
      itens: nota.itens,
      valorTotal: nota.valorTotal,
      volumes: nota.volumes,
      pesoBrutoKg: nota.pesoBrutoKg,
      status,
      rotaId: null,
      xmlStoragePath: null,
      // Só carrega os campos de entrega quando há divergência — pedido normal
      // fica idêntico ao de antes do recurso (sem chaves indefinidas no doc).
      ...(enderecoEntrega ? { enderecoEntrega, coordenadaEntrega } : {}),
      ...(enderecoAnterior ? { enderecoAnterior } : {}),
      cdId,
    };
    await repo.salvarPedido(nota.chaveAcesso, pedido);
    relatorio.importados += 1;
  }

  return relatorio;
}

/**
 * Seção 9 — classificação de destino na importação. Geocodifica TODO destino
 * ainda sem coordenada (inclusive rural) e classifica pela precisão:
 * 1. cliente já com coordenada → pronto_para_rota;
 * 2. resultado PRECISO no município → coordenada exata, `geocodificado`, pronto;
 * 3. resultado APROXIMADO no município certo (rural / nível cidade) → serve de
 *    ponto de partida: coordenada grosseira, `aproximado`, pronto_para_rota — o
 *    motorista experiente entrega e o app aprende a trilha na 1ª viagem;
 * 4. sem resultado, fora do município, ou sem geocodificador → pendente_de_mapeamento.
 *
 * `relatorio` é nulo quando a chamada não vem de uma importação (reclassificação
 * depois de o escritório descartar um ponto vencido) — não há o que contabilizar.
 */
async function classificarDestino(
  clienteId: string,
  cliente: Cliente,
  repo: Repositorio,
  geocodificador: Geocodificador | null,
  relatorio: RelatorioImportacao | null,
): Promise<StatusPedido> {
  if (cliente.coordenada) return 'pronto_para_rota';
  if (!geocodificador) return 'pendente_de_mapeamento';

  const resultado = await geocodificador.geocodificar(cliente.enderecoFiscal).catch(() => null);
  if (!resultado) return 'pendente_de_mapeamento';

  if (resultado.precisa) {
    // Update por CAMPO, não `set` do documento inteiro: entre a leitura do
    // cliente e esta escrita houve uma ida à Google, e um motorista em campo
    // pode ter gravado pin, foto ou observações nesse intervalo — reescrever o
    // doc com a cópia lida antes apagaria esse trabalho em silêncio.
    await repo.atualizarCliente(clienteId, {
      coordenada: resultado.coordenada,
      statusMapeamento: 'geocodificado',
    });
    if (relatorio) relatorio.geocodificados += 1;
    return 'pronto_para_rota';
  }

  if (resultado.municipioConfere) {
    // Ponto aproximado no município certo: despachável com ponto grosseiro, mas
    // marcado como `aproximado` — o motorista mapeia em campo na 1ª entrega.
    await repo.atualizarCliente(clienteId, {
      coordenada: resultado.coordenada,
      statusMapeamento: 'aproximado',
    });
    if (relatorio) relatorio.aproximados += 1;
    return 'pronto_para_rota';
  }

  return 'pendente_de_mapeamento'; // fora do município → ponto errado, descarta
}

/**
 * Geocodifica o endereço de ENTREGA divergente (candidato B da decisão, seção
 * 8.4). Mesma disciplina da seção 9: pula rural e aceita só resultado preciso —
 * o que não resolver, o escritório posiciona no mapa da tela de decisão.
 */
async function geocodificarEntrega(
  endereco: EnderecoFiscal,
  geocodificador: Geocodificador | null,
): Promise<GeoPonto | null> {
  if (!geocodificador || ehEnderecoRural(endereco)) return null;
  const resultado = await geocodificador.geocodificar(endereco).catch(() => null);
  return resultado?.precisa ? resultado.coordenada : null;
}

interface ResultadoUpsert {
  cliente: Cliente;
  /**
   * Endereço fiscal para o qual o ponto atual foi estabelecido — presente
   * enquanto a revisão do ponto estiver aberta (mudança relevante de endereço
   * num cliente que já tinha ponto). É o gatilho da decisão da seção 8.3;
   * ausente significa "nada a questionar".
   */
  enderecoAnterior?: EnderecoFiscal;
  /** A revisão começou NESTA nota — só então vale alertar (uma vez por remessa). */
  revisaoNova: boolean;
}

/**
 * Seção 8.3: a nota é mais recente que o cadastro — atualiza contato e endereço
 * fiscal, preservando coordenada, statusMapeamento e trilhas.
 */
async function upsertCliente(nota: NotaImportada, repo: Repositorio): Promise<ResultadoUpsert> {
  const { clienteId } = nota.destinatario;
  const existente = await repo.obterCliente(clienteId);

  if (!existente) {
    const novo: Cliente = {
      nome: nota.destinatario.nome,
      documentoMascarado: nota.destinatario.documentoMascarado,
      telefone: nota.destinatario.telefone,
      email: nota.destinatario.email,
      enderecoFiscal: nota.destinatario.enderecoFiscal,
      coordenada: null,
      statusMapeamento: 'nao_mapeado',
      trilhaAtivaId: null,
      mapeadoPor: null,
      mapeadoEm: null,
      fotoReferenciaPath: null,
      observacoes: '',
      enderecoEmRevisao: null,
    };
    await repo.salvarCliente(clienteId, novo);
    return { cliente: novo, revisaoNova: false };
  }

  // `enderecosDivergem` compara os campos que mudam o LUGAR (logradouro, número,
  // bairro, município, UF, CEP) já normalizados — diferença só de formatação ou
  // de complemento não vira decisão para o escritório resolver à toa.
  // Sem coordenada não há ponto velho para questionar: a classificação vai
  // geocodificar o endereço novo normalmente, que é o comportamento certo.
  const mudouDeLugar =
    existente.coordenada !== null &&
    enderecosDivergem(existente.enderecoFiscal, nota.destinatario.enderecoFiscal);

  // Uma revisão já aberta prevalece: o ponto pertence ao endereço da PRIMEIRA
  // divergência, e mudanças encadeadas antes da decisão não podem reescrever
  // essa referência (senão o "antes" que o escritório vê seria o intermediário).
  const revisaoAberta = existente.enderecoEmRevisao ?? null;
  const enderecoEmRevisao = revisaoAberta ?? (mudouDeLugar ? existente.enderecoFiscal : null);

  // Só os campos que a nota traz — `set` do doc inteiro reescreveria pin, foto e
  // observações com a cópia lida acima, apagando o que o campo tivesse gravado
  // no intervalo (a importação roda com motoristas na rua).
  const campos = {
    nome: nota.destinatario.nome,
    telefone: nota.destinatario.telefone ?? existente.telefone,
    email: nota.destinatario.email ?? existente.email,
    enderecoFiscal: nota.destinatario.enderecoFiscal,
    enderecoEmRevisao,
  };
  const atualizado: Cliente = { ...existente, ...campos };
  await repo.atualizarCliente(clienteId, campos);
  return enderecoEmRevisao
    ? { cliente: atualizado, enderecoAnterior: enderecoEmRevisao, revisaoNova: !revisaoAberta }
    : { cliente: atualizado, revisaoNova: false };
}

export type ResultadoDecisao =
  | { ok: true; status: StatusPedido }
  | { ok: false; status: number; erro: string };

/**
 * Resolve a ambiguidade de endereço (seção 8.4): o escritório escolhe entre o
 * endereço fiscal (do cliente) e o de entrega (da nota). A escolha vira override
 * no pedido — nunca toca o cadastro do cliente, que segue com o endereço fiscal
 * canônico. Sem coordenada no escolhido, o pedido cai em mapeamento.
 */
export async function decidirEnderecoEntrega(
  repo: Repositorio,
  pedidoId: string,
  escolha: 'fiscal' | 'entrega',
  coordenada?: GeoPonto | null,
): Promise<ResultadoDecisao> {
  if (escolha !== 'fiscal' && escolha !== 'entrega') {
    return { ok: false, status: 400, erro: 'Escolha inválida (fiscal ou entrega)' };
  }
  const pedido = await repo.obterPedido(pedidoId);
  if (!pedido) return { ok: false, status: 404, erro: 'Pedido não encontrado' };
  if (pedido.status !== 'pendente_de_decisao' || !pedido.enderecoEntrega) {
    return { ok: false, status: 409, erro: 'Pedido não está aguardando decisão de endereço' };
  }

  if (escolha === 'fiscal') {
    // Quando o cadastro TAMBÉM mudou de endereço (seção 8.3), escolher o fiscal
    // ainda deixa em aberto a pergunta do ponto antigo — o pedido continua em
    // decisão, agora só com ela. `usarEnderecoEntrega: false` registra que a
    // pergunta da entrega já foi respondida e tira este cartão da fila.
    if (pedido.enderecoAnterior) {
      await repo.salvarPedido(pedidoId, { ...pedido, usarEnderecoEntrega: false });
      return { ok: true, status: 'pendente_de_decisao' };
    }
    const cliente = await repo.obterCliente(pedido.clienteId);
    const status: StatusPedido = cliente?.coordenada ? 'pronto_para_rota' : 'pendente_de_mapeamento';
    await repo.salvarPedido(pedidoId, { ...pedido, usarEnderecoEntrega: false, status });
    return { ok: true, status };
  }

  // escolha === 'entrega': usa a coordenada ajustada no mapa; senão a que a
  // importação geocodificou. EXIGE um ponto — "entregar em local X" sem saber X
  // não roteiriza, e mapear o cliente depois não resolveria o override (o pedido
  // ficaria preso). Sem coordenada, o operador precisa posicionar o pin.
  const coord = validarGeoPonto(coordenada) ?? pedido.coordenadaEntrega ?? null;
  if (!coord) {
    return {
      ok: false,
      status: 400,
      erro: 'Posicione o pin do endereço de entrega no mapa antes de confirmar',
    };
  }
  await repo.salvarPedido(pedidoId, {
    ...pedido,
    usarEnderecoEntrega: true,
    coordenadaEntrega: coord,
    status: 'pronto_para_rota',
  });
  return { ok: true, status: 'pronto_para_rota' };
}

/**
 * Apaga um pedido importado por engano (nota trocada, remessa duplicada de
 * outro dia). O CLIENTE fica: coordenada, pin de campo, trilha e dossiê são
 * conhecimento sobre o lugar, não sobre a nota — e reimportar o mesmo XML
 * recria o pedido reaproveitando tudo isso.
 *
 * Recusa o que já saiu do escritório: pedido `em_rota` está impresso no
 * documento da rota e no celular do motorista, e apagá-lo deixaria uma parada
 * apontando para nada, cuja confirmação de entrega falharia em campo, longe de
 * quem poderia entender o porquê. Entregue ou insucesso é histórico, com
 * registro de entrega apontando para ele.
 */
export async function apagarPedidoImportado(
  repo: Repositorio,
  pedidoId: string,
): Promise<ResultadoDecisao> {
  const pedido = await repo.obterPedido(pedidoId);
  if (!pedido) return { ok: false, status: 404, erro: 'Pedido não encontrado' };

  const bloqueados: Record<string, string> = {
    em_rota: 'já está numa rota publicada — a parada ficaria apontando para nada no app do motorista',
    entregue: 'já foi entregue — é histórico da operação',
    insucesso: 'já tem insucesso registrado — é histórico da operação',
  };
  const motivo = bloqueados[pedido.status];
  if (motivo) {
    return { ok: false, status: 409, erro: `Nota ${pedido.numeroNota} ${motivo}` };
  }

  await repo.apagarPedido(pedidoId);
  return { ok: true, status: pedido.status };
}

/**
 * Resolve a mudança de endereço do cadastro (seção 8.3): o cliente passou a ter
 * outro endereço fiscal e já tinha um ponto estabelecido para o anterior. Quem
 * conhece a operação decide se aquele ponto sobrevive à mudança.
 * - `manter`: era mudança de cadastro, não de lugar (ou o operador sabe que a
 *   entrega continua no mesmo ponto) — o pedido volta ao fluxo normal.
 * - `remapear`: o ponto morreu com o endereço antigo. Descarta coordenada,
 *   autoria e trilha ativa e reclassifica pelo endereço NOVO: se ele
 *   geocodificar, o pedido já sai despachável; se não (o caso rural), vai para
 *   mapeamento em campo, que é como um destino novo sempre entra.
 */
export async function decidirMudancaEndereco(
  repo: Repositorio,
  pedidoId: string,
  escolha: 'manter' | 'remapear',
  geocodificador: Geocodificador | null = null,
): Promise<ResultadoDecisao> {
  if (escolha !== 'manter' && escolha !== 'remapear') {
    return { ok: false, status: 400, erro: 'Escolha inválida (manter ou remapear)' };
  }
  const pedido = await repo.obterPedido(pedidoId);
  if (!pedido) return { ok: false, status: 404, erro: 'Pedido não encontrado' };
  if (pedido.status !== 'pendente_de_decisao' || !pedido.enderecoAnterior) {
    return {
      ok: false,
      status: 409,
      erro: 'Pedido não está aguardando decisão de mudança de endereço',
    };
  }
  // Com a pergunta da entrega ainda aberta, responder esta primeiro pularia
  // aquela: a rota sairia pelo cadastro sem o escritório ter escolhido.
  if (pedido.enderecoEntrega && pedido.usarEnderecoEntrega === undefined) {
    return {
      ok: false,
      status: 409,
      erro: 'Responda antes a decisão de endereço de entrega desta nota',
    };
  }
  const cliente = await repo.obterCliente(pedido.clienteId);
  if (!cliente) return { ok: false, status: 404, erro: 'Cliente não encontrado' };

  if (escolha === 'manter') {
    const status: StatusPedido = cliente.coordenada ? 'pronto_para_rota' : 'pendente_de_mapeamento';
    await repo.atualizarCliente(pedido.clienteId, { enderecoEmRevisao: null });
    await liberarPedidosEmRevisao(repo, pedido.clienteId, status);
    return { ok: true, status };
  }

  // O ponto vencido sai ANTES da reclassificação: com a coordenada ainda no
  // cadastro, classificarDestino curto-circuitaria em 'pronto_para_rota' e o
  // endereço novo nunca seria geocodificado. Junto do pin e da trilha vai o
  // dossiê: a foto da fachada e as observações ("portão azul", "entrar pela
  // lateral") descrevem o local ANTIGO e no endereço novo enganariam o
  // motorista tanto quanto o pin vencido.
  const limpeza = {
    coordenada: null,
    statusMapeamento: 'nao_mapeado',
    mapeadoPor: null,
    mapeadoEm: null,
    trilhaAtivaId: null,
    fotoReferenciaPath: null,
    observacoes: '',
    enderecoEmRevisao: null,
  } satisfies Partial<Cliente>;
  const semPonto: Cliente = { ...cliente, ...limpeza };
  await repo.atualizarCliente(pedido.clienteId, limpeza);
  // A trilha aprendida levava ao endereço antigo: desativa para não reaparecer
  // como "anterior" num reaprendizado. Escrita separada de propósito — se ela
  // falhar sobra uma trilha ativa que ninguém lê (o cliente já não aponta para
  // ela), o que é bem menos grave do que o cadastro ficar com o ponto vencido.
  if (cliente.trilhaAtivaId) await repo.atualizarTrilha(cliente.trilhaAtivaId, { ativa: false });

  const status = await classificarDestino(pedido.clienteId, semPonto, repo, geocodificador, null);
  await liberarPedidosEmRevisao(repo, pedido.clienteId, status);
  return { ok: true, status };
}

/**
 * Refaz o ponto de um cliente a pedido do escritório (RF-23). Existe porque
 * havia um beco sem saída: uma vez `mapeado`, o pin não tem correção. O app do
 * motorista só oferece o ajuste para destino `aproximado`/`nao_mapeado`, então
 * um pin marcado no lugar errado — um teste feito dentro do CD, um toque torto
 * em movimento — virava o ponto oficial de entrega daquele cliente para sempre.
 *
 * Descarta coordenada, autoria e trilha, e reclassifica pelo endereço atual
 * (geocodifica se der; senão volta para mapeamento em campo). **Preserva o
 * dossiê**: pin errado não invalida a foto da fachada nem as observações do
 * local — quem descarta o dossiê é a mudança de endereço (seção 8.3), porque
 * ali o LUGAR mudou.
 */
export async function refazerPontoDoCliente(
  repo: Repositorio,
  clienteId: string,
  geocodificador: Geocodificador | null = null,
): Promise<ResultadoDecisao> {
  const cliente = await repo.obterCliente(clienteId);
  if (!cliente) return { ok: false, status: 404, erro: 'Cliente não encontrado' };

  const limpeza = {
    coordenada: null,
    statusMapeamento: 'nao_mapeado',
    mapeadoPor: null,
    mapeadoEm: null,
    trilhaAtivaId: null,
  } satisfies Partial<Cliente>;
  await repo.atualizarCliente(clienteId, limpeza);
  if (cliente.trilhaAtivaId) await repo.atualizarTrilha(cliente.trilhaAtivaId, { ativa: false });

  const status = await classificarDestino(
    clienteId,
    { ...cliente, ...limpeza },
    repo,
    geocodificador,
    null,
  );

  // Os pedidos ainda não roteirizados seguem o ponto: sem isto, um pedido
  // continuaria marcado "pronto para rota" apontando para um cliente que
  // acabou de ficar sem coordenada, e só a montagem da rota reclamaria.
  for (const { id, ...pedido } of await repo.listarPedidos()) {
    if (pedido.clienteId !== clienteId) continue;
    if (pedido.status !== 'pronto_para_rota' && pedido.status !== 'pendente_de_mapeamento') continue;
    if (pedido.status !== status) await repo.salvarPedido(id, { ...pedido, status });
  }

  return { ok: true, status };
}

/**
 * Solta os pedidos que estavam presos SÓ pela revisão do ponto (seção 8.3) —
 * inclusive o que motivou a decisão. Uma remessa com várias notas do mesmo
 * cliente faz a pergunta uma vez, não uma por nota. Quem ainda deve a decisão
 * de endereço de ENTREGA (seção 8.4) fica na fila: são perguntas diferentes.
 */
async function liberarPedidosEmRevisao(
  repo: Repositorio,
  clienteId: string,
  status: StatusPedido,
): Promise<void> {
  for (const { id, ...dados } of await repo.listarPedidos()) {
    if (dados.clienteId !== clienteId) continue;
    if (dados.status !== 'pendente_de_decisao' || !dados.enderecoAnterior) continue;
    if (dados.enderecoEntrega && dados.usarEnderecoEntrega === undefined) continue;
    await repo.salvarPedido(id, { ...dados, status });
  }
}

export { ehEnderecoRural };
