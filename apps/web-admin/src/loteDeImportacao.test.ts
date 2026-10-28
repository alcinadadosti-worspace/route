import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RelatorioImportacao } from '@rota/shared';
import {
  cabecalhoDoLote,
  descricaoDoEnvio,
  mensagemDoDigitado,
  resolvidosFora,
  somarEnvios,
  type Envio,
} from './loteDeImportacao.js';

function relatorio(extra: Partial<RelatorioImportacao> = {}): RelatorioImportacao {
  return {
    total: 11,
    importados: 11,
    duplicados: 0,
    rejeitados: [],
    prontosParaRota: 2,
    pendentesDeMapeamento: 9,
    pendentesDeDecisao: 0,
    geocodificados: 0,
    aproximados: 0,
    alertas: [],
    porCd: { palmeira: 11 },
    semCarga: 0,
    ...extra,
  };
}

const envio = (r: RelatorioImportacao, arquivos = ['rota.pdf']): Envio => ({ quando: '2026-10-27T14:00:00Z', arquivos, relatorio: r });

test('dois romaneios da MESMA rota, mandados um de cada vez, somam no lote', () => {
  const a = relatorio({
    romaneios: 1,
    folhas: [{ rota: '1673300', motorista: 'Caique Santos', pacotes: 11 }],
    alertas: [{ clienteId: '', nome: 'Endereços a localizar', mensagem: '9 sem ponto' }],
    clientesACompletar: [{ id: 'x', nome: 'MARIA', endereco: 'RUA A', telefone: null, observacoes: '' }],
  });
  const b = relatorio({
    total: 5,
    importados: 5,
    romaneios: 1,
    folhas: [{ rota: '1673301', motorista: 'Caique Santos', pacotes: 5 }],
    alertas: [{ clienteId: '', nome: 'Endereços a localizar', mensagem: '14 sem ponto' }],
    porCd: { palmeira: 5 },
  });
  const soma = somarEnvios([envio(a), envio(b)])!;
  assert.equal(soma.importados, 16);
  assert.equal(soma.romaneios, 2);
  assert.deepEqual(soma.porCd, { palmeira: 16 });
  assert.equal(soma.folhas?.length, 2);
  // O aviso da fila sai: o botão Localizar já mostra o total — não "9" e "14" ao lado dele.
  assert.deepEqual(soma.alertas, []);
  // A cliente do primeiro envio continua esperando dados.
  assert.deepEqual(soma.clientesACompletar?.map((c) => c.id), ['x']);
});

test('a MESMA folha mandada duas vezes conta um romaneio; vale a versão mais nova', () => {
  const folha = (pacotes: number) => relatorio({ romaneios: 1, folhas: [{ rota: '1673300', motorista: 'Caique Santos', pacotes }] });
  const soma = somarEnvios([envio(folha(11)), envio(relatorio({ romaneios: 1, folhas: [{ rota: '1673301', motorista: 'Caique Santos', pacotes: 2 }] })), envio(folha(12))])!;
  assert.equal(soma.romaneios, 2);
  assert.deepEqual(soma.folhas?.map((f) => [f.rota, f.pacotes]), [['1673300', 12], ['1673301', 2]]);
});

test('completado fora da tela sai da lista; o completado aqui e quem ainda espera, não', () => {
  const c = (id: string) => ({ id, nome: id, endereco: 'RUA A', telefone: null, observacoes: '' });
  assert.deepEqual(resolvidosFora([c('a'), c('b'), c('c')], ['a'], { c: 'salvo' }), ['b']);
});

test('lote vazio não tem relatório; o "Fora da base" é refeito pela tela', () => {
  assert.equal(somarEnvios([]), null);
  const r = somarEnvios([envio(relatorio({ alertas: [{ clienteId: '', nome: 'Fora da base de revendedoras', mensagem: '1' }] }))])!;
  assert.equal(r.alertas.length, 0);
});

test('a lista do lote: rota, motorista e pacotes de cada folha; planilha pelo nome do arquivo', () => {
  assert.deepEqual(descricaoDoEnvio(envio(relatorio({ folhas: [{ rota: '1673300', motorista: 'Caique Santos', pacotes: 11 }] }))), [
    'Rota 1673300 · Caique Santos · 11 pacote(s)',
  ]);
  assert.deepEqual(descricaoDoEnvio(envio(relatorio(), ['ConsultaPedidos.xlsx'])), ['ConsultaPedidos.xlsx']);
});

test('cabeçalho do lote: folhas e pacotes; digitado à parte; planilha conta envios', () => {
  const comFolha = relatorio({ romaneios: 1, folhas: [{ rota: '1673300', motorista: 'Caique Santos', pacotes: 11 }] });
  assert.equal(cabecalhoDoLote(comFolha, 1), 'Romaneios desta rota: 1 · 11 pacote(s) · 11 pedido(s) novo(s)');
  const soma = somarEnvios([envio(comFolha), envio(relatorio({ importados: 1, digitados: 1 }))])!;
  assert.equal(cabecalhoDoLote(soma, 2), 'Romaneios desta rota: 1 · 11 pacote(s) · 1 digitado(s) · 12 pedido(s) novo(s)');
  assert.equal(cabecalhoDoLote(relatorio({ importados: 1, digitados: 1 }), 1), 'Pedidos digitados: 1 · 1 pedido(s) novo(s)');
  assert.equal(cabecalhoDoLote(relatorio(), 1), 'Envios: 1 · 11 pedido(s) novo(s)');
});

test('pedido digitado: a frase diz para onde foi; repetido não entrou', () => {
  const base = { importados: 1, prontosParaRota: 0, pendentesDeMapeamento: 0, pendentesDeDecisao: 0 };
  assert.match(mensagemDoDigitado(relatorio({ ...base, prontosParaRota: 1 }), '537733613').texto, /537733613 entrou — pronto/);
  assert.match(mensagemDoDigitado(relatorio({ ...base, pendentesDeMapeamento: 1, semCadastro: 1 }), '1').texto, /Localizar.*complete o telefone/);
  assert.match(mensagemDoDigitado(relatorio({ ...base, pendentesDeDecisao: 1 }), '1').texto, /Decisões/);
  const repetido = mensagemDoDigitado(relatorio({ importados: 0, duplicados: 1 }), '537733613');
  assert.equal(repetido.entrou, false);
  assert.match(repetido.texto, /já está no sistema/);
  for (const r of [repetido, mensagemDoDigitado(relatorio({ importados: 0 }), '9')]) assert.doesNotMatch(r.texto, /undefined|NaN|\{/);
});

test('o envio digitado aparece na lista pela descrição', () => {
  assert.deepEqual(descricaoDoEnvio({ ...envio(relatorio(), []), descricao: 'Pedido 537733613 digitado · MARIA' }), [
    'Pedido 537733613 digitado · MARIA',
  ]);
});
