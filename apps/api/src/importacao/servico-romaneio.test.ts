import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Cliente } from '@rota/shared';
import { blocoDoRomaneio, type LinhaRomaneio, type Romaneio } from './romaneio.js';
import type { LinhaPlanilha } from './planilha.js';
import { importarRomaneiosLidos } from './servico-romaneio.js';
import { importarLinhas, relatorioVazio } from './servico-planilha.js';
import { salvarDadosDoCliente } from './dados-cliente.js';
import { RepositorioMemoria } from '../db/repositorio.js';

function cliente(extra: Partial<Cliente> = {}): Cliente {
  return {
    nome: 'JOANA BATISTA DA SILVA',
    documentoMascarado: 'cód. 70000001',
    telefone: '+5582999991234',
    email: null,
    // Como o cadastro grava: número da casa dentro do complemento.
    enderecoFiscal: {
      logradouro: 'PREFEITO JOSÉ INÁCIO',
      numero: '43 CASA',
      bairro: 'CENTRO',
      municipio: 'QUEBRANGULO',
      uf: 'AL',
      cep: '57750000',
    },
    coordenada: { lat: -9.32, lng: -36.47 },
    statusMapeamento: 'mapeado',
    trilhaAtivaId: null,
    mapeadoPor: 'mot1',
    mapeadoEm: '2026-10-01T00:00:00Z',
    fotoReferenciaPath: null,
    observacoes: '',
    ...extra,
  };
}

function linha(extra: Partial<LinhaRomaneio> = {}): LinhaRomaneio {
  return {
    notaFiscal: 190001,
    cep: '57750000',
    nome: 'JOANA BATISTA DA SILVA',
    pedido: '530000001',
    bairro: 'CENTRO',
    cidade: 'QUEBRANGULO',
    uf: 'AL',
    endereco: 'PREFEITO JOSÉ INÁCIO, 43, CASA-SUBIDA DA PADARIA',
    ...extra,
  };
}

function romaneio(linhas: LinhaRomaneio[], quantidade: number | null = linhas.length): Romaneio {
  return { rota: '1673300', motorista: 'Caique Santos', quantidade, linhas };
}

test('romaneio: revendedora do cadastro com ponto sai pronta, com o telefone e o ponto dela', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('70000001', cliente());
  const r = relatorioVazio();
  await importarRomaneiosLidos([{ romaneio: romaneio([linha()]), codCd: '684' }], repo, r);

  assert.equal(r.importados, 1);
  assert.deepEqual(r.folhas, [{ rota: '1673300', motorista: 'Caique Santos', pacotes: 1 }]);
  assert.equal(r.prontosParaRota, 1);
  assert.equal(r.pendentesDeDecisao, 0, 'mesmo endereço escrito como no romaneio não abre revisão');
  assert.equal(r.semCadastro ?? 0, 0);
  const p = await repo.obterPedido('530000001');
  assert.equal(p?.clienteId, '70000001');
  assert.equal(p?.status, 'pronto_para_rota');
  assert.equal(p?.cdId, 'palmeira');
  assert.equal(p?.romaneio, '1673300');
  assert.equal(p?.volumes, 1);
  const c = await repo.obterCliente('70000001');
  assert.equal(c?.telefone, '+5582999991234', 'o romaneio não traz telefone — e não apaga o do cadastro');
  assert.deepEqual(c?.coordenada, { lat: -9.32, lng: -36.47 });
});

