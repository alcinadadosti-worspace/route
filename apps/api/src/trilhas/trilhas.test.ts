import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Cliente, PontoTrilha, TrilhaBruta } from '@rota/shared';
import { criarClienteOsrm, type ClienteOsrm, type ResultadoMatch } from '../rotas/osrm.js';
import { simplificarTrilha } from './simplificar.js';
import { processarTrilhasBrutas } from './processar.js';
import { RepositorioMemoria } from '../db/repositorio.js';

function ponto(lat: number, lng: number, precisaoM = 10, t = 0): PontoTrilha {
  return { lat, lng, precisaoM, t };
}

test('simplificação colapsa pontos colineares nos extremos', () => {
  const reta = [
    ponto(-9.95, -36.49),
    ponto(-9.9495, -36.49),
    ponto(-9.949, -36.49),
    ponto(-9.9485, -36.49),
  ];
  assert.deepEqual(simplificarTrilha(reta, 10), [reta[0], reta[3]]);
});

test('simplificação preserva curva acima da tolerância', () => {
  // Ponto do meio desvia ~33 m da reta entre os extremos — bem acima dos 10 m.
  const curva = [ponto(-9.95, -36.49), ponto(-9.9495, -36.4903), ponto(-9.949, -36.49)];
  assert.deepEqual(simplificarTrilha(curva, 10), curva);
});

test('match monta a URL com raios da precisão e mapeia tracepoints', async () => {
  const urls: string[] = [];
  const fetchFalso = (async (url: string) => {
    urls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        code: 'Ok',
        tracepoints: [{ location: [-36.4901, -9.9501] }, null],
      }),
    };
  }) as unknown as typeof fetch;

  const osrm = criarClienteOsrm('http://osrm.local', fetchFalso)!;
  const resultado = await osrm.match([
    { lat: -9.95, lng: -36.49, precisaoM: 8 },
    { lat: -9.9495, lng: -36.4903, precisaoM: 18.2 },
  ]);

  assert.match(urls[0]!, /\/match\/v1\/driving\//);
  assert.match(urls[0]!, /radiuses=10;19/); // mínimo 10 m; 18,2 arredonda para cima
  assert.deepEqual(resultado.pontos, [{ lat: -9.9501, lng: -36.4901 }, null]);
});

test('match trata NoMatch como rastro inteiro fora da malha, não como erro', async () => {
  const fetchFalso = (async () => ({
    ok: false,
    status: 400,
    json: async () => ({ code: 'NoMatch' }),
  })) as unknown as typeof fetch;

  const osrm = criarClienteOsrm('http://osrm.local', fetchFalso)!;
  const resultado = await osrm.match([
    { lat: -9.95, lng: -36.49 },
    { lat: -9.9495, lng: -36.4903 },
  ]);
  assert.deepEqual(resultado.pontos, [null, null]);
});

test('match divide rastros longos em lotes de 100 com 1 ponto de sobreposição', async () => {
  const chamadas: number[] = [];
  const fetchFalso = (async (url: string) => {
    const coordenadas = String(url).match(/driving\/([^?]+)/)![1]!.split(';');
    chamadas.push(coordenadas.length);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        code: 'Ok',
        tracepoints: coordenadas.map(() => ({ location: [-36.49, -9.95] })),
      }),
    };
  }) as unknown as typeof fetch;

  const osrm = criarClienteOsrm('http://osrm.local', fetchFalso)!;
  const pontos = Array.from({ length: 150 }, (_, i) => ({
    lat: -9.95 + i * 0.0005,
    lng: -36.49,
  }));
  const resultado = await osrm.match(pontos);

  assert.deepEqual(chamadas, [100, 51]); // segundo lote começa no ponto 99
  assert.equal(resultado.pontos.length, 150);
  assert.ok(resultado.pontos.every((p) => p !== null));
});

test('match com menos de 2 pontos não chama o OSRM', async () => {
  const fetchFalso = (async () => {
    throw new Error('não deveria chamar');
  }) as unknown as typeof fetch;
  const osrm = criarClienteOsrm('http://osrm.local', fetchFalso)!;
  assert.deepEqual(await osrm.match([{ lat: -9.95, lng: -36.49 }]), { pontos: [null] });
});

// --- pós-processamento completo (seção 11.2) ---

function clienteTeste(): Cliente {
  return {
    nome: 'MARIA JOSE DA SILVA',
    documentoMascarado: '***.***.***-00',
    telefone: null,
    email: null,
    enderecoFiscal: {
      logradouro: 'Povoado Brejo dos Bois',
      numero: '83',
      bairro: 'Zona Rural',
      municipio: 'Junqueiro',
      uf: 'AL',
      cep: '57270-000',
    },
    coordenada: { lat: -9.9475, lng: -36.4897 },
    statusMapeamento: 'mapeado',
    trilhaAtivaId: null,
    mapeadoPor: 'uid-motorista',
    mapeadoEm: '2026-07-22T10:00:00-03:00',
    fotoReferenciaPath: null,
    observacoes: '',
  };
}

/**
 * Rastro em zigue-zague (desvios ~33 m — a simplificação preserva todos):
 * os 3 primeiros pontos estão na malha, os 3 últimos são a entrada rural.
 */
