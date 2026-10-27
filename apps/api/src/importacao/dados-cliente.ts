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
 * na frente dele (diferente da importação, onde vazio nunca apaga).
 */
export function camposDosDados(corpo: unknown): CamposDosDados {
  const c = (corpo !== null && typeof corpo === 'object' ? corpo : {}) as Record<string, unknown>;
  const campos: Partial<Cliente> = { completarDados: false };

  if (c.telefone !== undefined) {
    if (c.telefone !== null && typeof c.telefone !== 'string') return { ok: false, erro: 'Telefone inválido' };
    const texto = (c.telefone ?? '').trim();
    if (texto === '') {
      campos.telefone = null;
    } else {
      // Mesma normalização da importação: o link do WhatsApp precisa do +55.
      const fone = normalizarTelefone(texto);
      if (!fone) return { ok: false, erro: `Telefone "${texto}" inválido — escreva com DDD, ex.: (82) 99999-1234` };
      campos.telefone = fone;
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
  if (c.codigo !== undefined && c.codigo !== null) {
    if (typeof c.codigo !== 'string' || !/^\d{1,20}$/.test(c.codigo)) return { ok: false, erro: 'Código inválido' };
    campos.documentoMascarado = `cód. ${c.codigo}`;
    campos.codigoErp = c.codigo;
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
  const v = camposDosDados(corpo);
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
  };
}
