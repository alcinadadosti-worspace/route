import {
  ehEnderecoRural,
  type Cliente,
  type Pedido,
  type RelatorioImportacao,
  type StatusPedido,
} from '@rota/shared';
import { parseNfe, type NotaImportada } from '../nfe/parser.js';
import type { Repositorio } from '../db/repositorio.js';

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
  arquivos: ArquivoXml[],
  repo: Repositorio,
): Promise<RelatorioImportacao> {
  const relatorio: RelatorioImportacao = {
    total: arquivos.length,
    importados: 0,
    duplicados: 0,
    rejeitados: [],
    prontosParaRota: 0,
    pendentesDeMapeamento: 0,
    alertas: [],
  };

  for (const arquivo of arquivos) {
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
    const status = statusInicial(cliente);
    if (status === 'pronto_para_rota') relatorio.prontosParaRota += 1;
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
    };
    await repo.salvarPedido(nota.chaveAcesso, pedido);
    relatorio.importados += 1;
  }

  return relatorio;
}

/**
 * Seção 9 — classificação de destino na importação:
 * 1. cliente já tem coordenada confirmada → pronto_para_rota;
 * 2. heurística rural → pendente_de_mapeamento (sem gastar geocodificação);
 * 3. urbano plausível → geocodificação automática (Fase 2; até lá, pendente).
 */
function statusInicial(cliente: Cliente): StatusPedido {
  if (cliente.coordenada) return 'pronto_para_rota';
  return 'pendente_de_mapeamento';
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

export { ehEnderecoRural };
