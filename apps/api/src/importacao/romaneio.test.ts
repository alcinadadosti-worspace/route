import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blocoDoRomaneio,
  codCdDoMotorista,
  lerRomaneio,
  romaneioDasPaginas,
  type ItemTexto,
  type LinhaRomaneio,
} from './romaneio.js';
import { importarRomaneios } from './servico-romaneio.js';
import { RepositorioMemoria } from '../db/repositorio.js';

/**
 * Posições copiadas do romaneio REAL (rota 1673300, impresso pelo navegador):
 * o x de cada coluna e o passo de ~13 pt entre as linhas de uma célula que
 * quebra. Os nomes e endereços são inventados — o real tem dados pessoais.
 */
const X = { nf: 98, cep: 149, nome: 189, pedido: 265, bairro: 341, cidade: 391, endereco: 442 };

function cabecalho(y = 675): ItemTexto[] {
  return [
    { x: X.nf, y, texto: 'NF do pedido' },
    { x: X.cep, y, texto: 'CEP' },
    { x: X.nome, y, texto: 'Nome do destinatário' },
    { x: X.pedido, y, texto: 'Pedido Entrega' },
    { x: X.bairro, y, texto: 'Bairro' },
    { x: X.cidade, y, texto: 'Cidade/UF' },
    { x: X.endereco, y, texto: 'Endereço' },
  ];
}

function topo(motorista = 'Caique Santos'): ItemTexto[] {
  return [
    { x: 423, y: 758, texto: 'Rota:' },
    { x: 484, y: 758, texto: '1673300' },
    { x: 397, y: 743, texto: 'Quantidade:' },
    { x: 476, y: 743, texto: '2 pacotes' },
    { x: 88, y: 727, texto: 'Romaneio de Entrega de Mercadorias' },
    { x: 88, y: 710, texto: 'Motorista:' },
    { x: 116, y: 710, texto: motorista },
  ];
}

/** Uma linha da tabela: cada célula é uma lista de linhas visuais (quebra). */
function linha(y: number, c: Record<keyof typeof X, string[]>): ItemTexto[] {
  const itens: ItemTexto[] = [{ x: 88, y, texto: '▢' }];
  for (const [col, partes] of Object.entries(c) as Array<[keyof typeof X, string[]]>) {
    partes.forEach((texto, i) => itens.push({ x: X[col], y: y - 13 * i, texto }));
  }
  return itens;
}

const PAGINA_REAL: ItemTexto[] = [
  { x: 36, y: 820, texto: '26/10/2026, 17:12' },
  { x: 300, y: 820, texto: 'Rotas - Plataforma Logística | Grupo Boticário' },
  ...topo(),
  ...cabecalho(),
  ...linha(661, {
    nf: ['190001'],
    cep: ['57750000'],
    nome: ['ANA PAULA DE', 'SOUZA LIMA'],
    pedido: ['530000001'],
    bairro: ['CENTRO'],
    cidade: ['QUEBRANGULO/AL'],
    endereco: ['RUA DAS FLORES, 43,', 'CASA-SUBIDA DO', 'MERCADINHO'],
  }),
  ...linha(622, {
    nf: ['190002'],
    cep: ['57750000'],
    nome: ['Bia Teste'],
    pedido: ['160000001-1'],
    bairro: ['CONJUNTO', 'FREDERICO', 'MAIA FILHO'],
    cidade: ['QUEBRANGULO/AL'],
    endereco: ['AV 15 DE NOVEMBRO, S\\N, PERTO DA', 'CLINICA-'],
  }),
  { x: 88, y: 330, texto: 'Observações:' },
  // Rodapé do navegador: o "1/2" cai na coluna do endereço, lá embaixo — e
  // grudava no endereço da última linha.
  { x: 36, y: 20, texto: 'https://plataformalogistica.grupoboticario.com.br/rotas/1673300/print' },
  { x: 560, y: 20, texto: '1/2' },
];

