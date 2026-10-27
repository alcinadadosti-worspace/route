import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EnderecoFiscal } from '@rota/shared';
import { codigoNoNome, criarCasador, idSemCadastro, nomeSemCodigo } from './casamento.js';

function end(logradouro: string, numero: string, municipio = 'QUEBRANGULO'): EnderecoFiscal {
  return { logradouro, numero, bairro: 'CENTRO', municipio, uf: 'AL', cep: '57750000' };
}

const CADASTRO = [
  { id: '70000001', nome: 'JOANA BATISTA DA SILVA', enderecoFiscal: end('PREFEITO JOSÉ INÁCIO', '43 CASA') },
  { id: '98765', nome: 'ANTONIA PEREIRA DA SILVA', enderecoFiscal: end('R JOAO EXEMPLO', '0020') },
  // Homônimas na mesma cidade (15 casos no cadastro real), em ruas diferentes.
  { id: '111', nome: 'MARIA JOSE DOS SANTOS', enderecoFiscal: end('RUA A', '10') },
  { id: '222', nome: 'MARIA JOSÉ DOS SANTOS', enderecoFiscal: end('RUA B', '20') },
  // Mesmo nome em OUTRA cidade não é homônima.
  { id: '333', nome: 'JOANA BATISTA DA SILVA', enderecoFiscal: end('RUA X', '1', 'PALMEIRA DOS ÍNDIOS') },
];

test('casa por nome + cidade, ignorando acento e caixa', () => {
  const casar = criarCasador(CADASTRO);
  const c = casar({ nome: 'Joana Batista da Silva', cidade: 'QUEBRANGULO', logradouro: 'PREFEITO JOSE INACIO', numero: '43' });
  assert.deepEqual(c, { id: '70000001', nome: 'JOANA BATISTA DA SILVA', noCadastro: true, codigo: '70000001' });
});

test('o código colado no nome pela plataforma ("… 98.765") casa direto', () => {
  assert.equal(codigoNoNome('ANTONIA PEREIRA DA SILVA 98.765'), '98765');
  assert.equal(codigoNoNome('ANTONIA PEREIRA DA SILVA'), null);
  assert.equal(nomeSemCodigo('ANTONIA PEREIRA DA SILVA 98.765'), 'ANTONIA PEREIRA DA SILVA');
  const casar = criarCasador(CADASTRO);
  const c = casar({ nome: 'ANTONIA PEREIRA DA SILVA 98.765', cidade: 'QUEBRANGULO', logradouro: '', numero: '' });
  assert.equal(c.id, '98765');
  assert.equal(c.noCadastro, true);
});

test('código no nome que pertence a OUTRA pessoa não vale — volta para nome + cidade', () => {
  const casar = criarCasador(CADASTRO);
  const c = casar({ nome: 'JOANA BATISTA DA SILVA 98.765', cidade: 'QUEBRANGULO', logradouro: '', numero: '' });
  assert.equal(c.id, '70000001');
});

test('homônimas: a rua e o número da casa desempatam', () => {
  const casar = criarCasador(CADASTRO);
  const c = casar({ nome: 'MARIA JOSE DOS SANTOS', cidade: 'QUEBRANGULO', logradouro: 'RUA B', numero: '20 CASA' });
  assert.equal(c.id, '222');
});

test('homônimas sem desempate: cliente novo, nunca uma delas no chute — e sempre o mesmo', () => {
  const casar = criarCasador(CADASTRO);
  const d = { nome: 'MARIA JOSE DOS SANTOS', cidade: 'QUEBRANGULO', logradouro: 'RUA C', numero: '5' };
  const c = casar(d);
  assert.equal(c.noCadastro, false);
  assert.ok(!c.noCadastro && c.motivo === 'nome-repetido');
  assert.match(c.id, /^[0-9a-f]{64}$/);
  assert.notEqual(c.id, '111');
  assert.notEqual(c.id, '222');
  assert.equal(casar(d).id, c.id, 'o próximo romaneio cai no mesmo cliente');
});

test('fora do cadastro: id de 64 hex, estável na mesma porta; homônimas em portas diferentes NÃO se fundem', () => {
  const casar = criarCasador(CADASTRO);
  const a = casar({ nome: 'Maria Exemplo', cidade: 'QUEBRANGULO', logradouro: 'AV 15', numero: '1042' });
  const mesma = casar({ nome: 'MARIA EXEMPLO', cidade: 'Quebrangulo', logradouro: 'Av 15', numero: '1042 CASA' });
  const outraPorta = casar({ nome: 'MARIA EXEMPLO', cidade: 'Quebrangulo', logradouro: 'SITIO LAGOA', numero: 'S/N' });
  const outraCidade = casar({ nome: 'Maria Exemplo', cidade: 'IGACI', logradouro: 'AV 15', numero: '1042' });
  assert.ok(!a.noCadastro && a.motivo === 'sem-cadastro');
  assert.match(a.id, /^[0-9a-f]{64}$/);
  assert.equal(mesma.id, a.id, 'o próximo romaneio dela cai no mesmo cliente');
  // Só nome + cidade fundia duas pessoas: as duas paradas no mesmo ponto.
  assert.notEqual(outraPorta.id, a.id);
  assert.notEqual(outraCidade.id, a.id);
});

