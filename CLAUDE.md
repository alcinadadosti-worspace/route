# Rota · Grupo Alcina Maria

Roteirização e entrega para operação de venda direta em Alagoas — cosméticos entregues a
revendedoras, boa parte em zona rural sem endereço no mapa.

A especificação completa é `especificacao-rota-grupo-alcina-maria.md` (as seções citadas nos
comentários do código apontam para ela). O histórico de decisões está nas mensagens de commit,
que são longas de propósito: cada uma explica **por que**, não o que mudou.

## As três peças

| Pacote | O que é |
|---|---|
| `packages/shared` | Modelo, geometria, polyline, mensagens ao cliente, regras puras. Sem I/O. |
| `apps/api` | Fastify. Lê NF-e, geocodifica, orquestra o OSRM, publica rota, calcula produtividade. |
| `apps/web-admin` | PWA do Admin Estoque: importação, decisões de endereço, montagem de rota, produtividade. |
| `apps/web-motorista` | PWA de campo: rota do dia, navegação, mapeamento, comprovante. **Funciona offline.** |

Persistência é Firestore (Admin SDK no servidor, SDK web com fila offline no motorista).
Mapa embarcado em PMTiles no OPFS. Roteirizador OSRM próprio.

## Comandos

```bash
npm test          # node --test em todos os workspaces
npm run typecheck
npm run build
npm run publicar-rules -w @rota/api   # firestore.rules + storage.rules
```

## O que torna esta base diferente

**O app aprende o lugar.** Endereço rural não existe no mapa. O motorista confirma o pin exato,
grava a trilha de terra, fotografa a fachada e escreve como chegar — e isso fica no **cliente**,
não no pedido, valendo para toda entrega futura de qualquer motorista. Nenhuma plataforma
comercial faz isso; elas assumem que o endereço existe.

**Offline não é recurso, é premissa.** Confirmar entrega, mapear e navegar funcionam sem rede.
O que exige rede (avisar cliente, re-rota, upload de foto) degrada em silêncio e retoma sozinho.

## Convenções

- **Código e comentários em português.** Comentário explica *por que*, nunca *o quê*; se descreve
  um bug que já aconteceu, diz qual era o sintoma.
- **Toda regra com consequência vira função pura testada** (`rotaAtiva.ts`, `chegada.ts`,
  `aviso.ts`, `produtividade.ts`). Lógica dentro de componente React é lógica sem teste.
- **Nada decide sozinho no meio do trabalho de campo** — nem recarregar versão, nem trocar rota,
  nem confirmar entrega. Avisar sim, decidir não.
- **Guardas avisam, não bloqueiam**, quando o dado pode estar errado (pin rural impreciso, GPS
  falhando). Travar entrega é pior que aceitar um registro imperfeito.
- **Alvo de toque mínimo de 48px** (`--alvo-toque`) — o app é usado de pé, na chuva.
- Números para o cliente em pt-BR (`1.284,6`); nunca deixar placeholder vazar em mensagem.

## Verificar contra a realidade

Os bugs que chegaram ao usuário **passaram nos testes**. Foram todos erro de contexto de uso, e
todos apareceram confrontando o código com o mundo:

- rodar o parser sobre as notas reais de `notas-teste/` antes de decidir formato ou limite;
- `curl` no serviço de verdade em vez de confiar na documentação;
- testar security rules autenticado **como o usuário real** (SDK web + custom token) — a chave
  admin passa por cima de tudo e mascara o bug;
- fingerprintar o bundle publicado antes de afirmar que algo está ou não no ar;
- auditar o Firestore de produção (órfãos, duplicatas, status divergente) depois de mudar fluxo.

**Antes de pedir deploy, medir.** O auto-deploy funciona nos três serviços; baixe o
`/assets/index-*.js` publicado e faça `grep` por um texto do código novo.

**`Ctrl+Shift+R` não contorna service worker.** Se algo "não aparece", a primeira hipótese é o
navegador estar rodando outra versão — não um bug no código.

## Armadilhas conhecidas

- **Não importar `virtual:pwa-register`**: em `autoUpdate` ele embute `location.reload()` e
  recarrega a página no meio do trabalho. O registro do SW é manual (`useAtualizacao`).
- **`allow create` no Storage não barra sobrescrita** — use `resource == null`.
- `entregas` é imutável por regra: o que precisa ser gravado depois (recibo enviado, chegada)
  mora na **parada**, dentro do doc da rota.
- O painel lê coleções inteiras. Com volume real de notas isso esgota a cota diária do Firestore
  — paginação é dívida com prazo, não melhoria.
