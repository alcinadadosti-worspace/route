import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type {
  CentroDistribuicao,
  Cliente,
  ConfigGeral,
  Pedido,
  Rota,
  Trilha,
  TrilhaBruta,
  Usuario,
} from '@rota/shared';
import type { Repositorio } from './repositorio.js';
import { appFirebase } from '../firebase.js';

/**
 * Persistência real no Firestore (Admin SDK — seção 6 da especificação).
 * Sem credenciais Firebase, retorna null e a API cai no repositório em
 * memória (o App admin é compartilhado com a autenticação — ver firebase.ts).
 */
export function criarRepositorioFirestore(): Repositorio | null {
  const app = appFirebase();
  if (!app) return null;

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

  async apagarPedido(chaveAcesso: string): Promise<void> {
    await this.pedidos.doc(chaveAcesso).delete();
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

  async obterConfig(): Promise<ConfigGeral> {
    const doc = await this.db.collection('config').doc('geral').get();
    return (doc.data() as ConfigGeral) ?? {};
  }

  async listarUsuarios(): Promise<Array<{ id: string } & Usuario>> {
    const resposta = await this.db.collection('usuarios').get();
    return resposta.docs.map((d) => ({ id: d.id, ...(d.data() as Usuario) }));
  }

  async salvarRota(rotaId: string, rota: Rota): Promise<void> {
    await this.db.collection('rotas').doc(rotaId).set(rota);
  }

  async publicarRotaAtomica(rotaId: string, rota: Rota, pedidoIds: string[]): Promise<void> {
    const lote = this.db.batch();
    lote.set(this.db.collection('rotas').doc(rotaId), rota);
    for (const id of pedidoIds) {
      lote.update(this.pedidos.doc(id), { status: 'em_rota', rotaId });
    }
    await lote.commit();
  }

  async obterRota(rotaId: string): Promise<({ id: string } & Rota) | null> {
    const doc = await this.db.collection('rotas').doc(rotaId).get();
    return doc.exists ? { id: doc.id, ...(doc.data() as Rota) } : null;
  }

  async listarRotas(): Promise<Array<{ id: string } & Rota>> {
    const resposta = await this.db.collection('rotas').orderBy('publicadaEm', 'desc').get();
    return resposta.docs.map((d) => ({ id: d.id, ...(d.data() as Rota) }));
  }

  async atualizarCliente(clienteId: string, campos: Partial<Cliente>): Promise<void> {
    await this.clientes.doc(clienteId).update(campos);
  }

  async salvarTrilhaBruta(id: string, bruta: TrilhaBruta): Promise<void> {
    await this.db.collection('trilhasBrutas').doc(id).set(bruta);
  }

  async listarTrilhasBrutasPendentes(): Promise<Array<{ id: string } & TrilhaBruta>> {
    const resposta = await this.db
      .collection('trilhasBrutas')
      .where('status', '==', 'pendente')
      .get();
    return resposta.docs.map((d) => ({ id: d.id, ...(d.data() as TrilhaBruta) }));
  }

  async atualizarTrilhaBruta(id: string, campos: Partial<TrilhaBruta>): Promise<void> {
    await this.db.collection('trilhasBrutas').doc(id).update(campos);
  }

  async salvarTrilha(trilhaId: string, trilha: Trilha): Promise<void> {
    await this.db.collection('trilhas').doc(trilhaId).set(trilha);
  }

  async atualizarTrilha(trilhaId: string, campos: Partial<Trilha>): Promise<void> {
    await this.db.collection('trilhas').doc(trilhaId).update(campos);
  }

  async obterTrilhaAtiva(clienteId: string): Promise<({ id: string } & Trilha) | null> {
    // Duas igualdades: atendida pelos índices automáticos de campo único.
    const resposta = await this.db
      .collection('trilhas')
      .where('clienteId', '==', clienteId)
      .where('ativa', '==', true)
      .limit(1)
      .get();
    const doc = resposta.docs[0];
    return doc ? { id: doc.id, ...(doc.data() as Trilha) } : null;
  }

  async listarTrilhas(): Promise<Array<{ id: string } & Trilha>> {
    const resposta = await this.db.collection('trilhas').get();
    return resposta.docs.map((d) => ({ id: d.id, ...(d.data() as Trilha) }));
  }

  async aplicarProcessamentoDeTrilha(dados: {
    trilhaAnteriorId: string | null;
    trilhaId: string;
    trilha: Trilha;
    clienteId: string;
    trilhaBrutaId: string;
    brutaCampos: Partial<TrilhaBruta>;
  }): Promise<void> {
    const lote = this.db.batch();
    if (dados.trilhaAnteriorId) {
      lote.update(this.db.collection('trilhas').doc(dados.trilhaAnteriorId), { ativa: false });
    }
    lote.set(this.db.collection('trilhas').doc(dados.trilhaId), dados.trilha);
    lote.update(this.clientes.doc(dados.clienteId), { trilhaAtivaId: dados.trilhaId });
    lote.update(this.db.collection('trilhasBrutas').doc(dados.trilhaBrutaId), dados.brutaCampos);
    await lote.commit();
  }
}
