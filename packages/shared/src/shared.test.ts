import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clienteIdDeDocumento, mascararDocumento } from './documento.js';
import { normalizarTelefone, linkWhatsApp } from './telefone.js';
import {
  ehEnderecoRural,
  enderecosDivergem,
  formatarCarga,
  paradaPrecisaMapear,
  precisaMapearEmCampo,
  temCarga,
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
import {
  formatarJanela,
  janelaDeChegada,
  mensagemDeChegada,
  mensagemDeRecibo,
  mensagemDeRota,
  mesclarParametrosAviso,
  PARAMETROS_AVISO_PADRAO,
} from './aviso.js';
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

// --- Aviso ao cliente (seção 11.8) ---

/** 8h00 em ponto, para as janelas saírem em horários conferíveis na mão. */
const OITO_DA_MANHA = new Date(2026, 6, 29, 8, 0, 0);

test('janela da primeira parada é estreita; a do fim do dia, larga', () => {
  const p = PARAMETROS_AVISO_PADRAO;
  const primeira = janelaDeChegada(20, 0, p);
  const decima = janelaDeChegada(180, 9, p);

  const larguraPrimeira = primeira.ateMin - primeira.deMin;
  const larguraDecima = decima.ateMin - decima.deMin;
  assert.ok(
    larguraDecima > larguraPrimeira * 2,
    `a incerteza tem de crescer: ${larguraPrimeira} → ${larguraDecima}`,
  );
  // O tempo parado nos clientes anteriores empurra a chegada para mais tarde.
  assert.ok(decima.deMin > 180, 'a décima parada não chega no ETA cru de direção');
});

test('janela vira horário redondo e não promete precisão que não existe', () => {
  // 40 min de direção, 3 paradas antes → centro 70 min, margem 38 min.
  const texto = formatarJanela(OITO_DA_MANHA, janelaDeChegada(40, 3, PARAMETROS_AVISO_PADRAO));
  assert.equal(texto, 'entre 8h30 e 9h50');
});

test('janela nunca começa no passado', () => {
  const janela = janelaDeChegada(2, 0, PARAMETROS_AVISO_PADRAO);
  assert.equal(janela.deMin, 0);
});

test('mensagem do dia embute a janela; a de chegada, o tempo restante', () => {
  const rota = mensagemDeRota(OITO_DA_MANHA, 40, 3, PARAMETROS_AVISO_PADRAO);
  assert.match(rota, /entre 8h30 e 9h50/);
  assert.ok(!rota.includes('{janela}'), 'o modelo não pode vazar para o cliente');

  assert.match(mensagemDeChegada(10, PARAMETROS_AVISO_PADRAO), /em uns 10 minutos/);
  assert.match(mensagemDeChegada(1, PARAMETROS_AVISO_PADRAO), /agora/);
  // Sem sinal não há estimativa de estrada: não inventa número.
  assert.match(mensagemDeChegada(null, PARAMETROS_AVISO_PADRAO), /em instantes/);
  // O OSRM devolve minuto FRACIONÁRIO. 1,4 arredonda para 1, e "em uns 1
  // minutos" é português torto indo para o cliente — vira "agora".
  assert.match(mensagemDeChegada(1.4, PARAMETROS_AVISO_PADRAO), /agora/);
  assert.match(mensagemDeChegada(1.6, PARAMETROS_AVISO_PADRAO), /em uns 2 minutos/);
  assert.match(mensagemDeChegada(9.6, PARAMETROS_AVISO_PADRAO), /em uns 10 minutos/);
});

test('config torta não vira mensagem em branco no WhatsApp do cliente', () => {
  const p = mesclarParametrosAviso({
    textoRota: '   ',
    textoChegando: 'Chego {quando}, tudo bem?',
    minutosPorParada: -5,
    margemBaseMin: 45,
  });
  assert.equal(p.textoRota, PARAMETROS_AVISO_PADRAO.textoRota); // vazio é ignorado
  assert.equal(p.textoChegando, 'Chego {quando}, tudo bem?'); // texto válido entra
  assert.equal(p.minutosPorParada, PARAMETROS_AVISO_PADRAO.minutosPorParada); // negativo, não
  assert.equal(p.margemBaseMin, 45);
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

test('carga zerada na nota não vira "0 vol · 0.000 kg" na tela', () => {
  // O caso real: ~1 de cada 3 notas chega com qVol=0 e pesoB=0.000.
  assert.equal(formatarCarga(0, 0), 'vol/peso não informado');
  assert.equal(temCarga(0, 0), false);

  assert.equal(formatarCarga(1, 3.113), '1 vol · 3,113 kg');
  assert.equal(temCarga(1, 3.113), true);
  // Uma parte só informada ainda vale: mostra o que existe, omite o que não.
  assert.equal(formatarCarga(2, 0), '2 vol');
  assert.equal(formatarCarga(0, 4.5), '4,500 kg');
  assert.equal(temCarga(2, 0), true);
  // Dado corrompido não pode virar "NaN vol".
  assert.equal(formatarCarga(NaN, NaN), 'vol/peso não informado');
  assert.equal(formatarCarga(-1, -2), 'vol/peso não informado');
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

test('recibo leva hora e quem recebeu — e não inventa nome quando não há', () => {
  const quinzeHoras = new Date(2026, 6, 30, 14, 5);
  assert.equal(
    mensagemDeRecibo(quinzeHoras, 'Maria', PARAMETROS_AVISO_PADRAO),
    'Entrega registrada às 14h05, recebida por Maria. Grupo Alcina Maria.',
  );
  // Insucesso ou nome não anotado: some o trecho, em vez de "recebida por ".
  for (const vazio of [null, '', '   ']) {
    assert.equal(
      mensagemDeRecibo(quinzeHoras, vazio, PARAMETROS_AVISO_PADRAO),
      'Entrega registrada às 14h05. Grupo Alcina Maria.',
      `${JSON.stringify(vazio)} deveria sumir da frase`,
    );
  }
});

test('redação do recibo é ajustável sem deploy, como as outras', () => {
  const p = mesclarParametrosAviso({ textoRecibo: 'Recebemos: {hora}{quem}. Obrigado!' });
  assert.equal(
    mensagemDeRecibo(new Date(2026, 6, 30, 9, 0), 'Ana', p),
    'Recebemos: 9h00, recebida por Ana. Obrigado!',
  );
  // Vazio continua sendo ignorado — config torta não vira recibo em branco.
  assert.equal(mesclarParametrosAviso({ textoRecibo: '  ' }).textoRecibo, PARAMETROS_AVISO_PADRAO.textoRecibo);
});

test('recibo carrega a hora da ENTREGA, não a de quando foi montado', () => {
  // O bug que isto trava: montar com `new Date()` fazia o cliente receber
  // "registrada às 14h20" quando a entrega tinha sido às 14h05 — e a diferença
  // cresce com a demora em mandar. O aviso de chegada é previsão e se refaz; o
  // recibo afirma um fato passado e não pode se mexer.
  const entregue = new Date(2026, 6, 30, 14, 5);
  const enviado = new Date(2026, 6, 30, 16, 40);
  assert.match(mensagemDeRecibo(entregue, 'Maria', PARAMETROS_AVISO_PADRAO), /14h05/);
  assert.ok(
    !mensagemDeRecibo(entregue, 'Maria', PARAMETROS_AVISO_PADRAO).includes('16h40'),
    'a hora do envio não pode aparecer no lugar da hora da entrega',
  );
  assert.match(mensagemDeRecibo(enviado, 'Maria', PARAMETROS_AVISO_PADRAO), /16h40/);
});
