import {
  chaveDeMunicipio,
  formatarDia,
  type Cliente,
  type ExcecaoRota,
  type ParadaRota,
  type Rota,
} from '@rota/shared';

/**
 * O roteiro em papel: o que o motorista sem app leva no caminhão. Este módulo
 * decide O QUE vai no PDF (texto pronto, na ordem); `roteiroPdf.ts` só desenha.
 * Separado assim para o conteúdo ser testável — o desenho não é.
 *
 * O PDF nasce de uma rota PUBLICADA, nunca da prévia: publicar é o que reserva
 * os pedidos. Um PDF da prévia deixaria os pedidos livres, e a montagem do dia
 * seguinte os ofereceria de novo — dois caminhões, a mesma caixa.
 */

export interface ItemRoteiro {
  /** `01`, `02`… nas paradas; `E1`, `E2`… nas exceções. */
  marca: string;
  nome: string;
  endereco: string;
  /** O que se sabe do lugar: dossiê do motorista ou referência do ERP. */
  comoChegar: string | null;
  telefone: string | null;
  documento: string;
  carga: string;
  /** Distância e tempo de direção desde o CD. Só nas paradas. */
  estimativa: string | null;
  aviso: string | null;
  /** Já tem resultado (PDF baixado de novo depois da baixa parcial). */
  resultado: 'Entregue' | 'Não entregue' | null;
}

export interface Roteiro {
  arquivo: string;
  titulo: string;
  subtitulo: string;
  resumo: string;
  paradas: ItemRoteiro[];
  excecoes: ItemRoteiro[];
  rodape: string;
}

const numero = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

/** `+5582999990000` → `(82) 99999-0000`. O que não reconhece passa como veio. */
export function telefoneLegivel(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const m = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/** `200` → `3h20`; `45` → `45 min`. */
export function duracaoLegivel(minutos: number): string {
  const m = Math.max(0, Math.round(minutos));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

function carga(p: { quantidadeMateriais?: number; volumes: number; pesoBrutoKg: number }): string {
  const partes: string[] = [];
  if (p.quantidadeMateriais) {
    partes.push(`${p.quantidadeMateriais} produto${p.quantidadeMateriais === 1 ? '' : 's'}`);
  }
  if (p.volumes > 0) partes.push(`${p.volumes} vol`);
  if (p.pesoBrutoKg > 0) partes.push(`${numero.format(p.pesoBrutoKg)} kg`);
  return partes.length > 0 ? partes.join(' · ') : 'carga não informada';
}

function documento(p: { numeroPedido?: string | null; numeroNota?: number }): string {
  const partes: string[] = [];
  if (p.numeroPedido) partes.push(`Pedido ${p.numeroPedido}`);
  if (p.numeroNota) partes.push(`NF ${p.numeroNota}`);
  return partes.join(' · ');
}

function resultado(status: string): ItemRoteiro['resultado'] {
  if (status === 'entregue') return 'Entregue';
  if (status === 'insucesso') return 'Não entregue';
  return null;
}

function comum(p: ParadaRota | ExcecaoRota, clientes: Record<string, Cliente>) {
  const observacoes = clientes[p.clienteId]?.observacoes?.trim();
  return {
    nome: p.nome,
    endereco: p.endereco,
    comoChegar: observacoes ? observacoes : null,
    telefone: telefoneLegivel(p.telefone),
    documento: documento(p),
    carga: carga(p),
    resultado: resultado(p.status),
  };
}

/** Municípios da rota, do que mais aparece para o que menos — vira o título. */
function municipios(rota: Rota, clientes: Record<string, Cliente>): string[] {
  const conta = new Map<string, { nome: string; n: number }>();
  for (const p of [...rota.paradas, ...(rota.excecoes ?? [])]) {
    const nome =
      clientes[p.clienteId]?.enderecoFiscal.municipio ??
      // Fallback: a parada guarda "rua — bairro, MUNICÍPIO/UF".
      /, ([^,]+)\/[A-Z]{2}$/.exec(p.endereco)?.[1];
    if (!nome) continue;
    // Sem pontuação: "OLHO D'ÁGUA" e "OLHO DÁGUA" no título seriam duas cidades.
    const chave = chaveDeMunicipio(nome);
    const atual = conta.get(chave) ?? { nome, n: 0 };
    atual.n += 1;
    conta.set(chave, atual);
  }
  return [...conta.values()].sort((a, b) => b.n - a.n).map((m) => m.nome);
}

function paraArquivo(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function montarRoteiro(
  rotaId: string,
  rota: Rota,
  contexto: { motorista: string; clientes: Record<string, Cliente>; geradoEm: Date },
): Roteiro {
  const { clientes } = contexto;
  const lugares = municipios(rota, clientes);
  const excecoes = rota.excecoes ?? [];

  const paradas: ItemRoteiro[] = rota.paradas.map((p, i) => {
    // Distância ACUMULADA: `distanciaKm` da parada é a perna, e o motorista
    // quer saber quanto já andou desde o CD — não o trecho isolado.
    const km = p.kmDoCd ?? rota.paradas.slice(0, i + 1).reduce((t, q) => t + q.distanciaKm, 0);
    return {
      ...comum(p, clientes),
      marca: String(p.numero ?? i + 1).padStart(2, '0'),
      estimativa: `${numero.format(km)} km do CD · ~${duracaoLegivel(p.etaMin)} de direção`,
      aviso: p.precisaMapear ? 'Ponto aproximado no mapa — confirme o local com a cliente' : null,
    };
  });

  const itensExcecao: ItemRoteiro[] = excecoes.map((e, i) => ({
    ...comum(e, clientes),
    marca: `E${e.numero ?? i + 1}`,
    estimativa: null,
    aviso: null,
  }));

  const destino = lugares.length > 0 ? lugares.slice(0, 3).join(', ') : rota.origemNome;
  const mais = lugares.length > 3 ? ` e mais ${lugares.length - 3}` : '';
  const resumo = [
    `${rota.paradas.length} parada${rota.paradas.length === 1 ? '' : 's'}`,
    ...(excecoes.length > 0 ? [`${excecoes.length} exceç${excecoes.length === 1 ? 'ão' : 'ões'}`] : []),
    `${numero.format(rota.distanciaTotalKm)} km`,
    `~${duracaoLegivel(rota.duracaoTotalMin)} de direção`,
    rota.retornaAoCd ? 'volta ao CD' : 'termina na última parada',
  ].join(' · ');

  const gerado = contexto.geradoEm.toLocaleString('pt-BR', {
    timeZone: 'America/Maceio',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return {
    arquivo: `rota-${rota.data}-${paraArquivo(lugares[0] ?? rota.origemNome) || 'rota'}.pdf`,
    titulo: `Rota de ${formatarDia(rota.data, true)} — ${destino}${mais}`,
    subtitulo: `Saída: ${rota.origemNome} · Motorista: ${contexto.motorista}`,
    resumo,
    paradas,
    excecoes: itensExcecao,
    rodape: `Rota ${rotaId} · gerado em ${gerado}`,
  };
}
