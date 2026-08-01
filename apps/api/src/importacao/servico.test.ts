import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  decidirEnderecoEntrega,
  decidirModoEntrega,
  decidirMudancaEndereco,
  importarXmls,
  refazerPontoDoCliente,
} from './servico.js';
import { RepositorioMemoria } from '../db/repositorio.js';
import { parseNfe } from '../nfe/parser.js';
import type { Cliente, EnderecoFiscal, Pedido } from '@rota/shared';

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

// --- Refazer o ponto do cliente (RF-23) ---

test('refazer o ponto descarta pin e trilha, mas PRESERVA o dossiê', async () => {
  const repo = new RepositorioMemoria();
  const clienteId = await comClienteExistente(repo, {
    trilhaAtivaId: 'trilha-1',
    fotoReferenciaPath: 'clientes/x/referencia.jpg',
    observacoes: 'portão azul',
  });
  await repo.salvarTrilha('trilha-1', {
    clienteId,
    polyline: 'abc',
    pontoEntrada: { lat: -9.9, lng: -36.4 },
    distanciaM: 100,
    precisaoMediaM: 8,
    ativa: true,
    gravadaPor: 'motorista-1',
    gravadaEm: '2026-03-01T10:00:00-03:00',
    versao: 1,
  });

  const r = await refazerPontoDoCliente(repo, clienteId);

  assert.ok(r.ok);
  const cliente = (await repo.obterCliente(clienteId))!;
  assert.equal(cliente.coordenada, null);
  assert.equal(cliente.statusMapeamento, 'nao_mapeado');
  assert.equal(cliente.mapeadoPor, null);
  assert.equal(cliente.trilhaAtivaId, null);
  assert.equal(await repo.obterTrilhaAtiva(clienteId), null);
  // Pin errado não invalida o que se sabe sobre o LUGAR.
  assert.equal(cliente.fotoReferenciaPath, 'clientes/x/referencia.jpg');
  assert.equal(cliente.observacoes, 'portão azul');
});

test('refazer o ponto reaproveita a geocodificação quando o endereço resolve', async () => {
  const repo = new RepositorioMemoria();
  const clienteId = await comClienteExistente(repo);

  const r = await refazerPontoDoCliente(repo, clienteId, {
    async geocodificar() {
      return { coordenada: { lat: -9.88, lng: -36.44 }, precisa: true, municipioConfere: true };
    },
  });

  assert.ok(r.ok);
  assert.equal(r.status, 'pronto_para_rota');
  const cliente = (await repo.obterCliente(clienteId))!;
  assert.equal(cliente.statusMapeamento, 'geocodificado');
  assert.deepEqual(cliente.coordenada, { lat: -9.88, lng: -36.44 });
});

test('refazer o ponto sincroniza os pedidos ainda não roteirizados', async () => {
  const repo = new RepositorioMemoria();
  const clienteId = await comClienteExistente(repo);
  // Um pedido pronto (pelo pin antigo) e um já em rota, que não deve mudar.
  await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo);
  // O `id` sai do objeto antes de gravar: guardá-lo DENTRO do documento faria a
  // listagem devolver o id errado (o campo sobrescreve a chave).
  const { id: idPronto, ...dados } = (await repo.listarPedidos())[0]!;
  await repo.salvarPedido(idPronto, { ...dados, status: 'pronto_para_rota' });
  await repo.salvarPedido('em-rota', { ...dados, status: 'em_rota' });

  // Endereço rural que não geocodifica → volta para mapeamento em campo.
  await refazerPontoDoCliente(repo, clienteId);

  const pedidos = await repo.listarPedidos();
  assert.equal(
    pedidos.find((p) => p.id === idPronto)!.status,
    'pendente_de_mapeamento',
    'pedido pronto tem de acompanhar o ponto, senão a tela mente',
  );
  assert.equal(
    pedidos.find((p) => p.id === 'em-rota')!.status,
    'em_rota',
    'pedido já em rota não pode ser mexido pelas costas do motorista',
  );
});

test('refazer o ponto de cliente inexistente é 404', async () => {
  const repo = new RepositorioMemoria();
  const r = await refazerPontoDoCliente(repo, 'a'.repeat(64));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 404);
});

// --- CD de origem pelo emitente da nota (seção 8.5) ---

/**
 * Troca o CNPJ do EMITENTE, preservando o resto da nota. Casa com as tags de
 * propósito: o CNPJ também aparece dentro da chave de acesso (os dígitos 7 a 20
 * da chave SÃO o CNPJ do emitente), e uma troca solta corromperia a chave.
 */
function xmlDoEmitente(cnpj: string, base = xml): string {
  return base.replace('<CNPJ>14750618000155</CNPJ>', `<CNPJ>${cnpj}</CNPJ>`);
}

const CNPJ_PENEDO = '14750618000183';
const CNPJ_PALMEIRA = '14750618000264';

