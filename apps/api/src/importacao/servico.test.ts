import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { importarXmls, decidirEnderecoEntrega } from './servico.js';
import { RepositorioMemoria } from '../db/repositorio.js';
import { parseNfe } from '../nfe/parser.js';
import type { EnderecoFiscal } from '@rota/shared';

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
      return { coordenada: { lat: -10.29, lng: -36.58 }, precisa: true, municipioConfere: true };
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

test('endereço rural é geocodificado; aproximado no município vira despachável (aproximado)', async () => {
  const repo = new RepositorioMemoria();
  let chamadas = 0;
  const relatorio = await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo, {
    async geocodificar() {
      chamadas += 1;
      return { coordenada: { lat: -9.9, lng: -36.5 }, precisa: false, municipioConfere: true };
    },
  });

  assert.equal(chamadas, 1); // rural agora É geocodificado (sem curto-circuito)
  assert.equal(relatorio.aproximados, 1);
  assert.equal(relatorio.geocodificados, 0);
  assert.equal(relatorio.prontosParaRota, 1); // despachável
  const cliente = (await repo.listarClientes())[0]!;
  assert.equal(cliente.statusMapeamento, 'aproximado');
  assert.deepEqual(cliente.coordenada, { lat: -9.9, lng: -36.5 });
  assert.equal((await repo.listarPedidos())[0]!.status, 'pronto_para_rota');
});

