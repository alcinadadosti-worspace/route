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
  | 'retirada'
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
  /**
   * Segmentação da revendedora no ERP (`Papel` da planilha: Cobre → Diamante,
   * mais variantes "GB", "Revendedor" e "Consumidor Final"). Texto livre de
   * propósito — a lista real tem 10 valores e o ERP pode inventar outros;
   * validar aqui derrubaria importação por causa de rótulo novo.
   */
  papel?: string | null;
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
  /**
   * `transp/modFrete` da NF-e, guardado como FATO da nota (não como decisão).
   * `'9'` = sem ocorrência de transporte; `'1'` = frete por conta do
   * destinatário. Medido nas 3507 notas reais e nas 318 que o escritório
   * rotulou como retirada: as 318 são `'9'`, sem uma exceção, e nenhuma nota
   * `'1'` sequer se parece com elas (todas têm caixa e lote de remessa).
   *
   * Serve para SUGERIR `modoEntrega` na aba Decisões — nunca para decidir
   * sozinho. Ausente em pedidos importados antes deste campo existir.
   */
  modFrete?: '1' | '9';
  /**
   * Escolha do escritório: este pedido sai no caminhão ou a revendedora retira?
   * Ausente = ainda não perguntado (o pedido fica `pendente_de_decisao` e não
   * entra em rota). A escolha é reversível enquanto o pedido não saiu: se a
   * revendedora não aparecer, o escritório devolve para a fila.
   *
   * Na importação por PLANILHA o ERP responde sozinho (`Tipo de Entrega` é
   * explícito) e o campo já nasce preenchido, sem passar pela aba Decisões —
   * decisão do usuário em 01/08/2026, porque ali não há inferência.
   */
  modoEntrega?: 'rota' | 'retirada';
  /**
   * Quantidade FÍSICA de produtos (`QtdeMateriais` da planilha do ERP). A
   * importação por planilha não traz a lista de itens — sem este campo, o app
   * do motorista mostraria "0 itens" na porta do cliente com a caixa cheia.
   */
  quantidadeMateriais?: number;
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
  /**
   * Identificação da nota para o RECIBO ao cliente: a revendedora confere pelo
   * número do pedido (o que ela digitou no ERP), não pela chave de acesso.
   * Opcionais porque rotas antigas não os carregam — aí o app deriva a nota da
   * própria chave (`notaDaChaveDeAcesso`) e omite o pedido.
   */
  numeroNota?: number;
  serie?: number;
  numeroPedido?: string | null;
  itens: ItemPedido[];
  volumes: number;
  pesoBrutoKg: number;
  coordenada: GeoPonto;
  /** Minutos ACUMULADOS de direção desde o CD (não a perna): é o que responde
   * "que horas eu chego aí" e alimenta a janela do aviso ao cliente. */
  etaMin: number;
  /**
   * Km da PERNA — do ponto anterior até esta parada —, e NÃO o acumulado.
   * A diferença de semântica em relação ao `etaMin` logo acima é armadilha
   * pronta: numa rota real medida, as paradas saem 57,3 · 5,3 · 10,8 · 49,8 km
   * enquanto os ETAs saem 52 · 60 · 76 · 135 min. Somar estes números dá a
   * quilometragem da rota; comparar um com o outro não significa nada.
   */
  distanciaKm: number;
  status: StatusPedido;
  /** Denormalizado da situação de mapeamento do cliente (seção 9): o app do
   * motorista liga o "navegar e mapear" por aqui, sem depender do doc do cliente
   * estar no cache offline. Ausente em rotas antigas → o app recai no cliente. */
  precisaMapear?: boolean;
  /** Quantidade física de produtos quando o pedido veio da PLANILHA (que não
   * traz a lista de itens) — sem isto o app do motorista diria "0 itens" na
   * porta do cliente. Ausente em rotas de pedidos importados por XML. */
  quantidadeMateriais?: number;
  /**
   * Quando o motorista avisou o cliente pelo WhatsApp (seção 11.8). Serve ao
   * escritório: diante de um "ausente", saber se o cliente tinha sido avisado
   * é o que separa aprendizado de reclamação.
   */
  avisadoEm?: string | null;
  /**
   * Quando o recibo da entrega foi mandado ao cliente pelo WhatsApp. Fica na
   * PARADA, e não no registro de entrega, porque `entregas` é imutável por
   * regra — e o recibo é mandado depois de confirmar. Mesmo lugar e mesma
   * mecânica do `avisadoEm`.
   */
  reciboEnviadoEm?: string | null;
  /**
   * Quem recebeu, copiado do registro de entrega para a parada. O registro é a
   * fonte de verdade (imutável); esta cópia existe porque a TELA precisa do
   * nome — para mostrar no card e para citá-lo no recibo — e ler o doc de
   * entrega a cada card seria uma consulta por parada.
   */
  recebidoPor?: string | null;
  /**
   * Quando esta parada foi confirmada. Copiado do registro de entrega pelo mesmo
   * motivo do nome, e ele é INDISPENSÁVEL ao recibo: o recibo afirma um FATO
   * passado ("entrega registrada às 14h05"), e não uma previsão. Montá-lo com a
   * hora do toque faria o cliente receber a hora errada sempre que o motorista
   * demorasse a mandar.
   */
  confirmadaEm?: string | null;
  /**
   * Chegada ao cliente, detectada sozinha na navegação (permanência a <100 m do
   * pin por 30 s — ver chegada.ts no app do motorista). É o que separa VIAGEM
   * de ATENDIMENTO na produtividade. Ausente em rotas antigas e quando o
   * motorista não navegou até a parada — nesses casos a produtividade volta a
   * mostrar só o tempo somado, como antes.
   */
  chegouEm?: string | null;
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
  /**
   * Quem recebeu a mercadoria, perguntado na porta e digitado pelo motorista.
   * Sozinho é palavra dele; ao lado da hora e da distância até o ponto do
   * cliente, vira uma história que a revendedora confirma ou desmente na hora —
   * e é o que falta hoje quando aparece um "não recebi" semanas depois.
   * Nulo no insucesso (não houve quem recebesse) e em registros antigos.
   */
  recebidoPor?: string | null;
  /**
   * Foto do ato, no Storage. Opcional na entrega; o app INSISTE no insucesso,
   * porque a briga real é o "cliente ausente" contra o "eu estava em casa" — e
   * ali uma foto do portão fechado encerra a conversa. Caminho determinístico
   * (`entregas/{entregaId}/comprovante.jpg`), gravado junto com o registro
   * porque `entregas` é imutável; a imagem sobe pela fila e chega depois.
   */
  comprovantePath?: string | null;
}