/** Repositório com os dois CDs reais, cada um com seu CNPJ. */
function repoComCds(): RepositorioMemoria {
  const repo = new RepositorioMemoria();
  repo.cds = {
    penedo: { nome: 'CD Penedo', coordenada: { lat: -10.28, lng: -36.56 }, cnpj: CNPJ_PENEDO },
    palmeira: { nome: 'CD Palmeira', coordenada: { lat: -9.42, lng: -36.64 }, cnpj: CNPJ_PALMEIRA },
  };
  return repo;
}

test('o CD de origem sai do CNPJ do emitente, sem ninguém digitar', async () => {
  const repo = repoComCds();

  const relatorio = await importarXmls(
    [{ nome: 'a.xml', conteudo: xmlDoEmitente(CNPJ_PALMEIRA) }],
    repo,
  );

  assert.equal((await repo.listarPedidos())[0]!.cdId, 'palmeira');
  assert.deepEqual(relatorio.porCd, { palmeira: 1 });
});

test('emitente desconhecido não inventa CD — o operador escolhe na mão', async () => {
  const repo = repoComCds();

  // A fixture vem com uma filial que não é nenhum dos dois CDs.
  const relatorio = await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo);

  assert.equal((await repo.listarPedidos())[0]!.cdId, null);
  assert.deepEqual(relatorio.porCd, { '—': 1 });
});

test('relatório conta as notas por CD da remessa', async () => {
  const repo = repoComCds();

  const relatorio = await importarXmls(
    [
      { nome: 'a.xml', conteudo: xmlDoEmitente(CNPJ_PENEDO) },
      { nome: 'b.xml', conteudo: xmlDoEmitente(CNPJ_PALMEIRA, xmlOutraChave()) },
    ],
    repo,
  );

  assert.equal(relatorio.importados, 2);
  assert.deepEqual(relatorio.porCd, { penedo: 1, palmeira: 1 });
});

// --- Mudança de endereço do cadastro (seção 8.3) ---

/** Cliente já cadastrado, com o endereço da nota alterado pelos `campos`. */
async function comClienteExistente(
  repo: RepositorioMemoria,
  campos: Partial<Cliente> = {},
  enderecoAntigo: Partial<EnderecoFiscal> = { logradouro: 'RUA ANTIGA' },
): Promise<string> {
  const parse = await parseNfe(xml);
  assert.ok(parse.ok);
  const clienteId = parse.nota.destinatario.clienteId;
  await repo.salvarCliente(clienteId, {
    nome: 'MARIA JOSE DA SILVA',
    documentoMascarado: '***.***.***-82',
    telefone: null,
    email: null,
    enderecoFiscal: { ...parse.nota.destinatario.enderecoFiscal, ...enderecoAntigo },
    coordenada: { lat: -9.925, lng: -36.47 },
    statusMapeamento: 'mapeado',
    trilhaAtivaId: null,
    mapeadoPor: 'motorista-1',
    mapeadoEm: '2026-03-01T10:00:00-03:00',
    fotoReferenciaPath: null,
    observacoes: '',
    ...campos,
  });
  return clienteId;
}

test('mudança de endereço segura o pedido em decisão e NÃO descarta o pin', async () => {
  const repo = new RepositorioMemoria();
  await comClienteExistente(repo);

  const relatorio = await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo);
  assert.equal(relatorio.pendentesDeDecisao, 1);
  assert.equal(relatorio.prontosParaRota, 0);
  assert.equal(relatorio.alertas.length, 1);
  assert.match(relatorio.alertas[0]!.mensagem, /cadastro mudou/i);

  // O pedido carrega o endereço ANTERIOR, para o escritório comparar.
  const pedido = (await repo.listarPedidos())[0]!;
  assert.equal(pedido.status, 'pendente_de_decisao');
  assert.equal(pedido.enderecoAnterior?.logradouro, 'RUA ANTIGA');

  // O cadastro recebe o endereço novo; o ponto fica intacto até a decisão.
  const cliente = (await repo.listarClientes())[0]!;
  assert.equal(cliente.enderecoFiscal.logradouro, 'POVOADO BREJO DOS BOIS');
  assert.deepEqual(cliente.coordenada, { lat: -9.925, lng: -36.47 });
  assert.equal(cliente.statusMapeamento, 'mapeado');
});

/** Mesma nota com outra chave de acesso: segunda nota do MESMO cliente. */
function xmlOutraChave(): string {
  return xml.replaceAll(
    '27260314750618000155550010002761651000070282',
    '27260314750618000155550010002761661000070283',
  );
}

test('segunda nota do mesmo cliente na mesma remessa também é segurada', async () => {
  const repo = new RepositorioMemoria();
  await comClienteExistente(repo);

  const relatorio = await importarXmls(
    [
      { nome: 'a.xml', conteudo: xml },
      { nome: 'b.xml', conteudo: xmlOutraChave() },
    ],
    repo,
  );

  // A 1ª nota já atualiza o cadastro; sem a marca no CLIENTE, a 2ª não veria
  // divergência nenhuma e sairia roteirizada no ponto vencido.
  assert.equal(relatorio.importados, 2);
  assert.equal(relatorio.pendentesDeDecisao, 2);
  assert.equal(relatorio.prontosParaRota, 0);
  assert.equal(relatorio.alertas.length, 1); // um alerta por cliente, não por nota

  const pedidos = await repo.listarPedidos();
  assert.ok(pedidos.every((p) => p.status === 'pendente_de_decisao'));
  assert.ok(pedidos.every((p) => p.enderecoAnterior?.logradouro === 'RUA ANTIGA'));
});

