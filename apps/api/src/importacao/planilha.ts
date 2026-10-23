import { unzipSync } from 'fflate';
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
 *
 * A leitura é em FLUXO, linha a linha, e não por árvore: com um parser DOM os
 * 9 MB de XML viravam ~185 MB de objetos (20x de amplificação). Numa instância
 * Render free de 512 MB isso estourava a memória — o processo morria, a
 * requisição sumia sem resposta, e no navegador aparecia como "erro de CORS",
 * que despista de vez. Aqui o pico é o texto mais UMA linha por vez.
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
  /** `SituaçãoComercial = Entregue`: o ERP já registrou a entrega (sempre com
   * `DataEntrega` preenchida nas planilhas reais). */
  entregueNoErp: boolean;
  /** `DataEntrega` do ERP em AAAA-MM-DD, quando vem. */
  dataEntrega: string | null;
  enderecoCadastro: BlocoEndereco;
  enderecoEntrega: BlocoEndereco;
  telefone: string | null;
  /** Cód Estrutura Pai só dígitos: 1048 = Penedo, 1515 = Palmeira. */
  estrutura: string | null;
  /** `CodCD` só dígitos (542 = Penedo, 684 = Palmeira): preenchido em 100% das
   * linhas, inclusive no "Consumidor Final", que vem sem estrutura. */
  codCd: string | null;
  lote: string | null;
  volumes: number;
  pesoBrutoKg: number;
  emitidoEm: string;
}

export type ResultadoPlanilha =
  | { ok: true; linhas: LinhaPlanilha[] }
  | { ok: false; motivo: string };

