# Rota Grupo Alcina Maria — Especificação Técnica e Funcional

**Versão 0.2 · 22/07/2026 — decisões da revisão incorporadas (registro na seção 18)**

---

## 1. Visão geral

### 1.1 O problema
A operação de entregas depende de um único motorista, que é a única pessoa que conhece os percursos — em especial os destinos em zona rural, cujos endereços fiscais não são localizáveis por geocodificação convencional. Exemplo real (NF-e 276165, pedido 499450697): *"POVOADO BREJO DOS BOIS, 83 — PRÓX A PISCINA, ZONA RURAL, JUNQUEIRO/AL, CEP 57270-000"*. O CEP terminado em 000 é o genérico do município inteiro, e a referência "próx a piscina" só é interpretável por quem já esteve lá. Ausência, doença ou férias do motorista paralisam ou degradam a operação.

### 1.2 Objetivo do sistema
Um PWA de roteirização e navegação de entregas que:

1. Importa os pedidos do dia a partir dos XMLs de NF-e (fonte única de dados, sem digitação);
2. Otimiza a ordem das paradas e traça as rotas na malha viária conhecida;
3. Na primeira entrega a cada destino não mapeado, captura o ponto exato (pin) e o caminho percorrido (trilha GPS) — transformando o conhecimento tácito do motorista em dado permanente da empresa, utilizável por qualquer condutor dali em diante.

### 1.3 Princípios de arquitetura
1. **Offline-first no campo.** O app do motorista opera o dia inteiro sem rede: dados da rota pré-carregados, mapa embarcado no aparelho, GPS (que independe de internet) e sincronização em fila automática.
2. **O campo não depende do backend.** Em rota, o app conversa apenas com o cache local do Firestore. A API no Render é ferramenta do escritório e de processamento (parse, geocodificação, otimização); se ela cair durante o dia, as entregas continuam.
3. **Destino entregue uma vez fica mapeado para sempre.** Coordenada confirmada e trilha aprendida são vinculadas ao **cliente**, não ao pedido — na próxima nota daquela revendedora, a navegação já nasce pronta.
4. **Mapa em primeiro plano no motorista; identidade visual rica no admin.** No campo, performance e bateria mandam; o 3D e as animações elaboradas vivem no painel do escritório.

---

## 2. Atores e permissões

| Papel | Quem é | O que faz | O que não vê |
|---|---|---|---|
| **Admin** | TI / gestão | Tudo: importa XML, monta e publica rotas, edita clientes/trilhas, gerencia usuários, vê métricas | — |
| **Operador** | Equipe do escritório | Importa XML, monta e publica rotas, resolve pendências de geocodificação | Gestão de usuários e configurações |
| **Motorista** | Condutor em campo | Vê a rota do dia, navega, confirma entregas, crava pins e grava trilhas | CPF do destinatário, valores financeiros da nota, rotas de outros dias/motoristas |

Papéis implementados via **custom claims** do Firebase Auth e espelhados nas security rules do Firestore (seção 13). Login por e-mail/senha; contas criadas apenas pelo Admin (sem autocadastro).

---

## 3. Fluxos operacionais

**Fluxo 1 — Importação do dia (escritório, online).** O operador arrasta os XMLs das notas do dia para o painel. A API valida cada arquivo (NF-e modelo 55 autorizada, `cStat=100` no protocolo), deduplica pela chave de acesso, extrai os campos (seção 8), cria/atualiza o cliente e registra o pedido com status `importado`. Pedidos cujo destino já tem coordenada confirmada entram como `pronto_para_rota`; os demais entram como `pendente_de_mapeamento` ou passam pela geocodificação (seção 9).

**Fluxo 2 — Montagem e publicação da rota (escritório, online).** O operador seleciona os pedidos do dia (ou aceita a sugestão de agrupamento por município/região), escolhe o CD de partida entre os dois cadastrados e aciona a otimização. A API consulta o OSRM (`/trip`) para ordenar as paradas, calcula o traçado e as estimativas, e o operador publica a rota para o motorista. Publicar dispara a **pré-carga**: o app do motorista, ainda no Wi-Fi da base, baixa para o cache local tudo que a rota exige (pedidos, clientes, coordenadas, trilhas, e o mapa se houver atualização).

**Fluxo 3 — Execução da entrega (campo, offline-capaz).** O motorista vê a lista ordenada de paradas e o traçado no mapa. Para cada parada: navega, contata o cliente se preciso (ligação ou WhatsApp em um toque), entrega, e confirma com um toque — o app registra data/hora e posição GPS da confirmação. Insucessos são registrados com motivo (ausente, endereço não localizado, recusa) para reentrega.

**Fluxo 4 — Mapeamento de destino novo em zona rural (campo, offline-capaz).** Para paradas `pendente_de_mapeamento`, ao tocar "a caminho desta parada" o app inicia automaticamente a gravação da trilha GPS. Ao chegar, o motorista posiciona o pin no ponto exato, fotografa a fachada como referência do local e registra observações se quiser ("portão azul", "ligar ao chegar") antes de confirmar. A trilha bruta e o pin ficam na fila de sincronização; quando a rede volta, o backend faz o pós-processamento (map-matching, seção 11) e o destino passa a `mapeado`.