test('romaneio: revendedora que só está no CADASTRO guardado vira cliente — com o telefone e o GPS de lá', async () => {
  const repo = new RepositorioMemoria();
  await repo.gravarRevendedoras([
    {
      id: '70000001',
      dados: {
        nome: 'JOANA BATISTA DA SILVA',
        chave: 'JOANA BATISTA DA SILVA|QUEBRANGULO',
        telefone: '+5582988887777',
        papel: 'Ouro',
        endereco: cliente().enderecoFiscal,
        referencia: 'SUBIDA DO MERCADINHO',
        pin: { lat: -9.31, lng: -36.46 },
        situacao: 'Ativo',
        dadosDe: null,
      },
    },
  ]);
  const r = relatorioVazio();
  await importarRomaneiosLidos([{ romaneio: romaneio([linha()]), codCd: '684' }], repo, r);
  assert.equal(r.semCadastro ?? 0, 0);
  const c = await repo.obterCliente('70000001');
  assert.equal(c?.telefone, '+5582988887777');
  assert.equal(c?.papel, 'Ouro');
  assert.deepEqual(c?.coordenada, { lat: -9.31, lng: -36.46 });
  assert.equal((await repo.obterPedido('530000001'))?.status, 'pronto_para_rota');
});

test('romaneio: cliente que também está no cadastro não vira "nome repetido" dela mesma', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('70000001', cliente());
  await repo.gravarRevendedoras([
    {
      id: '70000001',
      dados: {
        nome: 'JOANA BATISTA DA SILVA',
        chave: 'JOANA BATISTA DA SILVA|QUEBRANGULO',
        telefone: null,
        papel: null,
        // Endereço do cadastro diferente do cliente (mudou): continua a mesma pessoa.
        endereco: { ...cliente().enderecoFiscal, logradouro: 'RUA VELHA' },
        referencia: '',
        pin: null,
        situacao: 'Ativo',
        dadosDe: null,
      },
    },
  ]);
  const r = relatorioVazio();
  await importarRomaneiosLidos([{ romaneio: romaneio([linha()]), codCd: '684' }], repo, r);
  assert.equal(r.semCadastro ?? 0, 0);
  assert.equal((await repo.obterPedido('530000001'))?.clienteId, '70000001');
});

test('romaneio: revendedora do cadastro SEM ponto entra na fila da localização', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('70000001', cliente({ coordenada: null, statusMapeamento: 'nao_mapeado', mapeadoPor: null }));
  const r = relatorioVazio();
  await importarRomaneiosLidos([{ romaneio: romaneio([linha()]), codCd: '542' }], repo, r);
  const p = await repo.obterPedido('530000001');
  assert.equal(p?.status, 'pendente_de_mapeamento');
  assert.equal(p?.cdId, 'penedo');
  assert.equal(p?.serie, 1);
});

test('romaneio: endereço que MUDOU em cliente com ponto vai para a aba Decisões', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('70000001', cliente());
  const r = relatorioVazio();
  await importarRomaneiosLidos(
    [{ romaneio: romaneio([linha({ endereco: 'RUA NOVA, 99, -PERTO DA IGREJA' })]), codCd: '684' }],
    repo,
    r,
  );
  const p = await repo.obterPedido('530000001');
  assert.equal(p?.status, 'pendente_de_decisao');
  assert.equal(p?.enderecoAnterior?.logradouro, 'PREFEITO JOSÉ INÁCIO');
});

test('romaneio: destinatária fora da base vira cliente novo MARCADO para o Admin completar', async () => {
  const repo = new RepositorioMemoria();
  const r = relatorioVazio();
  await importarRomaneiosLidos(
    [{ romaneio: romaneio([linha({ nome: 'Maria do Site', pedido: '160000001-1' })]), codCd: '684' }],
    repo,
    r,
  );
  assert.equal(r.semCadastro, 1);
  assert.ok(r.alertas.some((a) => a.nome === 'Fora da base de revendedoras'));
  const p = await repo.obterPedido('160000001-1');
  assert.ok(p);
  assert.match(p.clienteId, /^[0-9a-f]{64}$/);
  const c = await repo.obterCliente(p.clienteId);
  assert.equal(c?.nome, 'Maria do Site');
  assert.equal(c?.telefone, null);
  assert.equal(c?.completarDados, true);
  // O hash de 64 letras na coluna "Documento" só confundia.
  assert.equal(c?.documentoMascarado, 'fora da base');
  // A tela da importação abre o formulário dela ali mesmo.
  assert.deepEqual(r.clientesACompletar, [
    {
      id: p.clienteId,
      nome: 'Maria do Site',
      endereco: 'PREFEITO JOSÉ INÁCIO, 43 CASA — CENTRO, QUEBRANGULO/AL',
      telefone: null,
      observacoes: 'SUBIDA DA PADARIA',
      codigoErp: null,
    },
  ]);
});

