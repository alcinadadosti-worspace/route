import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Cliente, Entrega, ParadaRota, Rota, Trilha } from '@rota/shared';
import { calcularProdutividade } from './produtividade.js';

const MOTORISTA = 'motorista-1';

function parada(
  pedidoId: string,
  avisadoEm: string | null = null,
  carga: { quantidades?: number[]; volumes?: number; pesoBrutoKg?: number } = {},
): ParadaRota {
  return {
    pedidoId,
    clienteId: `cliente-${pedidoId}`,
    nome: 'CLIENTE',
    endereco: 'Rua A, 1',
    telefone: null,
    itens: (carga.quantidades ?? []).map((quantidade, i) => ({
      codigo: `cod-${i}`,
      descricao: `ITEM ${i}`,
      quantidade,
    })),
    volumes: carga.volumes ?? 1,
    pesoBrutoKg: carga.pesoBrutoKg ?? 1,
    coordenada: { lat: -10.28, lng: -36.56 },
    etaMin: 10,
    distanciaKm: 1,
    status: 'em_rota',
    avisadoEm,
  };
}

function rota(id: string, data: string, paradas: ParadaRota[], km = 100): { id: string } & Rota {
  return {
    id,
    data,
    motoristaId: MOTORISTA,
    origemCdId: 'penedo',
    origemNome: 'CD Penedo',
    origemCoordenada: { lat: -10.28, lng: -36.56 },
    retornaAoCd: true,
    paradas,
    polylinePlanejada: '',
    distanciaTotalKm: km,
    duracaoTotalMin: 120,
    status: 'concluida',
    publicadaEm: `${data}T08:00:00-03:00`,
    concluidaEm: `${data}T12:00:00-03:00`,
  };
}

function entrega(
  rotaId: string,
  pedidoId: string,
  resultado: Entrega['resultado'],
  confirmadaEm: string,
): Entrega {
  return {
    pedidoId,
    rotaId,
    clienteId: `cliente-${pedidoId}`,
    resultado,
    confirmadaEm,
    posicaoConfirmacao: null,
    gravadaPor: MOTORISTA,
  };
}

const SEM_NADA = { rotas: [], entregas: [], clientes: [], trilhas: [] };

test('datas inválidas ou invertidas são recusadas antes de qualquer conta', () => {
  for (const janela of [
    { desde: '', ate: '' },
    { desde: '30/07/2026', ate: '30/07/2026' },
    { desde: '2026-07-30', ate: '2026-07-01' },
  ]) {
    const r = calcularProdutividade(janela, SEM_NADA);
    assert.equal(r.ok, false, `${janela.desde}..${janela.ate} deveria ser recusado`);
    if (!r.ok) assert.equal(r.status, 400);
  }
});

test('sem rota na janela, nenhum motorista é listado — e nada é inventado', () => {
  const r = calcularProdutividade(
    { desde: '2026-07-01', ate: '2026-07-10' },
    { ...SEM_NADA, rotas: [rota('r1', '2026-07-29', [parada('p1')])] },
  );
  assert.ok(r.ok);
  assert.deepEqual(r.relatorio.motoristas, []);
});

test('conta volume, resultado por motivo e quilometragem planejada', () => {
  const paradas = [parada('p1'), parada('p2'), parada('p3')];
  const r = calcularProdutividade(
    { desde: '2026-07-29', ate: '2026-07-29' },
    {
      ...SEM_NADA,
      rotas: [rota('r1', '2026-07-29', paradas, 118.6)],
      entregas: [
        entrega('r1', 'p1', 'entregue', '2026-07-29T08:10:00-03:00'),
        entrega('r1', 'p2', 'ausente', '2026-07-29T08:40:00-03:00'),
        entrega('r1', 'p3', 'recusa', '2026-07-29T09:00:00-03:00'),
      ],
    },
  );

  assert.ok(r.ok);
  const m = r.relatorio.motoristas[0]!;
  assert.equal(m.rotas, 1);
  assert.equal(m.paradasPlanejadas, 3);
  assert.equal(m.entregues, 1);
  assert.equal(m.insucessos, 2);
  assert.deepEqual(m.porMotivo, { ausente: 1, recusa: 1 });
  assert.equal(m.kmPlanejados, 118.6);
});

