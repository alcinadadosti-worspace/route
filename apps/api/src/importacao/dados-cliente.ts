import {
  chaveDeMunicipio,
  normalizarTelefone,
  type Cliente,
  type ClienteACompletar,
  type RevendedoraCandidata,
} from '@rota/shared';
import { chaveDeNome, chaveDeRevendedora, nomeSemCodigo } from './casamento.js';
import { enderecoEmLinha } from '../rotas/previa.js';
import type { Repositorio, Revendedora } from '../db/repositorio.js';

/**
 * O que o Admin Estoque acrescenta a um cliente que o romaneio trouxe sem
 * estar na base de revendedoras. A folha só tem nome e endereço; o resto do
 * que o app entrega depende disto: o telefone (ligar, avisar a chegada, mandar
 * o recibo pelo WhatsApp) e a referência — o "como chegar" do dossiê.
 */

/** Teto da referência: o dossiê é lido no celular, de pé. */
const MAX_OBSERVACOES = 1000;

export type CamposDosDados = { ok: true; campos: Partial<Cliente> } | { ok: false; erro: string };

/**
 * O corpo do formulário vira os campos a gravar. Corpo vazio é "não tenho mais
 * dados": só tira o cliente da lista. Campo AUSENTE não mexe no que existe; o
 * telefone EM BRANCO apaga de propósito — é o Admin corrigindo, com o número
 * na frente dele (diferente da importação, onde vazio nunca apaga) — e fica
 * MARCADO como apagado (`telefoneApagado`): sem a marca, o romaneio seguinte e
 * a carga da base o preenchiam de novo como "faltando", e o aviso e o recibo
 * voltavam para o número que o Admin tirou por estar errado.
 *
 * `clienteId`: o "É ela" (`codigo`) só vale para cliente de FORA da base (id
 * de 64 hex). Num cliente do ERP ele ligava o cliente a OUTRA pessoa, e os
 * pedidos da homônima passavam a cair nele. `codigo: null` desfaz a ligação.
 */
export function camposDosDados(corpo: unknown, clienteId = ''): CamposDosDados {
  const c = (corpo !== null && typeof corpo === 'object' ? corpo : {}) as Record<string, unknown>;
  const campos: Partial<Cliente> = { completarDados: false };

  if (c.telefone !== undefined) {
    if (c.telefone !== null && typeof c.telefone !== 'string') return { ok: false, erro: 'Telefone inválido' };
    const texto = (c.telefone ?? '').trim();
    if (texto === '') {
      campos.telefone = null;
      campos.telefoneApagado = true;
    } else {
      // Mesma normalização da importação: o link do WhatsApp precisa do +55.
      const fone = normalizarTelefone(texto);
      if (!fone) return { ok: false, erro: `Telefone "${texto}" inválido — escreva com DDD, ex.: (82) 99999-1234` };
      campos.telefone = fone;
      campos.telefoneApagado = false;
    }
  }

  if (c.observacoes !== undefined) {
    if (typeof c.observacoes !== 'string') return { ok: false, erro: 'Referência inválida' };
    const texto = c.observacoes.trim();
    if (texto.length > MAX_OBSERVACOES) {
      return { ok: false, erro: `Referência com mais de ${MAX_OBSERVACOES} caracteres — resuma` };
    }
    campos.observacoes = texto;
  }

  if (c.papel !== undefined) {
    if (c.papel !== null && typeof c.papel !== 'string') return { ok: false, erro: 'Papel inválido' };
    campos.papel = (c.papel ?? '').trim().slice(0, 40) || null;
  }

  // Revendedora da base que o Admin reconheceu como esta pessoa: o código
  // aparece na coluna "Documento" no lugar de "fora da base", e o próximo
  // romaneio dela cai NESTE cliente (`codigoErp`, ver criarCasador). O id do
  // cliente e os pedidos dele não mudam.
  if (c.codigo !== undefined) {
    if (/^\d{1,20}$/.test(clienteId)) {
      return { ok: false, erro: 'Cliente do ERP já é a revendedora do código dele — "é ela" só vale para cliente fora da base' };
    }
    if (c.codigo === null) {
      campos.documentoMascarado = 'fora da base';
      campos.codigoErp = null;
    } else {
      if (typeof c.codigo !== 'string' || !/^\d{1,20}$/.test(c.codigo)) return { ok: false, erro: 'Código inválido' };
      campos.documentoMascarado = `cód. ${c.codigo}`;
      campos.codigoErp = c.codigo;
    }
  }

  return { ok: true, campos };
}

export type ResultadoDados =
  | { ok: true; cliente: { id: string } & Cliente }
  | { ok: false; status: number; erro: string };