**Fluxo 5 — Sincronização (automática).** Toda escrita feita em campo (confirmações, pins, trilhas, motivos de insucesso) entra na fila offline do Firestore e é despachada automaticamente ao reencontrar rede — seja um bolsão de 4G no caminho, seja o Wi-Fi da base no retorno. O painel do escritório reflete o progresso em tempo real sempre que o aparelho estiver online.

---

## 4. Requisitos funcionais

Prioridades: **[E]** essencial (sem isso o sistema não cumpre o objetivo) · **[I]** importante (entra logo após o núcleo) · **[D]** desejável (evolução).

### 4.1 Ingestão de pedidos (NF-e)
- **RF-01 [E]** Upload múltiplo de XMLs `procNFe` pelo painel, com parse, validação de autorização e deduplicação pela chave de acesso (reimportar o mesmo arquivo é inócuo).
- **RF-02 [E]** Extração dos campos da seção 8, incluindo número do pedido e lote a partir de `infCpl` por expressão regular tolerante, com campo editável caso o padrão do texto mude.
- **RF-03 [E]** Criação/atualização automática do cadastro de cliente a partir do destinatário da nota (chave de identidade na seção 7).
- **RF-04 [I]** Relatório de importação: quantos pedidos entraram, quantos duplicados, quantos com destino já mapeado, quantos pendentes.
- **RF-05 [D]** Ingestão automática (pasta monitorada ou e-mail) em vez de upload manual.

### 4.2 Clientes e mapeamento
- **RF-06 [E]** Cada cliente guarda: dados de contato, endereço fiscal original, coordenada confirmada (quando houver), status de mapeamento e trilhas associadas.
- **RF-07 [E]** Pin: o motorista posiciona/ajusta o ponto exato de entrega no mapa e confirma; a coordenada fica vinculada ao cliente com autoria e data.
- **RF-08 [E]** Trilha: gravação automática do rastro GPS ao dirigir para uma parada não mapeada (parâmetros na seção 11), com pós-processamento no backend para extrair só o trecho fora da malha viária conhecida.
- **RF-09 [I]** Reaprendizado: se o motorista percorrer um caminho substancialmente diferente para um destino já mapeado, o app pergunta ao final se o novo caminho deve virar o padrão.
- **RF-10 [I]** Edição de trilhas e pins pelo painel (corrigir, desativar, excluir), com histórico de versões.

### 4.3 Rotas
- **RF-11 [E]** Montagem de rota: seleção de pedidos, partida por um dos dois CDs cadastrados (com retorno ao CD de origem por padrão, desmarcável por rota), otimização da ordem das paradas via OSRM e visualização do traçado com distância e duração estimadas.
- **RF-12 [E]** Ajuste manual da ordem (arrastar paradas) após a otimização — o operador conhece restrições que o algoritmo não conhece.
- **RF-13 [E]** Publicação da rota para um motorista, disparando a pré-carga offline no aparelho dele.
- **RF-14 [I]** Reotimização parcial durante o dia (ex.: pedido cancelado ou incluído) com republicação.
- **RF-15 [D]** Suporte a múltiplos motoristas/rotas simultâneas no mesmo dia (o modelo de dados já nasce pronto para isso; a interface de divisão de carga vem depois).

### 4.4 App do motorista
- **RF-16 [E]** Rota do dia: lista ordenada de paradas com nome do cliente, endereço, itens/volumes/peso, status e — quando existirem — foto de referência e observações do local; mapa com traçado completo.
- **RF-17 [E]** Navegação por parada: traçado no mapa com reposicionamento contínuo; no trecho fora da malha, exibição da trilha aprendida com seta de direção e distância até o pin (seção 11).
- **RF-18 [E]** Confirmação de entrega em um toque, registrando timestamp e posição GPS; registro de insucesso com motivo.
- **RF-19 [E]** Contato rápido: botão de ligar e botão de WhatsApp (`https://wa.me/55` + telefone da nota normalizado).
- **RF-20 [E]** Tela sempre ativa durante navegação/gravação (Screen Wake Lock), com aviso para uso de suporte e carregador veicular.
- **RF-21 [E]** Dossiê do local: na primeira entrega (ou quando ainda faltar), o motorista fotografa a fachada/referência da casa e pode registrar uma observação livre. Foto e notas ficam vinculadas ao **cliente** e aparecem para qualquer motorista que navegar até lá — junto de pin e trilha, completam o conhecimento do local. Prova de entrega clássica (comprovante/recebedor) está fora de escopo por decisão.
- **RF-22 [D]** Instruções por voz sintetizada (Web Speech API) para reduzir olhares à tela.

### 4.5 Painel, acompanhamento e relatórios
- **RF-23 [E]** Painel de pendências de mapeamento: fila de destinos sem coordenada confiável, com endereço original e ferramenta de posicionamento manual pelo operador (quando ele souber onde é).
- **RF-24 [I]** Acompanhamento do dia: progresso da rota (entregues / restantes), última posição sincronizada, insucessos.
- **RF-25 [I]** Métricas históricas: entregas por dia, km rodados, tempo médio por parada, taxa de insucesso, cobertura de mapeamento (% de clientes com coordenada confirmada).
- **RF-26 — fora de escopo por decisão.** Notificação à revendedora via WhatsApp não será construída; se a necessidade surgir um dia, o caminho (webhook + Flow no Digital Engagement) não exige mudança de arquitetura.