test('tempo por parada usa MEDIANA — a parada do almoço não pode puxar o número', () => {
  // Intervalos: 20, 20, 90 (almoço), 20 min. Média seria 37; mediana, 20.
  const r = calcularProdutividade(
    { desde: '2026-07-29', ate: '2026-07-29' },
    {
      ...SEM_NADA,
      rotas: [rota('r1', '2026-07-29', [parada('p1'), parada('p2'), parada('p3'), parada('p4'), parada('p5')])],
      entregas: [
        entrega('r1', 'p1', 'entregue', '2026-07-29T08:00:00-03:00'),
        entrega('r1', 'p2', 'entregue', '2026-07-29T08:20:00-03:00'),
        entrega('r1', 'p3', 'entregue', '2026-07-29T08:40:00-03:00'),
        entrega('r1', 'p4', 'entregue', '2026-07-29T10:10:00-03:00'),
        entrega('r1', 'p5', 'entregue', '2026-07-29T10:30:00-03:00'),
      ],
    },
  );

  assert.ok(r.ok);
  const m = r.relatorio.motoristas[0]!;
  assert.equal(m.minutosPorParadaMediana, 20);
  assert.equal(m.minutosEmRota, 150); // 08h00 → 10h30
});

test('ausência é separada entre avisados e não avisados — é o laço do aviso', () => {
  const r = calcularProdutividade(
    { desde: '2026-07-29', ate: '2026-07-29' },
    {
      ...SEM_NADA,
      rotas: [
        rota('r1', '2026-07-29', [
          parada('p1', '2026-07-29T07:30:00-03:00'),
          parada('p2', null),
        ]),
      ],
      entregas: [
        entrega('r1', 'p1', 'ausente', '2026-07-29T08:00:00-03:00'),
        entrega('r1', 'p2', 'ausente', '2026-07-29T08:30:00-03:00'),
      ],
    },
  );

  assert.ok(r.ok);
  const m = r.relatorio.motoristas[0]!;
  assert.equal(m.avisados, 1);
  assert.equal(m.ausenciasAvisados, 1);
  assert.equal(m.ausenciasNaoAvisados, 1);
});

test('pin e trilha contam pela data do PRÓPRIO registro, não pela rota', () => {
  const cliente = (id: string, mapeadoEm: string | null): { id: string } & Cliente => ({
    id,
    nome: 'C',
    documentoMascarado: '***',
    telefone: null,
    email: null,
    enderecoFiscal: {
      logradouro: 'R',
      numero: '1',
      bairro: 'B',
      municipio: 'M',
      uf: 'AL',
      cep: '57200000',
    },
    coordenada: { lat: -10.28, lng: -36.56 },
    statusMapeamento: 'mapeado',
    trilhaAtivaId: null,
    mapeadoPor: mapeadoEm ? MOTORISTA : null,
    mapeadoEm,
    fotoReferenciaPath: null,
    observacoes: '',
  });
  const trilha = (gravadaEm: string): Trilha => ({
    clienteId: 'c1',
    polyline: 'abc',
    pontoEntrada: { lat: -10.28, lng: -36.56 },
    distanciaM: 100,
    precisaoMediaM: 8,
    ativa: true,
    gravadaPor: MOTORISTA,
    gravadaEm,
    versao: 1,
  });

  const r = calcularProdutividade(
    { desde: '2026-07-29', ate: '2026-07-29' },
    {
      rotas: [rota('r1', '2026-07-29', [parada('p1')])],
      entregas: [],
      clientes: [
        cliente('c1', '2026-07-29T09:00:00-03:00'), // dentro
        cliente('c2', '2026-07-15T09:00:00-03:00'), // fora
        cliente('c3', null), // nunca mapeado
      ],
      trilhas: [trilha('2026-07-29T09:05:00-03:00'), trilha('2026-07-01T09:05:00-03:00')],
    },
  );

  assert.ok(r.ok);
  const m = r.relatorio.motoristas[0]!;
  assert.equal(m.pinsConfirmados, 1);
  assert.equal(m.trilhasGravadas, 1);
});

