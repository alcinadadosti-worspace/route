import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clienteIdDeDocumento, mascararDocumento } from './documento.js';
import { normalizarTelefone, linkWhatsApp } from './telefone.js';
import {
  ehEnderecoRural,
  enderecosDivergem,
  paradaPrecisaMapear,
  precisaMapearEmCampo,
} from './endereco.js';
import { extrairPedidoELote } from './infcpl.js';
import { codificarPolyline, decodificarPolyline } from './polyline.js';
import {
  distanciaAoTracadoEmMetros,
  distanciaEmMetros,
  rumoEmGraus,
  validarGeoPonto,
} from './geo.js';
import { aplicarResultadoParada } from './execucao.js';
import { mesclarParametrosTrilha, PARAMETROS_TRILHA_PADRAO } from './trilha.js';
import type { ParadaRota } from './tipos.js';
import type { EnderecoFiscal } from './tipos.js';

test('clienteId é determinístico e ignora formatação do documento', async () => {
  const a = await clienteIdDeDocumento('100.000.047-82');
  const b = await clienteIdDeDocumento('10000004782');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('pepper: id determinístico mas diferente do SHA-256 puro (não reversível)', async () => {
  const semPepper = await clienteIdDeDocumento('10000004782');
  const comPepper1 = await clienteIdDeDocumento('10000004782', 'segredo');
  const comPepper2 = await clienteIdDeDocumento('100.000.047-82', 'segredo');
  assert.equal(comPepper1, comPepper2); // mesmo CPF+pepper → mesmo id (dedup)
  assert.notEqual(comPepper1, semPepper); // pepper muda o id (não é o hash puro)
  assert.match(comPepper1, /^[0-9a-f]{64}$/);
});

test('máscara de CPF e CNPJ mostra apenas os dois últimos dígitos', () => {
  assert.equal(mascararDocumento('10000004782'), '***.***.***-82');
  assert.equal(mascararDocumento('14750618000155'), '**.***.***/****-55');
});

/** Traçado reto de ~2 km ao longo do meridiano -36,56. */
const TRACADO = [
  { lat: -10.28, lng: -36.56 },
  { lat: -10.27, lng: -36.56 },
  { lat: -10.26, lng: -36.56 },
];

test('em cima do traçado, o desvio é ~zero', () => {
  const d = distanciaAoTracadoEmMetros({ lat: -10.275, lng: -36.56 }, TRACADO);
  assert.ok(d != null && d < 1, `esperava ~0 m, veio ${d}`);
});

test('desvio lateral é medido perpendicular ao segmento, não até os vértices', () => {
  // No MEIO de um segmento, deslocado ~110 m para leste (0,001° de longitude).
  const d = distanciaAoTracadoEmMetros({ lat: -10.275, lng: -36.559 }, TRACADO);
  assert.ok(d != null && d > 95 && d < 125, `esperava ~110 m, veio ${d}`);
});

test('além da ponta do traçado, a distância é até a ponta (não à reta infinita)', () => {
  // 0,01° ao sul do primeiro ponto: ~1,1 km depois do fim do traçado.
  const d = distanciaAoTracadoEmMetros({ lat: -10.29, lng: -36.56 }, TRACADO);
  assert.ok(d != null && d > 1000 && d < 1250, `esperava ~1,1 km, veio ${d}`);
});

test('traçado vazio devolve null — "não sei" não pode virar desvio zero', () => {
  assert.equal(distanciaAoTracadoEmMetros({ lat: -10.28, lng: -36.56 }, []), null);
});

test('validação de coordenada barra null, NaN e faixa impossível', () => {
  assert.deepEqual(validarGeoPonto({ lat: -10.28, lng: -36.56 }), { lat: -10.28, lng: -36.56 });
  assert.equal(validarGeoPonto(null), null);
  assert.equal(validarGeoPonto({ lat: NaN, lng: -36.56 }), null);
  assert.equal(validarGeoPonto({ lat: 91, lng: -36.56 }), null);
  assert.equal(validarGeoPonto({ lat: -10.28, lng: 181 }), null);
});

test('parada: o doc do cliente manda sobre a flag denormalizada da rota', () => {
  // O caso que travava: rota publicada com precisaMapear=true e o motorista
  // acabou de confirmar o pin — a parada não pode continuar pedindo mapeamento.
  assert.equal(paradaPrecisaMapear(true, 'mapeado'), false);
  assert.equal(paradaPrecisaMapear(true, 'geocodificado'), false);
  assert.equal(paradaPrecisaMapear(true, 'aproximado'), true);
  // Cliente que ficou aproximado depois da publicação volta a pedir o pin.
  assert.equal(paradaPrecisaMapear(false, 'aproximado'), true);
});

test('parada: sem o doc do cliente no aparelho, vale a flag da rota (offline)', () => {
  assert.equal(paradaPrecisaMapear(true, null), true);
  assert.equal(paradaPrecisaMapear(false, null), false);
  // Rota antiga, sem o campo denormalizado, e sem doc: não inventa mapeamento.
  assert.equal(paradaPrecisaMapear(undefined, null), false);
});

test('máscara de documento malformado não expõe dígitos', () => {
  assert.equal(mascararDocumento('5'), '***');
  assert.equal(mascararDocumento(''), '***');
  assert.equal(mascararDocumento('123'), '***');
});

test('telefone normaliza para E.164 com +55', () => {
  assert.equal(normalizarTelefone('82999887766'), '+5582999887766');
  assert.equal(normalizarTelefone('8233221100'), '+558233221100');
  assert.equal(normalizarTelefone('5582999887766'), '+5582999887766');
  assert.equal(normalizarTelefone('082999887766'), '+5582999887766');
  assert.equal(normalizarTelefone(''), null);
  assert.equal(normalizarTelefone('3322'), null);
});

test('link de WhatsApp usa apenas dígitos', () => {
  assert.equal(linkWhatsApp('+5582999887766'), 'https://wa.me/5582999887766');
});

function endereco(parcial: Partial<EnderecoFiscal>): EnderecoFiscal {
  return {
    logradouro: 'Rua das Flores',
    numero: '10',
    bairro: 'Centro',
    municipio: 'Maceió',
    uf: 'AL',
    cep: '57000-010',
    ...parcial,
  };
}

test('CEP genérico da cidade (termina em 000) NÃO é sinal de rural por si só', () => {
  // Cidades menores (Penedo/Coruripe) usam o CEP genérico para ruas urbanas;
  // marcar rural pelo CEP deixava rua urbana sem coordenada. Quem decide o
  // ponto agora é o geocodificador (filtro de precisão).
  assert.equal(ehEnderecoRural(endereco({ cep: '57200-000', logradouro: 'Rua Santo Antônio', numero: '222' })), false);
});

test('heurística rural: bairro zona rural (com ou sem acento/caixa)', () => {
  assert.equal(ehEnderecoRural(endereco({ bairro: 'Zona Rural' })), true);
  assert.equal(ehEnderecoRural(endereco({ bairro: 'ZONA   RURAL' })), true);
});

test('heurística rural: prefixos de logradouro', () => {
  assert.equal(ehEnderecoRural(endereco({ logradouro: 'POVOADO BREJO DOS BOIS' })), true);
  assert.equal(ehEnderecoRural(endereco({ logradouro: 'Sítio Boa Vista' })), true);
  assert.equal(ehEnderecoRural(endereco({ logradouro: 'Fazenda Santa Fé' })), true);
  assert.equal(ehEnderecoRural(endereco({ logradouro: 'ROD AL-110 KM 12' })), true);
  assert.equal(ehEnderecoRural(endereco({ logradouro: 'RODOVIA AL-110 KM 12' })), true);
});

test('endereço urbano plausível não é rural', () => {
  assert.equal(ehEnderecoRural(endereco({})), false);
});

test('enderecosDivergem: mesmo endereço com CEP formatado diferente NÃO diverge', () => {
  assert.equal(
    enderecosDivergem(endereco({ cep: '57200-000' }), endereco({ cep: '57200000' })),
    false,
  );
});

test('enderecosDivergem: ignora acento e caixa', () => {
  assert.equal(
    enderecosDivergem(endereco({ municipio: 'MACEIÓ' }), endereco({ municipio: 'maceio' })),
    false,
  );
});

test('enderecosDivergem: logradouro ou número diferente diverge', () => {
  assert.equal(enderecosDivergem(endereco({}), endereco({ logradouro: 'Av Outra' })), true);
  assert.equal(enderecosDivergem(endereco({ numero: '10' }), endereco({ numero: '20' })), true);
  assert.equal(enderecosDivergem(endereco({ bairro: 'Centro' }), endereco({ bairro: 'Farol' })), true);
});

test('enderecosDivergem: CEP ausente num dos lados NÃO força divergência', () => {
  assert.equal(enderecosDivergem(endereco({ cep: '57200-000' }), endereco({ cep: '' })), false);
});

test('enderecosDivergem: CEPs diferentes (ambos presentes) divergem', () => {
  assert.equal(
    enderecosDivergem(endereco({ cep: '57200-000' }), endereco({ cep: '57000-000' })),
    true,
  );
});

test('precisaMapearEmCampo: nao_mapeado e aproximado precisam; geocodificado e mapeado não', () => {
  assert.equal(precisaMapearEmCampo('nao_mapeado'), true);
  assert.equal(precisaMapearEmCampo('aproximado'), true);
  assert.equal(precisaMapearEmCampo('geocodificado'), false);
  assert.equal(precisaMapearEmCampo('mapeado'), false);
});

test('mesclarParametrosTrilha: override válido sobrescreve; inválido/ausente cai no padrão', () => {
  const padrao = PARAMETROS_TRILHA_PADRAO;
  assert.equal(mesclarParametrosTrilha().precisaoMaximaM, padrao.precisaoMaximaM);
  assert.equal(mesclarParametrosTrilha({ precisaoMaximaM: 40 }).precisaoMaximaM, 40);
  // demais campos permanecem no padrão
  assert.equal(mesclarParametrosTrilha({ precisaoMaximaM: 40 }).raioChegadaM, padrao.raioChegadaM);
  // valores inválidos (0, negativo, NaN) são ignorados — cai no padrão
  assert.equal(mesclarParametrosTrilha({ precisaoMaximaM: 0 }).precisaoMaximaM, padrao.precisaoMaximaM);
  assert.equal(mesclarParametrosTrilha({ precisaoMaximaM: NaN }).precisaoMaximaM, padrao.precisaoMaximaM);
});

test('decodifica encoded polyline (exemplo canônico do formato)', () => {
  const pontos = decodificarPolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.deepEqual(pontos, [
    { lat: 38.5, lng: -120.2 },
    { lat: 40.7, lng: -120.95 },
    { lat: 43.252, lng: -126.453 },
  ]);
  assert.deepEqual(decodificarPolyline(''), []);
});

test('codifica encoded polyline (inverso do exemplo canônico)', () => {
  const pontos = [
    { lat: 38.5, lng: -120.2 },
    { lat: 40.7, lng: -120.95 },
    { lat: 43.252, lng: -126.453 },
  ];
  assert.equal(codificarPolyline(pontos), '_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.equal(codificarPolyline([]), '');
});

test('codificar e decodificar polyline são inversos (ida e volta de trilha real)', () => {
  const trilha = [
    { lat: -9.95601, lng: -36.49302 },
    { lat: -9.95644, lng: -36.49188 },
    { lat: -9.9571, lng: -36.49075 },
  ];
  assert.deepEqual(decodificarPolyline(codificarPolyline(trilha)), trilha);
});

test('distância haversine bate com valores conhecidos', () => {
  const origem = { lat: -9.95, lng: -36.49 };
  // 0.001° de latitude ≈ 111,2 m em qualquer longitude.
  const aoNorte = { lat: -9.949, lng: -36.49 };
  assert.ok(Math.abs(distanciaEmMetros(origem, aoNorte) - 111.2) < 1);
  assert.equal(distanciaEmMetros(origem, origem), 0);
});

test('rumo: norte é 0°, leste é 90°', () => {
  const origem = { lat: -9.95, lng: -36.49 };
  assert.ok(Math.abs(rumoEmGraus(origem, { lat: -9.94, lng: -36.49 }) - 0) < 0.5);
  assert.ok(Math.abs(rumoEmGraus(origem, { lat: -9.95, lng: -36.48 }) - 90) < 0.5);
});

function parada(pedidoId: string, status: ParadaRota['status']): ParadaRota {
  return {
    pedidoId,
    clienteId: 'c',
    nome: 'X',
    endereco: 'Rua A, 1',
    telefone: null,
    itens: [],
    volumes: 1,
    pesoBrutoKg: 1,
    coordenada: { lat: 0, lng: 0 },
    etaMin: 10,
    distanciaKm: 5,
    status,
  };
}

test('resultado de parada: primeira resolução deixa a rota em execução', () => {
  const r = aplicarResultadoParada([parada('p1', 'em_rota'), parada('p2', 'em_rota')], 'p1', 'entregue');
  assert.equal(r.statusRota, 'em_execucao');
  assert.equal(r.paradas[0]!.status, 'entregue');
  assert.equal(r.paradas[1]!.status, 'em_rota');
});

test('resultado de parada: todas resolvidas (mesmo com insucesso) concluem a rota', () => {
  const r = aplicarResultadoParada(
    [parada('p1', 'entregue'), parada('p2', 'em_rota')],
    'p2',
    'insucesso',
  );
  assert.equal(r.statusRota, 'concluida');
  assert.equal(r.paradas[1]!.status, 'insucesso');
});

test('extração de pedido e lote tolera variações de formato', () => {
  assert.deepEqual(extrairPedidoELote('PEDIDO: 499450697  LOTE: 47097393'), {
    numeroPedido: '499450697',
    lote: '47097393',
  });
  assert.deepEqual(extrairPedidoELote('*** Pedido # 499450697 *** Lote 47097393 ***'), {
    numeroPedido: '499450697',
    lote: '47097393',
  });
  assert.deepEqual(extrairPedidoELote('texto sem os campos'), {
    numeroPedido: null,
    lote: null,
  });
  assert.deepEqual(extrairPedidoELote(null), { numeroPedido: null, lote: null });
});

test('extração NÃO casa palavra que apenas termina em pedido/lote', () => {
  assert.deepEqual(extrairPedidoELote('Expedido 24/07/2026'), { numeroPedido: null, lote: null });
  assert.deepEqual(extrairPedidoELote('culote 42'), { numeroPedido: null, lote: null });
  // Ainda casa o campo de verdade mesmo colado a outro texto.
  assert.equal(extrairPedidoELote('nota; PEDIDO 999').numeroPedido, '999');
});
