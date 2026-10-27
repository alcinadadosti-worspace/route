import { isDeepStrictEqual } from 'node:util';
import {
  chaveDePonto,
  ehCelular,
  enderecosDivergem,
  normalizarTelefone,
  pontosRepetidos,
  type Cliente,
  type RelatorioImportacao,
} from '@rota/shared';
import type { LinhaCadastro } from './cadastro.js';
import { chaveDeRevendedora } from './casamento.js';
import { enderecoDeBloco, extrairCoordenada, type BlocoEndereco, type LinhaPlanilha } from './planilha.js';
import { realinharPedidosDosClientes } from './servico.js';
import type { FonteRevendedora, FontesDaRevendedora, Repositorio, Revendedora } from '../db/repositorio.js';

/**
 * A base de dados de clientes que o romaneio consulta (`revendedoras/`), feita
 * de TRÊS fontes: o cadastro de revendedoras do ERP (sem data — o usuário diz
 * que o enviado é de 2025), os pedidos de ENTREGA e os de RETIRADA (cada um
 * com a data do pedido). O usuário quer a base "rica": todo mundo, inclusive
 * inativa, com o dado mais novo que existir.
 *
 * Cada registro guarda o que cada fonte disse (`fontes`) e os campos que as
 * consultas usam saem de `consolidarRevendedora`, uma regra fixa. Assim a base
 * é a MESMA em qualquer ordem de carga, e recarregar um arquivo grava zero
 * documentos — juntando registro com registro, aos pares, nenhuma das duas
 * coisas era verdade.
 */

/** Telefones válidos, normalizados, sem repetir, na ordem dada. */
function telefonesValidos(brutos: Array<string | null | undefined>): string[] {
  return [...new Set(brutos.map((t) => normalizarTelefone(t)).filter((t): t is string => !!t))];
}

/** Uma linha do cadastro de revendedoras. */
export function revendedoraDoCadastro(linha: LinhaCadastro): Revendedora {
  return comFonte('cadastro', {
    nome: linha.nome,
    telefones: telefonesValidos(linha.telefones),
    papel: linha.papel,
    endereco: enderecoDeBloco(linha.endereco),
    referencia: linha.endereco.referencia.trim(),
    // GPS digitado no texto do endereço (208 no cadastro completo).
    pin: extrairCoordenada([linha.endereco.complemento, linha.endereco.referencia]),
    data: null,
    situacao: linha.situacao,
  });
}

/**
 * Uma linha da planilha de PEDIDOS, como dado de cliente (sem criar pedido).
 *
 * Retirada usa o bloco do CADASTRO — o de entrega dela é o endereço do próprio
 * CD, a mesma regra da importação de pedidos — e por isso o GPS só dele (lido
 * do bloco de entrega, a cliente rural ganhava o pin do CD). É uma fonte à
 * parte, abaixo do cadastro: o bloco "cadastro" da planilha é o endereço
 * RESIDENCIAL, e o cadastro guarda o de ENTREGA, que é o que o romaneio imprime.
 *
 * Na linha de entrega, a referência e o GPS do bloco do cadastro só servem se
 * os dois blocos falam do mesmo lugar — senão a referência da casa de cadastro
 * ia parar no endereço de entrega (96 pessoas em 2026).
 */
export function revendedoraDoPedido(linha: LinhaPlanilha): Revendedora {
  const retirada = linha.tipoEntrega === 'retirada';
  const bloco: BlocoEndereco = retirada ? linha.enderecoCadastro : linha.enderecoEntrega;
  const endereco = enderecoDeBloco(bloco);
  const cadastroNoMesmoLugar =
    !retirada && !enderecosDivergem(enderecoDeBloco(linha.enderecoCadastro), endereco);
  const doCadastro = retirada || cadastroNoMesmoLugar;
  return comFonte(retirada ? 'retirada' : 'pedido', {
    nome: linha.nome,
    telefones: telefonesValidos([linha.telefone]),
    papel: linha.papel,
    endereco,
    referencia: (bloco.referencia || (doCadastro ? linha.enderecoCadastro.referencia : '')).trim(),
    pin: extrairCoordenada([
      bloco.complemento,
      bloco.referencia,
      ...(doCadastro && !retirada ? [linha.enderecoCadastro.complemento, linha.enderecoCadastro.referencia] : []),
    ]),
    data: linha.emitidoEm || null,
    codigo: linha.codigoPedido,
  });
}

/** Um registro com uma fonte só, já consolidado. */
function comFonte(qual: keyof FontesDaRevendedora, fonte: FonteRevendedora): Revendedora {
  // Sem chaves `undefined`: o banco as descarta, e o registro relido não
  // seria igual ao gravado — tudo pareceria mudado a cada carga.
  const limpa = Object.fromEntries(Object.entries(fonte).filter(([, v]) => v !== undefined)) as FonteRevendedora;
  const fontes: FontesDaRevendedora = { [qual]: limpa };
  return { ...consolidarRevendedora(fontes), fontes };
}

