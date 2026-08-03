import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localizarEnderecos } from './geocodificacao-lote.js';
import { RepositorioMemoria } from '../db/repositorio.js';
import type { Geocodificador } from '../geocodificacao/google.js';
import type { Cliente, Pedido } from '@rota/shared';

function clienteEm(municipio: string): Cliente {
  return {
    nome: 'REVENDEDORA',
    documentoMascarado: 'cód. 1',
    telefone: null,
    email: null,
    enderecoFiscal: {
      logradouro: 'POVOADO SEM MAPA',
      numero: 'S/N',
      bairro: 'ZONA RURAL',
      municipio,
      uf: 'AL',
      cep: '57270000',
    },
    coordenada: null,
    statusMapeamento: 'nao_mapeado',
    trilhaAtivaId: null,
    mapeadoPor: null,
    mapeadoEm: null,
    fotoReferenciaPath: null,
    observacoes: '',
  };
}

function pedidoDe(clienteId: string, status: Pedido['status'] = 'pendente_de_mapeamento'): Pedido {
  return {
    numeroNota: 1,
    serie: 1,
    numeroPedido: '1',
    lote: null,
    clienteId,
    emitidoEm: '2026-08-03T00:00:00-03:00',
    itens: [],
    valorTotal: 10,
    volumes: 1,
    pesoBrutoKg: 1,
    status,
    rotaId: null,
    xmlStoragePath: null,
  };
}

/** Geocodificador falso: localiza quem está em ACHAVEL, falha no resto. */
function geoQueFalhaEm(municipiosSemResultado: string[]): Geocodificador {
  return {
    async geocodificar(endereco) {
      if (municipiosSemResultado.includes(endereco.municipio)) return null;
      return {
        coordenada: { lat: -9.9, lng: -36.5 },
        precisa: true,
        municipioConfere: true,
      } as Awaited<ReturnType<Geocodificador['geocodificar']>>;
    },
  };
}

async function repoCom(clientes: Array<[string, Cliente]>, pedidos: Array<[string, Pedido]>) {
  const repo = new RepositorioMemoria();
  for (const [id, c] of clientes) await repo.salvarCliente(id, c);
  for (const [id, p] of pedidos) await repo.salvarPedido(id, p);
  return repo;
}

test('endereço que a Google NÃO acha não pode ser reprocessado para sempre', async () => {
  // O bug: `slice(0, limite)` pegava sempre os PRIMEIROS da fila. Quem falha
  // continua sem coordenada, volta ao começo, é cobrado de novo — e o laço do
  // painel nunca terminava. `pular` acumula as falhas e salta.
  const repo = await repoCom(
    [
      ['c1', clienteEm('LUGAR NENHUM')],
      ['c2', clienteEm('LUGAR NENHUM')],
      ['c3', clienteEm('ACHAVEL')],
    ],
    [
      ['p1', pedidoDe('c1')],
      ['p2', pedidoDe('c2')],
      ['p3', pedidoDe('c3')],
    ],
  );
  const geo = geoQueFalhaEm(['LUGAR NENHUM']);

  const l1 = await localizarEnderecos(repo, geo, { limite: 2, pular: 0 });
  assert.equal(l1.processados, 2);
  assert.equal(l1.semResultado, 2); // c1 e c2 falharam
  assert.equal(l1.restantes, 1); // sobrou c3

  // O painel salta as falhas: sem isto, este lote pegaria c1 e c2 DE NOVO.
  const l2 = await localizarEnderecos(repo, geo, { limite: 2, pular: l1.semResultado });
  assert.equal(l2.processados, 1);
  assert.equal(l2.geocodificados, 1); // chegou no c3
  assert.equal(l2.restantes, 0);
  assert.ok((await repo.obterCliente('c3'))!.coordenada);
});

test('localizar tira o pedido de "pendente de mapeamento" na mesma leva', async () => {
  const repo = await repoCom([['c1', clienteEm('ACHAVEL')]], [['p1', pedidoDe('c1')]]);
  const r = await localizarEnderecos(repo, geoQueFalhaEm([]), { limite: 10 });

  assert.equal(r.geocodificados, 1);
  assert.equal((await repo.obterPedido('p1'))!.status, 'pronto_para_rota');
});

test('quem só faz RETIRADA não é localizado — seria pagar por quem vem buscar', async () => {
  const repo = await repoCom(
    [
      ['c1', clienteEm('ACHAVEL')],
      ['c2', clienteEm('ACHAVEL')],
    ],
    [
      ['p1', pedidoDe('c1', 'retirada')],
      ['p2', pedidoDe('c2')],
    ],
  );
  const r = await localizarEnderecos(repo, geoQueFalhaEm([]), { limite: 10 });

  assert.equal(r.processados, 1); // só o c2
  assert.equal((await repo.obterCliente('c1'))!.coordenada, null);
  assert.ok((await repo.obterCliente('c2'))!.coordenada);
});

test('ponto APROXIMADO no município certo serve — é o caso rural', async () => {
  const repo = await repoCom([['c1', clienteEm('JUNQUEIRO')]], [['p1', pedidoDe('c1')]]);
  const geo: Geocodificador = {
    async geocodificar() {
      return {
        coordenada: { lat: -9.92, lng: -36.47 },
        precisa: false,
        municipioConfere: true,
      } as Awaited<ReturnType<Geocodificador['geocodificar']>>;
    },
  };
  const r = await localizarEnderecos(repo, geo, { limite: 10 });

  assert.equal(r.aproximados, 1);
  assert.equal((await repo.obterCliente('c1'))!.statusMapeamento, 'aproximado');
  assert.equal((await repo.obterPedido('p1'))!.status, 'pronto_para_rota');
});

test('ponto FORA do município é descartado — errado com cara de certo é pior que nada', async () => {
  const repo = await repoCom([['c1', clienteEm('JUNQUEIRO')]], [['p1', pedidoDe('c1')]]);
  const geo: Geocodificador = {
    async geocodificar() {
      return {
        coordenada: { lat: -9.66, lng: -35.73 },
        precisa: false,
        municipioConfere: false,
      } as Awaited<ReturnType<Geocodificador['geocodificar']>>;
    },
  };
  const r = await localizarEnderecos(repo, geo, { limite: 10 });

  assert.equal(r.semResultado, 1);
  assert.equal((await repo.obterCliente('c1'))!.coordenada, null);
});

test('sem geocodificador (dev/CI) não faz nada e não quebra', async () => {
  const repo = await repoCom([['c1', clienteEm('ACHAVEL')]], [['p1', pedidoDe('c1')]]);
  const r = await localizarEnderecos(repo, null);
  assert.equal(r.processados, 0);
  assert.equal(r.restantes, 0);
});