test('uma decisão libera todos os pedidos do cliente presos pela mesma pergunta', async () => {
  const repo = new RepositorioMemoria();
  await comClienteExistente(repo);
  await importarXmls(
    [
      { nome: 'a.xml', conteudo: xml },
      { nome: 'b.xml', conteudo: xmlOutraChave() },
    ],
    repo,
  );
  const pedido = (await repo.listarPedidos())[0]!;

  const r = await decidirMudancaEndereco(repo, pedido.id, 'manter');
  assert.ok(r.ok);
  const pedidos = await repo.listarPedidos();
  assert.ok(pedidos.every((p) => p.status === 'pronto_para_rota'));
  // A marca sai do cadastro: importações seguintes não são mais seguradas.
  assert.equal((await repo.listarClientes())[0]!.enderecoEmRevisao, null);
});

test('mudança encadeada antes da decisão preserva o endereço do ponto original', async () => {
  const repo = new RepositorioMemoria();
  const clienteId = await comClienteExistente(repo);
  // 1ª mudança: RUA ANTIGA → endereço da nota. Abre a revisão.
  await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo);
  // 2ª mudança antes de decidir: o "antes" continua sendo RUA ANTIGA, que é o
  // endereço para o qual o pin foi realmente estabelecido.
  await importarXmls([{ nome: 'b.xml', conteudo: xmlOutraChave() }], repo);

  const cliente = (await repo.obterCliente(clienteId))!;
  assert.equal(cliente.enderecoEmRevisao?.logradouro, 'RUA ANTIGA');
  const pedidos = await repo.listarPedidos();
  assert.ok(pedidos.every((p) => p.enderecoAnterior?.logradouro === 'RUA ANTIGA'));
});

test('vale para QUALQUER status de mapeamento — o rural aproximado também segura', async () => {
  const repo = new RepositorioMemoria();
  await comClienteExistente(repo, { statusMapeamento: 'aproximado', mapeadoPor: null });

  const relatorio = await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo);
  assert.equal(relatorio.pendentesDeDecisao, 1);
  assert.equal((await repo.listarPedidos())[0]!.status, 'pendente_de_decisao');
});

test('mudança irrelevante (só complemento) não vira decisão', async () => {
  const repo = new RepositorioMemoria();
  await comClienteExistente(repo, {}, { complemento: 'CASA' });

  const relatorio = await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo);
  assert.equal(relatorio.pendentesDeDecisao, 0);
  assert.equal(relatorio.prontosParaRota, 1);
  assert.equal(relatorio.alertas.length, 0);
});

test('cliente SEM ponto que muda de endereço não vira decisão — geocodifica o novo', async () => {
  const repo = new RepositorioMemoria();
  await comClienteExistente(repo, { coordenada: null, statusMapeamento: 'nao_mapeado' });

  const relatorio = await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo, {
    async geocodificar() {
      return { coordenada: { lat: -9.9, lng: -36.5 }, precisa: false, municipioConfere: true };
    },
  });
  assert.equal(relatorio.pendentesDeDecisao, 0);
  assert.equal(relatorio.aproximados, 1);
  assert.deepEqual((await repo.listarClientes())[0]!.coordenada, { lat: -9.9, lng: -36.5 });
});

test('decidir MANTER devolve o pedido ao fluxo normal, com o ponto preservado', async () => {
  const repo = new RepositorioMemoria();
  await comClienteExistente(repo);
  await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo);
  const pedido = (await repo.listarPedidos())[0]!;

  const r = await decidirMudancaEndereco(repo, pedido.id, 'manter');
  assert.ok(r.ok);
  assert.equal(r.status, 'pronto_para_rota');
  assert.equal((await repo.listarPedidos())[0]!.status, 'pronto_para_rota');
  assert.deepEqual((await repo.listarClientes())[0]!.coordenada, { lat: -9.925, lng: -36.47 });
});