test('quando ela entra na base, o pedido continua no cliente do romaneio — o pin aprendido não fica órfão', () => {
  const d = { nome: 'JOANA NOVA', cidade: 'QUEBRANGULO', logradouro: 'RUA Z', numero: '9' };
  const doRomaneio = idSemCadastro(d);
  const casar = criarCasador([
    { id: doRomaneio, nome: 'JOANA NOVA', enderecoFiscal: end('RUA Z', '9'), ehCliente: true },
    // A base (pedidos do ano) passou a ter a Joana.
    { id: '777', nome: 'JOANA NOVA', enderecoFiscal: end('RUA Z', '9') },
  ]);
  // O cliente é o do romaneio; os dados (telefone, papel) vêm do código 777.
  assert.deepEqual(casar(d), { id: doRomaneio, nome: 'JOANA NOVA', noCadastro: true, codigo: '777' });
  // Se o 777 JÁ é cliente (veio da planilha), é ele.
  const comCliente777 = criarCasador([
    { id: doRomaneio, nome: 'JOANA NOVA', enderecoFiscal: end('RUA Z', '9'), ehCliente: true },
    { id: '777', nome: 'JOANA NOVA', enderecoFiscal: end('RUA Z', '9'), ehCliente: true },
  ]);
  assert.equal(comCliente777(d).id, '777');
});

test('cliente que o Admin ligou a um código ("É ela") recebe os pedidos desse código', () => {
  const ligada = { id: 'f'.repeat(64), nome: 'ANA DO SITIO', enderecoFiscal: end('SITIO X', 'S/N', 'IGACI'), ehCliente: true, codigoErp: '555' };
  const casar = criarCasador([ligada, { id: '555', nome: 'ANA DO SITIO', enderecoFiscal: end('RUA NOVA', '1', 'IGACI') }]);
  const c = casar({ nome: 'ANA DO SITIO', cidade: 'IGACI', logradouro: 'RUA NOVA', numero: '1' });
  assert.deepEqual(c, { id: ligada.id, nome: 'ANA DO SITIO', noCadastro: true, codigo: '555' });
});

test('pedido do SITE com o nome de uma revendedora da cidade não herda o telefone dela — só na mesma porta', () => {
  const casar = criarCasador(CADASTRO);
  const outraPorta = casar({ nome: 'JOANA BATISTA DA SILVA', cidade: 'QUEBRANGULO', logradouro: 'RUA DO SITE', numero: '7', doSite: true });
  assert.equal(outraPorta.noCadastro, false);
  assert.match(outraPorta.id, /^[0-9a-f]{64}$/);
  const mesmaPorta = casar({ nome: 'JOANA BATISTA DA SILVA', cidade: 'QUEBRANGULO', logradouro: 'PREFEITO JOSE INACIO', numero: '43', doSite: true });
  assert.equal(mesmaPorta.id, '70000001', 'a revendedora comprando pelo site, em casa');
});

test('a MESMA porta vem antes do cliente ligado pelo Admin a outra porta', () => {
  const d = { nome: 'ANA DO SITIO', cidade: 'IGACI', logradouro: 'RUA NOVA', numero: '1' };
  const naPorta = { id: idSemCadastro(d), nome: 'ANA DO SITIO', enderecoFiscal: end('RUA NOVA', '1', 'IGACI'), ehCliente: true };
  const ligadoLonge = { id: 'e'.repeat(64), nome: 'ANA DO SITIO', enderecoFiscal: end('SITIO X', 'S/N', 'IGACI'), ehCliente: true, codigoErp: '555' };
  const casar = criarCasador([ligadoLonge, naPorta, { id: '555', nome: 'ANA DO SITIO', enderecoFiscal: end('RUA NOVA', '1', 'IGACI') }]);
  assert.equal(casar(d).id, naPorta.id);
});

test('Consumidor Final da base não herda pelo nome o pedido de uma revendedora de outra porta', () => {
  const casar = criarCasador([
    { id: '9000001', nome: 'LUCIA DO SITE', enderecoFiscal: end('RUA DA LUCIA', '5'), papel: 'Consumidor Final' },
  ]);
  const outraPorta = casar({ nome: 'LUCIA DO SITE', cidade: 'QUEBRANGULO', logradouro: 'RUA DA REVENDEDORA', numero: '9' });
  assert.equal(outraPorta.noCadastro, false);
  const naPorta = casar({ nome: 'LUCIA DO SITE', cidade: 'QUEBRANGULO', logradouro: 'RUA DA LUCIA', numero: '5' });
  assert.equal(naPorta.id, '9000001');
});
