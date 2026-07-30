import { temCarga } from '@rota/shared';
import type {
  Cliente,
  Entrega,
  ProdutividadeMotorista,
  ProdutividadeRota,
  RelatorioProdutividade,
  Rota,
  Trilha,
} from '@rota/shared';

/**
 * Produtividade do motorista (RF-25), calculada sobre o que a operação já
 * grava: nenhuma coleta nova foi inventada para isto.
 *
 * Duas decisões de leitura que valem explicar:
 *
 * MEDIANA, não média, para o tempo por parada. Uma parada para almoçar ou um
 * trecho de 40 km entre dois clientes rurais puxaria a média e faria o número
 * mentir para todo mundo.
 *
 * CONHECIMENTO ACRESCENTADO conta junto com as entregas. Pin confirmado e
 * trilha gravada não aparecem no dia em que acontecem, aparecem em todas as
 * rotas futuras até aquele cliente. Medir só entregas por hora premiaria quem
 * corre e ignora o mato — que é exatamente o contrário do que esta operação
 * precisa.
 */

/** Data no formato AAAA-MM-DD, como `rota.data`. */
const FORMATO_DATA = /^\d{4}-\d{2}-\d{2}$/;

export type ResultadoProdutividade =
  | { ok: true; relatorio: RelatorioProdutividade }
  | { ok: false; status: number; erro: string };