/**
 * Os campos que as consultas usam, a partir das fontes. Regra fixa — não
 * depende de qual chegou antes:
 * - endereço, nome e chave: do pedido de entrega; senão do cadastro; senão da
 *   retirada (o pedido de 2026 é mais novo que o cadastro de 2025; a retirada
 *   traz o residencial, não o de entrega);
 * - GPS e referência: da primeira fonte que fala do MESMO endereço escolhido —
 *   são do lugar, não da pessoa;
 * - telefone: o primeiro CELULAR, olhando o cadastro antes (ele separa celular
 *   de residencial) e os pedidos depois (a coluna Telefone da planilha de
 *   pedidos traz o residencial primeiro); sem celular nenhum, o primeiro fixo;
 * - papel: o da fonte mais nova que tiver; situação: só o cadastro tem.
 */
export function consolidarRevendedora(fontes: FontesDaRevendedora): Omit<Revendedora, 'fontes'> {
  const porPrioridade = [fontes.pedido, fontes.cadastro, fontes.retirada].filter(
    (f): f is FonteRevendedora => !!f,
  );
  const principal = porPrioridade[0]!;
  const doLugar = porPrioridade.filter((f) => !enderecosDivergem(principal.endereco, f.endereco));
  const telefones = [fontes.cadastro, fontes.pedido, fontes.retirada].flatMap((f) => f?.telefones ?? []);
  return {
    nome: principal.nome,
    chave: chaveDeRevendedora(principal.nome, principal.endereco.municipio),
    telefone: telefones.find((t) => ehCelular(t)) ?? telefones[0] ?? null,
    papel: porPrioridade.find((f) => f.papel)?.papel ?? null,
    endereco: principal.endereco,
    referencia: doLugar.find((f) => f.referencia)?.referencia ?? '',
    pin: doLugar.find((f) => f.pin)?.pin ?? null,
    situacao: fontes.cadastro?.situacao ?? null,
    dadosDe: fontes.pedido?.data ?? null,
  };
}

/** A fonte que chegou substitui a guardada? Cadastro: sim (o último carregado
 * vale). Pedido e retirada: só a mais NOVA (data, e o código no empate) — a
 * ordem de chegada não decide. */
function substitui(qual: keyof FontesDaRevendedora, guardada: FonteRevendedora | undefined, nova: FonteRevendedora): boolean {
  if (!guardada || qual === 'cadastro') return true;
  const chave = (f: FonteRevendedora) => `${f.data ?? ''}|${f.codigo ?? ''}`;
  if (chave(nova) !== chave(guardada)) return chave(nova) > chave(guardada);
  // O MESMO pedido em duas planilhas (o ciclo e o ano inteiro), com algum
  // campo diferente: desempate pelo conteúdo, para não valer o que chegou
  // primeiro — senão a base dependia da ordem das cargas.
  return JSON.stringify(nova) > JSON.stringify(guardada);
}

/** Registro gravado antes de existirem as fontes: o que ele diz vira a fonte
 * que a data indica (sem data = cadastro). */
function fontesDeRegistroAntigo(r: Revendedora): FontesDaRevendedora {
  const fonte: FonteRevendedora = {
    nome: r.nome,
    telefones: r.telefone ? [r.telefone] : [],
    papel: r.papel,
    endereco: r.endereco,
    referencia: r.referencia,
    pin: r.pin,
    data: r.dadosDe,
    ...(r.dadosDe === null ? { situacao: r.situacao } : {}),
  };
  return r.dadosDe === null ? { cadastro: fonte } : { pedido: fonte };
}

/**
 * Junta o registro guardado com o que chegou, fonte por fonte.
 * null = nada mudou (não grava de novo). A comparação é por CONTEÚDO, não por
 * texto: o banco devolve as chaves em ordem alfabética.
 */
export function mesclarRevendedora(antiga: Revendedora | undefined, nova: Revendedora): Revendedora | null {
  const fontes: FontesDaRevendedora = { ...(antiga ? (antiga.fontes ?? fontesDeRegistroAntigo(antiga)) : {}) };
  const chegaram = nova.fontes ?? fontesDeRegistroAntigo(nova);
  for (const qual of ['cadastro', 'pedido', 'retirada'] as const) {
    const chegou = chegaram[qual];
    if (chegou && substitui(qual, fontes[qual], chegou)) fontes[qual] = chegou;
  }
  const junta: Revendedora = { ...consolidarRevendedora(fontes), fontes };
  return antiga && isDeepStrictEqual({ ...junta }, { ...antiga }) ? null : junta;
}

/**
 * Grava as revendedoras que chegaram (já reduzidas a uma por código) mescladas
 * com as guardadas, e COMPLETA os clientes que já existem.
 *
 * Do cliente existente só se preenche o que FALTA (telefone, papel, GPS,
 * referência). O endereço do cliente nunca muda por aqui: muda pelo pedido,
 * que pede confirmação quando o ponto pode ter ficado para trás.
 */