test('decidir REMAPEAR limpa pin, autoria e trilha e manda o rural para mapeamento', async () => {
  const repo = new RepositorioMemoria();
  const clienteId = await comClienteExistente(repo, { trilhaAtivaId: 'trilha-1' });
  await repo.salvarTrilha('trilha-1', {
    clienteId,
    polyline: 'a~l~Fjk~uOwHJy@P',
    pontoEntrada: { lat: -9.9, lng: -36.4 },
    distanciaM: 100,
    precisaoMediaM: 8,
    ativa: true,
    gravadaPor: 'motorista-1',
    gravadaEm: '2026-03-01T10:00:00-03:00',
    versao: 1,
  });
  await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo);
  const pedido = (await repo.listarPedidos())[0]!;

  // Endereço novo é rural e não geocodifica → mapeamento em campo.
  const r = await decidirMudancaEndereco(repo, pedido.id, 'remapear', {
    async geocodificar() {
      return { coordenada: { lat: 0, lng: 0 }, precisa: false, municipioConfere: false };
    },
  });
  assert.ok(r.ok);
  assert.equal(r.status, 'pendente_de_mapeamento');

  const cliente = (await repo.listarClientes())[0]!;
  assert.equal(cliente.coordenada, null);
  assert.equal(cliente.statusMapeamento, 'nao_mapeado');
  assert.equal(cliente.mapeadoPor, null);
  assert.equal(cliente.trilhaAtivaId, null);
  // A trilha do endereço antigo sai de cena.
  assert.equal((await repo.obterTrilhaAtiva(clienteId)), null);
});

test('REMAPEAR também descarta o dossiê — foto e observações eram do lugar antigo', async () => {
  const repo = new RepositorioMemoria();
  const clienteId = await comClienteExistente(repo, {
    fotoReferenciaPath: 'clientes/x/referencia.jpg',
    observacoes: 'portão azul, entrar pela lateral',
  });
  await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo);
  const pedido = (await repo.listarPedidos())[0]!;

  await decidirMudancaEndereco(repo, pedido.id, 'remapear');

  const cliente = (await repo.obterCliente(clienteId))!;
  assert.equal(cliente.fotoReferenciaPath, null);
  assert.equal(cliente.observacoes, '');
  // O cadastro em si continua: identidade é o CPF, não o endereço.
  assert.equal(cliente.nome, 'MARIA JOSE DA SILVA');
});

test('MANTER preserva o dossiê e só tira a marca de revisão', async () => {
  const repo = new RepositorioMemoria();
  const clienteId = await comClienteExistente(repo, {
    fotoReferenciaPath: 'clientes/x/referencia.jpg',
    observacoes: 'portão azul',
    trilhaAtivaId: 'trilha-1',
  });
  await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo);
  const pedido = (await repo.listarPedidos())[0]!;

  await decidirMudancaEndereco(repo, pedido.id, 'manter');

  const cliente = (await repo.obterCliente(clienteId))!;
  assert.equal(cliente.fotoReferenciaPath, 'clientes/x/referencia.jpg');
  assert.equal(cliente.observacoes, 'portão azul');
  assert.equal(cliente.trilhaAtivaId, 'trilha-1');
  assert.equal(cliente.enderecoEmRevisao, null);
});

test('REMAPEAR com endereço novo geocodificável já sai despachável', async () => {
  const repo = new RepositorioMemoria();
  await comClienteExistente(repo);
  await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo);
  const pedido = (await repo.listarPedidos())[0]!;

  const r = await decidirMudancaEndereco(repo, pedido.id, 'remapear', {
    async geocodificar() {
      return { coordenada: { lat: -9.88, lng: -36.44 }, precisa: true, municipioConfere: true };
    },
  });
  assert.ok(r.ok);
  assert.equal(r.status, 'pronto_para_rota');
  const cliente = (await repo.listarClientes())[0]!;
  assert.equal(cliente.statusMapeamento, 'geocodificado');
  assert.deepEqual(cliente.coordenada, { lat: -9.88, lng: -36.44 });
});

test('decidir mudança num pedido que não a aguarda é rejeitado (409)', async () => {
  const repo = new RepositorioMemoria();
  await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo); // cliente novo → sem mudança
  const pedido = (await repo.listarPedidos())[0]!;

  const r = await decidirMudancaEndereco(repo, pedido.id, 'manter');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 409);
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

