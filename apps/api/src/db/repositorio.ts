import type {
  CentroDistribuicao,
  Cliente,
  Pedido,
  Rota,
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
  listarClientes(): Promise<Array<{ id: string } & Cliente>>;
  listarPedidos(): Promise<Array<{ id: string } & Pedido>>;
  obterCds(): Promise<Record<string, CentroDistribuicao>>;
  listarUsuarios(): Promise<Array<{ id: string } & Usuario>>;
  salvarRota(rotaId: string, rota: Rota): Promise<void>;
  listarRotas(): Promise<Array<{ id: string } & Rota>>;
  atualizarCliente(clienteId: string, campos: Partial<Cliente>): Promise<void>;
  salvarTrilhaBruta(id: string, bruta: TrilhaBruta): Promise<void>;
  listarTrilhasBrutasPendentes(): Promise<Array<{ id: string } & TrilhaBruta>>;
  atualizarTrilhaBruta(id: string, campos: Partial<TrilhaBruta>): Promise<void>;
  salvarTrilha(trilhaId: string, trilha: Trilha): Promise<void>;
  atualizarTrilha(trilhaId: string, campos: Partial<Trilha>): Promise<void>;
  obterTrilhaAtiva(clienteId: string): Promise<({ id: string } & Trilha) | null>;
  listarTrilhas(): Promise<Array<{ id: string } & Trilha>>;
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

export class RepositorioMemoria implements Repositorio {
  private clientes = new Map<string, Cliente>();
  private pedidos = new Map<string, Pedido>();

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

  async listarClientes(): Promise<Array<{ id: string } & Cliente>> {
    return [...this.clientes].map(([id, c]) => ({ id, ...c }));
  }

  async listarPedidos(): Promise<Array<{ id: string } & Pedido>> {
    return [...this.pedidos].map(([id, p]) => ({ id, ...p }));
  }

  async obterCds(): Promise<Record<string, CentroDistribuicao>> {
    return this.cds;
  }

  async listarUsuarios(): Promise<Array<{ id: string } & Usuario>> {
    return [{ id: 'motorista-demo', nome: 'Motorista Demo', papel: 'motorista', ativo: true }];
  }

  private rotas = new Map<string, Rota>();

  async salvarRota(rotaId: string, rota: Rota): Promise<void> {
    this.rotas.set(rotaId, rota);
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