test('romaneio: colunas pela posição, células que quebram, rodapé fora da última linha', () => {
  const r = romaneioDasPaginas([PAGINA_REAL]);
  assert.ok(r.ok, !r.ok ? r.motivo : '');
  assert.equal(r.romaneio.rota, '1673300');
  assert.equal(r.romaneio.motorista, 'Caique Santos');
  assert.equal(r.romaneio.quantidade, 2);
  assert.deepEqual(r.romaneio.linhas, [
    {
      notaFiscal: 190001,
      cep: '57750000',
      nome: 'ANA PAULA DE SOUZA LIMA',
      pedido: '530000001',
      bairro: 'CENTRO',
      cidade: 'QUEBRANGULO',
      uf: 'AL',
      endereco: 'RUA DAS FLORES, 43, CASA-SUBIDA DO MERCADINHO',
    },
    {
      notaFiscal: 190002,
      cep: '57750000',
      nome: 'Bia Teste',
      pedido: '160000001-1',
      bairro: 'CONJUNTO FREDERICO MAIA FILHO',
      cidade: 'QUEBRANGULO',
      uf: 'AL',
      endereco: 'AV 15 DE NOVEMBRO, S\\N, PERTO DA CLINICA-',
    },
  ]);
});

test('romaneio: a tabela que continua na página seguinte sem cabeçalho usa as colunas da anterior', () => {
  const continuacao = linha(780, {
    nf: ['165400'],
    cep: ['57750000'],
    nome: ['CARLA'],
    pedido: ['537000001'],
    bairro: ['CENTRO'],
    cidade: ['QUEBRANGULO/AL'],
    endereco: ['RUA B, 2, -'],
  });
  const r = romaneioDasPaginas([PAGINA_REAL, continuacao]);
  assert.ok(r.ok);
  assert.equal(r.romaneio.linhas.length, 3);
  assert.equal(r.romaneio.linhas[2]!.pedido, '537000001');
});

test('romaneio: linha cortada pela QUEBRA DE PÁGINA é emendada com o resto, no topo da seguinte', () => {
  // Página 1: a última linha começa no pé da folha, com só a 1ª linha visual
  // de cada célula; o rodapé "1/2" do navegador fica na margem, logo abaixo.
  const pagina1: ItemTexto[] = [
    ...topo(),
    ...cabecalho(),
    ...linha(50, {
      nf: ['165401'],
      cep: ['57750000'],
      nome: ['MARIA DAS'],
      pedido: ['537000002'],
      bairro: ['CENTRO'],
      cidade: ['PALMEIRA DOS'],
      endereco: ['RUA C, 5, CASA-'],
    }),
    { x: 560, y: 34, texto: '1/2', margem: true },
  ];
  // Página 2: o cabeçalho da tabela repetido, o RESTO da linha cortada e a próxima.
  const pagina2: ItemTexto[] = [
    { x: 36, y: 820, texto: '26/10/2026, 17:12', margem: true },
    ...cabecalho(790),
    { x: X.nome, y: 776, texto: 'GRAÇAS SILVA' },
    { x: X.cidade, y: 776, texto: 'ÍNDIOS/AL' },
    { x: X.endereco, y: 776, texto: 'PERTO DA PRAÇA' },
    ...linha(750, {
      nf: ['165402'],
      cep: ['57750000'],
      nome: ['JOANA'],
      pedido: ['537000003'],
      bairro: ['CENTRO'],
      cidade: ['IGACI/AL'],
      endereco: ['RUA D, 7, -'],
    }),
  ];
  const r = romaneioDasPaginas([pagina1, pagina2]);
  assert.ok(r.ok, !r.ok ? r.motivo : '');
  assert.equal(r.romaneio.linhas.length, 2);
  const [cortada, seguinte] = r.romaneio.linhas;
  assert.equal(cortada!.nome, 'MARIA DAS GRAÇAS SILVA');
  assert.equal(cortada!.cidade, 'PALMEIRA DOS ÍNDIOS');
  assert.equal(cortada!.uf, 'AL');
  assert.equal(cortada!.endereco, 'RUA C, 5, CASA- PERTO DA PRAÇA', 'sem o "1/2" do rodapé');
  assert.equal(seguinte!.nome, 'JOANA');
});