### 4.6 Administração
- **RF-27 [E]** Gestão de usuários e papéis (criar, desativar, redefinir senha).
- **RF-28 [E]** Configurações: cadastro dos dois CDs de partida, parâmetros de gravação de trilha, versão do mapa embarcado.
- **RF-29 [I]** Auditoria: log de importações, publicações de rota e edições de trilha/pin (quem, quando).

---

## 5. Requisitos não funcionais

- **RNF-01 — Offline total em campo.** Com a pré-carga feita, 100% do fluxo do motorista (navegar, mapear, confirmar) funciona em modo avião. Critério de teste: executar uma rota completa com o aparelho sem chip.
- **RNF-02 — Aparelho-alvo.** Celular Android corporativo dedicado à rota: Android 11+ com Chrome atualizado, 3 GB de RAM, GPS. O mesmo PWA atende o painel no PC do escritório — uma base de código para os dois contextos, como decidido. iOS fora do alvo. Instalação via "Adicionar à tela inicial".
- **RNF-03 — Bateria.** Uma jornada de 8 h de navegação com tela ativa deve ser viável com carregador veicular; o app não usa 3D nem efeitos custosos no modo motorista.
- **RNF-04 — Legibilidade ao sol.** Tema claro de alto contraste disponível no app do motorista (seção 14); alvos de toque ≥ 48 px.
- **RNF-05 — Sincronização resiliente.** Nenhum dado de campo se perde por queda de rede; fila com retry e resolução last-write-wins (adequada ao domínio: escritores raramente concorrem no mesmo documento).
- **RNF-06 — Segurança.** Acesso 100% autenticado; security rules por papel testadas em CI; HTTPS em tudo (padrão Render/Firebase).
- **RNF-07 — LGPD.** Minimização, retenção e controles da seção 13.
- **RNF-08 — Custo previsível.** Componentes de custo: plano pago do Render (API + OSRM), Firebase no plano pay-as-you-go (Firestore, Storage, Auth) e geocodificação sob demanda com cache agressivo. Download do mapa embarcado apenas em Wi-Fi para conter egress.
- **RNF-09 — Operabilidade.** Pelo menos duas pessoas do escritório treinadas no fluxo de importação e publicação (o sistema elimina o ponto único de falha do motorista; não vamos criar outro no painel).

---

## 6. Arquitetura

```
        ESCRITÓRIO (online)                        CAMPO (offline-capaz)
  ┌────────────────────────────┐            ┌────────────────────────────────┐
  │  Painel Admin (PWA/web)    │            │  App Motorista (PWA instalado) │
  │  React + MapLibre + R3F    │            │  React + MapLibre              │
  └──────┬──────────────┬──────┘            │  SW (Workbox) · Wake Lock      │
         │              │                   │  PMTiles local (OPFS)          │
         │ HTTPS        │ SDK Firebase      └───────────────┬────────────────┘
         ▼              │                                   │ SDK Firebase
  ┌─────────────────────┼──────── RENDER ──────────┐        │ (cache offline
  │  API Node (Fastify) │                          │        │  + fila de sync)
  │  · parse/valida NF-e│    ┌──────────────────┐  │        │
  │  · geocodificação   │───▶│ OSRM (serviço    │  │        │
  │  · otimização rotas │    │ privado)         │  │        │
  │  · map-matching     │    │ extrato OSM de AL│  │        │
  └─────────┬───────────┘    └──────────────────┘  │        │
            │ Admin SDK                            │        │
  ──────────┼──────────────────────────────────────┘        │
            ▼                                               ▼
  ┌───────────────────────── FIREBASE ─────────────────────────────┐
  │  Auth (papéis via custom claims)                               │
  │  Firestore: clientes · pedidos · rotas · trilhas · entregas    │
  │  Storage: arquivo PMTiles do mapa · XMLs originais · fotos de referência │
  └────────────────────────────────────────────────────────────────┘
```

**Divisão de responsabilidades.** O Firestore é a fonte de verdade e o único canal do app do motorista (leitura e escrita direto pelo SDK, com persistência local — é isso que garante o offline). A API no Render concentra o que exige processamento ou credenciais de servidor: parse de XML, geocodificação, chamadas ao OSRM e map-matching de trilhas. O OSRM roda como serviço privado no Render (acessível só pela API), carregando um extrato do OpenStreetMap recortado para Alagoas com folga de fronteira (~20 km), pré-processado no pipeline de build; extrato pequeno mantém o consumo de RAM baixo e o cold start rápido — dimensionamento exato validado na Fase 2. Atualização do extrato e do mapa embarcado: mensal, via job de build (seção 10 e 12).

---

## 7. Modelo de dados (Firestore)

### 7.1 `clientes/{clienteId}`
`clienteId` = SHA-256 do CPF/CNPJ do destinatário. Permite casar a mesma revendedora entre notas **sem persistir o documento em claro** (minimização LGPD — o CPF completo permanece apenas nos XMLs originais, sob acesso restrito).

