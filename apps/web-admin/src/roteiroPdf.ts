import type { jsPDF as JsPDF } from 'jspdf';
import type { ItemRoteiro, Roteiro } from './roteiro';

/**
 * Desenho do roteiro em A4. O conteúdo vem pronto de `montarRoteiro`; aqui só
 * se decide onde cada linha cai.
 *
 * Pensado para o papel no painel do caminhão: número da parada grande, nome em
 * negrito, e duas caixas para o motorista marcar "Entregue" / "Não entregue" —
 * é dessas marcas que o Admin Estoque dá a baixa no painel na volta.
 * Preto e cinza só: a impressora do galpão pode ser monocromática.
 */

/**
 * As fontes padrão do PDF escrevem em WinAnsi (Latin-1): acento português
 * passa, mas travessão, aspas curvas e "≈" viram lixo no papel. Troca pelo
 * equivalente ASCII e descarta o resto (emoji num nome, por exemplo).
 */
export function textoParaPdf(texto: string): string {
  return texto
    // Quebra de linha vira espaço, não some: a observação escrita em duas
    // linhas saía colada ("depois da igrejaportão azul").
    .replace(/\s*[\r\n\t]+\s*/g, ' ')
    .replace(/[–—]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…/g, '...')
    .replace(/≈/g, '~')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '');
}

const PAGINA = { largura: 210, altura: 297 };
const MARGEM = 14;
const TOPO = 16;
const BASE = PAGINA.altura - 16; // espaço do rodapé
const COLUNA_MARCA = 16;
const COLUNA_CAIXAS = 38;
const X_TEXTO = MARGEM + COLUNA_MARCA;
const LARGURA_TEXTO = PAGINA.largura - 2 * MARGEM - COLUNA_MARCA - COLUNA_CAIXAS;
const X_CAIXAS = PAGINA.largura - MARGEM - COLUNA_CAIXAS + 4;

/** Altura de linha em mm para um corpo em pt (fator 1,3). */
const alturaLinha = (pt: number) => pt * 0.3528 * 1.3;

interface Linha {
  texto: string;
  pt: number;
  estilo: 'normal' | 'bold' | 'italic';
  cinza?: boolean;
}

function linhasDoItem(doc: JsPDF, item: ItemRoteiro): Linha[] {
  const quebra = (texto: string, pt: number, estilo: Linha['estilo'], cinza = false): Linha[] => {
    doc.setFont('helvetica', estilo);
    doc.setFontSize(pt);
    return (doc.splitTextToSize(textoParaPdf(texto), LARGURA_TEXTO) as string[]).map((t) => ({
      texto: t,
      pt,
      estilo,
      cinza,
    }));
  };
  const info = [item.telefone ? `Tel. ${item.telefone}` : null, item.documento, item.carga]
    .filter(Boolean)
    .join('  ·  ');
  return [
    ...quebra(item.nome, 12, 'bold'),
    ...quebra(item.endereco, 10, 'normal'),
    ...(item.comoChegar ? quebra(`Como chegar: ${item.comoChegar}`, 10, 'italic') : []),
    ...quebra(info, 9, 'normal'),
    ...(item.estimativa ? quebra(item.estimativa, 9, 'normal', true) : []),
    ...(item.aviso ? quebra(`! ${item.aviso}`, 9, 'bold') : []),
  ];
}

function alturaDoItem(linhas: Linha[]): number {
  return linhas.reduce((t, l) => t + alturaLinha(l.pt), 0) + 5;
}

function caixa(doc: JsPDF, x: number, y: number, rotulo: string) {
  doc.setDrawColor(0);
  doc.setLineWidth(0.4);
  doc.rect(x, y - 3.6, 4.2, 4.2);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(rotulo, x + 6, y);
}

function desenharItem(doc: JsPDF, item: ItemRoteiro, linhas: Linha[], y: number): number {
  doc.setTextColor(0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(item.marca.startsWith('E') ? 13 : 16);
  doc.text(item.marca, MARGEM, y + 5);

  let yLinha = y + alturaLinha(12) - 0.5;
  for (const l of linhas) {
    doc.setFont('helvetica', l.estilo);
    doc.setFontSize(l.pt);
    doc.setTextColor(l.cinza ? 90 : 0);
    doc.text(l.texto, X_TEXTO, yLinha);
    yLinha += alturaLinha(l.pt);
  }
  doc.setTextColor(0);

  if (item.resultado) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text(textoParaPdf(`[${item.resultado}]`), X_CAIXAS, y + 5);
  } else {
    caixa(doc, X_CAIXAS, y + 5, 'Entregue');
    caixa(doc, X_CAIXAS, y + 12, textoParaPdf('Não entregue'));
  }

  const fim = y + alturaDoItem(linhas);
  doc.setDrawColor(200);
  doc.setLineWidth(0.2);
  doc.line(MARGEM, fim - 2, PAGINA.largura - MARGEM, fim - 2);
  return fim;
}