test('romaneio: linha que coube INTEIRA não recebe o que estiver no topo da página seguinte', () => {
  // Como o PDF real: a 2ª página só tem o que o navegador imprime — e aqui um
  // título que não foi marcado como margem, caindo na coluna do nome.
  const pagina2: ItemTexto[] = [
    { x: X.nome, y: 800, texto: 'Rotas - Portal | Grupo' },
    { x: X.nome, y: 760, texto: 'Observações:' },
  ];
  const r = romaneioDasPaginas([PAGINA_REAL, pagina2]);
  assert.ok(r.ok);
  assert.equal(r.romaneio.linhas.length, 2);
  assert.equal(r.romaneio.linhas[1]!.nome, 'Bia Teste');
});

test('romaneio: data impressa que não existe não vira data de pedido', () => {
  const comData = (data: string) =>
    romaneioDasPaginas([PAGINA_REAL.map((i) => (i.texto === '26/10/2026, 17:12' ? { ...i, texto: data } : i))]);
  const invalida = comData('31/02/2026, 17:12');
  assert.ok(invalida.ok);
  assert.equal(invalida.romaneio.impressoEm, null);
});

test('romaneio: o topo repetido com o motorista em outra caixa não é "outro romaneio"', () => {
  const repetido = topo('CAIQUE SANTOS').map((i) => (i.texto === '1673300' ? { ...i, texto: '1673 300' } : i));
  const r = romaneioDasPaginas([PAGINA_REAL, repetido]);
  assert.ok(r.ok, !r.ok ? r.motivo : '');
  assert.equal(r.romaneio.rota, '1673300');
});

test('romaneio: dois romaneios num PDF só são recusados — o segundo entraria com o motorista do primeiro', () => {
  const outro = [
    ...topo('Paulo Rogério Santos').map((i) => (i.texto === '1673300' ? { ...i, texto: '1673999' } : i)),
    ...cabecalho(),
    ...linha(661, {
      nf: ['170001'],
      cep: ['57200000'],
      nome: ['ZEZA'],
      pedido: ['537100001'],
      bairro: ['CENTRO'],
      cidade: ['PENEDO/AL'],
      endereco: ['RUA P, 1, -'],
    }),
  ];
  const r = romaneioDasPaginas([PAGINA_REAL, outro]);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.motivo : '', /mais de um romaneio.*1673300.*1673999/);
});

test('romaneio: sem o número da rota no cabeçalho, a folha é recusada', () => {
  const r = romaneioDasPaginas([PAGINA_REAL.filter((i) => i.texto !== '1673300')]);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.motivo : '', /número da rota/);
});

test('romaneio: pedido ilegível (linha sem NF fundida com a de cima) é recusado com aviso, o resto entra', () => {
  const fundida = PAGINA_REAL.map((i) => (i.texto === '530000001' ? { ...i, texto: '530000001530000003' } : i));
  const r = romaneioDasPaginas([fundida]);
  assert.ok(r.ok);
  assert.deepEqual(r.romaneio.linhas.map((l) => l.pedido), ['160000001-1']);
  assert.match(r.romaneio.recusadas![0]!, /NF 190001.*530000001530000003.*ilegível/);
});

test('romaneio: motorista em branco não vira "Assinatura:"; a data impressa vira a data dos pedidos', () => {
  const semMotorista = [
    ...PAGINA_REAL.filter((i) => i.texto !== 'Caique Santos'),
    { x: 300, y: 710, texto: 'Assinatura:' },
  ];
  const r = romaneioDasPaginas([semMotorista]);
  assert.ok(r.ok);
  assert.equal(r.romaneio.motorista, '');
  assert.equal(r.romaneio.impressoEm, '2026-10-26T17:12:00-03:00');
});

test('romaneio: "BAIRRO" escrito numa linha de dados não vira posição de coluna', () => {
  // A linha de dados vem ANTES do cabeçalho no fluxo de texto (a ordem dos
  // itens no PDF não é garantida) e tem um bairro chamado "BAIRRO".
  const dados = linha(661, {
    nf: ['190001'],
    cep: ['57750000'],
    nome: ['ANA'],
    pedido: ['530000001'],
    bairro: ['BAIRRO'],
    cidade: ['QUEBRANGULO/AL'],
    endereco: ['RUA A, 1, -'],
  });
  const r = romaneioDasPaginas([[...topo(), ...dados, ...cabecalho()]]);
  assert.ok(r.ok);
  assert.equal(r.romaneio.linhas[0]!.bairro, 'BAIRRO');
  assert.equal(r.romaneio.linhas[0]!.nome, 'ANA');
});

