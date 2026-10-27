import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import type { Cliente } from '@rota/shared';
import { lerCadastro } from './cadastro.js';
import { importarCadastro } from './servico-cadastro.js';
import { RepositorioMemoria } from '../db/repositorio.js';

/**
 * Monta um .xlsx no formato do export REAL de revendedoras (26/10/2026): texto
 * em `sharedStrings.xml` (célula `t="s"` guarda o índice), uma aba por CD.
 * Colunas no meio que o leitor NÃO deve ler (CPF, aniversário) vão junto.
 */
function cadastroXlsx(abas: Array<Array<Record<string, string>>>): Uint8Array {
  const COLUNAS = [
    'CodigoRevendedor', 'Nome', 'CPF/CNPJ', 'DtAniversario', 'Situacao', 'Papel', 'TelResidencial', 'TelCelular',
    'RuaResidencial', 'ComplementoResidencial', 'CEPResidencial', 'ReferenciaResidencial', 'BairroResidencial',
    'CidadeResidencial', 'EstadoResidencial', 'RuaEntrega', 'ComplementoEntrega', 'CEPEntrega',
    'ReferenciaEntrega', 'BairroEntrega', 'CidadeEntrega', 'EstadoEntrega',
  ];
  const textos: string[] = [];
  const indice = (t: string) => {
    let i = textos.indexOf(t);
    if (i < 0) i = textos.push(t) - 1;
    return i;
  };
  const letra = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : 'A' + String.fromCharCode(65 + i - 26));
  const row = (n: number, valores: string[]) =>
    `<row r="${n}">${valores
      .map((v, i) => (v === '' ? '' : `<c r="${letra(i)}${n}" t="s"><v>${indice(v)}</v></c>`))
      .join('')}</row>`;
  const arquivos: Record<string, Uint8Array> = { 'xl/workbook.xml': strToU8('<workbook/>') };
  abas.forEach((linhas, k) => {
    const corpo = [row(1, COLUNAS), ...linhas.map((l, i) => row(i + 2, COLUNAS.map((c) => l[c] ?? '')))].join('');
    arquivos[`xl/worksheets/sheet${k + 1}.xml`] = strToU8(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${corpo}</sheetData></worksheet>`,
    );
  });
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  arquivos['xl/sharedStrings.xml'] = strToU8(
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${textos
      .map((t) => `<si><t>${esc(t)}</t></si>`)
      .join('')}</sst>`,
  );
  return zipSync(arquivos);
}

function revendedora(extra: Record<string, string> = {}): Record<string, string> {
  return {
    CodigoRevendedor: '70.000.002',
    Nome: 'JOANA BATISTA DA SILVA',
    'CPF/CNPJ': '123.456.789-00',
    DtAniversario: '01/01/1990',
    Situacao: 'Ativo',
    Papel: 'Ouro',
    TelCelular: '(82) 99999-1234',
    RuaEntrega: 'PREFEITO JOSÉ INÁCIO',
    ComplementoEntrega: '43 CASA',
    CEPEntrega: '57750-000',
    ReferenciaEntrega: 'SUBIDA DO MERCADINHO',
    BairroEntrega: 'CENTRO',
    CidadeEntrega: 'QUEBRANGULO',
    EstadoEntrega: 'AL',
    ...extra,
  };
}

test('cadastro: lê as DUAS abas, código sem pontos, e não lê CPF nem aniversário', () => {
  const r = lerCadastro(
    cadastroXlsx([[revendedora()], [revendedora({ CodigoRevendedor: '98.765', Nome: 'ANTONIA' })]]),
  );
  assert.ok(r.ok, !r.ok ? r.motivo : '');
  assert.deepEqual(r.linhas.map((l) => l.codigo), ['70000002', '98765']);
  assert.equal(r.linhas[0]!.telefone, '(82) 99999-1234');
  assert.equal(r.linhas[0]!.endereco.complemento, '43 CASA');
  const tudo = JSON.stringify(r.linhas);
  assert.ok(!tudo.includes('123.456.789'), 'CPF não pode sair do leitor');
  assert.ok(!tudo.includes('1990'), 'aniversário não pode sair do leitor');
});

test('cadastro: CPF digitado no telefone ou no nome, e e-mail no nome, não saem do leitor', () => {
  const r = lerCadastro(
    cadastroXlsx([
      [
        // CPF no celular: vale o residencial.
        revendedora({ TelCelular: '123.456.789-00', TelResidencial: '(82) 3333-4444' }),
        revendedora({ CodigoRevendedor: '2', Nome: '123.456.789-00' }),
        revendedora({ CodigoRevendedor: '3', Nome: 'fulana@exemplo.com' }),
        // CPF sem o zero da frente, como o ERP às vezes guarda.
        revendedora({ CodigoRevendedor: '4', 'CPF/CNPJ': '012.345.678-90', TelCelular: '1234567890' }),
      ],
    ]),
  );
  assert.ok(r.ok);
  assert.deepEqual(r.linhas.map((l) => l.codigo), ['70000002', '4']);
  assert.equal(r.linhas[0]!.telefone, '(82) 3333-4444');
  assert.equal(r.linhas[1]!.telefone, null);
  const tudo = JSON.stringify(r.linhas);
  assert.ok(!tudo.includes('123.456.789') && !tudo.includes('12345678') && !tudo.includes('@'));
});

test('cadastro: sem endereço de entrega, vale o residencial', () => {
  const r = lerCadastro(
    cadastroXlsx([
      [
        revendedora({
          RuaEntrega: '',
          ComplementoEntrega: '',
          CidadeEntrega: '',
          RuaResidencial: 'RUA DE CASA',
          ComplementoResidencial: '7',
          CidadeResidencial: 'IGACI',
          EstadoResidencial: 'AL',
        }),
      ],
    ]),
  );
  assert.ok(r.ok);
  assert.equal(r.linhas[0]!.endereco.logradouro, 'RUA DE CASA');
  assert.equal(r.linhas[0]!.endereco.cidade, 'IGACI');
});

test('a planilha de PEDIDOS não é confundida com o cadastro', () => {
  const pedidos = zipSync({
    'xl/worksheets/sheet1.xml': strToU8(
      '<x:worksheet xmlns:x="m"><x:sheetData><x:row r="1">' +
        '<x:c t="str" r="A1"><x:v>CodigoPedido</x:v></x:c><x:c t="str" r="B1"><x:v>Papel</x:v></x:c>' +
        '</x:row></x:sheetData></x:worksheet>',
    ),
  });
  const r = lerCadastro(pedidos);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.naoEhCadastro);
});

