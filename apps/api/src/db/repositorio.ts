import type { CentroDistribuicao, Cliente, Pedido, Rota, Usuario } from '@rota/shared';

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