/**
 * A biblioteca desce sob demanda (não pesa em quem só importa notas), mas UMA
 * vez, cedo — a tela de Rotas chama isto ao abrir. O nome do arquivo dela muda
 * a cada build: pedida só no clique, num painel aberto desde antes de um
 * deploy, o arquivo antigo já não existia no servidor, e o "Publicar e baixar
 * PDF" falhava depois de publicar.
 */
let carregamento: Promise<typeof import('jspdf')> | null = null;
function bibliotecaPdf(): Promise<typeof import('jspdf')> {
  carregamento ??= import('jspdf').catch((e) => {
    carregamento = null;
    throw new Error(
      'O painel foi atualizado enquanto estava aberto e não achou a parte que gera o PDF. ' +
        'Recarregue a página (a rota já está salva) e baixe o PDF pelo Acompanhamento do dia.',
      { cause: e },
    );
  });
  return carregamento;
}

export function preCarregarPdf(): void {
  void bibliotecaPdf().catch(() => undefined);
}

/** Monta o documento. Separado de `baixar` para poder ser gerado fora do navegador. */
export async function gerarPdfRoteiro(roteiro: Roteiro): Promise<JsPDF> {
  const { jsPDF } = await bibliotecaPdf();
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  let y = TOPO;

  const bloco = (texto: string, pt: number, estilo: Linha['estilo'], largura = PAGINA.largura - 2 * MARGEM) => {
    doc.setFont('helvetica', estilo);
    doc.setFontSize(pt);
    for (const t of doc.splitTextToSize(textoParaPdf(texto), largura) as string[]) {
      y += alturaLinha(pt);
      doc.text(t, MARGEM, y);
    }
  };
  const caber = (altura: number) => {
    if (y + altura > BASE) {
      doc.addPage();
      y = TOPO;
    }
  };

  bloco(roteiro.titulo, 15, 'bold');
  y += 1;
  bloco(roteiro.subtitulo, 10, 'normal');
  bloco(roteiro.resumo, 10, 'normal');
  doc.setTextColor(90);
  bloco(
    'Marque cada parada ao passar. Na volta, a baixa é dada no painel (Rotas > Acompanhamento do dia): ' +
      'o que não foi entregue volta para a montagem.',
    8.5,
    'italic',
  );
  doc.setTextColor(0);
  y += 3;
  doc.setDrawColor(0);
  doc.setLineWidth(0.6);
  doc.line(MARGEM, y, PAGINA.largura - MARGEM, y);
  y += 3;

  const itens = (lista: ItemRoteiro[]) => {
    for (const item of lista) {
      const linhas = linhasDoItem(doc, item);
      caber(alturaDoItem(linhas));
      y = desenharItem(doc, item, linhas, y);
    }
  };

  itens(roteiro.paradas);

  if (roteiro.excecoes.length > 0) {
    // O cabeçalho (~23 mm) e a PRIMEIRA exceção juntos — `caber(30)` deixava o
    // título órfão no pé da página e a E1 na folha seguinte.
    caber(25 + alturaDoItem(linhasDoItem(doc, roteiro.excecoes[0]!)));
    y += 4;
    bloco(`EXCEÇÕES — sem ponto no mapa (${roteiro.excecoes.length})`, 12, 'bold');
    doc.setTextColor(90);
    bloco(
      'Fora da ordem otimizada: o sistema não sabe onde ficam. Encaixe no caminho conforme conhecer a região.',
      9,
      'italic',
    );
    doc.setTextColor(0);
    y += 2;
    doc.setDrawColor(0);
    doc.setLineWidth(0.4);
    doc.line(MARGEM, y, PAGINA.largura - MARGEM, y);
    y += 3;
    itens(roteiro.excecoes);
  }

  // Rodapé por último, quando já se sabe quantas páginas há: "página 2 de 3"
  // é o que mostra ao motorista que falta uma folha.
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(110);
    doc.text(textoParaPdf(roteiro.rodape), MARGEM, PAGINA.altura - 9);
    doc.text(`Página ${i} de ${total}`, PAGINA.largura - MARGEM, PAGINA.altura - 9, { align: 'right' });
  }
  doc.setTextColor(0);
  return doc;
}

export async function baixarPdfRoteiro(roteiro: Roteiro): Promise<void> {
  const doc = await gerarPdfRoteiro(roteiro);
  doc.save(roteiro.arquivo);
}
