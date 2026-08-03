import { unzipSync } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import type { EnderecoFiscal, GeoPonto } from '@rota/shared';

/**
 * Leitura da planilha `ConsultaPedidos_*.xlsx` que o ERP (GERA) exporta — a
 * fonte que SUBSTITUI o XML de NF-e na importação diária (decisão de
 * 01/08/2026). O que ela tem e a nota não tem: `Tipo de Entrega` explícito
 * (rota × retirada, sem inferência), `SituaçãoComercial` (cancelamento, que na
 * NF-e mora num documento que o ERP não exporta), coordenada GPS digitada no
 * cadastro de ~50 revendedoras e os pontos de referência da entrega.
 *
 * O arquivo real é um xlsx SEM `sharedStrings.xml` (strings inline, prefixo de
 * namespace `x:`), uma aba só. Verificado byte a byte contra o export real do
 * ciclo 11 (2019 linhas) antes de escrever isto — não é suposição de formato.
 */

export interface BlocoEndereco {
  logradouro: string;
  /** Na planilha o número da casa vem DENTRO do complemento (não há coluna
   * própria) — às vezes com lixo junto ("67 -10.404108,-36.431132"). */
  complemento: string;
  bairro: string;
  cidade: string;
  uf: string;
  cep: string;
  referencia: string;
}

export interface LinhaPlanilha {
  /** Nº do pedido no ERP (9 dígitos, único — vira o ID do documento). */
  codigoPedido: string;
  notaFiscal: number;
  /** Código da pessoa no ERP: identidade do cliente (não muda, não repete). */
  pessoa: string;
  nome: string;
  papel: string | null;
  quantidadeMateriais: number;
  valor: number;
  /** `Tipo de Entrega` traduzido; null = valor que não conhecemos (rejeitar,
   * nunca chutar rota/retirada num rótulo novo do ERP). */
  tipoEntrega: 'rota' | 'retirada' | null;
  tipoEntregaBruto: string;
  cancelada: boolean;
  enderecoCadastro: BlocoEndereco;
  enderecoEntrega: BlocoEndereco;
  telefone: string | null;
  /** Cód Estrutura Pai só dígitos: 1048 = Penedo, 1515 = Palmeira. */
  estrutura: string | null;
  lote: string | null;
  volumes: number;
  pesoBrutoKg: number;
  emitidoEm: string;
}

export type ResultadoPlanilha =
  | { ok: true; linhas: LinhaPlanilha[] }
  | { ok: false; motivo: string };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  removeNSPrefix: true,
});