export async function salvarDadosDoCliente(
  repo: Repositorio,
  clienteId: string,
  corpo: unknown,
): Promise<ResultadoDados> {
  const v = camposDosDados(corpo, clienteId);
  if (!v.ok) return { ok: false, status: 400, erro: v.erro };
  const cliente = await repo.obterCliente(clienteId);
  if (!cliente) return { ok: false, status: 404, erro: 'Cliente não encontrado' };
  await repo.atualizarCliente(clienteId, v.campos);
  return { ok: true, cliente: { ...cliente, ...v.campos, id: clienteId } };
}

/** Até quantas revendedoras de mesmo nome em OUTRAS cidades: "MARIA JOSÉ DA
 * SILVA" tem dezenas na base, e a lista é para o olho, não para varrer. */
const MAX_OUTRAS_CIDADES = 20;

/**
 * Revendedoras da base com o mesmo nome do cliente, as da MESMA cidade
 * primeiro — consulta só por esse nome, nunca a base de 40 mil. Quem decide se
 * é a mesma pessoa é o Admin Estoque, olhando o endereço: com homônimos,
 * escolher sozinho daria o telefone de outra pessoa.
 */
export async function candidatasDoCliente(
  repo: Repositorio,
  clienteId: string,
): Promise<{ ok: true; candidatas: RevendedoraCandidata[] } | { ok: false; status: number; erro: string }> {
  const cliente = await repo.obterCliente(clienteId);
  if (!cliente) return { ok: false, status: 404, erro: 'Cliente não encontrado' };
  const nome = chaveDeNome(nomeSemCodigo(cliente.nome));
  if (!nome) return { ok: true, candidatas: [] };

  const cidade = cliente.enderecoFiscal.municipio;
  const [mesmaCidade, mesmoNome] = await Promise.all([
    repo.revendedorasPorChaves([chaveDeRevendedora(cliente.nome, cidade)]),
    repo.revendedorasComNome(nome, MAX_OUTRAS_CIDADES),
  ]);
  const unicas = new Map([...mesmaCidade, ...mesmoNome].map((r) => [r.id, r]));
  const daCidade = chaveDeMunicipio(cidade);
  const candidatas = [...unicas.values()].sort(
    (a, b) =>
      Number(chaveDeMunicipio(b.endereco.municipio) === daCidade) -
        Number(chaveDeMunicipio(a.endereco.municipio) === daCidade) ||
      // Dado de pedido recente antes do cadastro de 2025 (sem data).
      (b.dadosDe ?? '').localeCompare(a.dadosDe ?? ''),
  );
  return { ok: true, candidatas: candidatas.map(candidata) };
}

/**
 * Dos clientes que o lote da Importação mostra para completar, quais AINDA
 * esperam dados. O lote fica guardado a sessão inteira, e o cliente
 * completado na aba Clientes (ou noutro computador) continuava com o
 * formulário vazio aberto — preenchê-lo de novo regravava o telefone.
 */
export async function aindaACompletar(repo: Repositorio, ids: string[]): Promise<string[]> {
  return (await repo.clientesPorIds(ids)).filter((c) => c.completarDados).map((c) => c.id);
}

/** Quantos resultados a busca devolve: é para achar UMA pessoa, não listar a base. */
const MAX_NA_BUSCA = 50;

/**
 * Busca na base de revendedoras (40 mil, inclusive inativas), para a aba
 * Clientes: ela só mostra quem já teve pedido, e o Admin não tinha como ver
 * o resto do que os cadastros e planilhas trouxeram. Código (só dígitos) acha
 * a pessoa daquele código; texto acha os nomes que COMEÇAM com ele.
 */
export async function buscarNaBase(repo: Repositorio, termo: string): Promise<RevendedoraCandidata[]> {
  const t = termo.trim();
  if (/^[\d.\s-]+$/.test(t)) {
    const codigo = t.replace(/\D/g, '');
    if (!/^\d{1,20}$/.test(codigo)) return [];
    return (await repo.revendedorasPorIds([codigo])).map(candidata);
  }
  const prefixo = chaveDeNome(t);
  if (prefixo.length < 3) return [];
  const achadas = await repo.revendedorasComecandoCom(prefixo, MAX_NA_BUSCA);
  return achadas.map(candidata);
}

function candidata(r: { id: string } & Revendedora): RevendedoraCandidata {
  return {
    codigo: r.id,
    nome: r.nome,
    endereco: enderecoEmLinha(r.endereco),
    telefone: r.telefone,
    papel: r.papel,
    referencia: r.referencia,
    situacao: r.situacao,
    dadosDe: r.dadosDe,
  };
}

/** O cliente como a tela de completar dados precisa. */
export function clienteACompletar(c: { id: string } & Cliente): ClienteACompletar {
  return {
    id: c.id,
    nome: c.nome,
    endereco: enderecoEmLinha(c.enderecoFiscal),
    telefone: c.telefone,
    observacoes: c.observacoes,
    codigoErp: c.codigoErp ?? null,
  };
}
