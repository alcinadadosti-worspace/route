import { initializeApp, cert, applicationDefault, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { CentroDistribuicao, Cliente, Pedido } from '@rota/shared';
import type { Repositorio } from './repositorio.js';

/**
 * Persistência real no Firestore (Admin SDK — seção 6 da especificação).
 * Credenciais, em ordem de preferência:
 *   1. FIREBASE_SERVICE_ACCOUNT — conteúdo JSON da service account
 *      (variável de ambiente no Render);
 *   2. GOOGLE_APPLICATION_CREDENTIALS — caminho do arquivo .json
 *      (desenvolvimento local).
 * Sem nenhuma das duas, retorna null e a API cai no repositório em memória.
 */
export function criarRepositorioFirestore(): Repositorio | null {
  const conteudo = process.env.FIREBASE_SERVICE_ACCOUNT;
  const caminho = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!conteudo && !caminho) return null;

  const app: App = initializeApp({
    credential: conteudo ? cert(JSON.parse(conteudo)) : applicationDefault(),
  });
  const db = getFirestore(app);
  // Campos opcionais ausentes (ex.: enderecoFiscal.complemento) viram undefined
  // no modelo; o Firestore rejeitaria o documento sem esta opção.
  db.settings({ ignoreUndefinedProperties: true });
  return new RepositorioFirestore(db);
}

class RepositorioFirestore implements Repositorio {
  constructor(private db: Firestore) {}

  private get clientes() {
    return this.db.collection('clientes');
  }

  private get pedidos() {
    return this.db.collection('pedidos');
  }

  async obterCliente(clienteId: string): Promise<Cliente | null> {
    const doc = await this.clientes.doc(clienteId).get();
    return doc.exists ? (doc.data() as Cliente) : null;
  }

  async salvarCliente(clienteId: string, cliente: Cliente): Promise<void> {
    await this.clientes.doc(clienteId).set(cliente);
  }

  async obterPedido(chaveAcesso: string): Promise<Pedido | null> {
    const doc = await this.pedidos.doc(chaveAcesso).get();
    return doc.exists ? (doc.data() as Pedido) : null;
  }

  async salvarPedido(chaveAcesso: string, pedido: Pedido): Promise<void> {
    await this.pedidos.doc(chaveAcesso).set(pedido);
  }

  async listarClientes(): Promise<Array<{ id: string } & Cliente>> {
    const resposta = await this.clientes.get();
    return resposta.docs.map((d) => ({ id: d.id, ...(d.data() as Cliente) }));
  }

  async listarPedidos(): Promise<Array<{ id: string } & Pedido>> {
    const resposta = await this.pedidos.orderBy('emitidoEm', 'desc').get();
    return resposta.docs.map((d) => ({ id: d.id, ...(d.data() as Pedido) }));
  }

  async obterCds(): Promise<Record<string, CentroDistribuicao>> {
    const doc = await this.db.collection('config').doc('cds').get();
    return (doc.data() as Record<string, CentroDistribuicao>) ?? {};
  }
}