/**
 * Produtividade do motorista (RF-25) — contrato de `GET /api/produtividade`.
 * Calculado no servidor: os registros de entrega carregam posição GPS, e somar
 * no navegador exigiria despejar tudo isso no painel sem necessidade.
 */
export interface ProdutividadeMotorista {
  motoristaId: string;
  rotas: number;
  paradasPlanejadas: number;
  entregues: number;
  insucessos: number;
  /** Insucessos por motivo: ausente é falha de aviso, não localizado é de mapa. */
  porMotivo: Record<string, number>;
  kmPlanejados: number;
  /**
   * Mediana do intervalo entre confirmações consecutivas — VIAGEM + ATENDIMENTO
   * juntos, porque a hora de chegada no cliente ainda não é gravada. Mediana e
   * não média: uma parada para almoçar distorceria a média.
   */
  minutosPorParadaMediana: number | null;
  /**
   * Da primeira à última confirmação de cada rota, somado. Subestima: o trecho
   * do CD até a primeira parada não tem como ser medido sem hora de saída.
   */
  minutosEmRota: number | null;
  avisados: number;
  /**
   * O laço causal do aviso por WhatsApp (seção 11.8): se avisar funciona, a
   * ausência tem de ser mais rara entre os avisados.
   */
  ausenciasAvisados: number;
  ausenciasNaoAvisados: number;
  /**
   * Conhecimento que ele acrescentou à base — pin confirmado e trilha gravada.
   * É produtividade que COMPÕE: mapear um cliente rural hoje deixa toda rota
   * futura até ele mais rápida, para qualquer motorista. Contar só entregas por
   * hora premiaria quem corre e ignora o mato.
   */
  pinsConfirmados: number;
  trilhasGravadas: number;
  /**
   * Mediana de minutos entre a chegada detectada (`chegouEm`) e a confirmação —
   * o ATENDIMENTO puro, sem a viagem. Null quando nenhuma parada da janela tem
   * chegada registrada (rotas antigas, ou paradas sem navegação aberta).
   */
  minutosAtendimentoMediana: number | null;
  /** Quantas paradas tinham chegada registrada — qualifica a mediana acima. */
  chegadasRegistradas: number;
  /**
   * Mercadoria efetivamente entregue.
   *
   * `itensEntregues` é a SOMA DAS QUANTIDADES (`qCom` de cada linha da nota) —
   * "item" no sentido que a operação usa: três frascos do mesmo desodorante são
   * três itens. `produtosDistintos` é quantas LINHAS a nota tem. Os dois não se
   * confundem porque nas 3507 notas reais a média é 24,1 itens em 8,3 linhas:
   * contar linha em vez de quantidade subestimaria o trabalho em três vezes.
   *
   * Somar quantidades entre linhas só é legítimo porque `uCom` é `UN` nas 28.088
   * linhas da base — não há caixa nem fardo se misturando à unidade.
   */
  itensEntregues: number;
  produtosDistintos: number;
  volumesEntregues: number;
  pesoEntregueKg: number;
  /**
   * Entregas cuja nota não informou volume nem peso (~1/3 das notas reais, ver
   * seção 8.2). Sem este número, a soma de peso pareceria a carga total do dia
   * quando é só a parte declarada.
   */
  entregasSemCarga: number;
  /** Rota a rota, para ver o dia em vez da média do período. */
  rotas_detalhe: ProdutividadeRota[];
}

