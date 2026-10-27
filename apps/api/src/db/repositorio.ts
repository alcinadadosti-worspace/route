import type {
  CentroDistribuicao,
  Cliente,
  ConfigGeral,
  EnderecoFiscal,
  Entrega,
  GeoPonto,
  Pedido,
  PosicaoMotorista,
  Rota,
  StatusMapeamento,
  StatusPedido,
  Trilha,
  TrilhaBruta,
  Usuario,
} from '@rota/shared';

/**
 * Camada de persistência da API.
 * Em produção a implementação é Firestore via Admin SDK (a fonte de verdade — seção 6);
 * a implementação em memória serve ao desenvolvimento local e aos testes enquanto o
 * projeto Firebase não está provisionado (Fase 0) e continua útil no CI depois.
 */
export interface Repositorio {
  obterCliente(clienteId: string): Promise<Cliente | null>;
  salvarCliente(clienteId: string, cliente: Cliente): Promise<void>;
  obterPedido(chaveAcesso: string): Promise<Pedido | null>;
  salvarPedido(chaveAcesso: string, pedido: Pedido): Promise<void>;
  apagarPedido(chaveAcesso: string): Promise<void>;
  listarClientes(): Promise<Array<{ id: string } & Cliente>>;
  listarPedidos(): Promise<Array<{ id: string } & Pedido>>;
  obterCds(): Promise<Record<string, CentroDistribuicao>>;
  /** Doc `config/geral` — overrides operacionais (mapa, parâmetros de trilha). */
  obterConfig(): Promise<ConfigGeral>;
  listarUsuarios(): Promise<Array<{ id: string } & Usuario>>;
  salvarRota(rotaId: string, rota: Rota): Promise<void>;
  /**
   * Publica a rota e move os pedidos para `em_rota` numa TRANSAÇÃO que confere,
   * no instante da escrita, que cada pedido ainda está no status em que foi
   * lido (`statusLido`). Se algum mudou, nada é gravado e volta o primeiro.
   *
   * A conferência tem de estar AQUI, e não só antes: entre ler os pedidos e
   * gravar há a chamada ao OSRM (segundos; dezenas no cold-start). Duas
   * publicações com o mesmo pedido nesse intervalo passavam ambas pela
   * checagem e gravavam ambas — reproduzido: duas rotas com a mesma parada,
   * dois motoristas com a mesma entrega, e o pedido apontando só para a última.
   */
  publicarRotaAtomica(
    rotaId: string,
    rota: Rota,
    statusLido: Record<string, StatusPedido>,
  ): Promise<ConflitoPublicacao | null>;
  /**
   * Lê a rota e o que `fn` pedir (pedidos, clientes) e grava o que ela devolver
   * — tudo numa transação. `fn` pode rodar mais de uma vez (o Firestore repete
   * a transação na contenção), então não pode ter efeito fora do retorno.
   * Devolve null se a rota não existe.
   */
  transacaoNaRota<T>(
    rotaId: string,
    fn: (rota: Rota, ler: LeituraTransacao) => Promise<EscritaTransacao<T>>,
  ): Promise<{ resultado: T } | null>;
  obterRota(rotaId: string): Promise<({ id: string } & Rota) | null>;
  apagarRota(rotaId: string): Promise<void>;
  listarRotas(): Promise<Array<{ id: string } & Rota>>;
  /** Última posição compartilhada pelo motorista de cada rota (seção 11.4). */
  posicoesDasRotas(rotaIds: string[]): Promise<Record<string, PosicaoMotorista>>;
  /**
   * IDs das rotas em execução. Consulta FILTRADA de propósito: o painel busca
   * as posições a cada 20 s enquanto acompanha o dia, e ler a coleção inteira
   * de rotas a cada volta esgotaria a cota diária do Firestore sozinha.
   */
  idsDeRotasEmExecucao(): Promise<string[]>;
  /**
   * Rotas ABERTAS (publicada ou em execução) para o acompanhamento ao vivo.
   * Consulta filtrada: o painel busca isto a cada 20 s, e reler a coleção
   * inteira a cada volta esgotaria a cota — o histórico só cresce.
   */
  rotasAbertas(): Promise<Array<{ id: string } & Rota>>;
  /** Apaga a posição compartilhada de uma rota. Dado de localização não
   * sobrevive à rota que o gerou. */
  apagarPosicao(rotaId: string): Promise<void>;
  atualizarCliente(clienteId: string, campos: Partial<Cliente>): Promise<void>;
  /**
   * Gravação em LOTE para importação de volume. Existe porque doc a doc não
   * escala: a planilha do ERP tem ~2000 linhas e cada uma fazia 5 idas ao
   * Firestore — MEDIDO a 134 ms por ida, ~67 s só de banco, e o proxy do Render
   * cortava a requisição antes do fim (o navegador reportava como erro de CORS,
   * que despista). `merge` faz update parcial; sem ele, `set` do doc inteiro.
   */
  gravarEmLote(
    escritas: Array<
      | { colecao: 'clientes'; id: string; dados: Partial<Cliente>; merge?: boolean }
      | { colecao: 'pedidos'; id: string; dados: Pedido }
    >,
  ): Promise<void>;
  /** Só os IDs dos pedidos, numa consulta — o dedupe de uma remessa grande não
   * pode ser 2000 `get` individuais. */
  idsDePedidos(): Promise<Set<string>>;
  /**
   * IDs e nº do pedido de cada documento, numa consulta só. O pedido do XML
   * tem por id a chave de 44 dígitos; o da planilha, o `CodigoPedido` — que é
   * o `numeroPedido` do XML (297 de 297 pares). Sem cruzar os dois, soltar o
   * XML e a planilha do mesmo ciclo duplicava tudo: os "entregues no ERP" e os
   * cancelados voltavam prontos para a rota.
   */
  chavesDePedidos(): Promise<{ ids: Set<string>; idPorNumero: Map<string, string> }>;
  /** Pedidos num status — consulta filtrada, para não ler a coleção inteira a
   * cada lote da busca de endereço (eram ~600 leituras por lote). */
  pedidosComStatus(status: StatusPedido): Promise<Array<{ id: string } & Pedido>>;
  /** Clientes com estas latitudes exatas — para achar ponto repetido sem ler
   * a coleção inteira a cada lote da busca. */
  clientesNasLatitudes(lats: number[]): Promise<Array<{ id: string } & Cliente>>;
  /**
   * Grava campos do cliente SÓ se o `statusMapeamento` dele ainda é um dos
   * esperados; devolve os ids pulados. A busca de endereço leva 10–20 s por
   * lote, e um pin confirmado em campo nesse meio era sobrescrito pelo palpite.
   */
  atualizarClientesSe(
    alteracoes: Array<{ id: string; seStatus: StatusMapeamento[]; dados: Partial<Cliente> }>,
  ): Promise<string[]>;
  /**
   * Busca vários clientes por id numa ida só. A localização em lotes precisa
   * exatamente de N clientes — reler a coleção inteira a cada lote gastaria a
   * cota diária do Firestore num ciclo só (~1400 clientes × 10 lotes).
   */
  clientesPorIds(ids: string[]): Promise<Array<{ id: string } & Cliente>>;
  /** O mesmo para pedidos: a importação precisa do status de N pedidos já
   * existentes, e N `get` em série numa planilha do ciclo inteiro não cabem
   * no tempo do proxy. */
  pedidosPorIds(ids: string[]): Promise<Array<{ id: string } & Pedido>>;
  /**
   * Grava cada pedido SÓ se o status dele ainda é o que foi lido — senão
   * pula e devolve o id. Para quem grava o doc inteiro em lote a partir de uma
   * leitura (liberação, localização de endereços): um `set` cego por cima de
   * uma publicação, uma devolução ou do apagar de um cancelado desfazia o que
   * acabara de acontecer — o cancelado voltava pronto para sempre.
   */
  atualizarPedidosSeStatus(
    alteracoes: Array<{ id: string; statusEsperado: StatusPedido; dados: Pedido }>,
  ): Promise<string[]>;
  /** IDs dos pedidos que o ERP cancelou e a importação já viu. */
  idsDeCancelados(): Promise<Set<string>>;
  registrarCancelados(registros: Array<{ id: string; dados: PedidoCancelado }>): Promise<void>;
  /** Cadastro de revendedoras (ver `Revendedora`): grava, e consulta só o necessário. */
  gravarRevendedoras(registros: Array<{ id: string; dados: Revendedora }>): Promise<void>;
  revendedorasPorChaves(chaves: string[]): Promise<Array<{ id: string } & Revendedora>>;
  revendedorasPorIds(ids: string[]): Promise<Array<{ id: string } & Revendedora>>;
  /** Revendedoras com este nome (`chaveDeNome`) em QUALQUER cidade — consulta
   * por faixa da `chave` ("NOME|…"), até `limite`. */
  revendedorasComNome(nome: string, limite: number): Promise<Array<{ id: string } & Revendedora>>;
  /** Grava SÓ o `romaneio` destes pedidos (os que não existem mais são
   * pulados) — gravar o doc inteiro lido antes desfazia outro campo mudado
   * no meio. */
  anotarRomaneio(registros: Array<{ id: string; romaneio: string }>): Promise<void>;
  /** `clienteId` dos pedidos que esperam ponto. É exatamente a fila da
   * localização: pedido só fica `pendente_de_mapeamento` porque o cliente não
   * tem coordenada, e quem só faz retirada nunca entra (a operação não paga
   * para localizar quem vem buscar). */
  clientesComEntregaPendente(): Promise<Set<string>>;
  salvarTrilhaBruta(id: string, bruta: TrilhaBruta): Promise<void>;
  listarTrilhasBrutasPendentes(): Promise<Array<{ id: string } & TrilhaBruta>>;
  atualizarTrilhaBruta(id: string, campos: Partial<TrilhaBruta>): Promise<void>;
  salvarTrilha(trilhaId: string, trilha: Trilha): Promise<void>;
  atualizarTrilha(trilhaId: string, campos: Partial<Trilha>): Promise<void>;
  obterTrilhaAtiva(clienteId: string): Promise<({ id: string } & Trilha) | null>;
  listarTrilhas(): Promise<Array<{ id: string } & Trilha>>;
  /** Registros de entrega (seção 7.5) — base da produtividade (RF-25). */
  listarEntregas(): Promise<Entrega[]>;
  /**
   * Entregas de UMA rota. O motivo do insucesso e a hora só existem aqui — a
   * parada guarda apenas 'insucesso'. Consulta escopada de propósito: o painel
   * abre uma rota por vez e não tem por que ler o histórico inteiro.
   */
  listarEntregasDaRota(rotaId: string): Promise<Entrega[]>;
  /** Só a CONTAGEM (agregação: 1 leitura por mil registros) — o acompanhamento
   * pergunta a cada 20 s se há registro que a rota não refletiu. */
  contarEntregasDaRota(rotaId: string): Promise<number>;
  /**
   * Resultado do pós-processamento numa escrita só (atômica no Firestore):
   * desativa a trilha anterior, grava a nova, aponta o cliente para ela e
   * marca a bruta como processada. Sem isso, um crash no meio deixaria
   * trilha órfã ativa ou cliente apontando para trilha desativada.
   */
  aplicarProcessamentoDeTrilha(dados: {
    trilhaAnteriorId: string | null;
    trilhaId: string;
    trilha: Trilha;
    clienteId: string;
    trilhaBrutaId: string;
    brutaCampos: Partial<TrilhaBruta>;
  }): Promise<void>;
}

