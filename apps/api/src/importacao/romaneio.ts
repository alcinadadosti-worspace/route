import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { normalizar } from '@rota/shared';
import type { BlocoEndereco } from './planilha.js';

/** Fontes padrão do PDF (métricas), que vêm no próprio pacote do pdf.js. No
 * Node ele as lê do disco: caminho com barra no fim. */
const PASTA_FONTES_PADRAO =
  join(dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts').replace(/\\/g, '/') + '/';

/**
 * Leitura do ROMANEIO em PDF da Plataforma Logística do Boticário
 * (`plataformalogistica.grupoboticario.com.br/rotas/<n>/print`, impresso pelo
 * navegador) — a fonte de pedidos que o usuário passou a usar em 26/10/2026, no
 * lugar da planilha `ConsultaPedidos` do ERP. Um PDF por rota de lá; todo pedido
 * da folha vai para entrega (sem cancelado, sem retirada — afirmação do usuário).
 *
 * POR POSIÇÃO, NÃO POR SEQUÊNCIA. A extração de texto em ordem embaralha as
 * colunas da tabela: a cidade e o endereço saíam intercalados letra a letra
 * ("QUEBRANGULOR/AUA DAS FLORES"). Cada item de texto do PDF tem posição
 * (x, y); a coluna é decidida pelo x do cabeçalho, e a linha começa no número da
 * NF. Medido no romaneio real (rota 1673300): 11/11 linhas com todas as colunas
 * certas, inclusive as células que quebram em 2–3 linhas.
 */

/** Um pedaço de texto da página, com a posição em pontos PDF (y cresce para cima). */
export interface ItemTexto {
  x: number;
  y: number;
  texto: string;
  /** Cabeçalho/rodapé que o NAVEGADOR imprime na margem (data, título, URL,
   * "1/2") — não é da folha. Marcado na leitura do PDF, que sabe a altura da página. */
  margem?: boolean;
}

export interface LinhaRomaneio {
  notaFiscal: number;
  cep: string;
  nome: string;
  /** "Pedido Entrega" — o código do pedido no ERP (9 dígitos), ou o do site
   * ("160000001-1") nos pedidos de Consumidor Final. */
  pedido: string;
  bairro: string;
  cidade: string;
  uf: string;
  /** "RUA, NÚMERO, complemento-referência", como a plataforma imprime. */
  endereco: string;
}

export interface Romaneio {
  rota: string;
  motorista: string;
  /** "Quantidade: N pacotes" do cabeçalho; null quando não veio. */
  quantidade: number | null;
  linhas: LinhaRomaneio[];
  /** Quando a folha foi impressa ("26/10/2026, 17:12" no topo), em
   * `…T17:12:00-03:00`; null/ausente quando o navegador não imprimiu a data. */
  impressoEm?: string | null;
  /** Linhas lidas mas recusadas (pedido ilegível), com o motivo. */
  recusadas?: string[];
}

export type ResultadoRomaneio = { ok: true; romaneio: Romaneio } | { ok: false; motivo: string };

/** Cabeçalho da tabela → campo. Casado por texto normalizado, não por ordem. */
const COLUNAS: Array<[string, keyof LinhaRomaneio | 'cidadeUf']> = [
  ['NF DO PEDIDO', 'notaFiscal'],
  ['CEP', 'cep'],
  ['NOME DO DESTINATARIO', 'nome'],
  ['PEDIDO ENTREGA', 'pedido'],
  ['BAIRRO', 'bairro'],
  ['CIDADE/UF', 'cidadeUf'],
  ['ENDERECO', 'endereco'],
];

/** Um romaneio de rota tem 1–3 páginas; o teto só barra arquivo que não é romaneio
 * (e o custo de ler centenas de páginas de um PDF qualquer). */
const MAX_PAGINAS = 30;

/** Itens na mesma linha visual: o PDF real usa exatamente o mesmo y, a folga
 * cobre arredondamento de outro gerador. */
const MESMA_LINHA = 2;
/** Entre as linhas de uma célula que quebra o passo é ~13 pt. Um salto maior
 * que isto é outra coisa: o rodapé "1/2" do navegador grudava no endereço da
 * última linha quando a faixa dela ia até o fim da página. */
const SALTO_MAXIMO = 22;

/** Faixa da borda da página onde o navegador imprime cabeçalho e rodapé: no
 * romaneio real, 22 pt do topo e 16 pt do pé; o conteúdo começa a 28 pt. */
const FAIXA_DA_MARGEM = 26;

/**
 * Altura (a partir do pé da página) abaixo da qual uma linha da tabela pode ter
 * sido CORTADA pela quebra de página: o conteúdo começa a 28 pt e o passo entre
 * linhas de uma célula é 13 pt. Linha que termina acima disto coube inteira — e
 * o que estiver no topo da página seguinte não é resto dela.
 */
const PE_DA_PAGINA = 70;

/** "26/10/2026, 17:12" — a data que o navegador imprime no topo da folha. */
const DATA_IMPRESSA = /^(\d{2})\/(\d{2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})$/;

/**
 * Texto que o navegador imprime na margem. Só a posição não basta (com margem
 * mínima o conteúdo encosta na borda, e uma linha de pedido seria jogada fora);
 * só o texto também não (um endereço pode ter "1/2"). Os dois juntos, sim. Sem
 * isto o "1/3" do rodapé grudava no endereço da última linha da página quando
 * ela terminava a menos de 22 pt dele — medido em romaneios de várias páginas.
 */
function ehDaMargem(texto: string, y: number, yBase: number, yTopo: number): boolean {
  const naBorda = y < yBase + FAIXA_DA_MARGEM || y > yTopo - FAIXA_DA_MARGEM;
  return (
    naBorda &&
    (/^\d+\s*\/\s*\d+$/.test(texto) ||
      /^https?:\/\//i.test(texto) ||
      DATA_IMPRESSA.test(texto) ||
      /plataforma log[ií]stica/i.test(texto))
  );
}

/**
 * Código do pedido numa linha do romaneio: o do ERP (9 dígitos hoje; a folga
 * cobre o código crescer) ou o do site com sufixo ("160000001-1"). Uma linha
 * sem NF se funde com a de cima, e os dois pedidos viravam UM código de 18
 * dígitos — que passava como pedido válido e escondia o verdadeiro.
 */
const PEDIDO_DA_FOLHA = /^\d{6,12}(-\d{1,4})?$/;

/** Lê o PDF e devolve o romaneio. O pdf.js é importado só aqui, sob demanda:
 * pesa na memória e a instância do Render tem 512 MB. */
export async function lerRomaneio(conteudo: Uint8Array): Promise<ResultadoRomaneio> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
  try {
    doc = await pdfjs.getDocument({
      // Cópia: o pdf.js toma posse do buffer (ele é transferido e fica vazio).
      data: new Uint8Array(conteudo),
      // Arquivo que veio do upload: nada de executar código embutido no PDF.
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      // Sem as métricas das fontes padrão (Helvetica…), o pdf.js não sabe a
      // largura do texto e FUNDE células vizinhas da mesma linha num item só
      // ("NF do pedido CEP") — a coluna passava a ser lida errada. O romaneio
      // do navegador embute as fontes, mas outro gerador pode não embutir.
      standardFontDataUrl: PASTA_FONTES_PADRAO,
      verbosity: 0,
    }).promise;
  } catch {
    return { ok: false, motivo: 'Arquivo não é um PDF válido' };
  }
  try {
    if (doc.numPages > MAX_PAGINAS) {
      return { ok: false, motivo: `PDF com ${doc.numPages} páginas — não parece um romaneio de rota` };
    }
    const paginas: ItemTexto[][] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const pagina = await doc.getPage(n);
      const { items } = await pagina.getTextContent();
      const itens: ItemTexto[] = [];
      // y medido a partir do PÉ da página (a caixa da página pode não começar
      // em 0): as faixas de margem e o `PE_DA_PAGINA` contam daí.
      const [, yBase = 0, , yTopo = 842] = pagina.view;
      for (const item of items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const y = (item.transform[5] as number) - yBase;
        const texto = item.str.trim();
        itens.push({ x: item.transform[4] as number, y, texto, margem: ehDaMargem(texto, y, 0, yTopo - yBase) });
      }
      paginas.push(itens);
    }
    return romaneioDasPaginas(paginas);
  } catch {
    return { ok: false, motivo: 'Não foi possível ler o texto do PDF' };
  } finally {
    await doc.destroy();
  }
}