/** Uma rota no relatório de produtividade. */
export interface ProdutividadeRota {
  rotaId: string;
  data: string;
  paradas: number;
  entregues: number;
  insucessos: number;
  /** Soma das quantidades; ver `ProdutividadeMotorista.itensEntregues`. */
  itensEntregues: number;
  produtosDistintos: number;
  volumesEntregues: number;
  pesoEntregueKg: number;
  entregasSemCarga: number;
  kmPlanejados: number;
}

/**
 * Cliente que mais dá "ausente" na janela — o alvo prioritário do aviso de
 * chegada e da combinação de horário. A leitura que importa é o par: ausência
 * COM aviso enviado sugere horário ruim; SEM aviso, sugere começar a avisar.
 */
export interface AusenciaPorCliente {
  clienteId: string;
  nome: string;
  ausencias: number;
  /** Dessas ausências, em quantas o cliente tinha sido avisado pelo WhatsApp. */
  avisadas: number;
}

export interface RelatorioProdutividade {
  desde: string;
  ate: string;
  motoristas: ProdutividadeMotorista[];
  /** Top 5 — o ranking é sobre o CLIENTE, não sobre o motorista. */
  ausenciasPorCliente: AusenciaPorCliente[];
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
  /** Notas que a importação não roteiriza sozinha — aguardam o escritório na aba
   * Decisões. Soma as três perguntas possíveis (endereço de entrega divergente,
   * cadastro que mudou de lugar, e rota × retirada). */
  pendentesDeDecisao: number;
  /**
   * Quantas das `pendentesDeDecisao` são a pergunta de RETIRADA no balcão.
   * Contada à parte porque é metade de uma importação típica, enquanto as de
   * endereço são raras: sem separar, o operador leria "60 aguardando endereço"
   * e procuraria um problema que não existe. Ausente em relatórios antigos.
   * Só a importação por XML usa (na planilha o ERP decide, não pergunta).
   */
  retiradaAConfirmar?: number;
  /** Importação por planilha: pedidos que o ERP já marcou como retirada no
   * balcão — classificados direto, sem passar pela aba Decisões. */
  retiradas?: number;
  /** Importação por planilha: linhas com `SituaçãoComercial = Cancelado`,
   * ignoradas de propósito (pedido cancelado não gera entrega). */
  canceladas?: number;
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
  /**
   * Notas que chegaram sem volume nem peso. Não é defeito do parser: o ERP
   * emissor manda `<vol>` com `qVol=0` e `pesoB=0.000`, ou omite o bloco. Vale
   * contar porque quem carrega o caminhão precisa desse número — e o conserto
   * é no ERP, não aqui.
   */
  semCarga: number;
}