test('rota sem nenhuma entrega ainda: aparece com volume, sem ritmo inventado', () => {
  const r = calcularProdutividade(
    { desde: '2026-07-29', ate: '2026-07-29' },
    { ...SEM_NADA, rotas: [rota('r1', '2026-07-29', [parada('p1'), parada('p2')])] },
  );

  assert.ok(r.ok);
  const m = r.relatorio.motoristas[0]!;
  assert.equal(m.paradasPlanejadas, 2);
  assert.equal(m.entregues, 0);
  assert.equal(m.minutosPorParadaMediana, null, 'sem entrega não há mediana a mostrar');
  assert.equal(m.minutosEmRota, null);
});

test('item é a soma das quantidades, não a contagem de linhas da nota', () => {
  // Nas 3507 notas reais a média é 24,1 itens em 8,3 linhas: contar linha em vez
  // de quantidade subestimaria o trabalho em três vezes.
  const r = calcularProdutividade(
    { desde: '2026-07-29', ate: '2026-07-29' },
    {
      ...SEM_NADA,
      rotas: [
        rota('r1', '2026-07-29', [
          parada('p1', null, { quantidades: [12, 6, 6] }),
          parada('p2', null, { quantidades: [2] }),
        ]),
      ],
      entregas: [
        entrega('r1', 'p1', 'entregue', '2026-07-29T08:00:00-03:00'),
        entrega('r1', 'p2', 'entregue', '2026-07-29T08:30:00-03:00'),
      ],
    },
  );

  assert.ok(r.ok);
  const m = r.relatorio.motoristas[0]!;
  assert.equal(m.itensEntregues, 26, 'qCom somado: 12+6+6+2');
  assert.equal(m.produtosDistintos, 4, 'linhas de nota: 3 + 1');
});

test('mercadoria que NÃO foi entregue não entra na conta — voltou no caminhão', () => {
  const r = calcularProdutividade(
    { desde: '2026-07-29', ate: '2026-07-29' },
    {
      ...SEM_NADA,
      rotas: [
        rota('r1', '2026-07-29', [
          parada('p1', null, { quantidades: [10], volumes: 3, pesoBrutoKg: 5.5 }),
          parada('p2', null, { quantidades: [99], volumes: 40, pesoBrutoKg: 900 }),
        ]),
      ],
      entregas: [
        entrega('r1', 'p1', 'entregue', '2026-07-29T08:00:00-03:00'),
        entrega('r1', 'p2', 'recusa', '2026-07-29T08:30:00-03:00'),
      ],
    },
  );

  assert.ok(r.ok);
  const m = r.relatorio.motoristas[0]!;
  assert.equal(m.produtosDistintos, 1);
  assert.equal(m.itensEntregues, 10);
  assert.equal(m.volumesEntregues, 3);
  assert.equal(m.pesoEntregueKg, 5.5, 'os 900 kg recusados não podem contar como entregues');
});