test('escrita de campo durante a importação não é apagada pela geocodificação', async () => {
  const repo = new RepositorioMemoria();
  const parse = await parseNfe(xmlUrbano());
  assert.ok(parse.ok);
  const clienteId = parse.nota.destinatario.clienteId;

  // O motorista salva observações e foto ENQUANTO a importação espera a Google.
  // Reescrever o doc inteiro com a cópia lida antes da chamada apagaria as duas.
  const relatorio = await importarXmls([{ nome: 'a.xml', conteudo: xmlUrbano() }], repo, {
    async geocodificar() {
      await repo.atualizarCliente(clienteId, {
        observacoes: 'portão azul',
        fotoReferenciaPath: `clientes/${clienteId}/referencia.jpg`,
      });
      return { coordenada: { lat: -10.29, lng: -36.58 }, precisa: true, municipioConfere: true };
    },
  });

  assert.equal(relatorio.geocodificados, 1);
  const cliente = (await repo.obterCliente(clienteId))!;
  assert.equal(cliente.observacoes, 'portão azul');
  assert.equal(cliente.fotoReferenciaPath, `clientes/${clienteId}/referencia.jpg`);
  assert.deepEqual(cliente.coordenada, { lat: -10.29, lng: -36.58 });
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

test('entrega divergente E cadastro mudado: uma pergunta de cada vez', async () => {
  const repo = new RepositorioMemoria();
  await comClienteExistente(repo);
  await importarXmls([{ nome: 'a.xml', conteudo: xmlComEntregaDivergente() }], repo, geoOk);

  const pedido = (await repo.listarPedidos())[0]!;
  assert.equal(pedido.status, 'pendente_de_decisao');
  assert.equal(pedido.enderecoAnterior?.logradouro, 'RUA ANTIGA');
  assert.equal(pedido.enderecoEntrega?.logradouro, 'RUA DA ENTREGA');

  // Escolher o fiscal responde a pergunta da entrega; a do cadastro continua —
  // senão o pedido sairia roteirizado no ponto do endereço antigo.
  const r1 = await decidirEnderecoEntrega(repo, pedido.id, 'fiscal');
  assert.ok(r1.ok);
  assert.equal(r1.status, 'pendente_de_decisao');
  assert.equal((await repo.listarPedidos())[0]!.usarEnderecoEntrega, false);

  const r2 = await decidirMudancaEndereco(repo, pedido.id, 'manter');
  assert.ok(r2.ok);
  assert.equal(r2.status, 'pronto_para_rota');
});

test('escolher a ENTREGA encerra a decisão mesmo com o cadastro mudado', async () => {
  const repo = new RepositorioMemoria();
  await comClienteExistente(repo);
  await importarXmls([{ nome: 'a.xml', conteudo: xmlComEntregaDivergente() }], repo, geoOk);
  const pedido = (await repo.listarPedidos())[0]!;

  // O ponto do cliente não importa: a rota usa o override da entrega.
  const r = await decidirEnderecoEntrega(repo, pedido.id, 'entrega');
  assert.ok(r.ok);
  assert.equal(r.status, 'pronto_para_rota');
});


/** Chave de acesso distinta por índice — cada nota é um pedido diferente. */
function xmlComChave(i: number): string {
  const nova = '272603147506180001555500100027616' + String(51000070282 + i).padStart(11, '0');
  return xml.replaceAll('27260314750618000155550010002761651000070282', nova);
}

test('remessa concorrente: notas do mesmo cliente não duplicam cadastro nem geocodificação', () =>
  (async () => {
    // A trava que isto prova: sem serializar por cliente, as três notas veriam
    // "cliente não existe" ao mesmo tempo, cada uma faria o `set` completo (uma
    // apagando o trabalho da outra) e as três chamariam a Google — o mesmo
    // endereço pago três vezes.
    const repo = new RepositorioMemoria();
    let geocodificacoes = 0;
    const geocodificador = {
      async geocodificar() {
        geocodificacoes += 1;
        // Latência de verdade: sem espera o await resolveria na mesma volta do
        // laço de eventos e a corrida nem apareceria.
        await new Promise((r) => setTimeout(r, 20));
        return { coordenada: { lat: -10.28, lng: -36.56 }, precisa: true, municipioConfere: true };
      },
    };

    const relatorio = await importarXmls(
      [0, 1, 2].map((i) => ({ nome: `n${i}.xml`, conteudo: xmlComChave(i) })),
      repo,
      geocodificador as never,
    );

    assert.equal(relatorio.importados, 3);
    assert.equal(geocodificacoes, 1, 'a 2ª e a 3ª já encontram a coordenada gravada');
    assert.equal((await repo.listarClientes()).length, 1, 'um cliente, não três');
  })());

test('mesmo arquivo repetido na MESMA remessa é duplicado, não grava duas vezes', async () => {
  // O dedupe por `obterPedido` só enxerga o que já está GRAVADO: dentro de um
  // lote concorrente as duas cópias passariam juntas pela verificação.
  const repo = new RepositorioMemoria();
  const relatorio = await importarXmls(
    [
      { nome: 'x.xml', conteudo: xml },
      { nome: 'x-copia.xml', conteudo: xml },
    ],
    repo,
  );

  assert.equal(relatorio.importados, 1);
  assert.equal(relatorio.duplicados, 1);
  assert.equal((await repo.listarPedidos()).length, 1);
});

test('remessa que cruza vários lotes mantém contagem exata e ordem dos rejeitados', async () => {
  const repo = new RepositorioMemoria();
  const arquivos = Array.from({ length: 45 }, (_, i) => ({
    nome: `n${i}.xml`,
    conteudo: xmlComChave(i),
  }));
  // No meio da remessa, para provar que a posição do rejeitado é preservada
  // mesmo com as notas processadas fora de ordem.
  arquivos.splice(20, 0, { nome: 'ruim.xml', conteudo: '<nao-e-nfe/>' });

  const relatorio = await importarXmls(arquivos, repo);

  assert.equal(relatorio.total, 46);
  assert.equal(relatorio.importados, 45);
  assert.equal(relatorio.rejeitados.length, 1);
  assert.equal(relatorio.rejeitados[0]!.arquivo, 'ruim.xml');
  assert.equal((await repo.listarPedidos()).length, 45);
});

/* ---------- Rota × retirada no balcão (ver retirada.ts) ---------- */

/** Cliente já mapeado, para o pedido nascer despachável e a única pergunta ser a do modo. */
async function comClienteMapeado(repo: RepositorioMemoria, conteudo: string): Promise<string> {
  const parse = await parseNfe(conteudo);
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
    trilhaAtivaId: null,
    mapeadoPor: 'motorista-1',
    mapeadoEm: '2026-03-01T10:00:00-03:00',
    fotoReferenciaPath: null,
    observacoes: '',
  });
  return clienteId;
}

