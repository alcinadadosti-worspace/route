import { enderecosDivergem, type RelatorioImportacao } from '@rota/shared';
import { chaveDeRevendedora, codigoNoNome, criarCasador } from './casamento.js';
import { enderecoDeBloco, type LinhaPlanilha } from './planilha.js';
import {
  MOTORISTAS_CONHECIDOS,
  blocoDoRomaneio,
  codCdDoMotorista,
  lerRomaneio,
  type Romaneio,
} from './romaneio.js';
import { importarLinhas, relatorioVazio } from './servico-planilha.js';
import { clienteACompletar } from './dados-cliente.js';
import type { Repositorio } from '../db/repositorio.js';

/**
 * Importação pelos ROMANEIOS em PDF do Boticário (26/10/2026). Cada linha da
 * folha vira uma `LinhaPlanilha` e segue pelo MESMO miolo da planilha do ERP
 * (`importarLinhas`): pedido repetido é ignorado, cliente novo é criado, ponto
 * vencido abre revisão na aba Decisões, sem ponto entra na fila da localização.
 *
 * O que o romaneio NÃO tem, e como cada falta foi resolvida:
 * - código da revendedora → casado pelo nome no cadastro (`casamento.ts`);
 * - CD → pelo motorista da folha (`codCdDoMotorista`), regra do usuário;
 * - cancelado / retirada / "entregue no ERP" → não existem aqui: todo pedido
 *   da folha vai para entrega (afirmação do usuário);
 * - peso e volume → 1 volume por pedido (a folha conta "N pacotes", um por
 *   linha), sem peso;
 * - data → a que o navegador imprime no topo da folha; sem ela, a da
 *   importação. Com a hora da importação, a folha ESQUECIDA de anteontem
 *   soltada depois da de hoje passava por "mais nova" e o endereço regredia.
 */
export async function importarRomaneios(
  arquivos: Array<{ nome: string; conteudo: Uint8Array }>,
  repo: Repositorio,
): Promise<RelatorioImportacao> {
  const relatorio = relatorioVazio();
  const lidos: Array<{ romaneio: Romaneio; codCd: string }> = [];
  for (const arquivo of arquivos) {
    const leitura = await lerRomaneio(arquivo.conteudo);
    if (!leitura.ok) {
      relatorio.total += 1;
      relatorio.rejeitados.push({ arquivo: arquivo.nome, motivo: leitura.motivo });
      continue;
    }
    const codCd = codCdDoMotorista(leitura.romaneio.motorista);
    if (!codCd) {
      relatorio.total += 1;
      relatorio.rejeitados.push({
        arquivo: arquivo.nome,
        motivo:
          `motorista "${leitura.romaneio.motorista || '(em branco)'}" sem CD definido — ` +
          `o CD sai do motorista (${MOTORISTAS_CONHECIDOS}). Nada deste romaneio foi importado.`,
      });
      continue;
    }
    lidos.push({ romaneio: leitura.romaneio, codCd });
  }
  if (lidos.length > 0) await importarRomaneiosLidos(lidos, repo, relatorio);
  return relatorio;
}

/** A parte depois da leitura do PDF — separada para o teste não depender de
 * um PDF de verdade (o romaneio real tem dados pessoais e não vai para o git). */