/** O pedido que mudou de status entre a leitura e a publicação. */
export interface ConflitoPublicacao {
  pedidoId: string;
  status: StatusPedido | null;
  rotaId: string | null;
}

export interface LeituraTransacao {
  pedido(id: string): Promise<Pedido | null>;
  cliente(id: string): Promise<Cliente | null>;
}

export type EscritaTransacao<T> =
  | { gravar: false; resultado: T }
  | {
      gravar: true;
      /** `null` apaga a rota (ficou sem parada e sem exceção). */
      rota: Rota | null;
      pedidos: Record<string, Partial<Pedido>>;
      /** Pedidos apagados na MESMA transação: tirar a parada da rota e apagar
       * o pedido em dois passos deixava uma baixa gravada no meio ser
       * sobrescrita pela rota antiga. */
      apagarPedidos?: string[];
      resultado: T;
    };

/**
 * Marca de pedido CANCELADO no ERP. O pedido em si é apagado (pedido do
 * usuário), mas sem uma marca o dedupe esquece dele: uma planilha mais velha,
 * de quando ele ainda estava ativo, o trazia de volta como novo.
 */
export interface PedidoCancelado {
  notaFiscal: number;
  clienteId: string;
  registradoEm: string;
}

/**
 * `revendedoras/{codigo}` — o cadastro de revendedoras do ERP, guardado À PARTE
 * dos clientes. Existe só para casar o ROMANEIO (que não traz código nem
 * telefone) com a pessoa certa. Não vira cliente de uma vez porque o cadastro
 * completo tem ~40 mil pessoas, a maioria desativada, e as abas Rotas, Pedidos,
 * Decisões e Clientes leem a coleção de clientes INTEIRA a cada abertura: 40 mil
 * documentos por clique. O cliente nasce quando chega um pedido dele.
 *
 * Sem CPF, aniversário nem e-mail. Nenhuma regra libera esta coleção: só o
 * servidor (Admin SDK) a lê.
 */
