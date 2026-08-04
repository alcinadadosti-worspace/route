import {
  ehEnderecoRural,
  enderecosDivergem,
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
import type { Repositorio } from '../db/repositorio.js';

/**
 * Importação pela PLANILHA do ERP (`ConsultaPedidos_*.xlsx`) — o caminho que
 * substitui o XML no dia a dia (decisão de 01/08/2026).
 *
 * O que a planilha tem e a NF-e não tem: `Tipo de Entrega` explícito (rota ×
 * retirada, sem inferência), `SituaçãoComercial` (cancelamento, que na nota
 * mora num documento que o ERP não exporta), coordenada GPS digitada no
 * cadastro de ~50 revendedoras e os pontos de referência da entrega.
 *
 * ESCALA MANDOU NO DESENHO. A primeira versão fazia como o fluxo de XML — um
 * `get`/`set` por documento e geocodificação embutida — e não terminava: com
 * 2019 linhas × ~5 idas ao Firestore a 134 ms cada (medido em produção), eram
 * ~67 s só de banco, mais ~20 s de Google. O proxy do Render cortava a
 * requisição antes do fim e o navegador reportava "erro de CORS", que despista
 * completamente. Agora:
 *
 * 1. UMA consulta traz os ids de pedidos (dedupe) e UMA traz os clientes;
 * 2. tudo é decidido em memória;
 * 3. as escritas vão num `BulkWriter` só;
 * 4. a GEOCODIFICAÇÃO SAI DAQUI — vira passo próprio, em lotes, com progresso
 *    na tela (`/api/geocodificacoes`). Além de caber no tempo, dá ao Admin Estoque
 *    controle sobre uma chamada que é PAGA.
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

  // Duas consultas para a remessa inteira, em vez de duas por linha.
  const [idsExistentes, clientesExistentes] = await Promise.all([
    repo.idsDePedidos(),
    repo.listarClientes(),
  ]);
  const clientes = new Map<string, Cliente>(
    clientesExistentes.map(({ id, ...c }) => [id, c as Cliente]),
  );

  const escritasDePedido: Array<{ colecao: 'pedidos'; id: string; dados: Pedido }> = [];
  /**
   * UMA escrita por cliente, não uma por linha. A mesma revendedora costuma ter
   * várias notas no ciclo (2019 pedidos para 1366 clientes): empilhar uma
   * escrita por linha mandaria ~650 gravações redundantes ao banco e — pior —
   * misturaria um `set` do doc inteiro (1ª linha, cliente novo) com `merge`s
   * parciais (linhas seguintes) do MESMO documento no mesmo lote, cuja ordem
   * relativa não vale a pena depender. Acumular o estado final aqui resolve os
   * dois de uma vez.
   */
  const escritasDeCliente = new Map<
    string,
    { dados: Partial<Cliente>; merge: boolean }
  >();
  const vistos = new Set<string>();
  let pinsDoCadastro = 0;
  let aGeocodificar = 0;

  for (const linha of leitura.linhas) {
    relatorio.total += 1;
    const rotulo = `pedido ${linha.codigoPedido}`;

    // Fora de Alagoas não se atende (decisão do usuário): rejeita com motivo,
    // em vez de importar um destino que nenhuma rota alcança.
    if (linha.enderecoEntrega.uf.trim().toUpperCase() !== 'AL') {
      relatorio.rejeitados.push({
        arquivo: rotulo,
        motivo: `UF ${linha.enderecoEntrega.uf || '?'} — a operação atende só AL`,
      });
      continue;
    }

    // `Tipo de Entrega` desconhecido: rejeitar, nunca chutar. Um rótulo novo do
    // ERP classificado no palpite mandaria caminhão para quem retira (ou o
    // contrário) sem ninguém perceber.
    if (linha.tipoEntrega === null) {
      relatorio.rejeitados.push({
        arquivo: rotulo,
        motivo: `Tipo de Entrega desconhecido ("${linha.tipoEntregaBruto}") — atualizar o importador`,
      });
      continue;
    }

    const jaExiste = idsExistentes.has(linha.codigoPedido) || vistos.has(linha.codigoPedido);

    // Cancelado no ERP: não entra. Se JÁ tinha entrado numa importação
    // anterior, ninguém apaga sozinho — o Admin Estoque é avisado e apaga pelo
    // painel (o caminho existente já tira a parada da rota junto, se houver).
    if (linha.cancelada) {
      relatorio.canceladas = (relatorio.canceladas ?? 0) + 1;
      if (jaExiste) {
        relatorio.alertas.push({
          clienteId: linha.pessoa,
          nome: linha.nome,
          mensagem: `Pedido ${linha.codigoPedido} (nota ${linha.notaFiscal}) foi CANCELADO no ERP depois de importado — apague pela aba Pedidos.`,
        });
      }
      continue;
    }

    if (jaExiste) {
      relatorio.duplicados += 1;
      continue;
    }
    vistos.add(linha.codigoPedido);

    const cd = linha.estrutura ? CD_POR_ESTRUTURA[linha.estrutura] : undefined;
    relatorio.porCd[cd?.cdId ?? '—'] = (relatorio.porCd[cd?.cdId ?? '—'] ?? 0) + 1;

    // Retirada usa o endereço do CADASTRO: o bloco de entrega dessas linhas
    // traz o endereço do PRÓPRIO CD (é para lá que a revendedora vai), e
    // gravá-lo no cliente apontaria toda entrega futura para o galpão.
    const endereco = enderecoDeBloco(
      linha.tipoEntrega === 'rota' ? linha.enderecoEntrega : linha.enderecoCadastro,
    );
    const telefone = normalizarTelefone(linha.telefone);
    const referencia = (
      linha.enderecoEntrega.referencia || linha.enderecoCadastro.referencia
    ).trim();
    const pinDoCadastro = extrairCoordenada([
      linha.enderecoCadastro.complemento,
      linha.enderecoCadastro.referencia,
      linha.enderecoEntrega.complemento,
      linha.enderecoEntrega.referencia,
    ]);

    const existente = clientes.get(linha.pessoa);
    let cliente: Cliente;
    let enderecoAnterior: Cliente['enderecoFiscal'] | null = null;

    if (!existente) {
      cliente = {
        nome: linha.nome,
        // Sem CPF na planilha (de propósito — LGPD agradece): o código do ERP
        // identifica a revendedora em qualquer conversa com o Admin Estoque.
        documentoMascarado: `cód. ${linha.pessoa}`,
        telefone,
        email: null,
        enderecoFiscal: endereco,
        coordenada: pinDoCadastro,
        statusMapeamento: pinDoCadastro ? 'geocodificado' : 'nao_mapeado',
        trilhaAtivaId: null,
        mapeadoPor: null,
        mapeadoEm: null,
        fotoReferenciaPath: null,
        observacoes: referencia,
        enderecoEmRevisao: null,
        papel: linha.papel,
      };
      if (pinDoCadastro) pinsDoCadastro += 1;
      escritasDeCliente.set(linha.pessoa, { dados: cliente, merge: false });
    } else {
      // Mudança de endereço com ponto estabelecido (seção 8.3): o ponto foi
      // fixado para o endereço ANTIGO e pode não valer mais — o Admin Estoque
      // confirma. Revisão já aberta prevalece (o "antes" é o da primeira).
      const mudouDeLugar =
        existente.coordenada !== null && enderecosDivergem(existente.enderecoFiscal, endereco);
      const revisao = existente.enderecoEmRevisao ?? (mudouDeLugar ? existente.enderecoFiscal : null);
      enderecoAnterior = revisao;

      const campos: Partial<Cliente> = {
        nome: linha.nome,
        // Telefone: preenche quando a planilha traz; NUNCA apaga o que existe.
        // 413 de 2019 linhas do ciclo real vêm sem telefone e o ERP tem o
        // número (ele vai na NF-e) — a coluna é que fica em branco.
        telefone: telefone ?? existente.telefone,
        enderecoFiscal: endereco,
        enderecoEmRevisao: revisao,
      };
      if (linha.papel && linha.papel !== existente.papel) campos.papel = linha.papel;
      // Pin do cadastro só entra em quem AINDA não tem ponto: nunca por cima do
      // pin que o motorista confirmou em campo.
      if (!existente.coordenada && pinDoCadastro) {
        campos.coordenada = pinDoCadastro;
        campos.statusMapeamento = 'geocodificado';
        pinsDoCadastro += 1;
      }
      // Referência alimenta o dossiê, mas NUNCA por cima do que o motorista
      // escreveu: o conhecimento de quem foi lá vale mais que o cadastro.
      if (referencia && !existente.observacoes) campos.observacoes = referencia;

      cliente = { ...existente, ...campos };
      // Cliente que NASCEU nesta remessa continua com a escrita completa: só
      // acumula os campos por cima, sem virar `merge` de um doc que ainda não
      // existe no banco.
      const anterior = escritasDeCliente.get(linha.pessoa);
      escritasDeCliente.set(linha.pessoa, {
        dados: anterior ? { ...anterior.dados, ...campos } : campos,
        merge: anterior ? anterior.merge : true,
      });
    }
    clientes.set(linha.pessoa, cliente);

    const status = statusDaLinha(linha, cliente, enderecoAnterior);
    if (status === 'pendente_de_mapeamento' && !cliente.coordenada) aGeocodificar += 1;
    if (status === 'pendente_de_decisao' && enderecoAnterior) {
      relatorio.alertas.push({
        clienteId: linha.pessoa,
        nome: linha.nome,
        mensagem:
          'Endereço do cadastro mudou — confirme na aba Decisões se o ponto atual ainda vale.',
      });
    }

    escritasDePedido.push({
      colecao: 'pedidos',
      id: linha.codigoPedido,
      dados: {
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
      },
    });
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

  await repo.gravarEmLote([
    ...[...escritasDeCliente].map(([id, e]) => ({
      colecao: 'clientes' as const,
      id,
      dados: e.dados,
      merge: e.merge,
    })),
    ...escritasDePedido,
  ]);

  if (pinsDoCadastro > 0) {
    relatorio.alertas.push({
      clienteId: '',
      nome: 'Pin do cadastro',
      mensagem: `${pinsDoCadastro} cliente(s) tinham coordenada GPS digitada no cadastro do ERP — viraram pin exato, sem geocodificar nem mapear em campo.`,
    });
  }
  if (aGeocodificar > 0) {
    relatorio.alertas.push({
      clienteId: '',
      nome: 'Endereços a localizar',
      mensagem: `${aGeocodificar} entrega(s) ainda sem ponto no mapa. Use "Localizar endereços" abaixo — a busca é paga e roda em lotes, por isso não vai junto com a importação.`,
    });
  }

  return relatorio;
}

/**
 * Status do pedido SEM tocar a rede. Retirada não precisa de ponto (ninguém
 * vai lá); rota depende do cliente já ter coordenada — quem não tem espera o
 * passo de localização, que é separado justamente por ser pago e lento.
 */
function statusDaLinha(
  linha: LinhaPlanilha,
  cliente: Cliente,
  enderecoAnterior: Cliente['enderecoFiscal'] | null,
): StatusPedido {
  if (linha.tipoEntrega === 'retirada') return 'retirada';
  if (enderecoAnterior) return 'pendente_de_decisao';
  if (cliente.coordenada) return 'pronto_para_rota';
  return 'pendente_de_mapeamento';
}

/** Endereço rural é o caso que a geocodificação mais erra — exposto para o
 * passo de localização decidir o que vale a pena tentar. */
export { ehEnderecoRural };