/** O romaneio a partir do texto posicionado de cada página — a parte testável. */
export function romaneioDasPaginas(paginas: ItemTexto[][]): ResultadoRomaneio {
  const todos = paginas.flat();
  const rotas = valoresAoLado(paginas, 'ROTA:').map((r) => r.replace(/\s+/g, ''));
  const motoristas = valoresAoLado(paginas, 'MOTORISTA:');
  const quantidade = /^(\d+)/.exec(valoresAoLado(paginas, 'QUANTIDADE:')[0] ?? '')?.[1];
  // Dois romaneios colados num PDF só: as linhas do segundo entravam com o
  // motorista, o CD e a rota do PRIMEIRO — mercadoria no caminhão errado.
  if (rotas.length > 1 || motoristas.length > 1) {
    return {
      ok: false,
      motivo: `PDF com mais de um romaneio (rotas ${rotas.join(', ') || '?'}; motoristas ${motoristas.join(', ') || '?'}) — envie um romaneio por arquivo`,
    };
  }
  const rota = rotas[0] ?? '';
  const motorista = motoristas[0] ?? '';

  // A tabela pode continuar na página seguinte com ou sem o cabeçalho repetido:
  // sem ele, valem as colunas da página anterior.
  let colunas: Array<{ campo: Campo; x: number }> | null = null;
  const brutas: Celulas[] = [];
  let paginaDaUltima = -1;
  /** Onde a última linha lida terminou (o menor y dela). */
  let pisoDaUltima = Infinity;

  for (const [p, daPagina] of paginas.entries()) {
    // O que o navegador imprime na margem não é da tabela.
    const itens = daPagina.filter((i) => !i.margem);
    // Os rótulos valem só na MESMA linha de "NF do pedido": um bairro chamado
    // "CEP" ou "BAIRRO" numa linha de dados não pode virar posição de coluna.
    const nf = itens.find((i) => normalizar(i.texto) === COLUNAS[0]![0]);
    const doCabecalho = COLUNAS.map(([rotulo, campo]) => ({
      campo,
      item: nf
        ? itens.find((i) => Math.abs(i.y - nf.y) <= MESMA_LINHA && normalizar(i.texto) === rotulo)
        : undefined,
    }));
    let yCabecalho = Infinity;
    if (doCabecalho.every((c) => c.item)) {
      colunas = doCabecalho.map((c) => ({ campo: c.campo, x: c.item!.x })).sort((a, b) => a.x - b.x);
      yCabecalho = Math.min(...doCabecalho.map((c) => c.item!.y));
    }
    if (!colunas) continue;
    const cols = colunas;
    const limiteDireito = (k: number) => (cols[k + 1]?.x ?? Infinity) - 3;
    const naColuna = (i: ItemTexto, k: number) => i.x >= cols[k]!.x - 3 && i.x < limiteDireito(k);
    const kNf = cols.findIndex((c) => c.campo === 'notaFiscal');
    /** Junta os textos de cada coluna, de cima para baixo e da esquerda para a direita. */
    const anexar = (destino: Celulas, daLinha: ItemTexto[]) => {
      for (const [k, c] of cols.entries()) {
        const textos = daLinha
          .filter((i) => naColuna(i, k))
          .sort((a, b) => b.y - a.y || a.x - b.x)
          .map((i) => i.texto);
        (destino[c.campo] ??= []).push(...textos);
      }
    };

    // A linha da tabela começa no número da NF: é a única célula que nunca
    // quebra, e não depende do glifo da caixinha "▢" (que outra fonte trocaria).
    const ancoras = itens
      .filter((i) => i.y < yCabecalho - MESMA_LINHA && naColuna(i, kNf) && /^\d{3,}$/.test(i.texto))
      .map((i) => i.y)
      .sort((a, b) => b - a);

    // A quebra de página corta a linha da tabela no meio: o resto das células
    // vai para o TOPO da página seguinte, antes da primeira NF dela. Ignorado,
    // o nome saía sem o sobrenome e o endereço pela metade — e a contagem de
    // pacotes batia, então nada avisava.
    //
    // Só quando a última linha ENCOSTOU no pé da página anterior. O PDF real
    // tem uma 2ª página só com o cabeçalho do navegador: emendando sempre, um
    // título ou um "Observações" ali virava o fim do nome da última cliente. E
    // rótulo ("Observações:") nunca é resto de célula.
    const ultima = brutas[brutas.length - 1];
    if (ultima && paginaDaUltima < p && pisoDaUltima < PE_DA_PAGINA) {
      const yPrimeira = ancoras[0] ?? -Infinity;
      const acima = itens.filter(
        (i) => i.y < yCabecalho - MESMA_LINHA && i.y > yPrimeira + MESMA_LINHA && !i.texto.endsWith(':'),
      );
      anexar(ultima, contiguasDoTopo(acima));
    }

    for (const [k, yTopo] of ancoras.entries()) {
      const yProxima = ancoras[k + 1] ?? -Infinity;
      const daFaixa = itens.filter((i) => i.y <= yTopo + MESMA_LINHA && i.y > yProxima + MESMA_LINHA);
      // Só as linhas visuais CONTÍGUAS à da NF: o que vem depois de um salto
      // ("Observações", a assinatura) não é desta linha da tabela.
      const celulas: Celulas = {};
      const daLinha = contiguasDoTopo(daFaixa);
      anexar(celulas, daLinha);
      brutas.push(celulas);
      paginaDaUltima = p;
      pisoDaUltima = Math.min(...daLinha.map((i) => i.y));
    }
  }

  if (!colunas) {
    return { ok: false, motivo: 'PDF sem a tabela do romaneio (cabeçalho "NF do pedido … Endereço" não encontrado)' };
  }
  // Sem o número, o pedido não guarda de que rota veio (a busca do painel
  // falha) — e um cabeçalho que não se lê é sinal de que a folha mudou de forma.
  if (!/^\d{1,20}$/.test(rota)) {
    return { ok: false, motivo: 'Romaneio sem o número da rota ("Rota:") no cabeçalho — a folha mudou de formato?' };
  }

  const linhas: LinhaRomaneio[] = [];
  const recusadas: string[] = [];
  for (const c of brutas) {
    const celula = (campo: Campo) => (c[campo] ?? []).join(' ').replace(/\s+/g, ' ').trim().slice(0, 1000);
    const cidadeUf = celula('cidadeUf');
    const barra = cidadeUf.lastIndexOf('/');
    const linha: LinhaRomaneio = {
      notaFiscal: Number(celula('notaFiscal')) || 0,
      cep: celula('cep').replace(/\D/g, ''),
      nome: celula('nome'),
      pedido: celula('pedido').replace(/\s+/g, ''),
      bairro: celula('bairro'),
      cidade: (barra >= 0 ? cidadeUf.slice(0, barra) : cidadeUf).trim(),
      uf: (barra >= 0 ? cidadeUf.slice(barra + 1) : '').trim().toUpperCase(),
      endereco: celula('endereco'),
    };
    if (!PEDIDO_DA_FOLHA.test(linha.pedido)) {
      recusadas.push(
        `NF ${linha.notaFiscal || '?'}: pedido "${linha.pedido.slice(0, 40) || '(em branco)'}" ilegível — confira esta linha no PDF (linha sem NF fundida com a de cima?)`,
      );
      continue;
    }
    linhas.push(linha);
  }
  if (linhas.length === 0 && recusadas.length === 0) return { ok: false, motivo: 'Romaneio sem nenhuma linha de pedido' };
  return {
    ok: true,
    romaneio: {
      rota,
      motorista,
      quantidade: quantidade ? Number(quantidade) : null,
      linhas,
      impressoEm: dataImpressa(todos),
      recusadas,
    },
  };
}

