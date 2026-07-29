import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  apagarPedidoImportado,
  decidirEnderecoEntrega,
  decidirMudancaEndereco,
  importarXmls,
} from './servico.js';
import { RepositorioMemoria } from '../db/repositorio.js';
import { parseNfe } from '../nfe/parser.js';
import type { Cliente, EnderecoFiscal } from '@rota/shared';

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

// --- Apagar nota importada por engano ---

test('apaga a nota importada e preserva o cliente que ela criou', async () => {
  const repo = new RepositorioMemoria();
  await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo);
  const pedido = (await repo.listarPedidos())[0]!;

  const r = await apagarPedidoImportado(repo, pedido.id);

  assert.ok(r.ok);
  assert.equal((await repo.listarPedidos()).length, 0);
  // O cliente fica: coordenada, pin e dossiê são sobre o LUGAR, não sobre a nota.
  assert.equal((await repo.listarClientes()).length, 1);
});

test('reimportar o mesmo XML depois de apagar traz a nota de volta', async () => {
  const repo = new RepositorioMemoria();
  await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo);
  const pedido = (await repo.listarPedidos())[0]!;
  await apagarPedidoImportado(repo, pedido.id);

  const relatorio = await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo);

  assert.equal(relatorio.importados, 1);
  assert.equal(relatorio.duplicados, 0);
  assert.equal((await repo.listarPedidos()).length, 1);
});

test('nota que já saiu do escritório não pode ser apagada', async () => {
  const repo = new RepositorioMemoria();
  await importarXmls([{ nome: 'a.xml', conteudo: xml }], repo);
  const pedido = (await repo.listarPedidos())[0]!;

  for (const status of ['em_rota', 'entregue', 'insucesso'] as const) {
    await repo.salvarPedido(pedido.id, { ...pedido, status });
    const r = await apagarPedidoImportado(repo, pedido.id);
    assert.equal(r.ok, false, `${status} deveria ser recusado`);
    if (!r.ok) assert.equal(r.status, 409);
  }
  assert.equal((await repo.listarPedidos()).length, 1, 'nada foi apagado');
});

test('apagar pedido inexistente é 404, não erro cru', async () => {
  const repo = new RepositorioMemoria();
  const r = await apagarPedidoImportado(repo, '0'.repeat(44));
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