test('geocodificação fora do município (ponto errado) fica pendente, sem coordenada', async () => {
  const repo = new RepositorioMemoria();
  const relatorio = await importarXmls([{ nome: 'a.xml', conteudo: xmlUrbano() }], repo, {
    async geocodificar() {
      return { coordenada: { lat: -10.3, lng: -36.6 }, precisa: false, municipioConfere: false };
    },
  });

  assert.equal(relatorio.geocodificados, 0);
  assert.equal(relatorio.aproximados, 0);
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

// --- Entrega em local diverso (seção 8.4) ---

function xmlComEntregaDivergente(): string {
  // <entrega> urbano (Maceió), divergente do fiscal rural (Junqueiro).
  const entrega =
    '<entrega><xLgr>RUA DA ENTREGA</xLgr><nro>500</nro><xBairro>CENTRO</xBairro>' +
    '<xMun>MACEIO</xMun><UF>AL</UF><CEP>57000000</CEP></entrega>';
  return xml.replace('</dest>', `</dest>${entrega}`);
}

// Geocodificador de teste: resolve o endereço de ENTREGA (Maceió) com precisão;
// o fiscal rural (Junqueiro) não resolve — reflete "Google resolve urbano, rural não".
const geoOk = {
  async geocodificar(e: EnderecoFiscal) {
    return e.municipio === 'MACEIO'
      ? { coordenada: { lat: -9.66, lng: -35.73 }, precisa: true, municipioConfere: true }
      : { coordenada: { lat: 0, lng: 0 }, precisa: false, municipioConfere: false };
  },
};

test('entrega divergente: pedido nasce pendente_de_decisao e geocodifica o candidato', async () => {
  const repo = new RepositorioMemoria();
  const relatorio = await importarXmls(
    [{ nome: 'a.xml', conteudo: xmlComEntregaDivergente() }],
    repo,
    geoOk,
  );

  assert.equal(relatorio.pendentesDeDecisao, 1);
  assert.equal(relatorio.prontosParaRota, 0);
  assert.equal(relatorio.pendentesDeMapeamento, 0);
  assert.equal(relatorio.alertas.length, 1);
  assert.match(relatorio.alertas[0]!.mensagem, /entrega diferente/i);

  const pedido = (await repo.listarPedidos())[0]!;
  assert.equal(pedido.status, 'pendente_de_decisao');
  assert.equal(pedido.enderecoEntrega?.logradouro, 'RUA DA ENTREGA');
  assert.deepEqual(pedido.coordenadaEntrega, { lat: -9.66, lng: -35.73 });
  // O cadastro do cliente NÃO é contaminado pelo endereço de entrega.
  const cliente = (await repo.listarClientes())[0]!;
  assert.equal(cliente.enderecoFiscal.logradouro, 'POVOADO BREJO DOS BOIS');
});

test('decidir pela ENTREGA vira pronto_para_rota com override no pedido', async () => {
  const repo = new RepositorioMemoria();
  await importarXmls([{ nome: 'a.xml', conteudo: xmlComEntregaDivergente() }], repo, geoOk);
  const pedido = (await repo.listarPedidos())[0]!;

  const r = await decidirEnderecoEntrega(repo, pedido.id, 'entrega');
  assert.ok(r.ok);
  assert.equal(r.status, 'pronto_para_rota');

  const atualizado = (await repo.listarPedidos())[0]!;
  assert.equal(atualizado.usarEnderecoEntrega, true);
  assert.equal(atualizado.status, 'pronto_para_rota');
  assert.deepEqual(atualizado.coordenadaEntrega, { lat: -9.66, lng: -35.73 });
});

test('decidir pela ENTREGA com pin ajustado usa a coordenada enviada', async () => {
  const repo = new RepositorioMemoria();
  await importarXmls([{ nome: 'a.xml', conteudo: xmlComEntregaDivergente() }], repo, geoOk);
  const pedido = (await repo.listarPedidos())[0]!;

  const r = await decidirEnderecoEntrega(repo, pedido.id, 'entrega', { lat: -9.7, lng: -35.8 });
  assert.ok(r.ok);
  const atualizado = (await repo.listarPedidos())[0]!;
  assert.deepEqual(atualizado.coordenadaEntrega, { lat: -9.7, lng: -35.8 });
});

test('decidir pela ENTREGA sem coordenada é rejeitado (obriga posicionar o pin)', async () => {
  const repo = new RepositorioMemoria();
  // Sem geocodificador → a entrega não é geocodificada (coordenadaEntrega null).
  await importarXmls([{ nome: 'a.xml', conteudo: xmlComEntregaDivergente() }], repo);
  const pedido = (await repo.listarPedidos())[0]!;
  assert.equal(pedido.coordenadaEntrega ?? null, null);

  const semCoord = await decidirEnderecoEntrega(repo, pedido.id, 'entrega');
  assert.equal(semCoord.ok, false);
  if (!semCoord.ok) assert.equal(semCoord.status, 400);
  // Continua aguardando decisão — nada travou.
  assert.equal((await repo.listarPedidos())[0]!.status, 'pendente_de_decisao');

  // Com o pin posicionado, a decisão passa.
  const comCoord = await decidirEnderecoEntrega(repo, pedido.id, 'entrega', {
    lat: -9.6,
    lng: -35.7,
  });
  assert.ok(comCoord.ok);
  assert.equal((await repo.listarPedidos())[0]!.status, 'pronto_para_rota');
});

test('decidir pelo FISCAL com cliente sem coordenada cai em mapeamento', async () => {
  const repo = new RepositorioMemoria();
  await importarXmls([{ nome: 'a.xml', conteudo: xmlComEntregaDivergente() }], repo, geoOk);
  const pedido = (await repo.listarPedidos())[0]!;

  const r = await decidirEnderecoEntrega(repo, pedido.id, 'fiscal');
  assert.ok(r.ok);
  assert.equal(r.status, 'pendente_de_mapeamento');
  assert.equal((await repo.listarPedidos())[0]!.usarEnderecoEntrega, false);
});

test('decidir num pedido que não aguarda decisão é rejeitado (409)', async () => {
  const repo = new RepositorioMemoria();
  await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo); // sem entrega → mapeamento
  const pedido = (await repo.listarPedidos())[0]!;

  const r = await decidirEnderecoEntrega(repo, pedido.id, 'entrega');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 409);
});