const comRetirada = (base: string) => base.replace('<modFrete>0</modFrete>', '<modFrete>9</modFrete>');

test('nota com cara de retirada NÃO vira rota sozinha: pergunta ao escritório', async () => {
  const repo = new RepositorioMemoria();
  await comClienteMapeado(repo, xml);
  const relatorio = await importarXmls([{ nome: 'a.xml', conteudo: comRetirada(xml) }], repo);

  // Mesmo com o cliente mapeado (que normalmente daria pronto_para_rota).
  assert.equal(relatorio.prontosParaRota, 0);
  assert.equal(relatorio.pendentesDeDecisao, 1);
  const pedido = (await repo.listarPedidos())[0]!;
  assert.equal(pedido.status, 'pendente_de_decisao');
  assert.equal(pedido.modFrete, '9');
  assert.equal(pedido.modoEntrega, undefined);
  assert.match(relatorio.alertas[0]?.mensagem ?? '', /retirada/i);
  // Contada à parte: metade de uma importação típica cai aqui, e somar tudo
  // num campo rotulado "aguardando endereço" faria o operador caçar um
  // problema que não existe.
  assert.equal(relatorio.retiradaAConfirmar, 1);
});

test('retirada em volume gera UM alerta-resumo, não um por nota', async () => {
  // Metade das notas do dia é retirada. Uma linha de alerta por nota (~60/dia)
  // afogaria os alertas raros que pedem leitura — mudança de cadastro, entrega
  // divergente. O detalhe fica na métrica; o alerta é o resumo.
  const repo = new RepositorioMemoria();
  await comClienteMapeado(repo, xml);
  const CHAVE = '27260314750618000155550010002761651000070282';
  const notas = ['11', '22', '33'].map((fim, i) => ({
    nome: `n${i}.xml`,
    conteudo: comRetirada(xml).replaceAll(CHAVE, CHAVE.slice(0, 42) + fim),
  }));
  const relatorio = await importarXmls(notas, repo);

  assert.equal(relatorio.retiradaAConfirmar, 3);
  const deRetirada = relatorio.alertas.filter((a) => /retirada/i.test(a.mensagem));
  assert.equal(deRetirada.length, 1);
  assert.match(deRetirada[0]!.mensagem, /3 nota/);
});

test('confirmar retirada duas vezes é inócuo (toque duplo na tela)', async () => {
  const repo = new RepositorioMemoria();
  await comClienteMapeado(repo, xml);
  await importarXmls([{ nome: 'a.xml', conteudo: comRetirada(xml) }], repo);
  const id = (await repo.listarPedidos())[0]!.id;

  await decidirModoEntrega(repo, id, 'retirada');
  const segunda = await decidirModoEntrega(repo, id, 'retirada');
  assert.ok(segunda.ok);
  assert.equal((await repo.obterPedido(id))?.status, 'retirada');
});

test('nota de rota segue direto — modFrete=1 não levanta pergunta', async () => {
  const repo = new RepositorioMemoria();
  await comClienteMapeado(repo, xml);
  const rota = xml.replace('<modFrete>0</modFrete>', '<modFrete>1</modFrete>');
  const relatorio = await importarXmls([{ nome: 'a.xml', conteudo: rota }], repo);

  assert.equal(relatorio.prontosParaRota, 1);
  assert.equal((await repo.listarPedidos())[0]!.status, 'pronto_para_rota');
});

test('escritório confirma retirada: status próprio, sem sumir da lista', async () => {
  const repo = new RepositorioMemoria();
  await comClienteMapeado(repo, xml);
  await importarXmls([{ nome: 'a.xml', conteudo: comRetirada(xml) }], repo);
  const id = (await repo.listarPedidos())[0]!.id;

  const r = await decidirModoEntrega(repo, id, 'retirada');
  assert.ok(r.ok);
  assert.equal(r.status, 'retirada');
  const pedido = await repo.obterPedido(id);
  assert.equal(pedido?.status, 'retirada');
  assert.equal(pedido?.modoEntrega, 'retirada');
});

test('escritório manda para a rota: volta ao fluxo normal', async () => {
  const repo = new RepositorioMemoria();
  await comClienteMapeado(repo, xml);
  await importarXmls([{ nome: 'a.xml', conteudo: comRetirada(xml) }], repo);
  const id = (await repo.listarPedidos())[0]!.id;

  const r = await decidirModoEntrega(repo, id, 'rota');
  assert.ok(r.ok);
  assert.equal(r.status, 'pronto_para_rota');
  assert.equal((await repo.obterPedido(id))?.modoEntrega, 'rota');
});

