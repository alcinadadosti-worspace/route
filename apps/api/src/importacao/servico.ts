import {
  ehEnderecoRural,
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
  };

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

    const cliente = await upsertCliente(nota, repo, relatorio);
    let status = await classificarDestino(
      nota.destinatario.clienteId,
      cliente,
      repo,
      geocodificador,
      relatorio,
    );

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
 */
async function classificarDestino(
  clienteId: string,
  cliente: Cliente,
  repo: Repositorio,
  geocodificador: Geocodificador | null,
  relatorio: RelatorioImportacao,
): Promise<StatusPedido> {
  if (cliente.coordenada) return 'pronto_para_rota';
  if (!geocodificador) return 'pendente_de_mapeamento';

  const resultado = await geocodificador.geocodificar(cliente.enderecoFiscal).catch(() => null);
  if (!resultado) return 'pendente_de_mapeamento';

  if (resultado.precisa) {
    await repo.salvarCliente(clienteId, {
      ...cliente,
      coordenada: resultado.coordenada,
      statusMapeamento: 'geocodificado',
    });
    relatorio.geocodificados += 1;
    return 'pronto_para_rota';
  }

  if (resultado.municipioConfere) {
    // Ponto aproximado no município certo: despachável com ponto grosseiro, mas
    // marcado como `aproximado` — o motorista mapeia em campo na 1ª entrega.
    await repo.salvarCliente(clienteId, {
      ...cliente,
      coordenada: resultado.coordenada,
      statusMapeamento: 'aproximado',
    });
    relatorio.aproximados += 1;
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

/**
 * Seção 8.3: a nota é mais recente que o cadastro — atualiza contato e endereço
 * fiscal, preservando coordenada, statusMapeamento e trilhas.
 */
async function upsertCliente(
  nota: NotaImportada,
  repo: Repositorio,
  relatorio: RelatorioImportacao,
): Promise<Cliente> {
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
    };
    await repo.salvarCliente(clienteId, novo);
    return novo;
  }

  const enderecoMudou =
    JSON.stringify(existente.enderecoFiscal) !== JSON.stringify(nota.destinatario.enderecoFiscal);
  if (enderecoMudou && existente.statusMapeamento === 'mapeado') {
    relatorio.alertas.push({
      clienteId,
      nome: nota.destinatario.nome,
      mensagem: 'Endereço da nota mudou; o pin continua válido?',
    });
  }

  const atualizado: Cliente = {
    ...existente,
    nome: nota.destinatario.nome,
    telefone: nota.destinatario.telefone ?? existente.telefone,
    email: nota.destinatario.email ?? existente.email,
    enderecoFiscal: nota.destinatario.enderecoFiscal,
  };
  await repo.salvarCliente(clienteId, atualizado);
  return atualizado;
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
  if (pedido.status !== 'pendente_de_decisao') {
    return { ok: false, status: 409, erro: 'Pedido não está aguardando decisão de endereço' };
  }

  if (escolha === 'fiscal') {
    const cliente = await repo.obterCliente(pedido.clienteId);
    const status: StatusPedido = cliente?.coordenada ? 'pronto_para_rota' : 'pendente_de_mapeamento';
    await repo.salvarPedido(pedidoId, { ...pedido, usarEnderecoEntrega: false, status });
    return { ok: true, status };
  }

  // escolha === 'entrega': usa a coordenada ajustada no mapa; senão a que a
  // importação geocodificou. EXIGE um ponto — "entregar em local X" sem saber X
  // não roteiriza, e mapear o cliente depois não resolveria o override (o pedido
  // ficaria preso). Sem coordenada, o operador precisa posicionar o pin.
  const coord = validarCoordenada(coordenada) ?? pedido.coordenadaEntrega ?? null;
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

function validarCoordenada(c: GeoPonto | null | undefined): GeoPonto | null {
  if (!c || typeof c.lat !== 'number' || typeof c.lng !== 'number') return null;
  if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) return null;
  if (c.lat < -90 || c.lat > 90 || c.lng < -180 || c.lng > 180) return null;
  return { lat: c.lat, lng: c.lng };
}

export { ehEnderecoRural };
