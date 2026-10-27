import type { RelatorioImportacao } from '@rota/shared';
import { lerCadastro, type LinhaCadastro } from './cadastro.js';
import { relatorioVazio } from './servico-planilha.js';
import { guardarRevendedoras, revendedoraDoCadastro, revendedorasDosPedidos } from './revendedoras.js';
import type { LinhaPlanilha } from './planilha.js';
import type { Repositorio, Revendedora } from '../db/repositorio.js';

/**
 * Importa o cadastro de revendedoras do ERP para a base que o romaneio consulta
 * (`revendedoras/`, à parte dos clientes — ver `Revendedora`). Manda-se UMA vez
 * e fica guardado; o romaneio, que não traz código nem telefone, casa cada
 * destinatária com a pessoa certa por ela.
 *
 * Não geocodifica nada: a busca é paga, e só quem tiver pedido precisa de ponto.
 */
export async function importarCadastro(
  nomeArquivo: string,
  conteudo: Uint8Array,
  repo: Repositorio,
): Promise<RelatorioImportacao | null> {
  const relatorio = relatorioVazio();
  const leitura = lerCadastro(conteudo);
  // null = é outro .xlsx (a planilha de pedidos): quem chama manda para lá. A
  // decisão é pelo CABEÇALHO, não pelo nome do arquivo, que o operador renomeia.
  if (!leitura.ok && leitura.naoEhCadastro) return null;
  if (!leitura.ok) {
    relatorio.total = 1;
    relatorio.rejeitados.push({ arquivo: nomeArquivo, motivo: leitura.motivo });
    return relatorio;
  }
  await gravarCadastro(leitura.linhas, repo, relatorio);
  return relatorio;
}

/** A gravação a partir das linhas já lidas — a mesma usada pelo script que
 * carrega o cadastro completo, grande demais para passar pelo servidor. */
export async function gravarCadastro(
  linhas: LinhaCadastro[],
  repo: Repositorio,
  relatorio: RelatorioImportacao,
): Promise<void> {
  const novas = new Map<string, Revendedora>();
  for (const linha of linhas) {
    relatorio.total += 1;
    // Mesma regra de id da planilha de pedidos: o código vira id de documento.
    if (!/^\d{1,20}$/.test(linha.codigo)) {
      relatorio.rejeitados.push({ arquivo: `revendedora ${linha.codigo}`, motivo: 'CodigoRevendedor fora do formato' });
      continue;
    }
    // A mesma revendedora repetida (duas abas): vale a primeira.
    if (!novas.has(linha.codigo)) novas.set(linha.codigo, revendedoraDoCadastro(linha));
  }
  await guardarRevendedoras(novas, repo, relatorio);
  relatorio.alertas.push({
    clienteId: '',
    nome: 'Cadastro de revendedoras',
    mensagem:
      `${novas.size} revendedora(s) guardadas para casar os romaneios; ${relatorio.clientesAtualizados ?? 0} cliente(s) já existentes completados (telefone, papel ou GPS que faltavam). ` +
      'Não precisa reenviar a cada romaneio.',
  });
}

/**
 * Pedidos do ERP (planilha `ConsultaPedidos`) usados SÓ como dado de cliente —
 * nenhum pedido é criado. O usuário mandou os pedidos de 2026 para a base ficar
 * com o endereço e o telefone mais novos de cada revendedora.
 */
export async function gravarClientesDosPedidos(
  linhas: LinhaPlanilha[],
  repo: Repositorio,
  relatorio: RelatorioImportacao,
): Promise<void> {
  relatorio.total += linhas.length;
  await guardarRevendedoras(revendedorasDosPedidos(linhas), repo, relatorio);
}