test('a escolha é REVERSÍVEL: a revendedora não apareceu, o pedido volta para a fila', async () => {
  const repo = new RepositorioMemoria();
  await comClienteMapeado(repo, xml);
  await importarXmls([{ nome: 'a.xml', conteudo: comRetirada(xml) }], repo);
  const id = (await repo.listarPedidos())[0]!.id;

  await decidirModoEntrega(repo, id, 'retirada');
  const volta = await decidirModoEntrega(repo, id, 'rota');
  assert.ok(volta.ok);
  assert.equal(volta.status, 'pronto_para_rota');
});

test('pedido que já saiu não se desfaz daqui', async () => {
  const repo = new RepositorioMemoria();
  await comClienteMapeado(repo, xml);
  await importarXmls([{ nome: 'a.xml', conteudo: comRetirada(xml) }], repo);
  const id = (await repo.listarPedidos())[0]!.id;
  const pedido = (await repo.obterPedido(id))!;
  await repo.salvarPedido(id, { ...pedido, status: 'em_rota', rotaId: 'r1' });

  const r = await decidirModoEntrega(repo, id, 'retirada');
  assert.equal(r.ok, false);
  assert.equal(r.ok ? 0 : r.status, 409);
});

test('escolha inválida não grava nada', async () => {
  const repo = new RepositorioMemoria();
  await comClienteMapeado(repo, xml);
  await importarXmls([{ nome: 'a.xml', conteudo: comRetirada(xml) }], repo);
  const id = (await repo.listarPedidos())[0]!.id;

  const r = await decidirModoEntrega(repo, id, 'balcao' as 'rota');
  assert.equal(r.ok, false);
  assert.equal((await repo.obterPedido(id))?.status, 'pendente_de_decisao');
});

test('nota com DUAS perguntas: responder o modo não solta a do endereço', async () => {
  // A mesma nota pode levantar as duas. Sem esta guarda, escolher "vai para
  // rota" mandaria para o caminhão um pedido cujo endereço ninguém escolheu.
  const repo = new RepositorioMemoria();
  await comClienteMapeado(repo, xml);
  const duasPerguntas = comRetirada(xml).replace(
    '</dest>',
    '</dest><entrega><xLgr>RUA DA ENTREGA</xLgr><nro>500</nro><xBairro>CENTRO</xBairro>' +
      '<xMun>MACEIO</xMun><UF>AL</UF><CEP>57000000</CEP></entrega>',
  );
  await importarXmls([{ nome: 'a.xml', conteudo: duasPerguntas }], repo);
  const id = (await repo.listarPedidos())[0]!.id;

  const r = await decidirModoEntrega(repo, id, 'rota');
  assert.ok(r.ok);
  assert.equal(r.status, 'pendente_de_decisao');
  assert.equal((await repo.obterPedido(id))?.modoEntrega, 'rota');
});

test('e o caminho inverso: responder o endereço não solta a do modo', async () => {
  const repo = new RepositorioMemoria();
  await comClienteMapeado(repo, xml);
  const duasPerguntas = comRetirada(xml).replace(
    '</dest>',
    '</dest><entrega><xLgr>RUA DA ENTREGA</xLgr><nro>500</nro><xBairro>CENTRO</xBairro>' +
      '<xMun>MACEIO</xMun><UF>AL</UF><CEP>57000000</CEP></entrega>',
  );
  await importarXmls([{ nome: 'a.xml', conteudo: duasPerguntas }], repo);
  const id = (await repo.listarPedidos())[0]!.id;

  const r = await decidirEnderecoEntrega(repo, id, 'fiscal');
  assert.ok(r.ok);
  assert.equal(r.status, 'pendente_de_decisao');
  // Respondidas as duas, aí sim sai.
  const fim = await decidirModoEntrega(repo, id, 'rota');
  assert.equal(fim.ok && fim.status, 'pronto_para_rota');
});

/* ---------- O ponto pode vir do OVERRIDE do pedido, não só do cliente ---------- */

const XML_ENTREGA_DIVERGENTE =
  '</dest><entrega><xLgr>RUA DA ENTREGA</xLgr><nro>500</nro><xBairro>CENTRO</xBairro>' +
  '<xMun>MACEIO</xMun><UF>AL</UF><CEP>57000000</CEP></entrega>';

