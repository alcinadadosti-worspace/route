import {
  normalizarTelefone,
  type Cliente,
  type Pedido,
  type RelatorioImportacao,
  type StatusPedido,
} from '@rota/shared';
import {
  enderecoDeBloco,
  extrairCoordenada,
  lerPlanilha,
  type LinhaPlanilha,
} from './planilha.js';
import { classificarDestino, emLotes, upsertCliente } from './servico.js';
import type { NotaImportada } from '../nfe/parser.js';
import type { Repositorio } from '../db/repositorio.js';
import type { Geocodificador } from '../geocodificacao/google.js';

/**
 * Importação pela PLANILHA do ERP (`ConsultaPedidos_*.xlsx`) — o caminho que
 * substitui o XML no dia a dia (decisão de 01/08/2026). As diferenças de
 * fundo em relação ao fluxo de XML:
 *
 * - `Pessoa` é a identidade do cliente (código do ERP: não muda, não repete) —
 *   sai de cena o hash de CPF, que a planilha nem traz;
 * - `Tipo de Entrega` é EXPLÍCITO: "Retirar na central" nasce `retirada` sem
 *   passar pela aba Decisões — não há inferência para confirmar;
 * - `SituaçãoComercial = Cancelado` é ignorado na entrada; se o pedido JÁ
 *   existe de importação anterior, vira alerta com ação manual (apagar pelo
 *   painel) — cancelar sozinho feriria o "nada decide sozinho";
 * - coordenada GPS digitada no cadastro (~50 revendedoras) vira pin exato de
 *   graça, pulando geocodificação paga e mapeamento em campo;
 * - a lista de itens não existe — `QtdeMateriais` responde "quantos produtos".
 */

/** Estrutura comercial do ERP → CD da operação. Códigos dados pelo usuário em
 * 01/08/2026 e conferidos no ciclo 11 (1.048 = 1337 pedidos, 1.515 = 664;
 * 18 "Consumidor Final" vêm sem estrutura). A série da NF-e acompanha o CD —
 * medido nas 3507 notas: Penedo emite série 1, Palmeira série 0. */
const CD_POR_ESTRUTURA: Record<string, { cdId: string; serie: number }> = {
  '1048': { cdId: 'penedo', serie: 1 },
  '1515': { cdId: 'palmeira', serie: 0 },
};

export async function importarPlanilha(
  nomeArquivo: string,
  conteudo: Uint8Array,
  repo: Repositorio,
  geocodificador: Geocodificador | null = null,
): Promise<RelatorioImportacao> {
  const relatorio: RelatorioImportacao = {
    total: 0,
    importados: 0,
    duplicados: 0,
    rejeitados: [],
    prontosParaRota: 0,
    pendentesDeMapeamento: 0,
    pendentesDeDecisao: 0,
    retiradas: 0,
    canceladas: 0,
    geocodificados: 0,
    aproximados: 0,
    alertas: [],
    porCd: {},
    semCarga: 0,
  };

  const leitura = lerPlanilha(conteudo);
  if (!leitura.ok) {
    relatorio.total = 1;
    relatorio.rejeitados.push({ arquivo: nomeArquivo, motivo: leitura.motivo });
    return relatorio;
  }

  // Mesma mecânica de concorrência da importação por XML (o custo é a LATÊNCIA
  // do Firestore, não o trabalho): lotes concorrentes + fila por cliente, para
  // duas linhas da mesma revendedora não se atropelarem no upsert.
  const filaPorCliente = new Map<string, Promise<unknown>>();
  function porCliente<T>(clienteId: string, tarefa: () => Promise<T>): Promise<T> {
    const anterior = filaPorCliente.get(clienteId) ?? Promise.resolve();
    const proxima = anterior.then(tarefa, tarefa);
    // Guarda a versão que NÃO rejeita: uma linha com erro não trava as
    // seguintes da mesma revendedora (mesma razão do fluxo XML).
    filaPorCliente.set(
      clienteId,
      proxima.then(
        () => undefined,
        () => undefined,
      ),
    );
    return proxima;
  }
  const codigosVistos = new Set<string>();
  let pinsDoCadastro = 0;

  for await (const lote of emLotes(leitura.linhas, 20)) {
    await Promise.all(
      lote.map((linha) =>
        processarLinha(linha, {
          repo,
          geocodificador,
          relatorio,
          porCliente,
          codigosVistos,
          aoAplicarPin: () => {
            pinsDoCadastro += 1;
          },
        }),
      ),
    );
  }

  if (pinsDoCadastro > 0) {
    relatorio.alertas.push({
      clienteId: '',
      nome: 'Pin do cadastro',
      mensagem: `${pinsDoCadastro} cliente(s) tinham coordenada GPS digitada no cadastro do ERP — viraram pin exato, sem geocodificar nem mapear em campo.`,
    });
  }

  return relatorio;
}

