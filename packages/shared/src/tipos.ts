/**
 * Modelo de dados do sistema (espelha as coleções do Firestore — seção 7 da especificação).
 * No Firestore, geopoints e timestamps usam os tipos nativos do SDK; aqui o modelo é
 * neutro (lat/lng e ISO 8601) para servir a API, os apps e os testes.
 */

export type Papel = 'admin' | 'operador' | 'motorista';

export type StatusMapeamento = 'nao_mapeado' | 'geocodificado' | 'mapeado';

export type StatusPedido =
  | 'importado'
  | 'pendente_de_mapeamento'
  | 'pronto_para_rota'
  | 'em_rota'
  | 'entregue'
  | 'insucesso';

export type StatusRota = 'rascunho' | 'publicada' | 'em_execucao' | 'concluida';

export type ResultadoEntrega = 'entregue' | 'ausente' | 'nao_localizado' | 'recusa';

export interface GeoPonto {
  lat: number;
  lng: number;
}

export interface EnderecoFiscal {
  logradouro: string;
  numero: string;
  complemento?: string;
  bairro: string;
  municipio: string;
  uf: string;
  cep: string;
}

/** `clientes/{clienteId}` — clienteId = SHA-256 do CPF/CNPJ (seção 7.1). */
export interface Cliente {
  nome: string;
  documentoMascarado: string;
  telefone: string | null;
  email: string | null;
  enderecoFiscal: EnderecoFiscal;
  coordenada: GeoPonto | null;
  statusMapeamento: StatusMapeamento;
  trilhaAtivaId: string | null;
  mapeadoPor: string | null;
  mapeadoEm: string | null;
  fotoReferenciaPath: string | null;
  observacoes: string;
}

export interface ItemPedido {
  codigo: string;
  descricao: string;
  quantidade: number;
}

/** `pedidos/{chaveAcesso}` — chave de acesso (44 dígitos) como ID (seção 7.2). */
export interface Pedido {
  numeroNota: number;
  serie: number;
  numeroPedido: string | null;
  lote: string | null;
  clienteId: string;
  emitidoEm: string;
  itens: ItemPedido[];
  valorTotal: number;
  volumes: number;
  pesoBrutoKg: number;
  status: StatusPedido;
  rotaId: string | null;
  xmlStoragePath: string | null;
}

export interface ParadaRota {
  pedidoId: string;
  clienteId: string;
  coordenada: GeoPonto;
  etaMin: number;
  distanciaKm: number;
  status: StatusPedido;
}

/** `rotas/{rotaId}` — seção 7.3. */
export interface Rota {
  data: string;
  motoristaId: string;
  origemCdId: string;
  retornaAoCd: boolean;
  paradas: ParadaRota[];
  polylinePlanejada: string;
  distanciaTotalKm: number;
  duracaoTotalMin: number;
  status: StatusRota;
  publicadaEm: string | null;
  concluidaEm: string | null;
}

/** `trilhas/{trilhaId}` — trecho fora da malha OSM (seção 7.4). */
export interface Trilha {
  clienteId: string;
  polyline: string;
  pontoEntrada: GeoPonto;
  distanciaM: number;
  precisaoMediaM: number;
  ativa: boolean;
  gravadaPor: string;
  gravadaEm: string;
  versao: number;
}

/** `entregas/{entregaId}` — seção 7.5. */
export interface Entrega {
  pedidoId: string;
  rotaId: string;
  clienteId: string;
  resultado: ResultadoEntrega;
  confirmadaEm: string;
  posicaoConfirmacao: GeoPonto;
}

/** Doc `config/cds` — centros de distribuição de partida (seção 7.6). */
export interface CentroDistribuicao {
  nome: string;
  endereco?: string;
  coordenada: GeoPonto;
}

/** Parada da prévia de rota — contrato de `POST /api/rotas/previa` (RF-11). */
export interface ParadaPrevia {
  posicao: number;
  pedidoId: string;
  clienteId: string;
  nome: string;
  endereco: string;
  coordenada: GeoPonto;
  volumes: number;
  pesoBrutoKg: number;
}

/** Prévia de rota otimizada — resposta de `POST /api/rotas/previa`. */
export interface PreviaRota {
  cd: { id: string } & CentroDistribuicao;
  retornaAoCd: boolean;
  paradas: ParadaPrevia[];
  polyline: string;
  distanciaTotalKm: number;
  duracaoTotalMin: number;
}

/** Relatório de importação (RF-04) — contrato de `POST /api/importacoes`. */
export interface RelatorioImportacao {
  total: number;
  importados: number;
  duplicados: number;
  rejeitados: Array<{ arquivo: string; motivo: string }>;
  prontosParaRota: number;
  pendentesDeMapeamento: number;
  /** Destinos urbanos resolvidos pela geocodificação automática (seção 9). */
  geocodificados: number;
  /** Seção 8.3: endereço fiscal mudou em cliente já mapeado — o pin continua válido? */
  alertas: Array<{ clienteId: string; nome: string; mensagem: string }>;
}