export interface Revendedora {
  nome: string;
  /** `chaveDeNome|chaveDeMunicipio` — o casamento consulta por igualdade aqui. */
  chave: string;
  telefone: string | null;
  papel: string | null;
  endereco: EnderecoFiscal;
  referencia: string;
  /** GPS digitado no complemento/referência do cadastro, quando houver. */
  pin: GeoPonto | null;
  /** "Ativo", "Cadastrado", "Desativado"… como o ERP escreve. */
  situacao: string | null;
  /**
   * Data do dado: o `emitidoEm` do pedido de onde ele saiu. null = veio do
   * cadastro, que não tem data (o enviado em 27/10/2026 é de 2025). Pedido de
   * 2026 é mais novo que o cadastro — sem a data, carregar o cadastro DEPOIS
   * trocaria o endereço novo pelo velho.
   */
  dadosDe: string | null;
  /**
   * O que cada FONTE disse desta pessoa; os campos de cima são calculados
   * daqui por uma regra fixa (`consolidarRevendedora`). Juntar registro com
   * registro, aos pares, perdia de onde cada campo tinha vindo: a base mudava
   * conforme a ORDEM das cargas (806 registros diferentes entre duas ordens) e
   * recarregar o mesmo arquivo regravava centenas, oscilando entre dois
   * estados. Ausente = registro gravado antes desta forma.
   */
  fontes?: FontesDaRevendedora;
}