type Campo = (typeof COLUNAS)[number][1];
type Celulas = Partial<Record<Campo, string[]>>;

/** Só as linhas visuais CONTÍGUAS a partir da de cima: um salto maior que
 * `SALTO_MAXIMO` separa a linha da tabela do que vem depois. */
function contiguasDoTopo(itens: ItemTexto[]): ItemTexto[] {
  const ys = [...new Set(itens.map((i) => Math.round(i.y)))].sort((a, b) => b - a);
  let piso = ys[0] ?? 0;
  for (const y of ys.slice(1)) {
    if (piso - y > SALTO_MAXIMO) break;
    piso = y;
  }
  return itens.filter((i) => Math.round(i.y) >= piso);
}

/**
 * Os valores à direita de um rótulo do cabeçalho ("Rota:" → "1673300"), um por
 * valor DISTINTO, procurados página a página (o mesmo y em duas páginas não é
 * a mesma linha). Rótulo em branco pegava o rótulo seguinte da linha
 * ("Motorista:" vazio devolvia "Assinatura:", e a recusa citava esse "nome"):
 * texto que termina em ":" é rótulo, não valor.
 */
function valoresAoLado(paginas: ItemTexto[][], rotulo: string): string[] {
  // Distintos pelo texto NORMALIZADO: o mesmo motorista em caixa diferente, ou
  // a rota com um espaço no meio, num topo repetido, não são dois romaneios.
  const valores = new Map<string, string>();
  for (const itens of paginas) {
    for (const r of itens.filter((i) => normalizar(i.texto) === rotulo)) {
      const ao = itens
        .filter((i) => Math.abs(i.y - r.y) <= MESMA_LINHA && i.x > r.x)
        .sort((a, b) => a.x - b.x)[0];
      const valor = ao?.texto.trim() ?? '';
      const chave = normalizar(valor).replace(/\s+/g, '');
      if (valor && !valor.endsWith(':') && !valores.has(chave)) valores.set(chave, valor);
    }
  }
  return [...valores.values()];
}

