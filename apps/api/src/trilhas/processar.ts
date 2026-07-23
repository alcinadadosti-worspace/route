import { randomUUID } from 'node:crypto';
import {
  codificarPolyline,
  distanciaEmMetros,
  PARAMETROS_TRILHA_PADRAO,
  type GeoPonto,
  type Trilha,
} from '@rota/shared';
import { simplificarTrilha } from './simplificar.js';
import type { Repositorio } from '../db/repositorio.js';
import type { ClienteOsrm } from '../rotas/osrm.js';

/**
 * Pós-processamento de trilhas brutas (RF-08, seção 11.2): simplifica o rastro,
 * separa via `/match` o que já existe na malha OSM do que não existe, e grava
 * como trilha aprendida apenas o trecho órfão do FIM do rastro — o caminho até
 * a porta do cliente que o mapa não conhece. Idempotente: processa só as
 * brutas `pendente`; em erro (ex.: OSRM dormindo) a bruta continua pendente e
 * a próxima chamada tenta de novo.
 */

export interface ItemProcessamento {
  trilhaBrutaId: string;
  clienteId: string;
  resultado: 'trilha_criada' | 'descartada' | 'erro';
  motivo?: string;
  trilhaId?: string;
  distanciaM?: number;
}

export interface RelatorioProcessamento {
  pendentes: number;
  criadas: number;
  descartadas: number;
  erros: number;
  itens: ItemProcessamento[];
}

export async function processarTrilhasBrutas(
  repo: Repositorio,
  osrm: ClienteOsrm,
): Promise<RelatorioProcessamento> {
  const pendentes = await repo.listarTrilhasBrutasPendentes();
  const itens: ItemProcessamento[] = [];

  for (const bruta of pendentes) {
    try {
      itens.push(await processarUma(bruta, repo, osrm));
    } catch (erro) {
      itens.push({
        trilhaBrutaId: bruta.id,
        clienteId: bruta.clienteId,
        resultado: 'erro',
        motivo: erro instanceof Error ? erro.message : String(erro),
      });
    }
  }

  return {
    pendentes: pendentes.length,
    criadas: itens.filter((i) => i.resultado === 'trilha_criada').length,
    descartadas: itens.filter((i) => i.resultado === 'descartada').length,
    erros: itens.filter((i) => i.resultado === 'erro').length,
    itens,
  };
}

type TrilhaBrutaComId = Awaited<ReturnType<Repositorio['listarTrilhasBrutasPendentes']>>[number];

async function processarUma(
  bruta: TrilhaBrutaComId,
  repo: Repositorio,
  osrm: ClienteOsrm,
): Promise<ItemProcessamento> {
  const parametros = PARAMETROS_TRILHA_PADRAO;

  // Ponto malformado não pode virar pílula envenenada: sem este filtro, um
  // NaN chegaria ao /match, o erro deixaria a bruta pendente e ela seria
  // retentada para sempre.
  const pontos = (bruta.pontos ?? []).filter(
    (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng) && Number.isFinite(p?.precisaoM),
  );
  if (pontos.length < 2) {
    return descartar(bruta, repo, 'gravação sem deslocamento suficiente (menos de 2 pontos válidos)');
  }

  // Cliente inexistente descarta em vez de envenenar: o `update` do Firestore
  // lançaria NOT_FOUND e a bruta ficaria pendente em retry eterno.
  if (!(await repo.obterCliente(bruta.clienteId))) {
    return descartar(bruta, repo, `cliente '${bruta.clienteId}' não existe`);
  }

  const simplificados = simplificarTrilha(pontos, parametros.toleranciaSimplificacaoM);
  const casamento = await osrm.match(simplificados);

  // O trecho órfão que interessa é o do FIM do rastro: do último ponto que a
  // malha reconhece até a porta do cliente. Órfãos no meio do caminho são
  // lacunas do OSM em estrada de passagem — o /route da rota cobre isso.
  let ultimoCasado = casamento.pontos.length - 1;
  while (ultimoCasado >= 0 && casamento.pontos[ultimoCasado] === null) ultimoCasado--;

  if (ultimoCasado === casamento.pontos.length - 1) {
    return descartar(bruta, repo, 'destino alcançável pela malha conhecida — sem trecho a aprender');
  }

  const trechoOrfao: GeoPonto[] = simplificados
    .slice(ultimoCasado + 1)
    .map((p) => ({ lat: p.lat, lng: p.lng }));
  // Sem nenhum ponto casado, a entrada É o primeiro ponto do trecho —
  // prefixá-lo de novo duplicaria o vértice inicial da polyline.
  const pontoEntrada: GeoPonto =
    ultimoCasado >= 0 ? casamento.pontos[ultimoCasado]! : { ...trechoOrfao[0]! };
  const caminho = ultimoCasado >= 0 ? [pontoEntrada, ...trechoOrfao] : trechoOrfao;

  let distanciaM = 0;
  for (let i = 1; i < caminho.length; i++) {
    distanciaM += distanciaEmMetros(caminho[i - 1]!, caminho[i]!);
  }
  distanciaM = Math.round(distanciaM);

  if (distanciaM < parametros.trilhaMinimaM) {
    return descartar(bruta, repo, `trecho fora da malha de ${distanciaM} m — ruído de GPS`);
  }

  const precisoes = simplificados.slice(ultimoCasado + 1).map((p) => p.precisaoM);
  const precisaoMediaM =
    Math.round((precisoes.reduce((soma, p) => soma + p, 0) / precisoes.length) * 10) / 10;

  const anterior = await repo.obterTrilhaAtiva(bruta.clienteId);
  const trilha: Trilha = {
    clienteId: bruta.clienteId,
    polyline: codificarPolyline(caminho),
    pontoEntrada,
    distanciaM,
    precisaoMediaM,
    ativa: true,
    gravadaPor: bruta.gravadaPor,
    gravadaEm: bruta.finalizadaEm,
    versao: (anterior?.versao ?? 0) + 1,
  };
  const trilhaId = randomUUID();

  await repo.aplicarProcessamentoDeTrilha({
    trilhaAnteriorId: anterior?.id ?? null,
    trilhaId,
    trilha,
    clienteId: bruta.clienteId,
    trilhaBrutaId: bruta.id,
    brutaCampos: {
      status: 'processada',
      processadaEm: new Date().toISOString(),
      trilhaGerada: trilhaId,
    },
  });

  return {
    trilhaBrutaId: bruta.id,
    clienteId: bruta.clienteId,
    resultado: 'trilha_criada',
    trilhaId,
    distanciaM,
  };
}

async function descartar(
  bruta: TrilhaBrutaComId,
  repo: Repositorio,
  motivo: string,
): Promise<ItemProcessamento> {
  await repo.atualizarTrilhaBruta(bruta.id, {
    status: 'descartada',
    processadaEm: new Date().toISOString(),
    motivoDescarte: motivo,
  });
  return { trilhaBrutaId: bruta.id, clienteId: bruta.clienteId, resultado: 'descartada', motivo };
}
