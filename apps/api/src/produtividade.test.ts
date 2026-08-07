import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Cliente, Entrega, ParadaRota, Rota, Trilha } from '@rota/shared';
import { calcularProdutividade } from './produtividade.js';

const MOTORISTA = 'motorista-1';

function parada(
  pedidoId: string,
  avisadoEm: string | null = null,
  carga: { quantidades?: number[]; volumes?: number; pesoBrutoKg?: number } = {},
  chegouEm: string | null = null,
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
    chegouEm,
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
  // NaN de sentinela: estas rotas TÊM lista de itens — se um null aparecer
  // aqui, a soma vira NaN e o assert acusa, em vez de um `?? 0` esconder.
  assert.equal(soma((d) => d.produtosDistintos ?? Number.NaN), m.produtosDistintos);
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

test('entrega duplicada não infla número nenhum — a coleção permite duplicata', () => {
  // `entregas` tem ID automático e é imutável pelas regras: dois aparelhos com a
  // mesma rota criam dois registros da mesma parada, e ninguém apaga depois.
  const r = calcularProdutividade(
    { desde: '2026-07-29', ate: '2026-07-29' },
    {
      ...SEM_NADA,
      rotas: [
        rota('r1', '2026-07-29', [
          parada('p1', null, { quantidades: [10], volumes: 2, pesoBrutoKg: 5 }),
          parada('p2', null, { quantidades: [4], volumes: 1, pesoBrutoKg: 3 }),
        ]),
      ],
      entregas: [
        entrega('r1', 'p1', 'entregue', '2026-07-29T08:00:00-03:00'),
        entrega('r1', 'p1', 'entregue', '2026-07-29T08:00:30-03:00'), // duplicata
        entrega('r1', 'p2', 'entregue', '2026-07-29T09:00:00-03:00'),
      ],
    },
  );

  assert.ok(r.ok);
  const m = r.relatorio.motoristas[0]!;
  assert.equal(m.entregues, 2, 'duas paradas entregues, não três');
  assert.equal(m.itensEntregues, 14);
  assert.equal(m.pesoEntregueKg, 8);
  assert.equal(m.volumesEntregues, 3);
  // O intervalo de 30 s da duplicata faria a mediana cair para ~0 e o motorista
  // parecer três vezes mais rápido do que é.
  assert.equal(m.minutosPorParadaMediana, 60);
});

test('insucesso duplicado também não conta duas vezes por motivo', () => {
  const r = calcularProdutividade(
    { desde: '2026-07-29', ate: '2026-07-29' },
    {
      ...SEM_NADA,
      rotas: [rota('r1', '2026-07-29', [parada('p1')])],
      entregas: [
        entrega('r1', 'p1', 'ausente', '2026-07-29T08:00:00-03:00'),
        entrega('r1', 'p1', 'ausente', '2026-07-29T08:00:10-03:00'),
      ],
    },
  );

  assert.ok(r.ok);
  const m = r.relatorio.motoristas[0]!;
  assert.equal(m.insucessos, 1);
  assert.deepEqual(m.porMotivo, { ausente: 1 });
  assert.equal(m.ausenciasNaoAvisados, 1);
});

test('rota sem o campo itens não derruba a aba inteira', () => {
  // Doc antigo ou escrito por script: `itens` ausente. Vale devolver zero, não
  // um 500 que apaga o relatório de todos os motoristas.
  const semItens = parada('p1');
  delete (semItens as { itens?: unknown }).itens;
  const r = calcularProdutividade(
    { desde: '2026-07-29', ate: '2026-07-29' },
    {
      ...SEM_NADA,
      rotas: [rota('r1', '2026-07-29', [semItens])],
      entregas: [entrega('r1', 'p1', 'entregue', '2026-07-29T08:00:00-03:00')],
    },
  );

  assert.ok(r.ok);
  const m = r.relatorio.motoristas[0]!;
  assert.equal(m.entregues, 1);
  assert.equal(m.itensEntregues, 0);
  assert.equal(m.produtosDistintos, 0);
});

test('pedido da planilha (sem lista de itens): produtos distintos vira NULL, nunca zero', () => {
  // A planilha do ERP manda só a quantidade. `produtosDistintos` da parada
  // devolve null de propósito ("não sei") — e um `?? 0` na agregação fazia o
  // relatório do mês dizer "0 produto(s) distinto(s)" com o caminhão cheio,
  // exatamente o que a régua de itens.ts proíbe.
  const daPlanilha = { ...parada('p1'), itens: [], quantidadeMateriais: 7 };
  const r = calcularProdutividade(
    { desde: '2026-07-29', ate: '2026-07-29' },
    {
      ...SEM_NADA,
      rotas: [
        rota('r1', '2026-07-29', [daPlanilha]),
        // Rota da era XML, COM lista: o total do período continua incontável —
        // somar só as rotas que sabem seria um subtotal disfarçado de total.
        rota('r2', '2026-07-29', [parada('p2', null, { quantidades: [3, 2] })]),
      ],
      entregas: [
        entrega('r1', 'p1', 'entregue', '2026-07-29T08:00:00-03:00'),
        entrega('r2', 'p2', 'entregue', '2026-07-29T09:00:00-03:00'),
      ],
    },
  );

  assert.ok(r.ok);
  const m = r.relatorio.motoristas[0]!;
  assert.equal(m.itensEntregues, 12, 'itens continuam contando: 7 da planilha + 5 da lista');
  assert.equal(m.produtosDistintos, null, 'não sei não pode virar nenhum');
  const detalhes = new Map(m.rotas_detalhe.map((d) => [d.rotaId, d.produtosDistintos]));
  assert.equal(detalhes.get('r1'), null, 'a rota da planilha não sabe');
  assert.equal(detalhes.get('r2'), 2, 'a rota com lista continua sabendo');
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

test('atendimento: mediana só das paradas com chegada registrada', () => {
  // p1: chegou 08:00, confirmou 08:10 → 10 min. p2: chegou 08:30, confirmou
  // 08:50 → 20 min. p3 sem chegada: não entra — é viagem+atendimento misturados.
  const r = calcularProdutividade(
    { desde: '2026-07-29', ate: '2026-07-29' },
    {
      ...SEM_NADA,
      rotas: [
        rota('r1', '2026-07-29', [
          parada('p1', null, {}, '2026-07-29T08:00:00-03:00'),
          parada('p2', null, {}, '2026-07-29T08:30:00-03:00'),
          parada('p3'),
        ]),
      ],
      entregas: [
        entrega('r1', 'p1', 'entregue', '2026-07-29T08:10:00-03:00'),
        entrega('r1', 'p2', 'entregue', '2026-07-29T08:50:00-03:00'),
        entrega('r1', 'p3', 'entregue', '2026-07-29T09:30:00-03:00'),
      ],
    },
  );

  assert.ok(r.ok);
  const m = r.relatorio.motoristas[0]!;
  assert.equal(m.minutosAtendimentoMediana, 15, 'mediana de 10 e 20');
  assert.equal(m.chegadasRegistradas, 2, 'p3 não conta — sem chegada gravada');
});

test('chegada depois da confirmação (fila fora de ordem) não vira atendimento', () => {
  const r = calcularProdutividade(
    { desde: '2026-07-29', ate: '2026-07-29' },
    {
      ...SEM_NADA,
      rotas: [rota('r1', '2026-07-29', [parada('p1', null, {}, '2026-07-29T09:00:00-03:00')])],
      entregas: [entrega('r1', 'p1', 'entregue', '2026-07-29T08:00:00-03:00')],
    },
  );

  assert.ok(r.ok);
  const m = r.relatorio.motoristas[0]!;
  assert.equal(m.minutosAtendimentoMediana, null);
  assert.equal(m.chegadasRegistradas, 0);
});

test('atendimento conta também no insucesso — é o tempo até desistir', () => {
  const r = calcularProdutividade(
    { desde: '2026-07-29', ate: '2026-07-29' },
    {
      ...SEM_NADA,
      rotas: [rota('r1', '2026-07-29', [parada('p1', null, {}, '2026-07-29T08:00:00-03:00')])],
      entregas: [entrega('r1', 'p1', 'ausente', '2026-07-29T08:05:00-03:00')],
    },
  );

  assert.ok(r.ok);
  assert.equal(r.relatorio.motoristas[0]!.minutosAtendimentoMediana, 5);
});

test('ausências por cliente: agrega entre rotas, conta avisadas, ordena e corta em 5', () => {
  const clienteDoc = (id: string, nome: string): { id: string } & Cliente => ({
    id,
    nome,
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
    statusMapeamento: 'geocodificado',
    trilhaAtivaId: null,
    mapeadoPor: null,
    mapeadoEm: null,
    fotoReferenciaPath: null,
    observacoes: '',
  });
  const paradaDe = (pedidoId: string, clienteId: string, avisadoEm: string | null = null) => ({
    ...parada(pedidoId, avisadoEm),
    clienteId,
  });
  const entregaDe = (
    rotaId: string,
    pedidoId: string,
    clienteId: string,
    resultado: Entrega['resultado'],
    quando: string,
  ): Entrega => ({ ...entrega(rotaId, pedidoId, resultado, quando), clienteId });

  // ANA falha 3x (1 avisada), BIA 2x, CLARA/DUDA/EVA/FLORA 1x cada → o corte em
  // 5 derruba FLORA (empate em 1 resolvido pelo nome). GIL entregue e HELO
  // recusa NÃO entram: o ranking é de ausência, não de insucesso.
  const r = calcularProdutividade(
    { desde: '2026-07-01', ate: '2026-07-31' },
    {
      ...SEM_NADA,
      clientes: [
        clienteDoc('c-ana', 'ANA'),
        clienteDoc('c-bia', 'BIA'),
        clienteDoc('c-clara', 'CLARA'),
        clienteDoc('c-duda', 'DUDA'),
        clienteDoc('c-eva', 'EVA'),
        clienteDoc('c-flora', 'FLORA'),
      ],
      rotas: [
        rota('r1', '2026-07-20', [
          paradaDe('a1', 'c-ana', '2026-07-20T07:00:00-03:00'),
          paradaDe('a2', 'c-ana'),
          paradaDe('b1', 'c-bia'),
          paradaDe('c1', 'c-clara'),
          paradaDe('d1', 'c-duda'),
        ]),
        rota('r2', '2026-07-21', [
          paradaDe('a3', 'c-ana'),
          paradaDe('b2', 'c-bia'),
          paradaDe('e1', 'c-eva'),
          paradaDe('f1', 'c-flora'),
          paradaDe('g1', 'c-gil'),
          paradaDe('h1', 'c-helo'),
        ]),
      ],
      entregas: [
        entregaDe('r1', 'a1', 'c-ana', 'ausente', '2026-07-20T08:00:00-03:00'),
        entregaDe('r1', 'a2', 'c-ana', 'ausente', '2026-07-20T08:10:00-03:00'),
        entregaDe('r1', 'b1', 'c-bia', 'ausente', '2026-07-20T08:20:00-03:00'),
        entregaDe('r1', 'c1', 'c-clara', 'ausente', '2026-07-20T08:30:00-03:00'),
        entregaDe('r1', 'd1', 'c-duda', 'ausente', '2026-07-20T08:40:00-03:00'),
        entregaDe('r2', 'a3', 'c-ana', 'ausente', '2026-07-21T08:00:00-03:00'),
        entregaDe('r2', 'b2', 'c-bia', 'ausente', '2026-07-21T08:10:00-03:00'),
        entregaDe('r2', 'e1', 'c-eva', 'ausente', '2026-07-21T08:20:00-03:00'),
        entregaDe('r2', 'f1', 'c-flora', 'ausente', '2026-07-21T08:30:00-03:00'),
        entregaDe('r2', 'g1', 'c-gil', 'entregue', '2026-07-21T08:40:00-03:00'),
        entregaDe('r2', 'h1', 'c-helo', 'recusa', '2026-07-21T08:50:00-03:00'),
      ],
    },
  );

  assert.ok(r.ok);
  const ranking = r.relatorio.ausenciasPorCliente;
  assert.deepEqual(
    ranking.map((a) => [a.nome, a.ausencias]),
    [
      ['ANA', 3],
      ['BIA', 2],
      ['CLARA', 1],
      ['DUDA', 1],
      ['EVA', 1],
    ],
    'ordenado por ausências, empate pelo nome, corte em 5',
  );
  assert.equal(ranking[0]!.avisadas, 1, 'uma das ausências de ANA tinha aviso enviado');
  assert.equal(ranking[1]!.avisadas, 0);
});

test('cliente ausente sem cadastro na base usa o começo do id como nome', () => {
  const r = calcularProdutividade(
    { desde: '2026-07-29', ate: '2026-07-29' },
    {
      ...SEM_NADA,
      rotas: [rota('r1', '2026-07-29', [parada('p1')])],
      entregas: [entrega('r1', 'p1', 'ausente', '2026-07-29T08:00:00-03:00')],
    },
  );

  assert.ok(r.ok);
  // O helper gera clienteId `cliente-p1`; sem doc, o nome cai para os 8 primeiros.
  assert.equal(r.relatorio.ausenciasPorCliente[0]!.nome, 'cliente-');
});
