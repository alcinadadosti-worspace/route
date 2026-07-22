import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { importarXmls } from './servico.js';
import { RepositorioMemoria } from '../db/repositorio.js';
import { parseNfe } from '../nfe/parser.js';

let xml: string;

before(async () => {
  xml = await readFile(new URL('../../test/fixtures/nfe-276165.xml', import.meta.url), 'utf8');
});

test('importa a nota, cria o cliente e o pedido nasce pendente_de_mapeamento (destino rural)', async () => {
  const repo = new RepositorioMemoria();
  const relatorio = await importarXmls([{ nome: 'nfe-276165.xml', conteudo: xml }], repo);

  assert.equal(relatorio.importados, 1);
  assert.equal(relatorio.duplicados, 0);
  assert.equal(relatorio.rejeitados.length, 0);
  assert.equal(relatorio.pendentesDeMapeamento, 1);

  const pedidos = await repo.listarPedidos();
  assert.equal(pedidos.length, 1);
  const pedido = pedidos[0]!;
  assert.equal(pedido.id, '27260314750618000155550010002761651000070282');
  assert.equal(pedido.status, 'pendente_de_mapeamento');
  assert.equal(pedido.numeroPedido, '499450697');

  const clientes = await repo.listarClientes();
  assert.equal(clientes.length, 1);
  assert.equal(clientes[0]!.statusMapeamento, 'nao_mapeado');
  assert.equal(clientes[0]!.coordenada, null);
});

test('reimportar o mesmo arquivo é inócuo (dedupe pela chave de acesso)', async () => {
  const repo = new RepositorioMemoria();
  await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo);
  const relatorio = await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo);

  assert.equal(relatorio.importados, 0);
  assert.equal(relatorio.duplicados, 1);
  assert.equal((await repo.listarPedidos()).length, 1);
});

test('cliente com coordenada confirmada gera pedido pronto_para_rota', async () => {
  const repo = new RepositorioMemoria();
  const parse = await parseNfe(xml);
  assert.ok(parse.ok);
  const clienteId = parse.nota.destinatario.clienteId;

  await repo.salvarCliente(clienteId, {
    nome: 'MARIA JOSE DA SILVA',
    documentoMascarado: '***.***.***-82',
    telefone: '+5582999887766',
    email: null,
    enderecoFiscal: parse.nota.destinatario.enderecoFiscal,
    coordenada: { lat: -9.925, lng: -36.47 },
    statusMapeamento: 'mapeado',
    trilhaAtivaId: 'trilha-1',
    mapeadoPor: 'motorista-1',
    mapeadoEm: '2026-03-01T10:00:00-03:00',
    fotoReferenciaPath: null,
    observacoes: 'portão azul',
  });

  const relatorio = await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo);
  assert.equal(relatorio.prontosParaRota, 1);

  const pedido = (await repo.listarPedidos())[0]!;
  assert.equal(pedido.status, 'pronto_para_rota');

  // Seção 8.3: o mapeamento é preservado no upsert.
  const cliente = (await repo.listarClientes())[0]!;
  assert.equal(cliente.statusMapeamento, 'mapeado');
  assert.deepEqual(cliente.coordenada, { lat: -9.925, lng: -36.47 });
  assert.equal(cliente.trilhaAtivaId, 'trilha-1');
});

test('mudança de endereço fiscal em cliente mapeado gera alerta, não descarta o pin', async () => {
  const repo = new RepositorioMemoria();
  const parse = await parseNfe(xml);
  assert.ok(parse.ok);

  await repo.salvarCliente(parse.nota.destinatario.clienteId, {
    nome: 'MARIA JOSE DA SILVA',
    documentoMascarado: '***.***.***-82',
    telefone: null,
    email: null,
    enderecoFiscal: { ...parse.nota.destinatario.enderecoFiscal, logradouro: 'RUA ANTIGA' },
    coordenada: { lat: -9.925, lng: -36.47 },
    statusMapeamento: 'mapeado',
    trilhaAtivaId: null,
    mapeadoPor: null,
    mapeadoEm: null,
    fotoReferenciaPath: null,
    observacoes: '',
  });

  const relatorio = await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo);
  assert.equal(relatorio.alertas.length, 1);
  assert.match(relatorio.alertas[0]!.mensagem, /pin continua válido/);

  const cliente = (await repo.listarClientes())[0]!;
  assert.deepEqual(cliente.coordenada, { lat: -9.925, lng: -36.47 });
  assert.equal(cliente.enderecoFiscal.logradouro, 'POVOADO BREJO DOS BOIS');
});

function xmlUrbano(): string {
  return xml
    .replace('POVOADO BREJO DOS BOIS', 'RUA DO COMERCIO')
    .replace('ZONA RURAL', 'CENTRO')
    .replace('57270000', '57200010');
}

test('endereço urbano com geocodificação precisa vira pronto_para_rota', async () => {
  const repo = new RepositorioMemoria();
  let chamadas = 0;
  const relatorio = await importarXmls([{ nome: 'a.xml', conteudo: xmlUrbano() }], repo, {
    async geocodificar() {
      chamadas += 1;
      return { coordenada: { lat: -10.29, lng: -36.58 }, precisa: true };
    },
  });

  assert.equal(chamadas, 1);
  assert.equal(relatorio.geocodificados, 1);
  assert.equal(relatorio.prontosParaRota, 1);
  const cliente = (await repo.listarClientes())[0]!;
  assert.equal(cliente.statusMapeamento, 'geocodificado');
  assert.deepEqual(cliente.coordenada, { lat: -10.29, lng: -36.58 });
  assert.equal((await repo.listarPedidos())[0]!.status, 'pronto_para_rota');
});

test('endereço rural NÃO consome geocodificação (curto-circuito da seção 9)', async () => {
  const repo = new RepositorioMemoria();
  let chamadas = 0;
  const relatorio = await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo, {
    async geocodificar() {
      chamadas += 1;
      return { coordenada: { lat: 0, lng: 0 }, precisa: true };
    },
  });

  assert.equal(chamadas, 0);
  assert.equal(relatorio.geocodificados, 0);
  assert.equal(relatorio.pendentesDeMapeamento, 1);
});

test('geocodificação imprecisa (nível cidade / fora do município) fica pendente', async () => {
  const repo = new RepositorioMemoria();
  const relatorio = await importarXmls([{ nome: 'a.xml', conteudo: xmlUrbano() }], repo, {
    async geocodificar() {
      return { coordenada: { lat: -10.3, lng: -36.6 }, precisa: false };
    },
  });

  assert.equal(relatorio.geocodificados, 0);
  assert.equal(relatorio.pendentesDeMapeamento, 1);
  assert.equal((await repo.listarClientes())[0]!.coordenada, null);
});

test('erro do geocodificador não derruba a importação', async () => {
  const repo = new RepositorioMemoria();
  const relatorio = await importarXmls([{ nome: 'a.xml', conteudo: xmlUrbano() }], repo, {
    async geocodificar() {
      throw new Error('quota exceeded');
    },
  });

  assert.equal(relatorio.importados, 1);
  assert.equal(relatorio.pendentesDeMapeamento, 1);
});

test('rejeitados aparecem no relatório com o motivo', async () => {
  const repo = new RepositorioMemoria();
  const relatorio = await importarXmls(
    [
      { nome: 'ok.xml', conteudo: xml },
      { nome: 'ruim.xml', conteudo: '<nada/>' },
    ],
    repo,
  );
  assert.equal(relatorio.importados, 1);
  assert.equal(relatorio.rejeitados.length, 1);
  assert.equal(relatorio.rejeitados[0]!.arquivo, 'ruim.xml');
});