/** Sem estas colunas o arquivo não é o relatório que esperamos. */
const OBRIGATORIAS = [
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

/**
 * Teto do XML DESCOMPRIMIDO. O upload limita o .xlsx a 5 MB, mas zip é
 * compressão: um arquivo forjado de 5 MB infla para centenas de MB e derruba a
 * instância de 512 MB — negação de serviço por um upload. O ciclo real inteiro
 * (3507 notas) dá ~9 MB de XML; 40 MB é 4x de folga e ainda é um limite.
 */
const XML_MAXIMO_BYTES = 40 * 1024 * 1024;

export function lerPlanilha(conteudo: Uint8Array): ResultadoPlanilha {
  let arquivos: Record<string, Uint8Array>;
  let estourou = false;
  try {
    // Só a aba de dados é inflada — estilos, temas e o resto do pacote nem
    // passam pelo descompressor. O tamanho é conferido ANTES de inflar, e o
    // campo certo é `originalSize` (descomprimido) — `size` é o COMPRIMIDO,
    // que numa bomba é justamente o número pequeno e inocente. Zip que mente o
    // originalSize para baixo também não estoura: a fflate aloca o buffer pelo
    // declarado e não cresce além dele.
    arquivos = unzipSync(conteudo, {
      filter: (arquivo) => {
        if (arquivo.name !== 'xl/worksheets/sheet1.xml') return false;
        if (arquivo.originalSize > XML_MAXIMO_BYTES) {
          estourou = true;
          return false;
        }
        // Zip que MENTE o tamanho para baixo: a memória fica no declarado, mas
        // a CPU descomprimia o real — 4 MB comprimidos "valendo" 1 KB seguraram
        // o event loop por 63 s. Deflate de verdade nunca sai muito maior que o
        // original (dado incompressível fica do mesmo tamanho), então
        // comprimido bem maior que o declarado é mentira.
        if (arquivo.size > arquivo.originalSize * 1.1 + 4096) {
          estourou = true;
          return false;
        }
        return true;
      },
    });
  } catch {
    return { ok: false, motivo: 'Arquivo não é um .xlsx válido (zip corrompido)' };
  }
  if (estourou) {
    return {
      ok: false,
      motivo: `Planilha grande demais (aba de dados acima de ${XML_MAXIMO_BYTES / 1024 / 1024} MB descomprimida) — se for um export legítimo, divida o período`,
    };
  }
  const caminho = Object.keys(arquivos).find((n) => n === 'xl/worksheets/sheet1.xml');
  if (!caminho) {
    return { ok: false, motivo: 'Planilha sem a aba de dados (xl/worksheets/sheet1.xml)' };
  }
  const xml = Buffer.from(arquivos[caminho]!).toString('utf8');

  // Cabeçalho → coluna, casado por nome NORMALIZADO e nunca por posição: o ERP
  // pode reordenar colunas num export futuro, e um mapeamento posicional leria
  // o campo errado sem ninguém perceber.
  const colunas = new Map<string, string>();
  const linhas: LinhaPlanilha[] = [];
  let viuCabecalho = false;

  for (const bruta of varrerLinhas(xml)) {
    if (!viuCabecalho) {
      for (const [letra, valor] of celulas(bruta)) {
        const nome = normalizar(valor);
        if (nome) colunas.set(letra, nome);
      }
      if (colunas.size === 0) continue; // linha em branco antes do cabeçalho
      viuCabecalho = true;
      const presentes = new Set(colunas.values());
      const faltando = OBRIGATORIAS.filter((c) => !presentes.has(c));
      if (faltando.length > 0) {
        return { ok: false, motivo: `Planilha sem as colunas: ${faltando.join(', ')}` };
      }
      continue;
    }

    const valores = new Map<string, string>();
    for (const [letra, valor] of celulas(bruta)) {
      const nome = colunas.get(letra);
      if (nome) valores.set(nome, valor);
    }
    // Teto por célula: uma célula gigante (a aba aceita até 40 MB) virava um
    // documento acima de 1 MiB, que o banco recusa — e a recusa derrubava a
    // importação. Nenhum campo real passa de umas centenas de caracteres.
    const v = (nome: string) => (valores.get(nome) ?? '').trim().slice(0, 1000);
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
      entregueNoErp: normalizar(v('situacaocomercial')) === 'entregue',
      dataEntrega: dataIso(v('dataentrega'))?.slice(0, 10) ?? null,
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
      codCd: somenteDigitos(v('codcd')) || null,
      lote: v('lotedeseparacao') || null,
      volumes: Number(v('volume')) || 0,
      // `Peso Real` vem em GRAMAS (12047 = 12,047 kg) — conferido contra o
      // <pesoB> das NF-e do mesmo ciclo: /1000 bate em 2019/2019.
      pesoBrutoKg: pesoKg(v('pesoreal')) ?? pesoKg(v('pesoestimado')) ?? 0,
      emitidoEm: dataIso(v('datafaturamento')) ?? dataIso(v('datacaptacao')) ?? '',
    });
  }

  if (!viuCabecalho) return { ok: false, motivo: 'Planilha sem linhas de dados' };
  return { ok: true, linhas };
}

/**
 * `<row>…</row>` uma por vez. `row` não aninha, então um par não-guloso casa a
 * linha inteira; `matchAll` é preguiçoso e não materializa todas de uma vez.
 *
 * As regex deste arquivo já foram corrompidas por edição via script: um `\b`
 * escrito por interpolação virou o caractere BACKSPACE literal dentro do
 * padrão, e a busca passou a procurar algo que nunca existe — zero linhas,
 * sem erro nenhum. Mexer aqui é só com edição direta.
 */
function* varrerLinhas(xml: string): Generator<string> {
  // Abertura por regex, fechamento por `indexOf` — LINEAR. O par não-guloso
  // `<row>([\s\S]*?)</row>` reescaneava até o fim do texto a cada `<row>` sem
  // `</row>`: um .xlsx forjado de 61 KB (40 MB inflado) segurava o event loop
  // por horas, e com ele a API inteira.
  const abre = /<(\w+:)?row\b[^>]{0,2000}>/g;
  let m: RegExpExecArray | null;
  while ((m = abre.exec(xml))) {
    const fecha = `</${m[1] ?? ''}row>`;
    const fim = xml.indexOf(fecha, abre.lastIndex);
    if (fim < 0) return; // linha sem fechamento: o resto não é confiável
    yield xml.slice(abre.lastIndex, fim);
    abre.lastIndex = fim + fecha.length;
  }
}

/** `[letra da coluna, valor]` de cada célula. Suporta `<v>` (o que o ERP usa) e
 * `<is><t>` (string inline), célula vazia auto-fechada, e desescapa entidades. */