test('override de entrega vale como ponto: endereço respondido antes de rota×retirada não cai em mapeamento', async () => {
  // O bug: decidirModoEntrega consultava só cliente.coordenada. Respondida a
  // pergunta do endereço PRIMEIRO ("usar endereço de entrega", pin no mapa),
  // responder "vai para rota" derrubava o pedido em pendente_de_mapeamento —
  // pedindo trabalho de campo por um ponto que o escritório já tinha cravado.
  const repo = new RepositorioMemoria();
  // Cliente nasce da importação, rural, NUNCA mapeado.
  const conteudo = comRetirada(xml).replace('</dest>', XML_ENTREGA_DIVERGENTE);
  await importarXmls([{ nome: 'a.xml', conteudo }], repo);
  const id = (await repo.listarPedidos())[0]!.id;

  const r1 = await decidirEnderecoEntrega(repo, id, 'entrega', { lat: -9.66, lng: -35.73 });
  assert.ok(r1.ok);
  assert.equal(r1.status, 'pendente_de_decisao'); // ainda falta rota×retirada

  const r2 = await decidirModoEntrega(repo, id, 'rota');
  assert.ok(r2.ok);
  assert.equal(r2.status, 'pronto_para_rota'); // o override É o ponto
});

test('as três perguntas na mesma nota: depois do remapeamento, o override segura o pedido pronto', async () => {
  // Cliente conhecido e MAPEADO cujo cadastro mudou de endereço (8.3), nota
  // com endereço de entrega divergente (8.4) E com cara de retirada. As três
  // perguntas se acumulam; a liberação em lote do fim não pode rebaixar o
  // pedido cujo ponto é o override — mesmo o cliente tendo acabado de perder
  // o dele no remapear.
  const repo = new RepositorioMemoria();
  const parse = await parseNfe(xml);
  assert.ok(parse.ok);
  const clienteId = parse.nota.destinatario.clienteId;
  await repo.salvarCliente(clienteId, {
    nome: 'MARIA JOSE DA SILVA',
    documentoMascarado: '***.***.***-82',
    telefone: null,
    email: null,
    enderecoFiscal: {
      logradouro: 'RUA ANTIGA',
      numero: '1',
      bairro: 'CENTRO',
      municipio: 'JUNQUEIRO',
      uf: 'AL',
      cep: '57270000',
    },
    coordenada: { lat: -9.92, lng: -36.47 },
    statusMapeamento: 'mapeado',
    trilhaAtivaId: null,
    mapeadoPor: 'motorista-1',
    mapeadoEm: '2026-01-01T00:00:00-03:00',
    fotoReferenciaPath: null,
    observacoes: '',
  });
  const conteudo = comRetirada(xml).replace('</dest>', XML_ENTREGA_DIVERGENTE);
  await importarXmls([{ nome: 'a.xml', conteudo }], repo);
  const id = (await repo.listarPedidos())[0]!.id;

  const r1 = await decidirEnderecoEntrega(repo, id, 'entrega', { lat: -9.66, lng: -35.73 });
  assert.ok(r1.ok && r1.status === 'pendente_de_decisao');
  const r2 = await decidirModoEntrega(repo, id, 'rota');
  assert.ok(r2.ok && r2.status === 'pendente_de_decisao'); // presa na do cadastro
  const r3 = await decidirMudancaEndereco(repo, id, 'remapear'); // cliente perde o ponto
  assert.ok(r3.ok);

  // Sem o fix a liberação aplicava o status-base do cliente (mapeamento).
  assert.equal((await repo.obterPedido(id))?.status, 'pronto_para_rota');
});

test('refazer o ponto do cliente não rebaixa pedido com override de entrega', async () => {
  const repo = new RepositorioMemoria();
  const clienteId = 'cliente-refazer';
  await repo.salvarCliente(clienteId, {
    nome: 'CLIENTE',
    documentoMascarado: '***',
    telefone: null,
    email: null,
    enderecoFiscal: {
      logradouro: 'RUA A',
      numero: '1',
      bairro: 'CENTRO',
      municipio: 'PENEDO',
      uf: 'AL',
      cep: '57200000',
    },
    coordenada: { lat: -10.28, lng: -36.56 },
    statusMapeamento: 'mapeado',
    trilhaAtivaId: null,
    mapeadoPor: 'motorista-1',
    mapeadoEm: '2026-01-01T00:00:00-03:00',
    fotoReferenciaPath: null,
    observacoes: '',
  });
  const base = {
    numeroNota: 1,
    serie: 1,
    numeroPedido: '1',
    lote: null,
    clienteId,
    emitidoEm: '2026-07-30T08:00:00-03:00',
    itens: [],
    valorTotal: 10,
    volumes: 1,
    pesoBrutoKg: 1,
    status: 'pronto_para_rota',
    rotaId: null,
    xmlStoragePath: null,
  } satisfies Pedido;
  await repo.salvarPedido('sem-override', { ...base });
  await repo.salvarPedido('com-override', {
    ...base,
    usarEnderecoEntrega: true,
    coordenadaEntrega: { lat: -9.9, lng: -36.5 },
  });

  // Sem geocodificador o cliente fica sem ponto nenhum.
  const r = await refazerPontoDoCliente(repo, clienteId, null);
  assert.ok(r.ok);
  assert.equal((await repo.obterPedido('sem-override'))?.status, 'pendente_de_mapeamento');
  // O pin do override não veio do cliente e não morre com o ponto dele.
  assert.equal((await repo.obterPedido('com-override'))?.status, 'pronto_para_rota');
});
