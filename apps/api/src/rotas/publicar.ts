import type { ParadaRota, Rota } from '@rota/shared';
import { randomUUID } from 'node:crypto';
import { coletarParadas, type FalhaColeta } from './previa.js';
import type { Repositorio } from '../db/repositorio.js';
import type { ClienteOsrm } from './osrm.js';

/**
 * Publicação de rota (RF-13): grava a rota na ordem final do operador, com
 * ETA e distância por parada, e move os pedidos para `em_rota`. No app do
 * motorista, a rota publicada é a rota do dia; a pré-carga offline (Fase 5)
 * parte deste mesmo documento.
 */

export interface EntradaPublicacao {
  /** Ordem FINAL das paradas (já otimizada e/ou ajustada no painel). */
  pedidoIds: string[];
  cdId: string;
  retornaAoCd?: boolean;
  motoristaId: string;
  /** YYYY-MM-DD; padrão: hoje no fuso de Alagoas. */
  data?: string;
}

export type ResultadoPublicacao =
  | { ok: true; rotaId: string; rota: Rota }
  | FalhaColeta;

export async function publicarRota(
  entrada: EntradaPublicacao,
  repo: Repositorio,
  osrm: ClienteOsrm,
): Promise<ResultadoPublicacao> {
  if (!entrada.pedidoIds?.length) {
    return { ok: false, status: 400, erro: 'Selecione ao menos um pedido' };
  }
  if (!entrada.motoristaId) {
    return { ok: false, status: 400, erro: 'Escolha o motorista da rota' };
  }
  // `data` entra no rotaId, que vira caminho de documento no Firestore ('/'
  // separa níveis): sem validar, `data` com barras escreveria num caminho
  // arbitrário sob rotas/.
  if (entrada.data !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(entrada.data)) {
    return { ok: false, status: 400, erro: 'Data inválida (esperado AAAA-MM-DD)' };
  }

  const usuarios = await repo.listarUsuarios();
  const motorista = usuarios.find((u) => u.id === entrada.motoristaId && u.ativo);
  if (!motorista) {
    return { ok: false, status: 400, erro: 'Motorista inválido ou inativo' };
  }

  const cds = await repo.obterCds();
  // hasOwnProperty: `cdId='__proto__'` retornaria o protótipo (truthy) e
  // furaria a checagem, seguindo com coordenada undefined.
  const cd = Object.prototype.hasOwnProperty.call(cds, entrada.cdId) ? cds[entrada.cdId] : undefined;
  if (!cd) return { ok: false, status: 400, erro: `CD '${entrada.cdId}' não cadastrado` };
  const retornaAoCd = entrada.retornaAoCd ?? true;

  const coleta = await coletarParadas(entrada.pedidoIds, repo);
  if (!coleta.ok) return coleta;
  const candidatas = coleta.candidatas;

  for (const c of candidatas) {
    const pedido = (await repo.obterPedido(c.pedidoId))!;
    if (pedido.status === 'em_rota') {
      return { ok: false, status: 409, erro: `Pedido ${pedido.numeroNota} já está em outra rota` };
    }
    if (pedido.status === 'entregue') {
      return { ok: false, status: 409, erro: `Pedido ${pedido.numeroNota} já foi entregue` };
    }
  }

  const pontos = [cd.coordenada, ...candidatas.map((c) => c.coordenada)];
  if (retornaAoCd) pontos.push(cd.coordenada);
  let tracado;
  try {
    tracado = await osrm.route(pontos);
  } catch (erro) {
    // Cold-start do OSRM ou falha de rota: mensagem clara em vez de 500 cru.
    return { ok: false, status: 503, erro: erro instanceof Error ? erro.message : 'Falha no roteirizador' };
  }

  let etaAcumuladoSeg = 0;
  const paradas: ParadaRota[] = candidatas.map((c, i) => {
    const perna = tracado.pernas[i] ?? { distanciaKm: 0, duracaoSeg: 0 };
    etaAcumuladoSeg += perna.duracaoSeg;
    return {
      pedidoId: c.pedidoId,
      clienteId: c.clienteId,
      nome: c.nome,
      endereco: c.endereco,
      telefone: c.telefone,
      numeroNota: c.numeroNota,
      serie: c.serie,
      numeroPedido: c.numeroPedido,
      itens: c.itens,
      volumes: c.volumes,
      pesoBrutoKg: c.pesoBrutoKg,
      coordenada: c.coordenada,
      // Acumula segundos crus e arredonda uma vez: o ETA de uma parada nunca
      // ultrapassa a duração total da rota (que também é arredondada do total cru).
      etaMin: Math.round(etaAcumuladoSeg / 60),
      distanciaKm: perna.distanciaKm,
      status: 'em_rota',
      precisaMapear: c.precisaMapear,
    };
  });

  const data = entrada.data ?? hojeEmAlagoas();
  const rotaId = `${data}_${randomUUID().slice(0, 8)}`;
  const rota: Rota = {
    data,
    motoristaId: entrada.motoristaId,
    origemCdId: entrada.cdId,
    origemNome: cd.nome,
    origemCoordenada: cd.coordenada,
    retornaAoCd,
    paradas,
    polylinePlanejada: tracado.polyline,
    distanciaTotalKm: tracado.distanciaKm,
    duracaoTotalMin: tracado.duracaoMin,
    status: 'publicada',
    publicadaEm: new Date().toISOString(),
    concluidaEm: null,
  };

  // Escrita atômica (batch): grava a rota e move os pedidos para em_rota de uma
  // vez. Sem isso, um crash entre as escritas deixaria a rota publicada com
  // pedidos ainda pronto_para_rota — que entrariam numa segunda rota.
  await repo.publicarRotaAtomica(
    rotaId,
    rota,
    candidatas.map((c) => c.pedidoId),
  );

  return { ok: true, rotaId, rota };
}

export function hojeEmAlagoas(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Maceio' }).format(new Date());
}
