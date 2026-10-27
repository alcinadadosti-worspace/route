import { isDeepStrictEqual } from 'node:util';
import {
  chaveDePonto,
  enderecosDivergem,
  normalizarTelefone,
  pontosRepetidos,
  type Cliente,
  type RelatorioImportacao,
} from '@rota/shared';
import type { LinhaCadastro } from './cadastro.js';
import { chaveDeRevendedora } from './casamento.js';
import { enderecoDeBloco, extrairCoordenada, type LinhaPlanilha } from './planilha.js';
import { realinharPedidosDosClientes } from './servico.js';
import type { Repositorio, Revendedora } from '../db/repositorio.js';

/**
 * A base de dados de clientes que o romaneio consulta (`revendedoras/`), feita
 * de DUAS fontes: o cadastro de revendedoras do ERP (sem data — o usuário diz
 * que o enviado é de 2025) e os pedidos (cada linha com a data do pedido). O
 * usuário quer a base "rica": todo mundo, inclusive inativa, com o dado mais
 * novo que existir.
 */

/** Uma linha do cadastro de revendedoras. */
export function revendedoraDoCadastro(linha: LinhaCadastro): Revendedora {
  return {
    nome: linha.nome,
    chave: chaveDeRevendedora(linha.nome, linha.endereco.cidade),
    telefone: normalizarTelefone(linha.telefone),
    papel: linha.papel,
    endereco: enderecoDeBloco(linha.endereco),
    referencia: linha.endereco.referencia.trim(),
    // GPS digitado no texto do endereço (208 no cadastro completo).
    pin: extrairCoordenada([linha.endereco.complemento, linha.endereco.referencia]),
    situacao: linha.situacao,
    dadosDe: null,
  };
}

/**
 * Uma linha da planilha de PEDIDOS, como dado de cliente (sem criar pedido).
 *
 * Retirada usa o bloco do CADASTRO — o de entrega dela é o endereço do próprio
 * CD, a mesma regra da importação de pedidos —, e por isso também o GPS só
 * dele: lido do bloco de entrega, a cliente rural ganhava o pin do CD. E vale
 * como dado SEM data: o bloco do cadastro na planilha é o do momento do export
 * (não muda ao longo do ano), não o do pedido; datado, a retirada de outubro
 * vencia a entrega de setembro e a revendedora "mudava" para o endereço de
 * cadastro — em 10 casos reais, de cidade, e o romaneio deixava de achá-la.
 */
export function revendedoraDoPedido(linha: LinhaPlanilha): Revendedora {
  const retirada = linha.tipoEntrega === 'retirada';
  const bloco = retirada ? linha.enderecoCadastro : linha.enderecoEntrega;
  return {
    nome: linha.nome,
    chave: chaveDeRevendedora(linha.nome, bloco.cidade),
    telefone: normalizarTelefone(linha.telefone),
    papel: linha.papel,
    endereco: enderecoDeBloco(bloco),
    referencia: (bloco.referencia || linha.enderecoCadastro.referencia).trim(),
    pin: extrairCoordenada(
      retirada
        ? [linha.enderecoCadastro.complemento, linha.enderecoCadastro.referencia]
        : [
            linha.enderecoCadastro.complemento,
            linha.enderecoCadastro.referencia,
            linha.enderecoEntrega.complemento,
            linha.enderecoEntrega.referencia,
          ],
    ),
    situacao: null,
    dadosDe: retirada ? null : linha.emitidoEm || null,
  };
}

/** Celular brasileiro: DDD + 9 + 8 dígitos. O WhatsApp (aviso, recibo) é nele. */
function ehCelular(telefone: string): boolean {
  return /^\+55\d{2}9\d{8}$/.test(telefone);
}

/**
 * O telefone que fica, entre o guardado e o que chegou. NÃO é "o mais novo":
 * a coluna Telefone da planilha de pedidos traz o RESIDENCIAL primeiro, o
 * cadastro traz o CELULAR — e carregar os pedidos de 2026 trocou o celular de
 * ~800 revendedoras por um fixo, para onde o WhatsApp não vai. Nem o telefone
 * do pedido é datado de verdade (nenhuma das 5944 pessoas com telefone varia
 * ao longo do ano: é o cadastro do momento do export). Ordem: celular antes de
 * fixo; depois o do cadastro; depois o do dado mais novo (`base`).
 */
