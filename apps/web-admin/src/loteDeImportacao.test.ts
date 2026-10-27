import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RelatorioImportacao } from '@rota/shared';
import { descricaoDoEnvio, somarEnvios, type Envio } from './loteDeImportacao.js';

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