/** Uma fonte de dado da revendedora. */
export interface FonteRevendedora {
  nome: string;
  /** Válidos, normalizados, na ordem de preferência DA FONTE (no cadastro: a
   * coluna do celular antes da do residencial). */
  telefones: string[];
  papel: string | null;
  endereco: EnderecoFiscal;
  referencia: string;
  pin: GeoPonto | null;
  /** Data do pedido; null no cadastro. */
  data: string | null;
  /** Código do pedido: desempata dois pedidos da mesma data. */
  codigo?: string;
  /** Só o cadastro tem. */
  situacao?: string | null;
}

export interface FontesDaRevendedora {
  /** O cadastro de revendedoras do ERP (vale o último carregado). */
  cadastro?: FonteRevendedora;
  /** O pedido de ENTREGA mais novo: o endereço onde ela recebeu. */
  pedido?: FonteRevendedora;
  /** O pedido de RETIRADA mais novo: o bloco dele é o do cadastro (residencial). */
  retirada?: FonteRevendedora;
}

/** Clientes que o motorista da rota precisa ler (paradas e exceções). */
export function clientesDaRota(rota: Pick<Rota, 'paradas' | 'excecoes'>): string[] {
  return [...new Set([...rota.paradas, ...(rota.excecoes ?? [])].map((p) => p.clienteId))];
}