async function processarLinha(
  linha: LinhaPlanilha,
  ctx: {
    repo: Repositorio;
    geocodificador: Geocodificador | null;
    relatorio: RelatorioImportacao;
    porCliente: <T>(clienteId: string, tarefa: () => Promise<T>) => Promise<T>;
    codigosVistos: Set<string>;
    aoAplicarPin: () => void;
  },
): Promise<void> {
  const { repo, geocodificador, relatorio, porCliente, codigosVistos, aoAplicarPin } = ctx;
  relatorio.total += 1;
  const rotulo = `pedido ${linha.codigoPedido}`;

  // Fora de Alagoas não se atende (decisão do usuário): rejeita com motivo, em
  // vez de importar um destino que nenhuma rota alcança.
  if (linha.enderecoEntrega.uf.trim().toUpperCase() !== 'AL') {
    relatorio.rejeitados.push({
      arquivo: rotulo,
      motivo: `UF ${linha.enderecoEntrega.uf || '?'} — a operação atende só AL`,
    });
    return;
  }

  // `Tipo de Entrega` desconhecido: rejeitar, nunca chutar. Um rótulo novo do
  // ERP classificado no palpite mandaria caminhão para quem retira (ou o
  // contrário) sem ninguém perceber.
  if (linha.tipoEntrega === null) {
    relatorio.rejeitados.push({
      arquivo: rotulo,
      motivo: `Tipo de Entrega desconhecido ("${linha.tipoEntregaBruto}") — atualizar o importador`,
    });
    return;
  }

  const existente = codigosVistos.has(linha.codigoPedido)
    ? true
    : await repo.obterPedido(linha.codigoPedido);

  // Cancelado no ERP: não entra. Se JÁ tinha entrado numa importação anterior,
  // ninguém apaga sozinho — o escritório é avisado e apaga pelo painel (o
  // caminho existente já tira a parada da rota junto, se houver).
  if (linha.cancelada) {
    relatorio.canceladas = (relatorio.canceladas ?? 0) + 1;
    if (existente && typeof existente === 'object') {
      if (existente.status !== 'entregue' && existente.status !== 'insucesso') {
        relatorio.alertas.push({
          clienteId: linha.pessoa,
          nome: linha.nome,
          mensagem: `Pedido ${linha.codigoPedido} (nota ${linha.notaFiscal}) foi CANCELADO no ERP depois de importado — apague pela aba Pedidos.`,
        });
      }
    }
    return;
  }

  if (existente) {
    relatorio.duplicados += 1;
    return;
  }
  codigosVistos.add(linha.codigoPedido);

  const cd = linha.estrutura ? CD_POR_ESTRUTURA[linha.estrutura] : undefined;
  relatorio.porCd[cd?.cdId ?? '—'] = (relatorio.porCd[cd?.cdId ?? '—'] ?? 0) + 1;

  // Retirada usa o endereço do CADASTRO no doc do cliente: o bloco de entrega
  // dessas linhas traz o endereço do PRÓPRIO CD (é para lá que a revendedora
  // vai), e gravá-lo no cliente apontaria toda entrega futura para o galpão.
  const endereco = enderecoDeBloco(
    linha.tipoEntrega === 'rota' ? linha.enderecoEntrega : linha.enderecoCadastro,
  );

  const nota: NotaImportada = {
    chaveAcesso: linha.codigoPedido,
    numeroNota: linha.notaFiscal,
    serie: cd?.serie ?? 0,
    emitidoEm: linha.emitidoEm,
    destinatario: {
      clienteId: linha.pessoa,
      nome: linha.nome,
      // Sem CPF na planilha (de propósito — LGPD agradece): o código do ERP
      // identifica a revendedora em qualquer conversa com o escritório.
      documentoMascarado: `cód. ${linha.pessoa}`,
      telefone: normalizarTelefone(linha.telefone),
      email: null,
      enderecoFiscal: endereco,
    },
    itens: [],
    valorTotal: linha.valor,
    volumes: linha.volumes,
    pesoBrutoKg: linha.pesoBrutoKg,
    numeroPedido: linha.codigoPedido,
    lote: linha.lote,
    emitenteCnpj: null,
  };

  const { status, alertaRevisao } = await porCliente(linha.pessoa, async () => {
    const upsert = await upsertCliente(nota, repo);
    let cliente = upsert.cliente;

    // Extras que só a planilha tem, numa escrita só. O pin do cadastro entra
    // ANTES da classificação: com coordenada, `classificarDestino` nem chama a
    // Geocoding (paga) — e o GPS digitado pela própria revendedora vale mais
    // que o palpite do Google sobre um endereço rural.
    const extras: Partial<Cliente> = {};
    if (!cliente.coordenada) {
      const pin = extrairCoordenada([
        linha.enderecoCadastro.complemento,
        linha.enderecoCadastro.referencia,
        linha.enderecoEntrega.complemento,
        linha.enderecoEntrega.referencia,
      ]);
      if (pin) {
        extras.coordenada = pin;
        extras.statusMapeamento = 'geocodificado';
        aoAplicarPin();
      }
    }
    if (linha.papel && linha.papel !== cliente.papel) extras.papel = linha.papel;
    // Referência de entrega ("POR TRÁS DA PREFEITURA") alimenta o dossiê — mas
    // NUNCA por cima do que o motorista escreveu em campo: o conhecimento de
    // quem foi lá vale mais que o texto do cadastro.
    const referencia = (linha.enderecoEntrega.referencia || linha.enderecoCadastro.referencia).trim();
    if (referencia && !cliente.observacoes) extras.observacoes = referencia;
    if (Object.keys(extras).length > 0) {
      await repo.atualizarCliente(linha.pessoa, extras);
      cliente = { ...cliente, ...extras };
    }

    // Retirada não classifica destino: não há entrega para geocodificar, e
    // gastar Geocoding com quem vem buscar seria pagar por nada.
    if (linha.tipoEntrega === 'retirada') {
      return { status: 'retirada' as StatusPedido, alertaRevisao: null };
    }

    const classificado = await classificarDestino(
      linha.pessoa,
      cliente,
      repo,
      geocodificador,
      relatorio,
    );
    // Mudança de endereço com ponto estabelecido (seção 8.3): mesma regra do
    // fluxo XML — o pedido espera o escritório confirmar se o ponto sobrevive.
    if (upsert.enderecoAnterior) {
      return {
        status: 'pendente_de_decisao' as StatusPedido,
        alertaRevisao: upsert.revisaoNova
          ? {
              clienteId: linha.pessoa,
              nome: linha.nome,
              mensagem:
                'Endereço do cadastro mudou — confirme na aba Decisões se o ponto atual ainda vale.',
            }
          : null,
      };
    }
    return { status: classificado, alertaRevisao: null };
  });

  if (alertaRevisao) relatorio.alertas.push(alertaRevisao);

  const pedido: Pedido = {
    numeroNota: linha.notaFiscal,
    serie: cd?.serie ?? 0,
    numeroPedido: linha.codigoPedido,
    lote: linha.lote,
    clienteId: linha.pessoa,
    emitidoEm: linha.emitidoEm,
    itens: [],
    valorTotal: linha.valor,
    volumes: linha.volumes,
    pesoBrutoKg: linha.pesoBrutoKg,
    quantidadeMateriais: linha.quantidadeMateriais,
    status,
    rotaId: null,
    xmlStoragePath: null,
    modoEntrega: linha.tipoEntrega,
    cdId: cd?.cdId ?? null,
  };
  await repo.salvarPedido(linha.codigoPedido, pedido);
  relatorio.importados += 1;

  if (status === 'retirada') relatorio.retiradas = (relatorio.retiradas ?? 0) + 1;
  else if (status === 'pronto_para_rota') relatorio.prontosParaRota += 1;
  else if (status === 'pendente_de_decisao') relatorio.pendentesDeDecisao += 1;
  else relatorio.pendentesDeMapeamento += 1;

  // Peso zerado só importa para quem VAI NO CAMINHÃO (mesma régua do XML).
  if (linha.tipoEntrega === 'rota' && linha.volumes <= 0 && linha.pesoBrutoKg <= 0) {
    relatorio.semCarga += 1;
  }
}