/** A data impressa no topo da folha, no formato das outras datas do sistema. */
function dataImpressa(itens: ItemTexto[]): string | null {
  for (const i of itens) {
    const m = DATA_IMPRESSA.exec(i.texto);
    if (!m) continue;
    const [, d, mes, a, h, min] = m;
    // Data que existe ("31/02" não): o texto vira data de pedido e entra na
    // comparação de "endereço mais novo".
    const dia = new Date(Date.UTC(Number(a), Number(mes) - 1, Number(d)));
    if (dia.getUTCMonth() !== Number(mes) - 1 || dia.getUTCDate() !== Number(d) || Number(h) > 23 || Number(min) > 59) {
      continue;
    }
    return `${a}-${mes}-${d}T${h!.padStart(2, '0')}:${min}:00-03:00`;
  }
  return null;
}

/**
 * CD de cada motorista do Boticário — regra dada pelo usuário em 26/10/2026: o
 * romaneio não diz de qual galpão a mercadoria sai, mas cada motorista de lá
 * atende um CD só. Devolve o `CodCD` do ERP (o mesmo código que a planilha usa),
 * para o romaneio cair na tabela de CDs que já existe. Nome desconhecido = null:
 * o PDF é recusado com aviso, NUNCA atribuído a um CD no palpite — mercadoria de
 * Palmeira montada a partir de Penedo é caminhão no lugar errado.
 */