export class RepositorioMemoria implements Repositorio {
  private clientes = new Map<string, Cliente>();
  private pedidos = new Map<string, Pedido>();
  /**
   * Fila das transações: em memória, duas `fn` assíncronas se intercalariam
   * nos `await` e o teste de corrida passaria por sorte. Uma de cada vez é o
   * que o Firestore garante de verdade.
   */
  private fila: Promise<unknown> = Promise.resolve();

  private exclusivo<T>(fn: () => Promise<T>): Promise<T> {
    const vez = this.fila.then(fn, fn);
    this.fila = vez.catch(() => undefined);
    return vez;
  }

  async obterCliente(clienteId: string): Promise<Cliente | null> {
    return this.clientes.get(clienteId) ?? null;
  }

  async salvarCliente(clienteId: string, cliente: Cliente): Promise<void> {
    this.clientes.set(clienteId, cliente);
  }

  async obterPedido(chaveAcesso: string): Promise<Pedido | null> {
    return this.pedidos.get(chaveAcesso) ?? null;
  }

  async salvarPedido(chaveAcesso: string, pedido: Pedido): Promise<void> {
    this.pedidos.set(chaveAcesso, pedido);
  }

  async apagarPedido(chaveAcesso: string): Promise<void> {
    this.pedidos.delete(chaveAcesso);
  }

  async listarClientes(): Promise<Array<{ id: string } & Cliente>> {
    return [...this.clientes].map(([id, c]) => ({ id, ...c }));
  }

  async listarPedidos(): Promise<Array<{ id: string } & Pedido>> {
    // A CHAVE manda: `{ ...p, id }` e não `{ id, ...p }` — um documento que
    // carregasse um campo `id` sobrescreveria a chave e a listagem devolveria
    // o id errado, que é dificílimo de perceber depois.
    return [...this.pedidos].map(([id, p]) => ({ ...p, id }));
  }

  async obterCds(): Promise<Record<string, CentroDistribuicao>> {
    return this.cds;
  }

  async obterConfig(): Promise<ConfigGeral> {
    return this.config;
  }

  async listarUsuarios(): Promise<Array<{ id: string } & Usuario>> {
    return [{ id: 'motorista-demo', nome: 'Motorista Demo', papel: 'motorista', ativo: true }];
  }

  private rotas = new Map<string, Rota>();

  async salvarRota(rotaId: string, rota: Rota): Promise<void> {
    this.rotas.set(rotaId, rota);
  }

  async publicarRotaAtomica(
    rotaId: string,
    rota: Rota,
    statusLido: Record<string, StatusPedido>,
  ): Promise<ConflitoPublicacao | null> {
    return this.exclusivo(async () => {
      for (const [id, status] of Object.entries(statusLido)) {
        const atual = this.pedidos.get(id);
        if (!atual || atual.status !== status) {
          return { pedidoId: id, status: atual?.status ?? null, rotaId: atual?.rotaId ?? null };
        }
      }
      this.rotas.set(rotaId, rota);
      for (const id of Object.keys(statusLido)) {
        this.pedidos.set(id, { ...this.pedidos.get(id)!, status: 'em_rota', rotaId });
      }
      for (const clienteId of clientesDaRota(rota)) {
        const c = this.clientes.get(clienteId);
        if (c) this.clientes.set(clienteId, { ...c, visivelPara: { ...c.visivelPara, [rota.motoristaId]: true } });
      }
      return null;
    });
  }

