# Rota Grupo Alcina Maria

PWA de roteirização e navegação de entregas — offline-first no campo, painel no escritório.
A especificação completa está em [`especificacao-rota-grupo-alcina-maria.md`](./especificacao-rota-grupo-alcina-maria.md).

## Estrutura (monorepo npm workspaces)

| Pacote | Caminho | O que é |
|---|---|---|
| `@rota/shared` | `packages/shared` | Modelo de dados (seção 7), utilitários (hash/máscara de documento, telefone E.164, heurística rural, extração de `infCpl`) e tokens do design system (seção 14) |
| `@rota/api` | `apps/api` | API Fastify: parse/validação de NF-e, importação com dedupe e relatório (seções 8–9) |
| `@rota/web-admin` | `apps/web-admin` | Painel do escritório (PWA): importação de XML, pedidos, clientes |
| `@rota/web-motorista` | `apps/web-motorista` | App do motorista (PWA): rota do dia, temas Galpão/Pátio |

## Rodando

```bash
npm install

npm run dev:api        # API em http://localhost:3000
npm run dev:admin      # Painel em http://localhost:5173
npm run dev:motorista  # App do motorista em http://localhost:5174

npm test               # testes (parser NF-e, importação, utilitários)
npm run typecheck
npm run build
```

Fluxo de demonstração da Fase 1: suba API + painel, arraste um XML de NF-e
(`apps/api/test/fixtures/nfe-276165.xml` serve de exemplo) na aba **Importação**
e veja o relatório, o pedido e o cliente criados.

## Estado atual × roadmap (seção 16 da spec)

- **Fase 0 — Fundação:** monorepo, dois PWAs instaláveis com o design industrial, API no ar. **Pendente:** provisionar o projeto Firebase (Auth com custom claims, Firestore, Storage) e o CI/CD no Render — exige credenciais/contas.
- **Fase 1 — Ingestão:** parser NF-e completo (validação mod 55 / cStat 100, dedupe pela chave, extração de pedido/lote via `infCpl`, upsert de cliente preservando mapeamento, heurística de zona rural) com testes. **Pendente:** persistência Firestore (hoje a API usa repositório em memória — trocar implementando a interface `Repositorio` em `apps/api/src/db/`) e guarda do XML original no Storage.
- **Fases 2+ (rotas/OSRM, motorista, mapeamento, offline total):** não iniciadas.

## Próximos passos de infraestrutura

1. Criar o projeto Firebase (plano Blaze) e preencher as credenciais Admin SDK na API (variáveis de ambiente no Render).
2. Implementar `RepositorioFirestore` e o login (Firebase Auth + custom claims `admin`/`operador`/`motorista`).
3. Subir a API no Render (web service) — o entrypoint é `npm start -w @rota/api`.