export function lerPlanilha(conteudo: Uint8Array): ResultadoPlanilha {
  let arquivos: Record<string, Uint8Array>;
  try {
    arquivos = unzipSync(conteudo);
  } catch {
    return { ok: false, motivo: 'Arquivo não é um .xlsx válido (zip corrompido)' };
  }
  const caminhoSheet = Object.keys(arquivos).find((n) => /^xl\/worksheets\/sheet1\.xml$/.test(n));
  if (!caminhoSheet) {
    return { ok: false, motivo: 'Planilha sem a aba de dados (xl/worksheets/sheet1.xml)' };
  }

  let doc: any;
  try {
    doc = parser.parse(Buffer.from(arquivos[caminhoSheet]!).toString('utf8'), true);
  } catch {
    return { ok: false, motivo: 'Não deu para ler o conteúdo da planilha' };
  }

  const rows: any[] = arr(doc?.worksheet?.sheetData?.row);
  if (rows.length < 2) return { ok: false, motivo: 'Planilha sem linhas de dados' };

  // Cabeçalho → coluna. Casamento por nome NORMALIZADO (sem acento, sem
  // espaço), nunca por posição: o ERP pode reordenar colunas num export futuro
  // e um mapeamento posicional leria o campo errado sem ninguém perceber.
  const colunas = new Map<string, string>(); // letra → nome normalizado
  for (const c of arr(rows[0]?.c)) {
    const letra = letraDe(String(c?.['@_r'] ?? ''));
    const nome = normalizar(texto(c));
    if (letra && nome) colunas.set(letra, nome);
  }
  const obrigatorias = [
    'codigopedido',
    'notafiscal',
    'pessoa',
    'nomepessoa',
    'tipodeentrega',
    'situacaocomercial',
    'logradouroentrega',
    'cidadeentregaretirada',
    'ufentregaretirada',
  ];
  const presentes = new Set(colunas.values());
  const faltando = obrigatorias.filter((c) => !presentes.has(c));
  if (faltando.length > 0) {
    return { ok: false, motivo: `Planilha sem as colunas: ${faltando.join(', ')}` };
  }

  const linhas: LinhaPlanilha[] = [];
  for (const row of rows.slice(1)) {
    const valores = new Map<string, string>(); // nome normalizado → valor
    for (const c of arr(row?.c)) {
      const nome = colunas.get(letraDe(String(c?.['@_r'] ?? '')));
      if (nome) valores.set(nome, texto(c));
    }
    const v = (nome: string) => (valores.get(nome) ?? '').trim();
    if (!v('codigopedido')) continue; // linha vazia de rodapé

    linhas.push({
      codigoPedido: v('codigopedido'),
      notaFiscal: Number(v('notafiscal')) || 0,
      pessoa: v('pessoa'),
      nome: v('nomepessoa'),
      papel: v('papel') || null,
      quantidadeMateriais: Number(v('qtdemateriais')) || 0,
      valor: Number(v('valorpraticado')) || 0,
      tipoEntrega: tipoDe(v('tipodeentrega')),
      tipoEntregaBruto: v('tipodeentrega'),
      cancelada: normalizar(v('situacaocomercial')) === 'cancelado',
      enderecoCadastro: {
        logradouro: v('logradouro'),
        complemento: v('complemento'),
        bairro: v('bairro'),
        cidade: v('cidade'),
        uf: v('uf'),
        cep: v('cep'),
        referencia: v('referencia'),
      },
      enderecoEntrega: {
        logradouro: v('logradouroentrega'),
        complemento: v('complementoentregaretirada'),
        bairro: v('bairroentregaretirada'),
        cidade: v('cidadeentregaretirada'),
        uf: v('ufentregaretirada'),
        cep: v('cepentregaretirada'),
        referencia: v('referenciaentregaretirada'),
      },
      telefone: v('telefone') || null,
      estrutura: somenteDigitos(v('codestruturapai')) || null,
      lote: v('lotedeseparacao') || null,
      volumes: Number(v('volume')) || 0,
      // `Peso Real` vem em GRAMAS (12047 = 12,047 kg) — conferido contra o
      // <pesoB> das NF-e do mesmo ciclo: /1000 bate em 2019/2019.
      pesoBrutoKg: pesoKg(v('pesoreal')) ?? pesoKg(v('pesoestimado')) ?? 0,
      emitidoEm: dataIso(v('datafaturamento')) ?? dataIso(v('datacaptacao')) ?? '',
    });
  }

  return { ok: true, linhas };
}

/**
 * `EnderecoFiscal` a partir de um bloco da planilha. O número da casa mora no
 * COMPLEMENTO (não há coluna própria) e vai quase verbatim: "S/N" fica "S/N",
 * porque a geocodificação e o motorista toleram, e inventar número é pior.
 *
 * A limpeza que existe é uma só, e é obrigatória: parte das revendedoras digita
 * a COORDENADA GPS junto do número ("67 -10.404108,-36.431132"). Esse texto
 * inteiro iria para a busca do Google e estragaria a consulta do endereço —
 * justamente o cliente que ganhou pin exato acabaria com o endereço ilegível
 * no cadastro e na tela do motorista. Fica só o que vem antes da coordenada.
 */
export function enderecoDeBloco(b: BlocoEndereco): EnderecoFiscal {
  return {
    logradouro: b.logradouro,
    numero: numeroLimpo(b.complemento),
    bairro: b.bairro,
    municipio: b.cidade,
    uf: b.uf,
    cep: somenteDigitos(b.cep),
  };
}

/** Corta a partir do primeiro sinal de coordenada (o `-` de uma latitude ou o
 * grau do formato DMS). Sobrando nada, vira "S/N". */