const COD_CD_POR_MOTORISTA: Record<string, string> = {
  'CAIQUE SANTOS': '684', // Palmeira dos Índios
  'PAULO ROGERIO SANTOS': '542', // Penedo
};

export function codCdDoMotorista(nome: string): string | null {
  return COD_CD_POR_MOTORISTA[normalizar(nome)] ?? null;
}

/** Os motoristas conhecidos, para a mensagem de recusa dizer quem é aceito. */
export const MOTORISTAS_CONHECIDOS = 'Caique Santos (Palmeira dos Índios), Paulo Rogério Santos (Penedo)';

/**
 * O endereço da folha ("PREFEITO JOSÉ INÁCIO, 43, CASA-SUBIDA DO
 * PADARIA") no MESMO formato da planilha do ERP: o número da casa
 * vai DENTRO do complemento ("43 CASA"), como no cadastro. Conferido contra o
 * cadastro de revendedoras nas 10 linhas do romaneio real: rua, nº, bairro e
 * CEP idênticos — então a comparação de endereço não abre revisão falsa.
 *
 * A plataforma junta `rua, número, complemento-referência`. O número é a
 * primeira parte que PARECE número (dígitos ou S/N): se a rua tiver vírgula
 * ("RUA A, QUADRA 2, 43"), a quadra não vira o número da casa.
 */