  async transacaoNaRota<T>(
    rotaId: string,
    fn: (rota: Rota, ler: LeituraTransacao) => Promise<EscritaTransacao<T>>,
  ): Promise<{ resultado: T } | null> {
    return this.exclusivo(async () => {
      const rota = this.rotas.get(rotaId);
      if (!rota) return null;
      const escrita = await fn(structuredClone(rota), {
        pedido: async (id) => this.pedidos.get(id) ?? null,
        cliente: async (id) => this.clientes.get(id) ?? null,
      });
      if (escrita.gravar) {
        if (escrita.rota) this.rotas.set(rotaId, escrita.rota);
        else this.rotas.delete(rotaId);
        for (const [id, campos] of Object.entries(escrita.pedidos)) {
          const pedido = this.pedidos.get(id);
          if (pedido) this.pedidos.set(id, { ...pedido, ...campos });
        }
        for (const id of escrita.apagarPedidos ?? []) this.pedidos.delete(id);
      }
      return { resultado: escrita.resultado };
    });
  }

  async obterRota(rotaId: string): Promise<({ id: string } & Rota) | null> {
    const rota = this.rotas.get(rotaId);
    return rota ? { id: rotaId, ...rota } : null;
  }

  async apagarRota(rotaId: string): Promise<void> {
    this.rotas.delete(rotaId);
  }

  async listarRotas(): Promise<Array<{ id: string } & Rota>> {
    return [...this.rotas].map(([id, r]) => ({ id, ...r }));
  }

  private trilhasBrutas = new Map<string, TrilhaBruta>();
  private trilhas = new Map<string, Trilha>();

  async atualizarCliente(clienteId: string, campos: Partial<Cliente>): Promise<void> {
    const atual = this.clientes.get(clienteId);
    if (atual) this.clientes.set(clienteId, { ...atual, ...campos });
  }

  async gravarEmLote(
    escritas: Array<
      | { colecao: 'clientes'; id: string; dados: Partial<Cliente>; merge?: boolean }
      | { colecao: 'pedidos'; id: string; dados: Pedido }
    >,
  ): Promise<void> {
    for (const e of escritas) {
      if (e.colecao === 'pedidos') {
        this.pedidos.set(e.id, e.dados);
      } else if (e.merge) {
        // `set(merge)` do Firestore CRIA o doc quando não existe — o fake tem
        // de fazer o mesmo, senão um teste passa aqui e o comportamento diverge
        // em produção.
        const atual = this.clientes.get(e.id);
        this.clientes.set(e.id, { ...(atual ?? ({} as Cliente)), ...e.dados } as Cliente);
      } else {
        this.clientes.set(e.id, e.dados as Cliente);
      }
    }
  }

  async idsDePedidos(): Promise<Set<string>> {
    return new Set(this.pedidos.keys());
  }

  async chavesDePedidos(): Promise<{ ids: Set<string>; idPorNumero: Map<string, string> }> {
    const idPorNumero = new Map<string, string>();
    for (const [id, p] of this.pedidos) {
      if (p.numeroPedido) idPorNumero.set(p.numeroPedido, id);
      if (p.codigoExterno) idPorNumero.set(p.codigoExterno, id);
    }
    return { ids: new Set(this.pedidos.keys()), idPorNumero };
  }

  async pedidosComStatus(status: StatusPedido): Promise<Array<{ id: string } & Pedido>> {
    return [...this.pedidos].filter(([, p]) => p.status === status).map(([id, p]) => ({ ...p, id }));
  }

  async clientesNasLatitudes(lats: number[]): Promise<Array<{ id: string } & Cliente>> {
    const procuradas = new Set(lats);
    return [...this.clientes]
      .filter(([, c]) => c.coordenada && procuradas.has(c.coordenada.lat))
      .map(([id, c]) => ({ ...c, id }));
  }