| Campo | Tipo | Descrição |
|---|---|---|
| `nome` | string | Razão/nome do destinatário |
| `documentoMascarado` | string | Ex.: `***.***.***-82` (exibição no painel) |
| `telefone` | string | Normalizado E.164 (`+5582...`) |
| `email` | string | Da nota (opcional) |
| `enderecoFiscal` | map | `logradouro, numero, complemento, bairro, municipio, uf, cep` — como veio na NF-e |
| `coordenada` | geopoint \| null | Ponto de entrega confirmado (pin) |
| `statusMapeamento` | string | `nao_mapeado` · `geocodificado` (automático, confiança média) · `mapeado` (pin confirmado em campo) |
| `trilhaAtivaId` | string \| null | Trilha padrão para navegação |
| `mapeadoPor` / `mapeadoEm` | ref/timestamp | Autoria do pin |
| `fotoReferenciaPath` | string \| null | Foto da fachada/referência no Storage (tirada na primeira entrega) |
| `observacoes` | string | Notas livres dos motoristas sobre o local ("portão azul", "cachorro solto no quintal") |

### 7.2 `pedidos/{chaveAcesso}`
`chaveAcesso` (44 dígitos da NF-e) como ID do documento: deduplicação estrutural, sem índice extra.

| Campo | Tipo | Descrição |
|---|---|---|
| `numeroNota`, `serie` | number | Da nota (ex.: 276165 / 1) |
| `numeroPedido`, `lote` | string | Extraídos de `infCpl` (ex.: 499450697 / 47097393); editáveis |
| `clienteId` | string | Referência ao cliente |
| `emitidoEm` | timestamp | `dhEmi` |
| `itens` | array<map> | `{codigo, descricao, quantidade}` — resumo para conferência na entrega |
| `valorTotal` | number | `vNF` (visível só para admin/operador) |
| `volumes`, `pesoBrutoKg` | number | Da tag `vol` |
| `status` | string | `importado` → `pendente_de_mapeamento` \| `pronto_para_rota` → `em_rota` → `entregue` \| `insucesso` |
| `rotaId` | string \| null | Rota em que foi alocado |
| `xmlStoragePath` | string | Caminho do XML original no Storage |

### 7.3 `rotas/{rotaId}`

| Campo | Tipo | Descrição |
|---|---|---|
| `data` | string `YYYY-MM-DD` | Dia da rota |
| `motoristaId` | string | UID do condutor |
| `origemCdId` | string | CD de partida (um dos dois em `config/cds`) |
| `retornaAoCd` | boolean | Retorna ao CD de origem ao fim (padrão: sim) |
| `paradas` | array<map> | Ordenadas: `{pedidoId, clienteId, coordenada, etaMin, distanciaKm, status}` |
| `polylinePlanejada` | string | Traçado OSRM (encoded polyline, precisão 5) |
| `distanciaTotalKm`, `duracaoTotalMin` | number | Estimativas da otimização |
| `status` | string | `rascunho` → `publicada` → `em_execucao` → `concluida` |
| `publicadaEm`, `concluidaEm` | timestamp | Marcos |

### 7.4 `trilhas/{trilhaId}`

| Campo | Tipo | Descrição |
|---|---|---|
| `clienteId` | string | Destino a que o caminho leva |
| `polyline` | string | Trecho **fora da malha OSM**, simplificado (encoded polyline) |
| `pontoEntrada` | geopoint | Onde o caminho sai da malha conhecida (handoff da navegação, seção 11) |
| `distanciaM` | number | Comprimento do trecho |
| `precisaoMediaM` | number | Qualidade média do GPS na gravação |
| `ativa` | boolean | Só uma trilha ativa por cliente |
| `gravadaPor`, `gravadaEm` | ref/timestamp | Autoria |
| `versao` | number | Incrementa a cada reaprendizado |

Encoded polyline mantém trilhas longas em poucos KB — folga ampla no limite de 1 MiB por documento do Firestore.

### 7.5 `entregas/{entregaId}`

| Campo | Tipo | Descrição |
|---|---|---|
| `pedidoId`, `rotaId`, `clienteId` | string | Referências |
| `resultado` | string | `entregue` · `ausente` · `nao_localizado` · `recusa` |
| `confirmadaEm` | timestamp | Momento do toque |
| `posicaoConfirmacao` | geopoint | Onde o motorista estava ao confirmar |

### 7.6 `usuarios/{uid}` e `config/geral`
Espelho de perfil (nome, papel, ativo) para listagens no painel — o papel efetivo é o custom claim. `config/geral` guarda parâmetros de trilha e a versão corrente do PMTiles; `config/cds/{cdId}` cadastra os dois centros de distribuição (nome, geopoint) usados como partida das rotas.

---

## 8. Ingestão de NF-e

### 8.1 Formato e validação
Entrada: XML `nfeProc` (namespace `http://www.portalfiscal.inf.br/nfe`), modelo 55. Validações antes de aceitar: estrutura parseável, `mod=55`, presença de `protNFe` com `cStat=100` (autorizada). Notas rejeitadas aparecem no relatório de importação com o motivo. Eventos de cancelamento (110111) ficam fora do escopo da v1 — cancelamento é tratado removendo o pedido manualmente no painel (registrado como decisão consciente; automatizar é evolução).

### 8.2 Mapeamento de campos