export function blocoDoRomaneio(linha: LinhaRomaneio): BlocoEndereco {
  const partes = linha.endereco.split(',').map((p) => p.trim());
  // "43", "43A", "43-A", "271 B", e sem número: "S/N", "S\N", "SN", "S/Nº".
  // Antes o "43-A" não parecia número: o hífen dele virava o separador da
  // referência e a letra da casa se perdia ("43" + referência "A, CASA-…").
  const comDigito = /^(N[º°O]?\.?\s*)?\d+\s*-?\s*[A-Z]{0,2}$/i;
  const semNumero = /^S\s*[\\/]?\s*N\s*[º°O.]?$/i;
  // Lote como número da casa ("LT-9", "J-16") só quando nenhuma parte começa
  // por dígito: "QUADRA 3" ou "QD 3" antes do número não podem tomar o lugar dele.
  const lote = /^(LT|LOTE|[A-Z])\s*-?\s*\d+\s*[A-Z]?$/i;
  // O número mora ANTES da referência: procurar depois do primeiro "-" (a
  // fronteira complemento-referência) tirava o "2" de "PERTO DO BAR, 2" e o
  // tomava pelo número da casa — revisão falsa e endereço ilegível.
  const comHifen = partes.findIndex((p) => p.includes('-'));
  const ate = comHifen >= 0 ? comHifen : partes.length - 1;
  const candidata = (teste: (p: string) => boolean) => partes.findIndex((p, i) => i > 0 && i <= ate && teste(p));
  let k = candidata((p) => comDigito.test(p) || semNumero.test(p));
  if (k < 0) k = candidata((p) => lote.test(p));
  const logradouro = (k > 0 ? partes.slice(0, k) : partes.slice(0, 1)).join(', ');
  const numero = k > 0 ? partes[k]! : '';
  const resto = (k > 0 ? partes.slice(k + 1) : partes.slice(1)).join(', ');
  const hifen = resto.indexOf('-');
  // Sem a vírgula que sobra antes do "-" ("SEM NUMERO, -PERTO…").
  const complemento = (hifen >= 0 ? resto.slice(0, hifen) : resto).trim().replace(/[,\s]+$/, '');
  const referencia = (hifen >= 0 ? resto.slice(hifen + 1) : '').trim();
  return {
    logradouro,
    complemento: [numero, complemento].filter(Boolean).join(' '),
    bairro: linha.bairro,
    cidade: linha.cidade,
    uf: linha.uf,
    cep: linha.cep,
    referencia,
  };
}