const RASTRO: PontoTrilha[] = [
  ponto(-9.95, -36.49, 12, 1000),
  ponto(-9.9495, -36.4897, 14, 2000),
  ponto(-9.949, -36.49, 10, 3000),
  ponto(-9.9485, -36.4897, 20, 4000),
  ponto(-9.948, -36.49, 22, 5000),
  ponto(-9.9475, -36.4897, 18, 6000),
];

function brutaTeste(sobrescrever: Partial<TrilhaBruta> = {}): TrilhaBruta {
  return {
    clienteId: 'c1',
    rotaId: 'r1',
    pontos: RASTRO,
    gravadaPor: 'uid-motorista',
    iniciadaEm: '2026-07-22T10:00:00-03:00',
    finalizadaEm: '2026-07-22T10:20:00-03:00',
    status: 'pendente',
    processadaEm: null,
    motivoDescarte: null,
    trilhaGerada: null,
    ...sobrescrever,
  };
}

/** OSRM falso: casa os `casados` primeiros pontos (na posição exata) e nega o resto. */
function osrmQueCasa(casados: number): ClienteOsrm {
  return {
    trip: () => Promise.reject(new Error('não usado')),
    route: () => Promise.reject(new Error('não usado')),
    async match(pontos): Promise<ResultadoMatch> {
      return {
        pontos: pontos.map((p, i) => (i < casados ? { lat: p.lat, lng: p.lng } : null)),
      };
    },
  };
}

test('processamento extrai o trecho órfão do fim como trilha aprendida', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('c1', clienteTeste());
  await repo.salvarTrilhaBruta('b1', brutaTeste());

  const relatorio = await processarTrilhasBrutas(repo, osrmQueCasa(3));

  assert.equal(relatorio.criadas, 1);
  const trilhas = await repo.listarTrilhas();
  assert.equal(trilhas.length, 1);
  const trilha = trilhas[0]!;

  // Entrada = último ponto casado; o caminho segue por todos os órfãos.
  assert.deepEqual(trilha.pontoEntrada, { lat: -9.949, lng: -36.49 });
  assert.equal(trilha.ativa, true);
  assert.equal(trilha.versao, 1);
  assert.equal(trilha.gravadaPor, 'uid-motorista');
  assert.ok(trilha.distanciaM > 150 && trilha.distanciaM < 250);
  assert.equal(trilha.precisaoMediaM, 20); // média de 20, 22, 18

  const cliente = await repo.obterCliente('c1');
  assert.equal(cliente?.trilhaAtivaId, trilha.id);
  assert.equal((await repo.listarTrilhasBrutasPendentes()).length, 0);
});

test('reaprendizado: nova gravação desativa a trilha anterior e incrementa a versão', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('c1', clienteTeste());
  await repo.salvarTrilhaBruta('b1', brutaTeste());
  await processarTrilhasBrutas(repo, osrmQueCasa(3));

  await repo.salvarTrilhaBruta('b2', brutaTeste({ finalizadaEm: '2026-07-23T09:00:00-03:00' }));
  const relatorio = await processarTrilhasBrutas(repo, osrmQueCasa(2));

  assert.equal(relatorio.criadas, 1);
  const trilhas = await repo.listarTrilhas();
  assert.equal(trilhas.length, 2);
  const ativa = trilhas.find((t) => t.ativa)!;
  const antiga = trilhas.find((t) => !t.ativa)!;
  assert.equal(ativa.versao, 2);
  assert.equal(antiga.versao, 1);
  assert.equal((await repo.obterCliente('c1'))?.trilhaAtivaId, ativa.id);
});

test('rastro todo na malha conhecida é descartado — nada a aprender', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('c1', clienteTeste());
  await repo.salvarTrilhaBruta('b1', brutaTeste());

  const relatorio = await processarTrilhasBrutas(repo, osrmQueCasa(RASTRO.length));

  assert.equal(relatorio.descartadas, 1);
  assert.match(relatorio.itens[0]?.motivo ?? '', /malha conhecida/);
  assert.equal((await repo.listarTrilhas()).length, 0);
  assert.equal((await repo.listarTrilhasBrutasPendentes()).length, 0);
});

test('gravação sem deslocamento é descartada sem chamar o OSRM', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('c1', clienteTeste());
  await repo.salvarTrilhaBruta('b1', brutaTeste({ pontos: [RASTRO[0]!] }));

  const osrm: ClienteOsrm = {
    trip: () => Promise.reject(new Error('não usado')),
    route: () => Promise.reject(new Error('não usado')),
    match: () => Promise.reject(new Error('não deveria chamar')),
  };
  const relatorio = await processarTrilhasBrutas(repo, osrm);

  assert.equal(relatorio.descartadas, 1);
  assert.match(relatorio.itens[0]?.motivo ?? '', /deslocamento/);
});

test('erro no OSRM deixa a bruta pendente para a próxima tentativa', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvarCliente('c1', clienteTeste());
  await repo.salvarTrilhaBruta('b1', brutaTeste());

  const osrm: ClienteOsrm = {
    trip: () => Promise.reject(new Error('não usado')),
    route: () => Promise.reject(new Error('não usado')),
    match: () => Promise.reject(new Error('OSRM dormindo (cold start)')),
  };
  const relatorio = await processarTrilhasBrutas(repo, osrm);

  assert.equal(relatorio.erros, 1);
  assert.match(relatorio.itens[0]?.motivo ?? '', /cold start/);
  assert.equal((await repo.listarTrilhasBrutasPendentes()).length, 1);
});
