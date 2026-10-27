import { readFileSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { cadastroDasPartes } from '../src/importacao/cadastro.js';
import { planilhaDoXml, textosCompartilhados, type LinhaPlanilha } from '../src/importacao/planilha.js';
import { gravarCadastro, gravarClientesDosPedidos } from '../src/importacao/servico-cadastro.js';
import { relatorioVazio } from '../src/importacao/servico-planilha.js';
import { criarRepositorioFirestore } from '../src/db/firestore.js';

/**
 * Carrega a base de dados de clientes que o romaneio consulta (`revendedoras/`)
 * direto no banco, sem passar pelo servidor. Aceita, em qualquer ordem:
 *
 * - o cadastro de revendedoras (`ConsultaRevendedores_*.xlsx`) — o completo tem
 *   40 mil pessoas, 14,6 MB, 130 MB descomprimido: derrubaria a instância de
 *   512 MB do Render (o painel recusa arquivo acima de 5 MB e explica);
 * - planilhas de PEDIDOS (`ConsultaPedidos_*.xlsx`) de um período longo, usadas
 *   SÓ como dado de cliente: nenhum pedido é criado. Cada dado leva a data do
 *   pedido, e o mais novo vence — a ordem dos arquivos não importa.
 *
 * Uso (caminhos ABSOLUTOS — `npm run -w` roda com o CWD em apps/api):
 *   GOOGLE_APPLICATION_CREDENTIALS=<chave.json> \
 *   npm run carregar-cadastro -w @rota/api -- <arquivo.xlsx> [outro.xlsx …]
 *
 * Rodar de novo é seguro: o que não mudou não é regravado.
 */
const arquivos = process.argv.slice(2);
if (arquivos.length === 0 || arquivos.some((a) => !isAbsolute(a))) {
  console.error('Uso: carregar-cadastro <caminho ABSOLUTO do .xlsx> [outros …]');
  process.exit(1);
}
const repo = criarRepositorioFirestore();
if (!repo) {
  console.error('Defina GOOGLE_APPLICATION_CREDENTIALS (caminho absoluto) ou FIREBASE_SERVICE_ACCOUNT.');
  process.exit(1);
}

for (const arquivo of arquivos) {
  const inicio = Date.now();
  const segundos = () => ((Date.now() - inicio) / 1000).toFixed(1);
  const zip = unzipSync(new Uint8Array(readFileSync(arquivo)), {
    filter: (f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f.name) || f.name === 'xl/sharedStrings.xml',
  });
  const partes = Object.fromEntries(Object.entries(zip).map(([nome, bytes]) => [nome, strFromU8(bytes)]));
  const relatorio = relatorioVazio();

  const cadastro = cadastroDasPartes(partes);
  if (cadastro.ok) {
    console.log(`${basename(arquivo)}: cadastro, ${cadastro.linhas.length} linhas lidas em ${segundos()} s — gravando…`);
    await gravarCadastro(cadastro.linhas, repo, relatorio);
  } else if (cadastro.naoEhCadastro && partes['xl/worksheets/sheet1.xml']) {
    // TODAS as abas e o texto compartilhado: o export de pedidos de 2025 vem
    // com o texto em sharedStrings.xml e duas abas — lido só pela 1ª aba sem
    // o texto, o cabeçalho saía como índices e o arquivo era recusado.
    const compartilhadas = textosCompartilhados(partes['xl/sharedStrings.xml'] ?? '');
    const abas = Object.keys(partes)
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
    const linhas: LinhaPlanilha[] = [];
    let motivo: string | null = null;
    for (const aba of abas) {
      const pedidos = planilhaDoXml(partes[aba]!, compartilhadas);
      if (!pedidos.ok) {
        motivo = `${aba}: ${pedidos.motivo}`;
        break;
      }
      linhas.push(...pedidos.linhas);
    }
    if (motivo) {
      console.error(`${basename(arquivo)}: nem cadastro nem planilha de pedidos — ${motivo}`);
      process.exitCode = 1;
      continue;
    }
    console.log(`${basename(arquivo)}: pedidos (só dados de cliente), ${abas.length} aba(s), ${linhas.length} linhas em ${segundos()} s — gravando…`);
    await gravarClientesDosPedidos(linhas, repo, relatorio);
  } else {
    console.error(`${basename(arquivo)}: ${cadastro.motivo}`);
    process.exitCode = 1;
    continue;
  }
  console.log(
    `  pronto em ${segundos()} s: ${relatorio.revendedoras} revendedoras na base, ` +
      `${relatorio.clientesAtualizados} clientes completados, ${relatorio.rejeitados.length} linhas recusadas.`,
  );
  for (const r of relatorio.rejeitados.slice(0, 10)) console.log('  recusada:', r.arquivo, '—', r.motivo);
}