test('romaneio: PDF sem a tabela é recusado com motivo', () => {
  const r = romaneioDasPaginas([[{ x: 10, y: 10, texto: 'qualquer coisa' }]]);
  assert.equal(r.ok, false);
});

test('CD sai do motorista; nome desconhecido não ganha CD no palpite', () => {
  assert.equal(codCdDoMotorista('Caique Santos'), '684');
  assert.equal(codCdDoMotorista('  CAIQUE   SANTOS '), '684');
  assert.equal(codCdDoMotorista('Paulo Rogério Santos'), '542');
  assert.equal(codCdDoMotorista('paulo rogerio santos'), '542');
  assert.equal(codCdDoMotorista('Caique'), null);
  assert.equal(codCdDoMotorista(''), null);
});

function linhaR(endereco: string): LinhaRomaneio {
  return { notaFiscal: 1, cep: '57750000', nome: 'X', pedido: '1', bairro: 'CENTRO', cidade: 'QUEBRANGULO', uf: 'AL', endereco };
}

test('endereço do romaneio no formato do cadastro: número dentro do complemento', () => {
  // Formatos tirados do romaneio real.
  const casos: Array<[string, string, string, string]> = [
    ['PREFEITO JOSÉ INÁCIO, 43, CASA-SUBIDA DA PADARIA', 'PREFEITO JOSÉ INÁCIO', '43 CASA', 'SUBIDA DA PADARIA'],
    ['AVENIDA 15 DE NOVEMBRO, 370, - VIZINHO AO MERCADO', 'AVENIDA 15 DE NOVEMBRO', '370', 'VIZINHO AO MERCADO'],
    ['AV 15 DE NOVEMBRO, S\\N, PERTO DA FARMACIA-', 'AV 15 DE NOVEMBRO', 'S\\N PERTO DA FARMACIA', ''],
    ['R JOAO EXEMPLO, 0020, -PROX AO MERCADINHO', 'R JOAO EXEMPLO', '0020', 'PROX AO MERCADINHO'],
    ['RESIDENCIAL MORADA NOVA, 16, QD AL LT16-', 'RESIDENCIAL MORADA NOVA', '16 QD AL LT16', ''],
    // Vírgula na rua: a quadra não pode virar o número da casa.
    ['RUA A, QUADRA B, 43, CASA-REF', 'RUA A, QUADRA B', '43 CASA', 'REF'],
    ['RUA SEM NUMERO', 'RUA SEM NUMERO', '', ''],
    // Número com hífen (~20 nas notas reais): a letra da casa não vira referência.
    ['RUA DAS FLORES, 43-A, CASA-REF', 'RUA DAS FLORES', '43-A CASA', 'REF'],
    ['RUA DAS FLORES, LT-9, -PERTO DA CAIXA', 'RUA DAS FLORES', 'LT-9', 'PERTO DA CAIXA'],
    ['RUA DAS FLORES, S/Nº, CASA-PERTO DO BAR, 2', 'RUA DAS FLORES', 'S/Nº CASA', 'PERTO DO BAR, 2'],
    // Quadra com número antes do número da casa continua na rua.
    ['RUA A, QD 3, 43, CASA-REF', 'RUA A, QD 3', '43 CASA', 'REF'],
    // "Nº 43" é o número; e o "2" da referência não é.
    ['RUA DAS FLORES, Nº 43, CASA-PERTO DO BAR, 2', 'RUA DAS FLORES', 'Nº 43 CASA', 'PERTO DO BAR, 2'],
    ['RUA DAS FLORES, SEM NUMERO, -PERTO DA ESCOLA, 100 M', 'RUA DAS FLORES', 'SEM NUMERO', 'PERTO DA ESCOLA, 100 M'],
  ];
  for (const [texto, logradouro, complemento, referencia] of casos) {
    const b = blocoDoRomaneio(linhaR(texto));
    assert.deepEqual([b.logradouro, b.complemento, b.referencia], [logradouro, complemento, referencia], texto);
  }
});