| Origem no XML | Destino no sistema | Exemplo (nota anexa) |
|---|---|---|
| `infNFe@Id` (44 dígitos) | `pedidos.{id}` | `27260314750618...0282` |
| `ide/nNF`, `ide/serie` | `numeroNota`, `serie` | 276165, 1 |
| `ide/dhEmi` | `emitidoEm` | 2026-03-11 |
| `dest/xNome` | `clientes.nome` | — |
| `dest/CPF` ou `dest/CNPJ` | `clienteId` (hash) + máscara | — |
| `dest/enderDest/*` | `clientes.enderecoFiscal` | Povoado Brejo dos Bois, 83, Zona Rural, Junqueiro/AL |
| `dest/enderDest/fone` | `clientes.telefone` (normalizado `+55`) | — |
| `dest/email` | `clientes.email` | — |
| `det[]/prod/{cProd,xProd,qCom}` | `pedidos.itens[]` | 10 itens |
| `total/ICMSTot/vNF` | `valorTotal` | 760,69 |
| `transp/vol/{qVol,pesoB}` | `volumes`, `pesoBrutoKg` | 1 vol, 3,113 kg |
| `infAdic/infCpl` → regex | `numeroPedido`, `lote` | 499450697, 47097393 |

Regex de referência (tolerante a variações de espaçamento e asteriscos): `Pedido\s*[:#]?\s*(\d+)` e `Lote\s*[:#]?\s*(\d+)`, aplicadas sobre `infCpl` normalizado. Se nada casar, o pedido entra sem número e o campo fica destacado para preenchimento manual — o layout desse texto é definido pelo ERP emissor e pode mudar sem aviso.

### 8.3 Regras de atualização de cliente
Se o `clienteId` já existe: atualizar telefone/e-mail/endereço fiscal se vierem diferentes (a nota é mais recente que o cadastro), **preservando** `coordenada`, `statusMapeamento` e trilhas — mudança de endereço fiscal com destino já mapeado gera um alerta no painel ("endereço da nota mudou; o pin continua válido?") em vez de descartar o mapeamento.

---

## 9. Geocodificação e classificação de destino

Pipeline executado na importação, nesta ordem:

1. **Match por cliente.** Se o `clienteId` já tem `coordenada`, o pedido nasce `pronto_para_rota`. Na prática este é o caminho dominante depois do primeiro ciclo: revendedoras compram recorrentemente, e o sistema aprende uma vez por cliente, não por pedido.
2. **Heurística de zona rural (curto-circuito).** Endereço com qualquer um dos sinais abaixo pula a geocodificação e vai direto para `pendente_de_mapeamento` — geocodificar seria gastar dinheiro para obter um ponto errado com cara de certo:
   - CEP terminado em `000` (CEP genérico de município);
   - bairro contendo `ZONA RURAL`;
   - logradouro iniciando com `POVOADO`, `SÍTIO`, `SITIO`, `FAZENDA`, `ASSENTAMENTO`, `ROD`, `KM`.
3. **Geocodificação automática** (endereços urbanos plausíveis): consulta ao provedor com o endereço completo. Resultado com precisão de nível "endereço/rua" e dentro do município esperado → `geocodificado` (confiança média; o pin será confirmado na primeira entrega). Resultado impreciso (nível "cidade") ou fora do município → `pendente_de_mapeamento`.
4. **Resolução manual (painel).** A fila de pendências (RF-23) permite ao operador posicionar o pin quando alguém do escritório conhece o local; senão, resolve-se em campo no primeiro atendimento (Fluxo 4).

**Provedor — decidido: Google Geocoding API.** Três razões objetivas: (1) o projeto já exige billing no Google de qualquer forma — o Firebase no plano Blaze é um projeto Google Cloud com cobrança habilitada, então "evitar a chave de billing" não economizaria nada; (2) a cobertura do Nominatim depende de endereços pontuais existirem no OpenStreetMap, e no interior de Alagoas eles são escassos — exatamente onde o sistema precisa acertar; (3) com o **cache permanente por cliente** (cada endereço geocodificado no máximo uma vez na vida) e a heurística rural cortando o que não deve ser consultado, o volume novo é de dezenas de chamadas por mês — dentro da franquia gratuita mensal do serviço e, mesmo que não fosse, custo de centavos.

---

## 10. Roteirização (OSRM)

**Build.** Job mensal: baixar o extrato `brazil/nordeste` (Geofabrik) → recortar Alagoas + buffer de ~20 km com `osmium extract` → pré-processar (`osrm-extract` com perfil `car`, `osrm-contract`) → publicar a imagem do serviço no Render. O recorte mantém RAM e cold start baixos; números exatos medidos na Fase 2.

**Uso pela API:**

- `GET /trip` — ordena as paradas (solução aproximada do caixeiro-viajante). Parâmetros: `source=first` (partida no CD escolhido), `roundtrip=true` por padrão — assume-se retorno ao CD de origem, desmarcável na montagem quando não for o caso —, coordenadas = CD + paradas. Adequado ao porte do problema (dezenas de paradas por dia); acima de ~50 paradas ou com janelas de horário/múltiplos veículos, o upgrade natural é o VROOM na frente do OSRM — fora do escopo v1, registrado como caminho de evolução.
- `GET /route` — traçado e duração entre pontos, usado no detalhe por parada e em recálculos.
- `GET /match` — map-matching de trilhas gravadas (seção 11).

**Limitação estrutural e honesta:** o OSRM só conhece as vias que existem no OpenStreetMap. Em zona rural alagoana, muitas não existem lá. O OSRM leva o motorista até a borda da malha conhecida; o resto é papel do modo trilha — é exatamente essa a divisão de trabalho do sistema. (Evolução opcional: contribuir as vias aprendidas de volta ao OSM, melhorando o próprio roteirizador a cada ciclo de atualização do extrato.)

---

## 11. Navegação e modo trilha

