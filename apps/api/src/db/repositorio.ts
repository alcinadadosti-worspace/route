import type { Cliente, Pedido } from '@rota/shared';

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
}
