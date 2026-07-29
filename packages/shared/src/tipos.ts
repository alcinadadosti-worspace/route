/**
 * Modelo de dados do sistema (espelha as coleções do Firestore — seção 7 da especificação).
 * No Firestore, geopoints e timestamps usam os tipos nativos do SDK; aqui o modelo é
 * neutro (lat/lng e ISO 8601) para servir a API, os apps e os testes.
 */

import type { ParametrosTrilha } from './trilha.js';
import type { ParametrosAviso } from './aviso.js';

export type Papel = 'admin' | 'operador' | 'motorista';

export type StatusMapeamento = 'nao_mapeado' | 'aproximado' | 'geocodificado' | 'mapeado';

export type StatusPedido =
  | 'importado'
  | 'pendente_de_mapeamento'
  | 'pendente_de_decisao'
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
  /**
   * Endereço fiscal para o qual o ponto atual foi estabelecido, guardado quando
   * o cadastro muda de lugar e o ponto ainda não foi revisto (seção 8.3).
   * Enquanto não for null, TODO pedido novo do cliente nasce
   * `pendente_de_decisao` — a marca vive no CLIENTE, e não só no pedido, porque
   * a segunda nota da mesma remessa já encontra o cadastro atualizado e
   * escaparia com o ponto vencido. Ausente (cadastro antigo) = null.
   */
  enderecoEmRevisao?: EnderecoFiscal | null;
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
  /**
   * Entrega em local diverso (bloco `<entrega>` da NF-e, seção 8.4): preenchido
   * só quando a nota traz endereço de entrega diferente do fiscal. O pedido
   * nasce `pendente_de_decisao` e o escritório escolhe na aba Decisões qual vale.
   * A escolha nunca toca o cadastro do cliente (endereço fiscal canônico).
   */
  enderecoEntrega?: EnderecoFiscal;
  /** Geocodificação do endereço de entrega (null = não localizado; o escritório
   * posiciona o pin na tela de decisão). */
  coordenadaEntrega?: GeoPonto | null;
  /** Escolha do escritório: true = a rota usa o endereço de entrega (override do
   * cliente); false/ausente = usa o endereço/coordenada do cliente. */
  usarEnderecoEntrega?: boolean;
  /**
   * Mudança de endereço do cadastro (seção 8.3): endereço fiscal que o cliente
   * tinha ANTES desta nota, preenchido só quando ele mudou de forma relevante e
   * o cliente já tinha um ponto (pin de campo, trilha ou geocodificação). Aquele
   * ponto foi estabelecido para o endereço antigo e pode não valer mais, então o
   * pedido nasce `pendente_de_decisao`: despachar no ponto velho levaria o
   * motorista ao lugar errado. O escritório confirma na aba Decisões.
   */
  enderecoAnterior?: EnderecoFiscal;
  /**
   * CD de origem, deduzido do CNPJ do EMITENTE da nota (seção 8.5). Null quando
   * o emitente não corresponde a nenhum CD cadastrado — aí o operador escolhe
   * na mão, como sempre foi.
   */
  cdId?: string | null;
}

/**
 * Parada publicada. Denormaliza o que o motorista precisa para entregar
 * (nome, endereço, contato, itens, volumes) — o app dele lê só `rotas` e
 * `clientes`; a coleção `pedidos`, com os valores da nota, fica restrita ao
 * escritório pelas security rules (seção 13).
 */
export interface ParadaRota {
  pedidoId: string;
  clienteId: string;
  nome: string;
  endereco: string;
  telefone: string | null;
  itens: ItemPedido[];
  volumes: number;
  pesoBrutoKg: number;
  coordenada: GeoPonto;
  etaMin: number;
  distanciaKm: number;
  status: StatusPedido;
  /** Denormalizado da situação de mapeamento do cliente (seção 9): o app do
   * motorista liga o "navegar e mapear" por aqui, sem depender do doc do cliente
   * estar no cache offline. Ausente em rotas antigas → o app recai no cliente. */
  precisaMapear?: boolean;
  /**
   * Quando o motorista avisou o cliente pelo WhatsApp (seção 11.8). Serve ao
   * escritório: diante de um "ausente", saber se o cliente tinha sido avisado
   * é o que separa aprendizado de reclamação.
   */
  avisadoEm?: string | null;
}