function telefoneQueFica(base: Revendedora, outra: Revendedora): string | null {
  const nota = (r: Revendedora) => (r.telefone ? (ehCelular(r.telefone) ? 2 : 0) + (r.dadosDe === null ? 1 : 0) : -1);
  const melhor = nota(outra) > nota(base) ? outra : base;
  return melhor.telefone ?? outra.telefone;
}

/**
 * Junta o que já está guardado com o que chegou. O endereço e o nome vêm do
 * dado MAIS NOVO (pedido com data > cadastro sem data; entre dois pedidos, o
 * de data maior; entre dois cadastros, o que chegou agora). Papel: o mais
 * novo, mas o vazio nunca apaga o que existe. Telefone: ver `telefoneQueFica`.
 *
 * GPS e referência são do LUGAR, não da pessoa: só passam do dado velho para
 * o novo se o endereço é o mesmo. Sem isto, a revendedora que se mudou ficava
 * com o endereço novo e o pin da casa velha — e o romaneio levava esse pin
 * como ponto exato.
 *
 * null = nada mudou (não grava de novo). Comparação por CONTEÚDO: por texto
 * (JSON), a ordem das chaves — que o banco devolve em ordem alfabética — fazia
 * todo registro parecer mudado, e cada carga regravava a base inteira.
 */
export function mesclarRevendedora(antiga: Revendedora | undefined, nova: Revendedora): Revendedora | null {
  if (!antiga) return nova;
  const novaVale =
    nova.dadosDe === null ? antiga.dadosDe === null : antiga.dadosDe === null || nova.dadosDe >= antiga.dadosDe;
  const [base, outra] = novaVale ? [nova, antiga] : [antiga, nova];
  const mesmoLugar = !enderecosDivergem(base.endereco, outra.endereco);
  const junta: Revendedora = {
    ...base,
    telefone: telefoneQueFica(base, outra),
    papel: base.papel ?? outra.papel,
    pin: base.pin ?? (mesmoLugar ? outra.pin : null),
    referencia: base.referencia || (mesmoLugar ? outra.referencia : ''),
    // Situação só o cadastro tem: o pedido (null) não apaga.
    situacao: nova.situacao ?? antiga.situacao,
  };
  return isDeepStrictEqual({ ...junta }, { ...antiga }) ? null : junta;
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
    if (r.telefone && !existente.telefone) campos.telefone = r.telefone;
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
    relatorio.clientesAtualizados = (relatorio.clientesAtualizados ?? 0) +
      [...comPonto].filter((id) => !escritas.some((e) => e.id === id)).length;
  }

  relatorio.revendedoras = (relatorio.revendedoras ?? 0) + novas.size;
  relatorio.clientesAtualizados = (relatorio.clientesAtualizados ?? 0) + escritas.length;
}

/**
 * Os pedidos de uma planilha como dado de cliente: uma revendedora por código,
 * a do pedido MAIS NOVO (uma planilha do ano tem várias por pessoa). Em ordem
 * de data e código: no mesmo dia, a ordem das linhas do arquivo decidia o
 * endereço (13 pessoas com dois endereços no mesmo dia em 2026).
 */
export function revendedorasDosPedidos(linhas: LinhaPlanilha[]): Map<string, Revendedora> {
  const ordenadas = [...linhas].sort(
    (a, b) => (a.emitidoEm || '').localeCompare(b.emitidoEm || '') || a.codigoPedido.localeCompare(b.codigoPedido),
  );
  const porCodigo = new Map<string, Revendedora>();
  for (const linha of ordenadas) {
    if (!/^\d{1,20}$/.test(linha.pessoa)) continue;
    const junta = mesclarRevendedora(porCodigo.get(linha.pessoa), revendedoraDoPedido(linha));
    if (junta) porCodigo.set(linha.pessoa, junta);
  }
  return porCodigo;
}