function numeroLimpo(complemento: string): string {
  const semGps = complemento
    .replace(/-?\d{1,2}[.,]\d{4,9}\s*[;,]?\s*-?\d{1,2}[.,]\d{4,9}/g, '')
    .replace(/\d{1,2}[°º][^,;]*[SN][^,;]*[°º][^,;]*[WOE]/gi, '')
    .replace(/[\s;,.-]+$/, '')
    .trim();
  return semGps || 'S/N';
}

/**
 * Coordenada GPS digitada nos campos de texto do cadastro (~50 revendedoras
 * fazem isso). Formatos reais encontrados: decimal com vírgula, ponto e
 * vírgula ou espaço (`-10.28, -36.54`, `-9.91;-36.61`) e DMS
 * (`10°07'30.1"S36°10'11.9"W`). Só aceita ponto DENTRO de Alagoas — coordenada
 * fora do estado é lixo de digitação, e um pin errado com cara de certo é o
 * pior dado que existe nesta base.
 */
const DECIMAL = /(-\s?\d{1,2}[.,]\d{4,9})\s*[;,]?\s*(-\s?\d{1,2}[.,]\d{4,9})/;
const DMS =
  /(\d{1,2})[°º]\s*(\d{1,2})'\s*([\d.]+)"?\s*([SN])\s*,?\s*(\d{1,3})[°º]\s*(\d{1,2})'\s*([\d.]+)"?\s*([WOE])/i;

export function extrairCoordenada(textos: Array<string | null | undefined>): GeoPonto | null {
  for (const t of textos) {
    if (!t) continue;
    const dms = DMS.exec(t);
    if (dms) {
      let lat = Number(dms[1]) + Number(dms[2]) / 60 + Number(dms[3]) / 3600;
      let lng = Number(dms[5]) + Number(dms[6]) / 60 + Number(dms[7]) / 3600;
      if (dms[4]!.toUpperCase() === 'S') lat = -lat;
      if (['W', 'O'].includes(dms[8]!.toUpperCase())) lng = -lng;
      const ponto = { lat: arred6(lat), lng: arred6(lng) };
      if (dentroDeAlagoas(ponto)) return ponto;
      continue;
    }
    const dec = DECIMAL.exec(t);
    if (dec) {
      const lat = Number(dec[1]!.replace(/\s/g, '').replace(',', '.'));
      const lng = Number(dec[2]!.replace(/\s/g, '').replace(',', '.'));
      const ponto = { lat: arred6(lat), lng: arred6(lng) };
      if (dentroDeAlagoas(ponto)) return ponto;
    }
  }
  return null;
}

/** Mesma caixa do mapa offline e do OSRM (bbox de Alagoas com folga). */
function dentroDeAlagoas(p: GeoPonto): boolean {
  return p.lat >= -10.9 && p.lat <= -8.5 && p.lng >= -38.6 && p.lng <= -34.9;
}

function arred6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function tipoDe(bruto: string): 'rota' | 'retirada' | null {
  const t = normalizar(bruto);
  if (t === 'noenderecodeentrega') return 'rota';
  if (t === 'retirarnacentraldeservicos') return 'retirada';
  return null;
}

/** `20/07/2026` → `2026-07-20T00:00:00-03:00` (fuso da operação, como o dhEmi
 * das NF-e — a listagem de pedidos ordena por esta string). */
function dataIso(bruta: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(bruta.trim());
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}T00:00:00-03:00`;
}

function pesoKg(bruto: string): number | null {
  if (!bruto.trim()) return null;
  const gramas = Number(bruto.replace(',', '.'));
  if (!Number.isFinite(gramas) || gramas <= 0) return null;
  return Math.round(gramas) / 1000;
}

function normalizar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function somenteDigitos(s: string): string {
  return s.replace(/\D/g, '');
}

function letraDe(ref: string): string {
  return /^([A-Z]+)\d+$/.exec(ref)?.[1] ?? '';
}

function texto(celula: any): string {
  const v = celula?.v;
  return v === undefined || v === null ? '' : String(v);
}

function arr(x: unknown): any[] {
  return x === undefined || x === null ? [] : Array.isArray(x) ? x : [x];
}