/** `rotas/{rotaId}` — seção 7.3. */
export interface Rota {
  data: string;
  motoristaId: string;
  origemCdId: string;
  origemNome: string;
  origemCoordenada: GeoPonto;
  retornaAoCd: boolean;
  paradas: ParadaRota[];
  polylinePlanejada: string;
  distanciaTotalKm: number;
  duracaoTotalMin: number;
  status: StatusRota;
  publicadaEm: string | null;
  concluidaEm: string | null;
}

/** `usuarios/{uid}` — espelho de perfil para listagens (seção 7.6). */
export interface Usuario {
  nome: string;
  papel: Papel;
  ativo: boolean;
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

/** Leitura de GPS aceita pelos filtros da gravação (seção 11.1). `t` em epoch ms. */
export interface PontoTrilha {
  lat: number;
  lng: number;
  precisaoM: number;
  t: number;
}

export type StatusTrilhaBruta = 'pendente' | 'processada' | 'descartada';

/**
 * `trilhasBrutas/{id}` — rastro cru gravado em campo, na fila offline do
 * Firestore até sincronizar; o backend pós-processa (seção 11.2) e o resultado
 * vira um documento em `trilhas`. Nada é processado no aparelho.
 */
export interface TrilhaBruta {
  clienteId: string;
  rotaId: string | null;
  pontos: PontoTrilha[];
  gravadaPor: string;
  iniciadaEm: string;
  finalizadaEm: string;
  status: StatusTrilhaBruta;
  processadaEm: string | null;
  motivoDescarte: string | null;
  /** ID do doc em `trilhas` quando o processamento gera trilha. */
  trilhaGerada: string | null;
}

/** `entregas/{entregaId}` — seção 7.5. Posição null quando o GPS falhar no toque. */
export interface Entrega {
  pedidoId: string;
  rotaId: string;
  clienteId: string;
  resultado: ResultadoEntrega;
  confirmadaEm: string;
  posicaoConfirmacao: GeoPonto | null;
  /** Autor do registro (uid) — accountability na trilha de auditoria. */
  gravadaPor: string;
}

/**
 * Bloco `mapa` do doc `config/geral` (seção 7.6): versão corrente do basemap
 * PMTiles no Storage (seção 12, camada 3). O app compara `versao` com a
 * instalada no OPFS e propõe o download quando o motorista está na base.
 */
export interface MapaOffline {
  /** Caminho no Storage (ex.: `mapas/alagoas-20260724.pmtiles`). */
  path: string;
  /** Data do extrato OSM no formato AAAAMMDD — comparável como string. */
  versao: string;
  /** Tamanho do arquivo — mostrado antes do download (egress é custo). */
  tamanhoBytes: number;
  atualizadoEm: string;
}

/**
 * Doc `config/geral` — parâmetros operacionais (seção 7.6). Além do mapa,
 * carrega overrides de `ParametrosTrilha` que apps e API mesclam sobre
 * `PARAMETROS_TRILHA_PADRAO`; ambos os blocos são opcionais.
 */
export interface ConfigGeral {
  mapa?: MapaOffline;
  trilha?: Partial<ParametrosTrilha>;
  /** Redação e ritmo do aviso ao cliente — ajustáveis sem deploy (seção 11.8). */
  aviso?: Partial<ParametrosAviso>;
}

/** Doc `config/cds` — centros de distribuição de partida (seção 7.6). */
export interface CentroDistribuicao {
  nome: string;
  endereco?: string;
  coordenada: GeoPonto;
  /**
   * CNPJ (só dígitos) da filial que emite as notas deste CD. É o que liga a
   * NF-e ao centro de distribuição sem ninguém digitar nada: o emitente da nota
   * identifica a origem. Ausente = este CD não é reconhecido automaticamente.
   */
  cnpj?: string;
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
  /** Notas com endereço de entrega divergente do fiscal — aguardam a escolha do
   * escritório na aba Decisões (seção 8.4). */
  pendentesDeDecisao: number;
  /** Destinos urbanos resolvidos pela geocodificação automática (seção 9). */
  geocodificados: number;
  /** Destinos aproximados (rural/impreciso, mas no município certo): despacháveis
   * com ponto grosseiro, a mapear em campo na 1ª entrega (seção 9). */
  aproximados: number;
  /** Seção 8.3: endereço fiscal mudou em cliente já mapeado — o pin continua válido? */
  alertas: Array<{ clienteId: string; nome: string; mensagem: string }>;
  /**
   * Quantas notas de cada CD de origem (seção 8.5), pelo CNPJ do emitente.
   * A chave `'—'` conta as que não casaram com nenhum CD cadastrado.
   */
  porCd: Record<string, number>;
}