  async atualizarClientesSe(
    alteracoes: Array<{ id: string; seStatus: StatusMapeamento[]; dados: Partial<Cliente> }>,
  ): Promise<string[]> {
    return this.exclusivo(async () => {
      const pulados: string[] = [];
      for (const a of alteracoes) {
        const atual = this.clientes.get(a.id);
        if (!atual || !a.seStatus.includes(atual.statusMapeamento)) pulados.push(a.id);
        else this.clientes.set(a.id, { ...atual, ...a.dados });
      }
      return pulados;
    });
  }

  private posicoes = new Map<string, PosicaoMotorista>();

  async posicoesDasRotas(rotaIds: string[]): Promise<Record<string, PosicaoMotorista>> {
    const saida: Record<string, PosicaoMotorista> = {};
    for (const id of rotaIds) {
      const p = this.posicoes.get(id);
      if (p) saida[id] = p;
    }
    return saida;
  }

  async idsDeRotasEmExecucao(): Promise<string[]> {
    const saida: string[] = [];
    for (const [id, r] of this.rotas) if (r.status === 'em_execucao') saida.push(id);
    return saida;
  }

  async rotasAbertas(): Promise<Array<{ id: string } & Rota>> {
    const saida: Array<{ id: string } & Rota> = [];
    for (const [id, r] of this.rotas) {
      if (r.status === 'publicada' || r.status === 'em_execucao') saida.push({ ...r, id });
    }
    return saida;
  }

  async apagarPosicao(rotaId: string): Promise<void> {
    this.posicoes.delete(rotaId);
  }

  /** Só para teste: o app do motorista escreve direto no Firestore. */
  async salvarPosicao(rotaId: string, posicao: PosicaoMotorista): Promise<void> {
    this.posicoes.set(rotaId, posicao);
  }

  async clientesPorIds(ids: string[]): Promise<Array<{ id: string } & Cliente>> {
    const saida: Array<{ id: string } & Cliente> = [];
    for (const id of ids) {
      const c = this.clientes.get(id);
      if (c) saida.push({ ...c, id });
    }
    return saida;
  }

  private cancelados = new Map<string, PedidoCancelado>();

  async atualizarPedidosSeStatus(
    alteracoes: Array<{ id: string; statusEsperado: StatusPedido; dados: Pedido }>,
  ): Promise<string[]> {
    return this.exclusivo(async () => {
      const conflitos: string[] = [];
      for (const a of alteracoes) {
        if (this.pedidos.get(a.id)?.status !== a.statusEsperado) conflitos.push(a.id);
        else this.pedidos.set(a.id, a.dados);
      }
      return conflitos;
    });
  }

  async idsDeCancelados(): Promise<Set<string>> {
    return new Set(this.cancelados.keys());
  }

  async registrarCancelados(registros: Array<{ id: string; dados: PedidoCancelado }>): Promise<void> {
    for (const r of registros) this.cancelados.set(r.id, r.dados);
  }

  private revendedoras = new Map<string, Revendedora>();

  async gravarRevendedoras(registros: Array<{ id: string; dados: Revendedora }>): Promise<void> {
    for (const r of registros) this.revendedoras.set(r.id, r.dados);
  }

  async revendedorasPorChaves(chaves: string[]): Promise<Array<{ id: string } & Revendedora>> {
    const procuradas = new Set(chaves);
    return [...this.revendedoras].filter(([, r]) => procuradas.has(r.chave)).map(([id, r]) => ({ ...r, id }));
  }

  async revendedorasPorIds(ids: string[]): Promise<Array<{ id: string } & Revendedora>> {
    return ids.flatMap((id) => {
      const r = this.revendedoras.get(id);
      return r ? [{ ...r, id }] : [];
    });
  }

  async anotarRomaneio(registros: Array<{ id: string; romaneio: string }>): Promise<void> {
    for (const { id, romaneio } of registros) {
      const p = this.pedidos.get(id);
      if (p) this.pedidos.set(id, { ...p, romaneio });
    }
  }

  async revendedorasComNome(nome: string, limite: number): Promise<Array<{ id: string } & Revendedora>> {
    return [...this.revendedoras]
      .filter(([, r]) => r.chave.startsWith(`${nome}|`))
      .sort(([, a], [, b]) => a.chave.localeCompare(b.chave))
      .slice(0, limite)
      .map(([id, r]) => ({ ...r, id }));
  }