test('importar cadastro: guarda as revendedoras SEM criar cliente; de quem já é cliente só completa o que falta', async () => {
  const repo = new RepositorioMemoria();
  const existente: Cliente = {
    nome: 'JOANA B SILVA',
    documentoMascarado: 'cód. 70000002',
    telefone: null,
    email: null,
    enderecoFiscal: { logradouro: 'RUA ANTIGA', numero: '1', bairro: 'CENTRO', municipio: 'QUEBRANGULO', uf: 'AL', cep: '' },
    coordenada: { lat: -9.3, lng: -36.4 },
    statusMapeamento: 'mapeado',
    trilhaAtivaId: null,
    mapeadoPor: 'mot1',
    mapeadoEm: '2026-10-01T00:00:00Z',
    fotoReferenciaPath: null,
    observacoes: 'portão azul',
  };
  await repo.salvarCliente('70000002', existente);

  const arquivo = cadastroXlsx([[revendedora(), revendedora({ CodigoRevendedor: '70.000.001', Nome: 'NOVA' })]]);
  const r = await importarCadastro('ConsultaRevendedores.xlsx', arquivo, repo);
  assert.ok(r);
  assert.equal(r.revendedoras, 2);
  assert.equal(r.clientesAtualizados, 1);
  // 40 mil revendedoras como clientes = 40 mil leituras a cada aba aberta.
  assert.equal((await repo.listarClientes()).length, 1, 'cadastro não vira cliente');

  const atualizado = await repo.obterCliente('70000002');
  // O cadastro é de 2025; o cliente veio dos pedidos de 2026. Só o que FALTAVA
  // (o telefone) entra — o nome fica o dos pedidos.
  assert.equal(atualizado?.nome, 'JOANA B SILVA');
  assert.equal(atualizado?.telefone, '+5582999991234');
  // Endereço, pin de campo e o que o motorista escreveu ficam.
  assert.equal(atualizado?.enderecoFiscal.logradouro, 'RUA ANTIGA');
  assert.deepEqual(atualizado?.coordenada, { lat: -9.3, lng: -36.4 });
  assert.equal(atualizado?.observacoes, 'portão azul');

  // A nova fica no cadastro guardado, achável pelo nome + cidade da folha.
  const [nova] = await repo.revendedorasPorChaves(['NOVA|QUEBRANGULO']);
  assert.equal(nova?.id, '70000001');
  assert.equal(nova?.telefone, '+5582999991234');
  assert.equal(nova?.endereco.logradouro, 'PREFEITO JOSÉ INÁCIO');
  assert.equal(nova?.referencia, 'SUBIDA DO MERCADINHO');
  assert.equal(nova?.situacao, 'Ativo');

  // Reimportar o mesmo cadastro não mexe em cliente nenhum.
  const deNovo = await importarCadastro('ConsultaRevendedores.xlsx', arquivo, repo);
  assert.equal(deNovo?.clientesAtualizados, 0);
});

test('o .xlsx que não é cadastro volta null — vai para o leitor de pedidos', async () => {
  const pedidos = zipSync({
    'xl/worksheets/sheet1.xml': strToU8(
      '<x:worksheet xmlns:x="m"><x:sheetData><x:row r="1"><x:c t="str" r="A1"><x:v>CodigoPedido</x:v></x:c></x:row></x:sheetData></x:worksheet>',
    ),
  });
  assert.equal(await importarCadastro('ConsultaPedidos.xlsx', pedidos, new RepositorioMemoria()), null);
});