function* celulas(linha: string): Generator<[string, string]> {
  // Mesma razão de `varrerLinhas`: fechamento por `indexOf`, nunca um par
  // não-guloso que reescaneia a linha inteira a cada `<c>` sem `</c>`.
  const abre = /<(\w+:)?c\b([^>]{0,2000})>/g;
  let m: RegExpExecArray | null;
  while ((m = abre.exec(linha))) {
    const atributos = m[2] ?? '';
    const ref = /\br="([A-Z]+)\d+"/.exec(atributos);
    if (atributos.endsWith('/')) {
      if (ref) yield [ref[1]!, ''];
      continue;
    }
    const fecha = `</${m[1] ?? ''}c>`;
    const fim = linha.indexOf(fecha, abre.lastIndex);
    if (fim < 0) return;
    const interno = linha.slice(abre.lastIndex, fim);
    abre.lastIndex = fim + fecha.length;
    if (!ref) continue;
    yield [ref[1]!, valorDaCelula(interno)];
  }
}

/** O texto de `<v>` ou `<is><t>`, também por `indexOf`. */
function valorDaCelula(interno: string): string {
  const abre = /<(\w+:)?(v|t)>/.exec(interno);
  if (!abre) return '';
  const inicio = abre.index + abre[0].length;
  const fim = interno.indexOf(`</${abre[1] ?? ''}${abre[2]}>`, inicio);
  return fim < 0 ? '' : desescapar(interno.slice(inicio, fim));
}

/** `&amp;` por último: desfazer antes reintroduziria entidades vindas do texto. */
function desescapar(t: string): string {
  return t
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // As duas formas numéricas do XML — decimal E hexadecimal (o export atual
    // usa a decimal, mas nada obriga o ERP a continuar). `fromCodePoint`, não
    // `fromCharCode`: este último trunca em 16 bits e trocava um emoji por
    // lixo em silêncio. E com guarda, porque `fromCodePoint` LANÇA em código
    // fora da faixa — uma entidade forjada numa planilha viraria 500 na
    // importação inteira; ponto inválido some, que é o que ele vale.
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => doCodigo(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => doCodigo(Number(n)))
    .replace(/&amp;/g, '&');
}

function doCodigo(codigo: number): string {
  const naFaixa = Number.isInteger(codigo) && codigo >= 0 && codigo <= 0x10ffff;
  const substituto = codigo >= 0xd800 && codigo <= 0xdfff;
  return naFaixa && !substituto ? String.fromCodePoint(codigo) : '';
}

/**
 * `EnderecoFiscal` a partir de um bloco da planilha. O número da casa mora no
 * COMPLEMENTO (não há coluna própria) e vai quase verbatim: "S/N" fica "S/N",
 * porque a geocodificação e o motorista toleram, e inventar número é pior.
 *
 * A limpeza que existe é uma só, e é obrigatória: parte das revendedoras digita
 * a COORDENADA GPS junto do número ("67 -10.404108,-36.431132"). Esse texto
 * inteiro iria para a busca do Google e para a tela do motorista — justamente o
 * cliente que ganhou pin exato ficaria com o endereço ilegível.
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

/** Tira a coordenada colada no número. Sobrando nada, vira "S/N". */
function numeroLimpo(complemento: string): string {
  const semGps = complemento
    .replace(/-?\d{1,2}[.,]\d{4,}\s*[;,]?\s*-?\d{1,2}[.,]\d{4,}/g, '')
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
// Casas decimais SEM teto: colado do Google Maps vem com 15 ("-10.28076012345678"),
// e o antigo {4,9} perdia esse pin exato — 2 das 53 revendedoras com GPS no
// ciclo 11 caíam na busca paga.
const DECIMAL = /(-\s?\d{1,2}[.,]\d{4,})\s*[;,]?\s*(-\s?\d{1,2}[.,]\d{4,})/;
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

/** `"Tipo de Entrega"` → `tipodeentrega`. O range de diacríticos vai como
 * ESCAPE (`̀-ͯ`), nunca como caractere literal: o literal já se
 * corrompeu numa edição e a normalização passou a devolver lixo em silêncio. */
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