test('romaneio: cliente fora da base que o Admin JÁ completou não volta para a lista no romaneio seguinte', async () => {
  const repo = new RepositorioMemoria();
  const folha = (pedido: string) => [
    { romaneio: romaneio([linha({ nome: 'Maria do Site', pedido })]), codCd: '684' },
  ];
  const primeira = relatorioVazio();
  await importarRomaneiosLidos(folha('160000001-1'), repo, primeira);
  const id = primeira.clientesACompletar![0]!.id;
  const ainda = relatorioVazio();
  await importarRomaneiosLidos(folha('160000001-2'), repo, ainda);
  assert.equal(ainda.clientesACompletar?.length, 1, 'ninguém completou: continua pedindo');

  await salvarDadosDoCliente(repo, id, { telefone: '82999991234' });
  const depois = relatorioVazio();
  await importarRomaneiosLidos(folha('160000001-3'), repo, depois);
  assert.equal(depois.clientesAtualizados ?? 0, 0);
  assert.equal(depois.clientesACompletar, undefined);
  assert.ok(!depois.alertas.some((a) => a.nome === 'Fora da base de revendedoras'));
  // O pedido novo cai no MESMO cliente, que fica com o telefone do Admin.
  assert.equal((await repo.obterPedido('160000001-3'))?.clienteId, id);
  assert.equal((await repo.obterCliente(id))?.telefone, '+5582999991234');
});

test('romaneio: reimportar a mesma folha não duplica nada', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('70000001', cliente());
  await importarRomaneiosLidos([{ romaneio: romaneio([linha()]), codCd: '684' }], repo, relatorioVazio());
  const r = relatorioVazio();
  await importarRomaneiosLidos([{ romaneio: romaneio([linha()]), codCd: '684' }], repo, r);
  assert.equal(r.importados, 0);
  assert.equal(r.duplicados, 1);
  assert.equal((await repo.listarPedidos()).length, 1);
});

test('romaneio: cliente que JÁ existe só ganha da base o que lhe falta — o telefone corrigido pelo Admin fica', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('70000001', cliente({ telefone: '+5582988887777', papel: 'Ouro' }));
  await repo.gravarRevendedoras([
    {
      id: '70000001',
      dados: {
        nome: 'JOANA BATISTA DA SILVA',
        chave: 'JOANA BATISTA DA SILVA|QUEBRANGULO',
        telefone: '+5582911110000',
        papel: 'Bronze',
        endereco: cliente().enderecoFiscal,
        referencia: '',
        pin: null,
        situacao: 'Ativo',
        dadosDe: null,
      },
    },
  ]);
  await importarRomaneiosLidos([{ romaneio: romaneio([linha()]), codCd: '684' }], repo, relatorioVazio());
  const c = await repo.obterCliente('70000001');
  assert.equal(c?.telefone, '+5582988887777');
  assert.equal(c?.papel, 'Ouro');
});