export function calcularProdutividade(
  entrada: { desde: string; ate: string },
  dados: {
    rotas: Array<{ id: string } & Rota>;
    entregas: Entrega[];
    clientes: Array<{ id: string } & Cliente>;
    trilhas: Trilha[];
  },
): ResultadoProdutividade {
  if (!FORMATO_DATA.test(entrada.desde) || !FORMATO_DATA.test(entrada.ate)) {
    return { ok: false, status: 400, erro: 'Datas inválidas (esperado AAAA-MM-DD)' };
  }
  if (entrada.desde > entrada.ate) {
    return { ok: false, status: 400, erro: 'A data inicial é depois da final' };
  }

  // A janela é pela DATA DA ROTA, que é o dia operacional — e não pela hora da
  // confirmação, que atravessaria a meia-noite numa rota que terminou tarde.
  const rotas = dados.rotas.filter((r) => r.data >= entrada.desde && r.data <= entrada.ate);
  const rotaPorId = new Map(rotas.map((r) => [r.id, r]));
  const entregas = dados.entregas.filter((e) => rotaPorId.has(e.rotaId));

  const porMotorista = new Map<string, ProdutividadeMotorista>();
  const vazio = (motoristaId: string): ProdutividadeMotorista => ({
    motoristaId,
    rotas: 0,
    paradasPlanejadas: 0,
    entregues: 0,
    insucessos: 0,
    porMotivo: {},
    kmPlanejados: 0,
    minutosPorParadaMediana: null,
    minutosEmRota: null,
    avisados: 0,
    ausenciasAvisados: 0,
    ausenciasNaoAvisados: 0,
    pinsConfirmados: 0,
    trilhasGravadas: 0,
    itensEntregues: 0,
    produtosDistintos: 0,
    volumesEntregues: 0,
    pesoEntregueKg: 0,
    entregasSemCarga: 0,
    rotas_detalhe: [],
  });
  const de = (motoristaId: string) => {
    if (!porMotorista.has(motoristaId)) porMotorista.set(motoristaId, vazio(motoristaId));
    return porMotorista.get(motoristaId)!;
  };

  // 1. O que veio das rotas: volume planejado, quilometragem e avisos.
  for (const rota of rotas) {
    const m = de(rota.motoristaId);
    m.rotas += 1;
    m.paradasPlanejadas += rota.paradas.length;
    m.kmPlanejados = Math.round((m.kmPlanejados + rota.distanciaTotalKm) * 10) / 10;
    m.avisados += rota.paradas.filter((p) => p.avisadoEm).length;
  }

  // 2. O que veio das entregas: resultado e ritmo.
  const intervalosPorMotorista = new Map<string, number[]>();
  const jornadaPorMotorista = new Map<string, number>();
  for (const rota of rotas) {
    const daRota = dados.entregas
      .filter((e) => e.rotaId === rota.id)
      .sort((a, b) => a.confirmadaEm.localeCompare(b.confirmadaEm));

    const m = de(rota.motoristaId);
    const paradaPorPedido = new Map(rota.paradas.map((p) => [p.pedidoId, p]));
    const daqui: ProdutividadeRota = {
      rotaId: rota.id,
      data: rota.data,
      paradas: rota.paradas.length,
      entregues: 0,
      insucessos: 0,
      itensEntregues: 0,
      produtosDistintos: 0,
      volumesEntregues: 0,
      pesoEntregueKg: 0,
      entregasSemCarga: 0,
      kmPlanejados: rota.distanciaTotalKm,
    };
    // Rota publicada e ainda não executada entra no detalhe com zero: sumir da
    // lista faria parecer que o dia não existiu.
    if (daRota.length === 0) {
      m.rotas_detalhe.push(daqui);
      continue;
    }

    for (const entrega of daRota) {
      const parada = paradaPorPedido.get(entrega.pedidoId);
      if (entrega.resultado !== 'entregue') {
        m.insucessos += 1;
        daqui.insucessos += 1;
        m.porMotivo[entrega.resultado] = (m.porMotivo[entrega.resultado] ?? 0) + 1;
        if (entrega.resultado === 'ausente') {
          if (parada?.avisadoEm) m.ausenciasAvisados += 1;
          else m.ausenciasNaoAvisados += 1;
        }
        continue;
      }

      m.entregues += 1;
      daqui.entregues += 1;
      if (!parada) continue;
      // Mercadoria que saiu do caminhão. ITEM é a soma das quantidades (`qCom`),
      // que é o que a operação chama de item; a contagem de linhas vai separada,
      // porque é três vezes menor nas notas reais.
      daqui.produtosDistintos += parada.itens.length;
      daqui.itensEntregues += parada.itens.reduce(
        (soma, item) => soma + (Number.isFinite(item.quantidade) ? item.quantidade : 0),
        0,
      );
      if (temCarga(parada.volumes, parada.pesoBrutoKg)) {
        if (parada.volumes > 0) daqui.volumesEntregues += parada.volumes;
        if (parada.pesoBrutoKg > 0) daqui.pesoEntregueKg += parada.pesoBrutoKg;
      } else {
        // Um terço das notas reais não informa carga: sem contar isto, a soma
        // de peso passaria por carga total do dia quando é só a parte declarada.
        daqui.entregasSemCarga += 1;
      }
    }

    // `qCom` vem como '3.0000' e nunca fracionário nas 28.088 linhas reais; o
    // arredondamento aqui só protege contra soma de ponto flutuante.
    daqui.itensEntregues = Math.round(daqui.itensEntregues);
    daqui.pesoEntregueKg = Math.round(daqui.pesoEntregueKg * 1000) / 1000;
    m.itensEntregues += daqui.itensEntregues;
    m.produtosDistintos += daqui.produtosDistintos;
    m.volumesEntregues += daqui.volumesEntregues;
    m.pesoEntregueKg = Math.round((m.pesoEntregueKg + daqui.pesoEntregueKg) * 1000) / 1000;
    m.entregasSemCarga += daqui.entregasSemCarga;
    m.rotas_detalhe.push(daqui);

    const intervalos = intervalosPorMotorista.get(rota.motoristaId) ?? [];
    for (let i = 1; i < daRota.length; i++) {
      const minutos = diferencaEmMinutos(daRota[i - 1]!.confirmadaEm, daRota[i]!.confirmadaEm);
      // Timestamp corrompido ou fila offline sincronizando fora de ordem não
      // pode virar intervalo negativo na mediana.
      if (minutos >= 0) intervalos.push(minutos);
    }
    intervalosPorMotorista.set(rota.motoristaId, intervalos);

    const jornada = diferencaEmMinutos(
      daRota[0]!.confirmadaEm,
      daRota[daRota.length - 1]!.confirmadaEm,
    );
    if (jornada >= 0) {
      jornadaPorMotorista.set(
        rota.motoristaId,
        (jornadaPorMotorista.get(rota.motoristaId) ?? 0) + jornada,
      );
    }
  }
  for (const [motoristaId, intervalos] of intervalosPorMotorista) {
    de(motoristaId).minutosPorParadaMediana = mediana(intervalos);
  }
  for (const [motoristaId, minutos] of jornadaPorMotorista) {
    de(motoristaId).minutosEmRota = minutos;
  }

  // 3. Conhecimento acrescentado. A janela aqui é a data do PRÓPRIO registro:
  // mapear não pertence a uma rota, pertence ao dia.
  const dentroDaJanela = (iso: string | null | undefined) => {
    const dia = (iso ?? '').slice(0, 10);
    return dia >= entrada.desde && dia <= entrada.ate;
  };
  for (const cliente of dados.clientes) {
    if (cliente.mapeadoPor && dentroDaJanela(cliente.mapeadoEm)) {
      de(cliente.mapeadoPor).pinsConfirmados += 1;
    }
  }
  for (const trilha of dados.trilhas) {
    if (trilha.gravadaPor && dentroDaJanela(trilha.gravadaEm)) {
      de(trilha.gravadaPor).trilhasGravadas += 1;
    }
  }

  return {
    ok: true,
    relatorio: {
      desde: entrada.desde,
      ate: entrada.ate,
      // Quem mais entregou primeiro; empate resolvido pelo nome, para a ordem
      // não dançar entre duas cargas da mesma tela.
      motoristas: [...porMotorista.values()]
        .map((m) => ({
          ...m,
          // Rota mais recente primeiro: é o dia que se quer olhar.
          rotas_detalhe: m.rotas_detalhe.sort((a, b) => b.data.localeCompare(a.data)),
        }))
        .sort((a, b) => b.entregues - a.entregues || a.motoristaId.localeCompare(b.motoristaId)),
    },
  };
}

function diferencaEmMinutos(inicio: string, fim: string): number {
  return Math.round((new Date(fim).getTime() - new Date(inicio).getTime()) / 60_000);
}

function mediana(valores: number[]): number | null {
  if (valores.length === 0) return null;
  const ordenados = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(ordenados.length / 2);
  const bruta =
    ordenados.length % 2 === 1 ? ordenados[meio]! : (ordenados[meio - 1]! + ordenados[meio]!) / 2;
  return Math.round(bruta);
}