  async pedidosPorIds(ids: string[]): Promise<Array<{ id: string } & Pedido>> {
    const saida: Array<{ id: string } & Pedido> = [];
    for (const id of ids) {
      const p = this.pedidos.get(id);
      if (p) saida.push({ ...p, id });
    }
    return saida;
  }

  async clientesComEntregaPendente(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const p of this.pedidos.values()) {
      if (p.status === 'pendente_de_mapeamento') ids.add(p.clienteId);
    }
    return ids;
  }

  async salvarTrilhaBruta(id: string, bruta: TrilhaBruta): Promise<void> {
    this.trilhasBrutas.set(id, bruta);
  }

  async listarTrilhasBrutasPendentes(): Promise<Array<{ id: string } & TrilhaBruta>> {
    return [...this.trilhasBrutas]
      .filter(([, b]) => b.status === 'pendente')
      .map(([id, b]) => ({ id, ...b }));
  }

  async atualizarTrilhaBruta(id: string, campos: Partial<TrilhaBruta>): Promise<void> {
    const atual = this.trilhasBrutas.get(id);
    if (atual) this.trilhasBrutas.set(id, { ...atual, ...campos });
  }

  async salvarTrilha(trilhaId: string, trilha: Trilha): Promise<void> {
    this.trilhas.set(trilhaId, trilha);
  }

  async atualizarTrilha(trilhaId: string, campos: Partial<Trilha>): Promise<void> {
    const atual = this.trilhas.get(trilhaId);
    if (atual) this.trilhas.set(trilhaId, { ...atual, ...campos });
  }

  async obterTrilhaAtiva(clienteId: string): Promise<({ id: string } & Trilha) | null> {
    for (const [id, t] of this.trilhas) {
      if (t.clienteId === clienteId && t.ativa) return { id, ...t };
    }
    return null;
  }

  async listarTrilhas(): Promise<Array<{ id: string } & Trilha>> {
    return [...this.trilhas].map(([id, t]) => ({ id, ...t }));
  }

  /** Espelho local de `entregas` para dev/testes. */
  entregas: Entrega[] = [];

  async listarEntregas(): Promise<Entrega[]> {
    return this.entregas;
  }

  async listarEntregasDaRota(rotaId: string): Promise<Entrega[]> {
    return this.entregas.filter((e) => e.rotaId === rotaId);
  }

  async contarEntregasDaRota(rotaId: string): Promise<number> {
    return new Set(this.entregas.filter((e) => e.rotaId === rotaId).map((e) => e.pedidoId)).size;
  }

  async aplicarProcessamentoDeTrilha(dados: {
    trilhaAnteriorId: string | null;
    trilhaId: string;
    trilha: Trilha;
    clienteId: string;
    trilhaBrutaId: string;
    brutaCampos: Partial<TrilhaBruta>;
  }): Promise<void> {
    if (dados.trilhaAnteriorId) await this.atualizarTrilha(dados.trilhaAnteriorId, { ativa: false });
    await this.salvarTrilha(dados.trilhaId, dados.trilha);
    await this.atualizarCliente(dados.clienteId, { trilhaAtivaId: dados.trilhaId });
    await this.atualizarTrilhaBruta(dados.trilhaBrutaId, dados.brutaCampos);
  }

  /** Espelho local de config/geral (overrides de trilha) para dev/testes. */
  config: ConfigGeral = {};

  /** Espelho local dos CDs reais (config/cds no Firestore) para dev/testes. */
  cds: Record<string, CentroDistribuicao> = {
    penedo: {
      nome: 'CD Penedo',
      coordenada: { lat: -10.2807606, lng: -36.5594998 },
    },
    palmeira: {
      nome: 'CD Palmeira dos Índios',
      coordenada: { lat: -9.4182497, lng: -36.6352813 },
    },
  };
}