### 11.1 Gravação (campo, offline)
Disparo automático ao tocar "a caminho desta parada" quando o destino é `pendente_de_mapeamento` (ou manual, pelo botão "gravar caminho"). Parâmetros iniciais (ajustáveis em `config`):

- `watchPosition` com `enableHighAccuracy: true`;
- descarte de leituras com `accuracy > 25 m`;
- registro de ponto a cada ≥ 12 m de deslocamento (filtro de distância — evita nuvem de pontos parado no semáforo);
- Wake Lock ativo durante toda a gravação; gravação encerra ao confirmar o pin.

A trilha bruta (pontos + timestamps + accuracy) vai para a fila de sincronização. **Nada é processado no aparelho** além dos filtros acima — celular intermediário não é lugar de algoritmo pesado.

### 11.2 Pós-processamento (backend, quando sincroniza)
1. Simplificação Douglas-Peucker (tolerância ~10 m) — reduz pontos sem deformar o caminho;
2. `OSRM /match` sobre a sequência: os trechos que **casam** com a malha OSM (confiança alta) são descartados — o motorista estava em estrada conhecida, o `/route` cobre isso; os trechos **sem correspondência** (tracepoints nulos / matchings quebrados) são o ouro: o caminho que não existe no mapa;
3. O último ponto casado antes do trecho órfão vira `pontoEntrada`; o trecho órfão vira a `polyline` da trilha; a trilha anterior do cliente (se houver) é desativada, `versao` incrementa.

### 11.3 Navegação híbrida (campo, offline)
- **Trecho 1 — malha conhecida:** o app segue a polyline planejada da rota (pré-calculada na publicação — em campo não há chamada de rota), com reposicionamento contínuo do veículo no mapa. v1 é *linha no mapa*, não turn-by-turn falado (RF-22 é evolução).
- **Handoff:** ao se aproximar do `pontoEntrada` da parada atual (raio ~100 m), o app troca o modo: destaca a trilha aprendida sobre o mapa.
- **Trecho 2 — fora da malha:** trilha desenhada + seta de direção + distância em linha reta até o pin. Direção por `deviceorientationabsolute` (bússola) quando disponível; fallback: rumo derivado do deslocamento GPS (funciona sempre que o veículo está em movimento).
- **Chegada:** raio de ~30 m do pin aciona o cartão de confirmação (RF-18).

### 11.4 Ponto empírico que sustenta tudo isso
O receptor GNSS do celular **não depende de internet** — rede só acelera o primeiro fix (A-GPS). Portanto gravação e navegação funcionam integralmente offline; o que a rede faz é sincronizar depois. É isso que torna a Starlink um conforto operacional na base, e não um pré-requisito do sistema em campo.

### 11.5 Limitação de plataforma (registrada com honestidade)
PWA no Android **não executa geolocalização confiável em segundo plano** (tela apagada = processo congelável). Mitigação de produto: navegação e gravação acontecem com a tela ligada (que é o uso natural — o motorista está seguindo o mapa), Wake Lock impede o desligamento, e a operação exige suporte + carregador veicular (RNF-03). Se um dia o requisito virar "rastrear o veículo continuamente com tela apagada", o caminho é empacotar com Capacitor (mesma base de código React, plugin de background geolocation) — decisão que não precisa ser tomada agora e não muda a arquitetura de dados.

---

## 12. Estratégia offline (três camadas)

**Camada 1 — Aplicação.** Service worker (Workbox) com precache do app shell e assets; o PWA abre instantaneamente sem rede. Fontes, estilo do mapa, sprites e glyphs embarcados no bundle (nenhuma dependência de CDN em campo).

**Camada 2 — Dados.** Firestore com `persistentLocalCache`. A publicação da rota dispara a pré-carga: o app executa, ainda no Wi-Fi, as queries de tudo que a rota referencia (pedidos, clientes, trilhas, config) — a partir daí o cache local responde tudo. Escritas em campo entram na fila do próprio SDK e sincronizam sozinhas ao reencontrar rede. As fotos de referência são a exceção: upload ao Storage não tem fila offline nativa, então a imagem fica em cache local (OPFS) numa fila própria com retry, e o documento do cliente só recebe `fotoReferenciaPath` quando o upload conclui. Conflitos: last-write-wins é suficiente (um motorista por rota; escritório e campo raramente tocam o mesmo documento no mesmo dia — exceção tratada no alerta da seção 8.3).

**Camada 3 — Mapa.** Basemap vetorial de Alagoas em um único arquivo **PMTiles**, gerado mensalmente com Planetiler a partir do mesmo extrato OSM do OSRM (uma fonte, dois artefatos — mapa e roteirizador nunca divergem). Distribuição: Firebase Storage → download completo pelo app **apenas em Wi-Fi** → gravação no **OPFS** (Origin Private File System) → leitura local via source customizado da lib `pmtiles` (interface `getBytes` sobre o arquivo local, com acesso aleatório por `slice`). Tamanho estimado na casa de dezenas de MB a ~150 MB para o estado — estimativa a medir na Fase 5; se necessário, recorta-se por macrorregião de atuação. Controle de versão do arquivo em `config/geral`; o app compara e propõe atualização quando estiver na base.

**Critério de aceite global do offline (repetindo o RNF-01 porque é o coração do sistema):** rota completa executada em modo avião, do primeiro ao último pin, com sincronização íntegra ao religar a rede.