export async function importarRomaneiosLidos(
  lidos: Array<{ romaneio: Romaneio; codCd: string }>,
  repo: Repositorio,
  relatorio: RelatorioImportacao,
): Promise<void> {
  // Candidatas: os clientes (coleção pequena — só quem já teve pedido) e, do
  // cadastro guardado, SÓ as revendedoras com o nome+cidade de alguma linha
  // destas folhas (ou com o código colado no nome). O cadastro completo tem 40
  // mil pessoas; ler tudo a cada romaneio seria 40 mil leituras por folha.
  const todas = lidos.flatMap((l) => l.romaneio.linhas);
  const [clientes, porChave, porCodigo] = await Promise.all([
    repo.listarClientes(),
    repo.revendedorasPorChaves(todas.map((l) => chaveDeRevendedora(l.nome, l.cidade))),
    repo.revendedorasPorIds(todas.map((l) => codigoNoNome(l.nome)).filter((c): c is string => c !== null)),
  ]);
  const doCadastro = new Map([...porChave, ...porCodigo].map((r) => [r.id, r]));
  const clientePorId = new Map(clientes.map((c) => [c.id, c]));
  const casar = criarCasador([
    // Clientes primeiro: o nome e o endereço que valem são os daqui.
    ...clientes.map((c) => ({ ...c, ehCliente: true })),
    ...[...doCadastro.values()].map((r) => ({ id: r.id, nome: r.nome, enderecoFiscal: r.endereco })),
  ]);
  const agora = agoraEmMaceio();
  const linhas: LinhaPlanilha[] = [];

  for (const { romaneio, codCd } of lidos) {
    relatorio.romaneios = (relatorio.romaneios ?? 0) + 1;
    const emitidoEm = romaneio.impressoEm ?? agora;
    for (const motivo of romaneio.recusadas ?? []) {
      relatorio.total += 1;
      relatorio.rejeitados.push({ arquivo: `romaneio ${romaneio.rota}`, motivo });
    }
    // A folha diz quantos pacotes leva: se a leitura achou outro número de
    // linhas, alguma ficou para trás (ou sobrou) — e ninguém perceberia.
    const lidas = romaneio.linhas.length + (romaneio.recusadas?.length ?? 0);
    if (romaneio.quantidade !== null && romaneio.quantidade !== lidas) {
      relatorio.alertas.push({
        clienteId: '',
        nome: `Romaneio ${romaneio.rota}`,
        mensagem: `A folha diz ${romaneio.quantidade} pacote(s), mas foram lidas ${lidas} linha(s). Confira o PDF contra a aba Pedidos.`,
      });
    }
    for (const l of romaneio.linhas) {
      const bloco = blocoDoRomaneio(l);
      const c = casar({
        nome: l.nome,
        cidade: bloco.cidade,
        logradouro: bloco.logradouro,
        numero: bloco.complemento,
        doSite: l.pedido.includes('-'),
      });
      if (!c.noCadastro) relatorio.semCadastro = (relatorio.semCadastro ?? 0) + 1;
      // O que só a base tem: telefone, papel e o GPS digitado. Cliente NOVO
      // nasce com eles; o que já existe só ganha o que lhe FALTA — senão cada
      // romaneio trocava o telefone que o Admin corrigiu pelo da base, e o
      // papel atual pelo do cadastro de 2025.
      const r = c.noCadastro ? doCadastro.get(c.codigo) : undefined;
      const existente = clientePorId.get(c.id);
      // O GPS da base é da casa da BASE: com o endereço da folha diferente
      // (mudou), o pin velho entrava como ponto exato no endereço novo — o
      // motorista ia à porta errada com cara de certa.
      const pin = r?.pin && !enderecosDivergem(r.endereco, enderecoDeBloco(bloco)) ? r.pin : null;
      linhas.push({
        codigoPedido: l.pedido,
        notaFiscal: l.notaFiscal,
        pessoa: c.id,
        nome: c.nome,
        papel: existente?.papel ? null : (r?.papel ?? null),
        quantidadeMateriais: 0,
        valor: 0,
        tipoEntrega: 'rota',
        tipoEntregaBruto: 'romaneio',
        cancelada: false,
        entregueNoErp: false,
        dataEntrega: null,
        enderecoCadastro: bloco,
        enderecoEntrega: bloco,
        // Null = não mexe: `importarLinhas` nunca apaga o telefone que existe.
        telefone: existente?.telefone ? null : (r?.telefone ?? null),
        estrutura: null,
        codCd,
        lote: null,
        volumes: 1,
        pesoBrutoKg: 0,
        emitidoEm,
        romaneio: romaneio.rota,
        pin,
        foraDoCadastro: !c.noCadastro,
      });
    }
  }

  await importarLinhas(linhas, repo, relatorio, { clientesExistentes: clientes });

  // Quem entrou fora da base e ainda espera dados: o cliente recém-criado, ou
  // o de um romaneio anterior que ninguém completou. Lido DEPOIS de gravar —
  // o que o Admin já completou (ou dispensou) não volta para a lista.
  const idsFora = [...new Set(linhas.filter((l) => l.foraDoCadastro).map((l) => l.pessoa))];
  const aCompletar = (await repo.clientesPorIds(idsFora)).filter((c) => c.completarDados);
  if (aCompletar.length > 0) {
    relatorio.clientesACompletar = aCompletar.map(clienteACompletar);
    relatorio.alertas.push({
      clienteId: '',
      nome: 'Fora da base de revendedoras',
      // Informativo, não pendência: os pedidos entraram e vão para a rota.
      mensagem:
        `${aCompletar.length} destinatária(s) não estão na base de revendedoras e entraram só com o que a folha traz (nome e endereço). ` +
        'Complete o telefone e a referência logo abaixo — ou depois, na aba Clientes. Pedido do site (Consumidor Final) é sempre assim.',
    });
  }
}

/** Agora, no fuso da operação e no mesmo formato das datas da planilha
 * (`…T00:00:00-03:00`) — a comparação de "endereço mais novo" é por texto. */
function agoraEmMaceio(): string {
  return new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 19) + '-03:00';
}