export async function guardarRevendedoras(
  novas: Map<string, Revendedora>,
  repo: Repositorio,
  relatorio: RelatorioImportacao,
): Promise<void> {
  const ids = [...novas.keys()];
  const guardadas = new Map<string, Revendedora>();
  // Em fatias: o cadastro completo tem 40 mil códigos.
  for (let i = 0; i < ids.length; i += 500) {
    for (const { id, ...r } of await repo.revendedorasPorIds(ids.slice(i, i + 500))) guardadas.set(id, r);
  }
  const gravar: Array<{ id: string; dados: Revendedora }> = [];
  for (const [id, nova] of novas) {
    const junta = mesclarRevendedora(guardadas.get(id), nova);
    if (junta) gravar.push({ id, dados: junta });
    guardadas.set(id, junta ?? guardadas.get(id)!);
  }
  await repo.gravarRevendedoras(gravar);

  const clientes = await repo.listarClientes();
  const escritas: Array<{ colecao: 'clientes'; id: string; dados: Partial<Cliente>; merge: boolean }> = [];
  const pontos = new Map<string, Partial<Cliente>>();
  for (const { id, ...existente } of clientes) {
    const r = guardadas.get(id);
    if (!r || !novas.has(id)) continue;
    const campos: Partial<Cliente> = {};
    // Nem o telefone que o Admin APAGOU por estar errado: sem a marca, cada
    // carga o devolvia como "faltando".
    if (r.telefone && !existente.telefone && !existente.telefoneApagado) campos.telefone = r.telefone;
    if (r.papel && !existente.papel) campos.papel = r.papel;
    // Referência e GPS são do lugar: só valem se a base fala do MESMO
    // endereço do cliente (que pode ter mudado por um pedido mais novo).
    const mesmoLugar = !enderecosDivergem(existente.enderecoFiscal, r.endereco);
    // Referência alimenta o dossiê, mas NUNCA por cima do que o motorista escreveu.
    if (mesmoLugar && r.referencia && !existente.observacoes) campos.observacoes = r.referencia;
    if (Object.keys(campos).length > 0) escritas.push({ colecao: 'clientes', id, dados: campos, merge: true });
    // GPS só em quem não tem ponto, e nunca o que o Admin Estoque descartou
    // ("refazer ponto") — a mesma regra da planilha de pedidos.
    const descartado =
      r.pin !== null && existente.pontoDescartado != null && chaveDePonto(existente.pontoDescartado) === chaveDePonto(r.pin);
    if (mesmoLugar && !existente.coordenada && existente.statusMapeamento === 'nao_mapeado' && r.pin && !descartado) {
      pontos.set(id, { coordenada: r.pin, statusMapeamento: 'geocodificado' });
    }
  }
  await repo.gravarEmLote(escritas);

  if (pontos.size > 0) {
    // As mesmas guardas da importação e da localização (varredura de 21/10):
    // ponto "exato" igual ao de outro endereço é o centro da cidade, não a
    // porta — vai como aproximado; e a gravação é CONDICIONAL, para não passar
    // por cima de um pin que o motorista confirmou enquanto isto rodava.
    const depois = clientes.map((c) => ({ ...c, ...(pontos.get(c.id) ?? {}) }));
    for (const id of pontosRepetidos(depois)) {
      const p = pontos.get(id);
      if (p) p.statusMapeamento = 'aproximado';
    }
    const pulados = new Set(
      await repo.atualizarClientesSe(
        [...pontos].map(([id, dados]) => ({ id, seStatus: ['nao_mapeado'], dados })),
      ),
    );
    const comPonto = new Set([...pontos.keys()].filter((id) => !pulados.has(id)));
    // Os pedidos deles que esperavam ponto saem da fila da localização paga.
    await realinharPedidosDosClientes(repo, comPonto);
    relatorio.clientesAtualizados =
      (relatorio.clientesAtualizados ?? 0) + [...comPonto].filter((id) => !escritas.some((e) => e.id === id)).length;
  }

  relatorio.revendedoras = (relatorio.revendedoras ?? 0) + novas.size;
  relatorio.clientesAtualizados = (relatorio.clientesAtualizados ?? 0) + escritas.length;
}

/** Os pedidos de uma planilha como dado de cliente: uma revendedora por
 * código, com o pedido de entrega e o de retirada mais novos dela. */
export function revendedorasDosPedidos(linhas: LinhaPlanilha[]): Map<string, Revendedora> {
  const porCodigo = new Map<string, Revendedora>();
  for (const linha of linhas) {
    if (!/^\d{1,20}$/.test(linha.pessoa)) continue;
    const junta = mesclarRevendedora(porCodigo.get(linha.pessoa), revendedoraDoPedido(linha));
    if (junta) porCodigo.set(linha.pessoa, junta);
  }
  return porCodigo;
}