---

## 13. Segurança e LGPD

**Dados pessoais tratados** (titulares: revendedoras destinatárias): nome, CPF/CNPJ, telefone, e-mail, endereço, coordenada de entrega. **Base legal:** execução de contrato (art. 7º, V — entrega do pedido comprado). Ainda assim, minimização por desenho:

- CPF/CNPJ **não é persistido em claro** no Firestore: vira hash (identidade) + máscara (exibição). O dado íntegro existe apenas nos XMLs originais no Storage, acessíveis só a admin.
- O app do motorista recebe o mínimo para entregar: nome, telefone, endereço, itens/volumes, coordenada. **Sem CPF, sem valores da nota** (imposto pelas security rules, não pela interface).
- Security rules por papel, com testes automatizados no CI (emulador Firebase) — regra mal escrita é o maior risco real de vazamento neste desenho.
- Retenção: XMLs e dados de pedido/entrega por prazo fiscal definido pela contabilidade (parametrizar); **coordenadas e trilhas são o ativo permanente** e não expiram enquanto o cliente for ativo. Cliente inativo há N meses pode ser anonimizado (mantém-se a trilha, remove-se o vínculo pessoal) — política a confirmar (seção 18).
- Transporte e repouso criptografados por padrão (Firebase/Render); segredos da API em variáveis de ambiente do Render; nenhum segredo no bundle do PWA.
- Direitos do titular (acesso/correção/eliminação): atendíveis pelo painel admin; registrar o procedimento na política interna.

---

## 14. Design system — "industrial de verdade"

### 14.1 Direção
Estética de **painel de máquina / HMI industrial**: superfícies de aço e carvão, sinalização âmbar e laranja de segurança, hazard stripes em estados críticos, cantos duros, bordas visíveis, tipografia condensada em caixa alta para títulos e monoespaçada para dados. Rústico no material, precisa na informação.

### 14.2 Tokens

| Token | Valor | Uso |
|---|---|---|
| `--carvao` | `#1C1C1E` | Fundo (tema escuro) |
| `--aco` | `#2E3033` | Superfícies/cards |
| `--borda` | `#4A4D52` | Bordas de 1px sempre visíveis |
| `--ambar` | `#FFB020` | Destaques, foco, hazard stripes |
| `--laranja-seg` | `#FF5F1F` | Ações primárias, alertas de ação |
| `--verde-maq` | `#2EA043` | Sucesso/entregue |
| `--vermelho-falha` | `#D64545` | Insucesso/erro |
| `--texto` / `--texto-2` | `#ECECEC` / `#9AA0A6` | Hierarquia de texto |
| Raio | `3px` | Cantos duros em tudo |
| Tipos | Archivo Black / Barlow Condensed (títulos, caps) · Barlow (corpo) · JetBrains Mono (números, códigos, coordenadas) | Google Fonts, embarcadas no bundle |

**Dois temas no app do motorista:** *Galpão* (escuro, o padrão acima) e *Pátio* (claro de alto contraste — concreto `#E8E6E1`, texto quase preto, âmbar mantido), porque tela escura sob sol direto é ilegível; alternância manual em um toque no topo da tela.

### 14.3 Movimento e 3D — onde cada coisa vive
- **App do motorista:** microanimações apenas (Framer Motion, 150–250 ms, easing `easeOut`): deslizar de cartões de parada, checkmark de entrega com `navigator.vibrate` (Android), pulso do pin de destino, transição do handoff para o modo trilha. **Zero Three.js**: o MapLibre já ocupa o contexto WebGL do aparelho, e empilhar uma segunda cena 3D num celular intermediário ao sol é bateria queimada e throttling térmico sem ganho operacional.
- **Painel admin:** aqui o 3D entrega identidade sem custo operacional — React Three Fiber com cena hero no dashboard (mapa de Alagoas extrudado em low-poly com os pontos de entrega do dia pulsando em âmbar; carregada lazy, desligável nas configurações), transições de página fluidas, hazard stripes animadas em operações destrutivas.

### 14.4 Ergonomia de campo
Alvos ≥ 48 px; ações críticas (confirmar entrega) na metade inferior da tela, alcançáveis com o polegar; nada de gestos escondidos; textos operacionais curtos e em caixa alta condensada; estados sempre com cor **e** ícone (sol lava cor).

---

## 15. Stack e infraestrutura

| Componente | Tecnologia | Onde roda | Observação |
|---|---|---|---|
| App motorista + painel | React 18 + Vite + TypeScript (monorepo, pacotes `web-motorista`, `web-admin`, `shared`) | Servidos como estáticos pela API ou static site do Render | Um repositório, deploy por push |
| Mapa | MapLibre GL JS + `pmtiles` | No aparelho | Estilo próprio (tema industrial), assets embarcados |
| Offline | Workbox (SW) + Firestore `persistentLocalCache` + OPFS | No aparelho | Seção 12 |
| Animações | Framer Motion (ambos) + React Three Fiber (só admin) | No aparelho | Seção 14.3 |
| API | Node 20 + Fastify + `fast-xml-parser` | Render (web service, plano pago) | Parse NF-e, geocodificação, orquestração OSRM |
| Roteirização | OSRM (perfil car, extrato AL) | Render (private service) | Acessível apenas pela API |
| Build de mapa/roteirizador | Job mensal: Geofabrik → `osmium` → `osrm-*` + Planetiler → PMTiles | CI (GitHub Actions) | Uma fonte OSM, dois artefatos |
| Identidade e dados | Firebase Auth + Firestore + Storage (plano pay-as-you-go) | Google | Custom claims, security rules testadas em CI |
| Geocodificação | Google Geocoding API (cache permanente por cliente) | Via API | Decidido — racional na seção 9 |