/**
 * PDF mínimo DE VERDADE, com o texto em posições absolutas — prova que a
 * leitura pelo pdf.js (e não só o arranjo das posições) funciona no teste, sem
 * versionar o romaneio real. Helvetica com WinAnsi cobre os acentos.
 *
 * Tamanhos do real: cabeçalho da tabela em 5 pt, dados em 7 pt. Com 8 pt em
 * tudo, "NF do pedido" encostava em "CEP" e o pdf.js fundia os dois num item.
 */
function pdfDeTexto(itens: ItemTexto[]): Uint8Array {
  const escapar = (t: string) => t.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const rotulos = new Set(cabecalho().map((i) => i.texto));
  const fluxo = itens
    .map((i) => `BT /F1 ${rotulos.has(i.texto) ? 5 : 7} Tf 1 0 0 1 ${i.x} ${i.y} Tm (${escapar(i.texto)}) Tj ET`)
    .join('\n');
  const objetos = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(fluxo, 'latin1')} >>\nstream\n${fluxo}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let corpo = '%PDF-1.4\n';
  const offsets: number[] = [];
  objetos.forEach((o, i) => {
    offsets.push(Buffer.byteLength(corpo, 'latin1'));
    corpo += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(corpo, 'latin1');
  corpo += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) corpo += `${String(o).padStart(10, '0')} 00000 n \n`;
  corpo += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(corpo, 'latin1'));
}

function romaneioEmPdf(motorista = 'Caique Santos'): Uint8Array {
  // O "▢" não existe em WinAnsi — e a leitura não depende dele (a linha começa na NF).
  return pdfDeTexto(PAGINA_REAL.filter((i) => i.texto !== '▢').map((i) => (i.texto === 'Caique Santos' ? { ...i, texto: motorista } : i)));
}

test('romaneio: leitura de um PDF de verdade pelo pdf.js', async () => {
  const r = await lerRomaneio(romaneioEmPdf());
  assert.ok(r.ok, !r.ok ? r.motivo : '');
  assert.equal(r.romaneio.motorista, 'Caique Santos');
  assert.equal(r.romaneio.linhas.length, 2);
  assert.equal(r.romaneio.linhas[0]!.nome, 'ANA PAULA DE SOUZA LIMA');
  assert.equal(r.romaneio.linhas[0]!.endereco, 'RUA DAS FLORES, 43, CASA-SUBIDA DO MERCADINHO');
  assert.equal(r.romaneio.linhas[1]!.pedido, '160000001-1');
});

test('romaneio: arquivo que não é PDF é recusado, não derruba a importação', async () => {
  const r = await lerRomaneio(new Uint8Array(Buffer.from('isto não é um pdf')));
  assert.equal(r.ok, false);
});

test('romaneio de motorista sem CD: recusado inteiro, nada importado', async () => {
  const repo = new RepositorioMemoria();
  const r = await importarRomaneios([{ nome: 'rota.pdf', conteudo: romaneioEmPdf('Fulano de Tal') }], repo);
  assert.equal(r.importados, 0);
  assert.equal(r.rejeitados.length, 1);
  assert.match(r.rejeitados[0]!.motivo, /Fulano de Tal.*sem CD/);
  assert.equal((await repo.listarPedidos()).length, 0);
});

test('romaneio do PDF até o pedido: CD de Palmeira pelo motorista, nº da rota guardado', async () => {
  const repo = new RepositorioMemoria();
  const r = await importarRomaneios([{ nome: 'rota.pdf', conteudo: romaneioEmPdf() }], repo);
  assert.equal(r.romaneios, 1);
  assert.equal(r.importados, 2);
  const pedido = await repo.obterPedido('530000001');
  assert.equal(pedido?.cdId, 'palmeira');
  assert.equal(pedido?.serie, 0);
  assert.equal(pedido?.romaneio, '1673300');
  assert.equal(pedido?.modoEntrega, 'rota');
  assert.ok(await repo.obterPedido('160000001-1'), 'pedido do site, com hífen, também entra');
});