test('romaneio: GPS da base de um endereço VELHO não vira ponto exato no endereço novo da folha', async () => {
  const repo = new RepositorioMemoria();
  await repo.gravarRevendedoras([
    {
      id: '70000001',
      dados: {
        nome: 'JOANA BATISTA DA SILVA',
        chave: 'JOANA BATISTA DA SILVA|QUEBRANGULO',
        telefone: '+5582911110000',
        papel: null,
        endereco: { ...cliente().enderecoFiscal, logradouro: 'SITIO VELHO', numero: 'S/N' },
        referencia: '',
        pin: { lat: -9.31, lng: -36.46 },
        situacao: 'Ativo',
        dadosDe: null,
      },
    },
  ]);
  await importarRomaneiosLidos([{ romaneio: romaneio([linha()]), codCd: '684' }], repo, relatorioVazio());
  const c = await repo.obterCliente('70000001');
  assert.equal(c?.coordenada, null, 'sem ponto: entra na localização, não vai para a casa velha');
  assert.equal(c?.telefone, '+5582911110000', 'o telefone, que é da pessoa, vem');
  assert.equal((await repo.obterPedido('530000001'))?.status, 'pendente_de_mapeamento');
});

test('romaneio: a data impressa na folha é a do pedido; linha ilegível vira rejeitada', async () => {
  const repo = new RepositorioMemoria();
  const r = relatorioVazio();
  const folha: Romaneio = {
    ...romaneio([linha()], 2),
    impressoEm: '2026-10-24T08:30:00-03:00',
    recusadas: ['NF 165331: pedido "530000001530000003" ilegível'],
  };
  await importarRomaneiosLidos([{ romaneio: folha, codCd: '684' }], repo, r);
  assert.equal((await repo.obterPedido('530000001'))?.emitidoEm, '2026-10-24T08:30:00-03:00');
  assert.equal(r.rejeitados.length, 1);
  assert.match(r.rejeitados[0]!.motivo, /ilegível/);
  // 2 pacotes = 1 lida + 1 recusada: a contagem fecha, sem o alerta duplicado.
  assert.ok(!r.alertas.some((a) => a.nome === 'Romaneio 1673300'));
});

test('pedido do SITE pelo romaneio e pela planilha (outro código, mesmo pacote) entra UMA vez, em qualquer ordem', async () => {
  const daFolha = () => [{ romaneio: romaneio([linha({ nome: 'Maria do Site', pedido: '160000001-1' })]), codCd: '684' }];
  // A planilha dá ao mesmo pedido um código de 9 dígitos e põe o do site no externo.
  const daPlanilha = (): LinhaPlanilha => ({
    codigoPedido: '530000002',
    codigoExterno: '160000001-1',
    notaFiscal: 190002,
    pessoa: '9000001',
    nome: 'MARIA DO SITE',
    papel: 'Consumidor Final',
    quantidadeMateriais: 2,
    valor: 50,
    tipoEntrega: 'rota',
    tipoEntregaBruto: 'No endereço de entrega',
    cancelada: false,
    entregueNoErp: false,
    dataEntrega: null,
    enderecoCadastro: blocoDoRomaneio(linha()),
    enderecoEntrega: blocoDoRomaneio(linha()),
    telefone: null,
    estrutura: null,
    codCd: '684',
    lote: null,
    volumes: 1,
    pesoBrutoKg: 1,
    emitidoEm: '2026-10-20T00:00:00-03:00',
  });
  for (const primeiroRomaneio of [true, false]) {
    const repo = new RepositorioMemoria();
    if (primeiroRomaneio) await importarRomaneiosLidos(daFolha(), repo, relatorioVazio());
    await importarLinhas([daPlanilha()], repo, relatorioVazio());
    if (!primeiroRomaneio) await importarRomaneiosLidos(daFolha(), repo, relatorioVazio());
    assert.equal((await repo.listarPedidos()).length, 1, primeiroRomaneio ? 'romaneio → planilha' : 'planilha → romaneio');
    // Veio antes pela planilha: o pedido ganha o número da folha, para a busca achar.
    if (!primeiroRomaneio) assert.equal((await repo.obterPedido('530000002'))?.romaneio, '1673300');
  }
});