---

## 16. Roadmap por fases (cada fase termina usável)

| Fase | Entrega | Critério de aceite |
|---|---|---|
| **0 — Fundação** | Monorepo, CI/CD Render, projeto Firebase, Auth com papéis, esqueleto dos dois PWAs instaláveis | Login como admin e como motorista; deploy automático por push |
| **1 — Ingestão** | Upload múltiplo de XML, parser completo, dedupe, cadastro automático de clientes, listagem de pedidos | Importar a NF-e 276165 e ver o pedido 499450697 com 10 itens, 3,1 kg, cliente criado e status `pendente_de_mapeamento` |
| **2 — Rotas** | Geocodificação com heurísticas, OSRM no ar, montagem/otimização/ajuste manual de rota, visualização no mapa | Rota real com ~15 paradas ordenada, traçada e com estimativas coerentes |
| **3 — Motorista v1 (online)** | Rota do dia no aparelho, navegação por linha no mapa, confirmação/insucesso, ligação e WhatsApp em um toque | Um dia de entregas urbanas executado inteiramente pelo app |
| **4 — Mapeamento** | Pin, gravação de trilha, map-matching no backend, navegação híbrida com handoff, reaprendizado, foto de referência + observações do local | Destino rural real entregue duas vezes: na 1ª grava pin, trilha, foto e notas; na 2ª o app guia sozinho até o pin exibindo a referência |
| **5 — Offline total** | PMTiles + OPFS, pré-carga na publicação, fila de sync verificada, temas Galpão/Pátio | Rota completa em modo avião (RNF-01) com sincronização íntegra no retorno |
| **6 — Acabamento** | Design industrial completo, cena 3D do admin, métricas (RF-25), auditoria | Checklist visual + relatório mensal gerado |
| **7 — Evoluções** | Ingestão automática (RF-05), múltiplos motoristas (RF-15), instruções por voz (RF-22) | Conforme priorização após operação assistida |

A partir da Fase 4 o sistema já cumpre a missão central (rota sem depender da memória de uma pessoa); a Fase 5 o torna imune à realidade de sinal da zona rural.

---

## 17. Riscos e mitigações

| Risco | Efeito | Mitigação |
|---|---|---|
| OSM incompleto no interior de AL | Rota planejada para até a borda da malha | É o desenho do sistema: modo trilha cobre o resto; opcionalmente contribuir vias ao OSM |
| Precisão de GPS sob mata/chuva | Trilha ruidosa, pin deslocado | Filtro de accuracy + Douglas-Peucker + pin sempre confirmado por humano; `precisaoMediaM` sinaliza trilhas ruins para regravação |
| PWA sem background confiável | Gravação exige tela ligada | Wake Lock + suporte/carregador veicular; plano B Capacitor documentado (11.5) sem mudança de arquitetura |
| Texto de `infCpl` muda de layout | Número de pedido não extraído | Regex tolerante + campo editável + destaque na importação |
| Security rules incorretas | Exposição de dado pessoal | Testes de rules no emulador em CI, obrigatórios para merge |
| Egress do PMTiles | Custo de Storage | Download só em Wi-Fi + verificação de versão antes de baixar |
| Painel operado por uma pessoa só | Novo ponto único de falha | RNF-09: duas pessoas treinadas desde a Fase 2 |
| Aparelho corporativo abaixo do mínimo | GPS ruim, app lento | RNF-02 define o mínimo de compra; validar o modelo escolhido antes da Fase 3 |

---

## 18. Registro de decisões (revisão de 22/07/2026)

| # | Tema | Decisão |
|---|---|---|
| 1 | Origem das rotas | Sempre a partir de um CD; **a operação tem dois CDs**, cadastrados em `config/cds` e selecionáveis na montagem da rota. Retorno ao CD de origem assumido como padrão (`roundtrip=true`), desmarcável por rota — *suposição a validar*. |
| 2 | Aparelho | **Celular Android da empresa**, dedicado à rota. O PWA atende celular (motorista) e PC (painel) com uma única base de código — motivação declarada da escolha por PWA. |
| 3 | RF-21 | Redefinido como **dossiê do local**: foto da fachada/referência quando ainda não houver + observação livre opcional, vinculados ao cliente, para orientar novos motoristas. Prova de entrega clássica (comprovante/recebedor) fora de escopo. |
| 4 | Geocodificação | **Google Geocoding API** — racional na seção 9. |
| 5 | Notificação WhatsApp | **Fora de escopo** por decisão. |
| 6 | Nome do produto | **Rota Grupo Alcina Maria**. |

**Ainda pendente (não bloqueia as Fases 0–2):** volume médio de entregas por dia e frequência semanal (refina dimensionamento e a UX da lista de paradas); prazo de retenção/anonimização de clientes inativos (seção 13).

---

*Fim do documento — v0.2. As pendências da seção 18 podem ser resolvidas durante as Fases 0–2; a v1.0 congela o escopo das Fases 0–5 para início do desenvolvimento.*
