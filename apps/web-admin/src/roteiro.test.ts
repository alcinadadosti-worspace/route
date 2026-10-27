import { test } from 'node:test';
import assert from 'node:assert/strict';
import { telefoneLegivel, type Cliente, type ExcecaoRota, type ParadaRota, type Rota } from '@rota/shared';
import { duracaoLegivel, montarRoteiro } from './roteiro.js';
import { textoParaPdf } from './roteiroPdf.js';

test('texto do PDF: quebra de linha vira espaço, e o que o Latin-1 não tem é trocado ou some', () => {
  assert.equal(textoParaPdf('depois da igreja\nportão azul'), 'depois da igreja portão azul');
  assert.equal(textoParaPdf('Sítio “Boa Vista” — 2 km… 😀'), 'Sítio "Boa Vista" - 2 km... ');
  assert.equal(textoParaPdf('Tel. 1  ·  NF 2'), 'Tel. 1  ·  NF 2');
});

function cliente(municipio: string, observacoes = '', telefone: string | null = '+5582999990000'): Cliente {
  return {
    nome: 'X',
    documentoMascarado: '***',
    telefone,
    email: null,
    enderecoFiscal: { logradouro: '', numero: '', bairro: '', municipio, uf: 'AL', cep: '' },
    coordenada: null,
    statusMapeamento: 'geocodificado',
    trilhaAtivaId: null,
    mapeadoPor: null,
    mapeadoEm: null,
    fotoReferenciaPath: null,
    observacoes,
  };
}

function parada(id: string, distanciaKm: number, etaMin: number, extra: Partial<ParadaRota> = {}): ParadaRota {
  return {
    pedidoId: id,
    clienteId: `c-${id}`,
    nome: `CLIENTE ${id}`,
    endereco: `RUA ${id} — CENTRO, TEOTONIO VILELA/AL`,
    telefone: '+5582999990000',
    numeroNota: 290000,
    numeroPedido: '845123456',
    itens: [],
    volumes: 1,
    pesoBrutoKg: 2.45,
    quantidadeMateriais: 12,
    coordenada: { lat: -9.9, lng: -36.3 },
    etaMin,
    distanciaKm,
    status: 'em_rota',
    ...extra,
  };
}

const EXCECAO: ExcecaoRota = {
  pedidoId: 'r1',
  clienteId: 'c-r1',
  nome: 'SITIO DA ANA',
  endereco: 'SITIO BOA VISTA — ZONA RURAL, TEOTONIO VILELA/AL',
  telefone: null,
  volumes: 1,
  pesoBrutoKg: 0,
  status: 'em_rota',
};

function rota(): Rota {
  return {
    data: '2026-10-16',
    motoristaId: 'm1',
    origemCdId: 'penedo',
    origemNome: 'CD Penedo',
    origemCoordenada: { lat: -10.28, lng: -36.56 },
    retornaAoCd: true,
    paradas: [parada('a', 57.3, 52), parada('b', 5.3, 60, { precisaMapear: true })],
    excecoes: [EXCECAO],
    polylinePlanejada: '',
    distanciaTotalKm: 1284.6,
    duracaoTotalMin: 220,
    status: 'publicada',
    publicadaEm: null,
    concluidaEm: null,
  };
}

const CLIENTES = {
  'c-a': cliente('Teotônio Vilela', 'portão azul depois da igreja'),
  'c-b': cliente('Teotônio Vilela'),
  // Exceção publicada SEM telefone (cliente do romaneio fora da base); o
  // Admin completou depois — o papel baixado de novo tem que trazer.
  'c-r1': cliente('Teotônio Vilela', 'entrar na estrada de barro do posto', '+5582988887777'),
};
const CONTEXTO = { motorista: 'José', clientes: CLIENTES, geradoEm: new Date('2026-10-16T10:12:00Z') };

test('roteiro: título pela cidade, resumo em pt-BR e nome de arquivo sem acento', () => {
  const r = montarRoteiro('2026-10-16_ab12cd34', rota(), CONTEXTO);
  assert.equal(r.titulo, 'Rota de 16/10/2026 — Teotônio Vilela');
  assert.equal(r.subtitulo, 'Saída: CD Penedo · Motorista: José');
  assert.equal(r.resumo, '2 paradas · 1 exceção · 1.284,6 km · ~3h40 de direção · volta ao CD');
  assert.equal(r.arquivo, 'rota-2026-10-16-teotonio-vilela.pdf');
  assert.equal(r.rodape, 'Rota 2026-10-16_ab12cd34 · gerado em 16/10/2026, 07:12');
});

test('roteiro: paradas na ordem, com km ACUMULADO desde o CD e o como-chegar do cliente', () => {
  const r = montarRoteiro('x', rota(), CONTEXTO);
  assert.deepEqual(r.paradas.map((p) => p.marca), ['01', '02']);
  const [a, b] = r.paradas;
  assert.equal(a!.estimativa, '57,3 km do CD · ~52 min de direção');
  // 57,3 + 5,3: a perna sozinha (5,3) enganaria quem lê no papel.
  assert.equal(b!.estimativa, '62,6 km do CD · ~1h00 de direção');
  assert.equal(a!.comoChegar, 'portão azul depois da igreja');
  assert.equal(b!.comoChegar, null);
  assert.equal(a!.telefone, '(82) 99999-0000');
  assert.equal(a!.documento, 'Pedido 845123456 · NF 290000');
  assert.equal(a!.carga, '12 produtos · 1 vol · 2,5 kg');
  assert.equal(a!.aviso, null);
  assert.match(b!.aviso!, /aproximado/);
});

test('roteiro: exceções separadas, marcadas E1…, sem estimativa (não têm lugar na ordem)', () => {
  const r = montarRoteiro('x', rota(), CONTEXTO);
  assert.equal(r.excecoes.length, 1);
  const e = r.excecoes[0]!;
  assert.equal(e.marca, 'E1');
  assert.equal(e.estimativa, null);
  assert.equal(e.comoChegar, 'entrar na estrada de barro do posto');
  assert.equal(e.telefone, '(82) 98888-7777', 'o telefone completado depois de publicar');
  assert.equal(e.carga, '1 vol');
});

test('roteiro baixado de novo depois da baixa mostra o que já tem resultado', () => {
  const base = rota();
  base.paradas[0]!.status = 'entregue';
  base.excecoes![0]!.status = 'insucesso';
  const r = montarRoteiro('x', base, CONTEXTO);
  assert.equal(r.paradas[0]!.resultado, 'Entregue');
  assert.equal(r.paradas[1]!.resultado, null);
  assert.equal(r.excecoes[0]!.resultado, 'Não entregue');
});

test('rota antiga sem exceções e cidade só no texto do endereço', () => {
  const base = rota();
  delete base.excecoes;
  const r = montarRoteiro('x', base, { ...CONTEXTO, clientes: {} });
  assert.equal(r.excecoes.length, 0);
  assert.equal(r.titulo, 'Rota de 16/10/2026 — TEOTONIO VILELA');
  assert.equal(r.resumo.includes('exce'), false);
});

test('telefone e duração legíveis, e nada de placeholder vazando', () => {
  assert.equal(telefoneLegivel('+558233334444'), '(82) 3333-4444');
  assert.equal(telefoneLegivel(null), null);
  assert.equal(telefoneLegivel('123'), '123');
  assert.equal(duracaoLegivel(45), '45 min');
  assert.equal(duracaoLegivel(125), '2h05');
  assert.equal(duracaoLegivel(-3), '0 min');
});