test('pedido do site CANCELADO pela planilha não volta quando o mesmo romaneio é reenviado', async () => {
  const repo = new RepositorioMemoria();
  const folha = () => [{ romaneio: romaneio([linha({ nome: 'Maria do Site', pedido: '160000001-1' })]), codCd: '684' }];
  await importarRomaneiosLidos(folha(), repo, relatorioVazio());
  assert.ok(await repo.obterPedido('160000001-1'));
  const cancelada: LinhaPlanilha = {
    codigoPedido: '530000002',
    codigoExterno: '160000001-1',
    notaFiscal: 1,
    pessoa: '9000001',
    nome: 'MARIA DO SITE',
    papel: 'Consumidor Final',
    quantidadeMateriais: 1,
    valor: 1,
    tipoEntrega: 'rota',
    tipoEntregaBruto: 'No endereço de entrega',
    cancelada: true,
    entregueNoErp: false,
    dataEntrega: null,
    enderecoCadastro: blocoDoRomaneio(linha()),
    enderecoEntrega: blocoDoRomaneio(linha()),
    telefone: null,
    estrutura: null,
    codCd: '684',
    lote: null,
    volumes: 1,
    pesoBrutoKg: 1,
    emitidoEm: '2026-10-20T00:00:00-03:00',
  };
  await importarLinhas([cancelada], repo, relatorioVazio());
  assert.equal(await repo.obterPedido('160000001-1'), null, 'o cancelado sai');
  await importarRomaneiosLidos(folha(), repo, relatorioVazio());
  assert.equal(await repo.obterPedido('160000001-1'), null, 'e não volta com a folha reenviada');
});

test('planilha não troca o CELULAR do cliente pelo fixo, nem repõe o telefone que o Admin apagou', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('70000001', cliente({ telefone: '+5582999991234' }));
  await repo.salvarCliente('70000002', cliente({ telefone: null, telefoneApagado: true }));
  const linhaDe = (pessoa: string, codigoPedido: string, telefone: string): LinhaPlanilha => ({
    codigoPedido,
    notaFiscal: 1,
    pessoa,
    nome: 'JOANA BATISTA DA SILVA',
    papel: null,
    quantidadeMateriais: 1,
    valor: 1,
    tipoEntrega: 'rota',
    tipoEntregaBruto: 'No endereço de entrega',
    cancelada: false,
    entregueNoErp: false,
    dataEntrega: null,
    enderecoCadastro: blocoDoRomaneio(linha()),
    enderecoEntrega: blocoDoRomaneio(linha()),
    telefone,
    estrutura: '1515',
    codCd: '684',
    lote: null,
    volumes: 1,
    pesoBrutoKg: 1,
    emitidoEm: '2026-10-20T00:00:00-03:00',
  });
  await importarLinhas(
    [linhaDe('70000001', '530000021', '(82) 3333-4444'), linhaDe('70000002', '530000022', '(82) 99888-7777')],
    repo,
    relatorioVazio(),
  );
  assert.equal((await repo.obterCliente('70000001'))?.telefone, '+5582999991234');
  assert.equal((await repo.obterCliente('70000002'))?.telefone, null);
});

test('folha VELHA soltada depois da nova não traz o GPS da casa velha para o cliente da casa nova', async () => {
  const repo = new RepositorioMemoria();
  await repo.gravarRevendedoras([
    {
      id: '70000001',
      dados: {
        nome: 'JOANA BATISTA DA SILVA',
        chave: 'JOANA BATISTA DA SILVA|QUEBRANGULO',
        telefone: '+5582911110000',
        papel: null,
        endereco: { ...cliente().enderecoFiscal, logradouro: 'SITIO B', numero: 'S/N' },
        referencia: '',
        pin: { lat: -9.31, lng: -36.46 },
        situacao: 'Ativo',
        dadosDe: null,
      },
    },
  ]);
  const nova: Romaneio = { ...romaneio([linha({ pedido: '530000031', endereco: 'RUA A, 10, -' })]), impressoEm: '2026-10-25T08:00:00-03:00' };
  const velha: Romaneio = { ...romaneio([linha({ pedido: '530000032', endereco: 'SITIO B, S/N, -' })]), impressoEm: '2026-10-23T08:00:00-03:00' };
  await importarRomaneiosLidos([{ romaneio: nova, codCd: '684' }], repo, relatorioVazio());
  await importarRomaneiosLidos([{ romaneio: velha, codCd: '684' }], repo, relatorioVazio());
  const c = await repo.obterCliente('70000001');
  assert.equal(c?.enderecoFiscal.logradouro, 'RUA A');
  assert.equal(c?.coordenada, null, 'o GPS é do sítio, não da RUA A');
});