test('nota sem volume nem peso é contada à parte — o peso somado é só o declarado', () => {
  const r = calcularProdutividade(
    { desde: '2026-07-29', ate: '2026-07-29' },
    {
      ...SEM_NADA,
      rotas: [
        rota('r1', '2026-07-29', [
          parada('p1', null, { quantidades: [4], volumes: 2, pesoBrutoKg: 4.5 }),
          // O ERP emissor manda a estrutura zerada: o dado não existe na nota.
          parada('p2', null, { quantidades: [7], volumes: 0, pesoBrutoKg: 0 }),
        ]),
      ],
      entregas: [
        entrega('r1', 'p1', 'entregue', '2026-07-29T08:00:00-03:00'),
        entrega('r1', 'p2', 'entregue', '2026-07-29T08:30:00-03:00'),
      ],
    },
  );

  assert.ok(r.ok);
  const m = r.relatorio.motoristas[0]!;
  assert.equal(m.entregues, 2);
  assert.equal(m.itensEntregues, 11, 'item é contado mesmo sem volume/peso na nota');
  assert.equal(m.volumesEntregues, 2);
  assert.equal(m.pesoEntregueKg, 4.5);
  assert.equal(m.entregasSemCarga, 1, 'sem este número o peso passaria por carga total do dia');
});

test('detalhe por rota: uma linha por rota, mais recente primeiro, somando o total', () => {
  const r = calcularProdutividade(
    { desde: '2026-07-01', ate: '2026-07-31' },
    {
      ...SEM_NADA,
      rotas: [
        rota('r1', '2026-07-20', [parada('p1', null, { quantidades: [5, 5], pesoBrutoKg: 3 })], 80),
        rota('r2', '2026-07-28', [parada('p2', null, { quantidades: [1], pesoBrutoKg: 2 })], 40),
      ],
      entregas: [
        entrega('r1', 'p1', 'entregue', '2026-07-20T08:00:00-03:00'),
        entrega('r2', 'p2', 'entregue', '2026-07-28T08:00:00-03:00'),
      ],
    },
  );

  assert.ok(r.ok);
  const m = r.relatorio.motoristas[0]!;
  assert.deepEqual(
    m.rotas_detalhe.map((d) => d.data),
    ['2026-07-28', '2026-07-20'],
  );
  assert.deepEqual(
    m.rotas_detalhe.map((d) => d.itensEntregues),
    [1, 10],
  );
  assert.deepEqual(
    m.rotas_detalhe.map((d) => d.kmPlanejados),
    [40, 80],
  );
  // O detalhe tem de fechar com o total: se divergir, um dos dois está errado.
  const soma = (f: (d: (typeof m.rotas_detalhe)[number]) => number) =>
    m.rotas_detalhe.reduce((s, d) => s + f(d), 0);
  assert.equal(soma((d) => d.produtosDistintos), m.produtosDistintos);
  assert.equal(soma((d) => d.itensEntregues), m.itensEntregues);
  assert.equal(soma((d) => d.pesoEntregueKg), m.pesoEntregueKg);
  assert.equal(soma((d) => d.entregues), m.entregues);
});

test('rota publicada e não executada aparece no detalhe com zero, não desaparece', () => {
  const r = calcularProdutividade(
    { desde: '2026-07-29', ate: '2026-07-29' },
    { ...SEM_NADA, rotas: [rota('r1', '2026-07-29', [parada('p1'), parada('p2')])] },
  );

  assert.ok(r.ok);
  const detalhe = r.relatorio.motoristas[0]!.rotas_detalhe;
  assert.equal(detalhe.length, 1);
  assert.equal(detalhe[0]!.paradas, 2);
  assert.equal(detalhe[0]!.entregues, 0);
  assert.equal(detalhe[0]!.itensEntregues, 0);
});

test('sincronização offline fora de ordem não vira intervalo negativo', () => {
  const r = calcularProdutividade(
    { desde: '2026-07-29', ate: '2026-07-29' },
    {
      ...SEM_NADA,
      rotas: [rota('r1', '2026-07-29', [parada('p1'), parada('p2')])],
      // Chegam desordenadas de propósito: a função ordena por confirmadaEm.
      entregas: [
        entrega('r1', 'p2', 'entregue', '2026-07-29T09:00:00-03:00'),
        entrega('r1', 'p1', 'entregue', '2026-07-29T08:00:00-03:00'),
      ],
    },
  );

  assert.ok(r.ok);
  assert.equal(r.relatorio.motoristas[0]!.minutosPorParadaMediana, 60);
});