test('telefone que o Admin APAGOU não volta da base no romaneio seguinte', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('70000001', cliente({ telefone: '+5582911110000' }));
  await repo.gravarRevendedoras([
    {
      id: '70000001',
      dados: {
        nome: 'JOANA BATISTA DA SILVA',
        chave: 'JOANA BATISTA DA SILVA|QUEBRANGULO',
        telefone: '+5582911110000',
        papel: null,
        endereco: cliente().enderecoFiscal,
        referencia: '',
        pin: null,
        situacao: 'Ativo',
        dadosDe: null,
      },
    },
  ]);
  await salvarDadosDoCliente(repo, '70000001', { telefone: '' });
  await importarRomaneiosLidos([{ romaneio: romaneio([linha()]), codCd: '684' }], repo, relatorioVazio());
  assert.equal((await repo.obterCliente('70000001'))?.telefone, null);
});

test('cliente do romaneio que passa a casar com a base fica LIGADO a ela e sai de "completar dados"', async () => {
  const repo = new RepositorioMemoria();
  const folha = (pedido: string) => [{ romaneio: romaneio([linha({ nome: 'Maria do Site', pedido })]), codCd: '684' }];
  const r1 = relatorioVazio();
  await importarRomaneiosLidos(folha('530000011'), repo, r1);
  const id = r1.clientesACompletar![0]!.id;
  // Os pedidos do ano trouxeram a Maria para a base, na mesma porta.
  await repo.gravarRevendedoras([
    {
      id: '777',
      dados: {
        nome: 'MARIA DO SITE',
        chave: 'MARIA DO SITE|QUEBRANGULO',
        telefone: '+5582977776666',
        papel: 'Bronze',
        endereco: cliente().enderecoFiscal,
        referencia: '',
        pin: null,
        situacao: 'Ativo',
        dadosDe: null,
      },
    },
  ]);
  const r2 = relatorioVazio();
  await importarRomaneiosLidos(folha('530000012'), repo, r2);
  assert.equal((await repo.obterPedido('530000012'))?.clienteId, id, 'o pedido fica no cliente que já existia');
  const c = await repo.obterCliente(id);
  assert.equal(c?.codigoErp, '777');
  assert.equal(c?.completarDados, false);
  assert.equal(c?.telefone, '+5582977776666');
});

test('data impressa no FUTURO (relógio errado) não vira a data do pedido', async () => {
  const repo = new RepositorioMemoria();
  await importarRomaneiosLidos(
    [{ romaneio: { ...romaneio([linha()]), impressoEm: '2099-01-01T08:00:00-03:00' }, codCd: '684' }],
    repo,
    relatorioVazio(),
  );
  assert.ok(((await repo.obterPedido('530000001'))?.emitidoEm ?? '') < '2099');
});

test('romaneio: a folha diz N pacotes e a leitura achou outro número — avisa', async () => {
  const repo = new RepositorioMemoria();
  const r = relatorioVazio();
  await importarRomaneiosLidos([{ romaneio: romaneio([linha()], 2), codCd: '684' }], repo, r);
  assert.ok(r.alertas.some((a) => a.nome === 'Romaneio 1673300' && /2 pacote.*1 linha/.test(a.mensagem)));
});
