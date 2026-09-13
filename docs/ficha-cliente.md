# Ficha de cliente — ponto de situação

Trabalho na branch `fix/no-credentials-to-browser`, **sem commit**.
Plano completo (contexto, decisões e porquês): `C:\Users\pedro\.claude\plans\deviamos-de-implementar-um-eager-goblet.md`.

Estado a 13/09/2026: **as três fases estão escritas.** Falta aplicar a migração em
produção e abrir as páginas contra dados reais.

Verificação nesse momento: `npm test` → 226 ficheiros / 2133 testes verdes;
`tsc --noEmit` limpo no worker e no backoffice; `npm run build` no backoffice
com exit 0 e as rotas novas todas dinâmicas (`/[locale]/conta`,
`/admin/clientes/[code]`, `/api/admin/clientes/[code]`).

---

## A ideia em três linhas

Cada cliente tem um número curto e ditável — `RIO-1A2B3C`, seis caracteres
hexadecimais, sem um único par confundível. É por esse número que a ficha de
admin reúne tudo (registo, integrações, subscrições, regras fiscais, Stripe,
faturas Kapta, registos) e é o gancho por onde qualquer coisa futura
(newsletter, exportações, suporte) vai resolver um cliente.

**Nenhum código é repetido e nenhum é reutilizado** — duas coisas diferentes, e
são precisas as duas. O índice único em `users.client_code` separa contas vivas;
a tabela `client_codes` é o livro de todos os códigos já emitidos e impede que o
número de uma conta apagada volte a sair, porque os `document_events` e
`processed_orders` dessa conta sobrevivem à eliminação e continuam arquivados
debaixo dele. É por isso que `client_codes` **não** entra na limpeza do
`user.deleted`.

---

## ⚠️ O que falta, por ordem

### 1. Aplicar a migração em produção

Está aplicada e verificada **só em local**.

```
npx wrangler d1 execute rioko-db --remote --file migrations/0058_client_code.sql
```

Depois, contra produção:

```sql
SELECT COUNT(*) FROM users WHERE client_code IS NULL;              -- 0
SELECT COUNT(*) - COUNT(DISTINCT client_code) FROM users;          -- 0
SELECT COUNT(*) FROM client_codes;                                 -- = nº de contas
```

Nunca `d1 migrations apply` nesta base: o ledger está parado no 0017.
Se o `CREATE UNIQUE INDEX` falhar, é colisão no backfill (≈2 em 100 000 para 26
contas): correr outra vez o `UPDATE` para os duplicados e repetir. Falha alta de
propósito — é por isso que o backfill vem antes do índice.

O código tolera a migração por aplicar (`try/catch → SQL pré-0058` nos upserts,
`ensureClientCode` devolve null, `SELECT` com fallback nas três rotas), por isso
um deploy que chegue primeiro não parte inscrições. Mesmo assim: aplicar antes.

### 2. Abrir contra dados reais

Nada disto foi aberto num browser. O plano diz contra quê:

- **Bikini Books** — 9 faturas, série `OL`, isenções M05/M40: a ficha tem de
  bater com o que `/admin/client-rules` e `/admin/ops` dizem hoje.
- **WHM** — duas ligações: têm de aparecer **duas** subscrições distintas, não
  uma duplicada.
- **Um membro convidado** — o código dele tem de redirigir para a ficha do dono,
  com o aviso.
- **`RIO-FFFFFF`** — tem de dar "não existe"; um código de conta apagada tem de
  dar o recado do número reformado (`lookupRetiredCode`).
- **`/pt/conta` como comerciante** — NIF em leitura, e um POST forjado a
  `/api/user/profile` com outro NIF **não** o muda.

### 3. Decidir o commit

Nada foi commitado. A branch actual já trazia trabalho de outra coisa
(`fix/no-credentials-to-browser`), por isso convém stage explícito por caminho —
nunca `git add .` a partir da raiz.

---

## O que ficou feito

### F1 — código, backfill, resolução

| Ficheiro | O que é |
|---|---|
| `migrations/0058_client_code.sql` | `users.client_code` + backfill + índice único + tabela `client_codes` (o livro de códigos queimados) |
| `backoffice/src/lib/client-code.ts` | `newClientCode`, `normalizeClientCode`, `upsertUserRow`, `ensureClientCode`, `resolveClientCode`, `lookupRetiredCode` |
| `backoffice/src/lib/client-code.test.ts` | 23 testes com SQL a sério, incluindo "nunca entrega o número de uma conta apagada" com o `crypto.getRandomValues` apontado à colisão |
| `backoffice/src/app/api/webhooks/clerk/route.ts` | `upsertUserRow`; comentário a dizer porque `client_codes` não entra na limpeza do `user.deleted` |
| `backoffice/src/app/api/auth/sync/route.ts` | a mesma chamada — os dois sítios partilham agora um só INSERT |
| `backoffice/src/app/api/admin/users/route.ts` | `u.client_code` no SELECT + nota no DELETE |
| `backoffice/src/components/admin/SuperadminPanel.tsx` | chip do código copiável, pesquisa pelo código, botão "Ficha" |

Detalhe que custou uma iteração: **um login não pode cunhar**. `upsertUserRow` lê
primeiro se a conta já tem número; só mina quando não tem, senão cada sessão
queimava um código.

### F2 — a ficha em `/admin/clientes/[code]`

| Ficheiro | O que é |
|---|---|
| `backoffice/src/app/api/admin/clientes/[code]/route.ts` | a montagem única: identidade, ligações, subscrições, Stripe, membros, lugares, contagens. Fiscal só a hiperadmin (omitido do payload, não escondido na UI); um superadmin não abre a ficha de um hiperadmin |
| `backoffice/src/app/admin/clientes/[code]/page.tsx` | resolve, redirige id→código e membro→dono, distingue código reformado de gralha |
| `backoffice/src/components/admin/CustomerRecordPanel.tsx` | sete separadores: Identidade · Subscrições · Integrações · Regras fiscais · Stripe · Faturas Kapta · Registos |
| `backoffice/src/components/admin/Section.tsx` | o cartão, tirado do DevModePanel para os dois usarem |
| `backoffice/src/lib/client-record-sql.ts` + `.test.ts` | `scope`→`connection_key`, baldeamento do `document_events`, 8 testes |
| `backoffice/src/lib/stripe.ts` | `stripeDashboardBase()` — test vs live pela chave, resolvido no servidor |
| `src/services/document-log.ts` + `.test.ts` novo | `readMerchantTimeline` (4 testes: isolamento entre clientes, o par na linha, o limite) |
| `src/index.ts`, `backoffice/src/app/api/admin/document-log/route.ts` | `?user_id=` na mesma rota |
| `backoffice/src/components/admin/IntegrationsPanel.tsx` | a ficha ganha ícone próprio; a chave-inglesa passa a dizer o que é (dev mode) |

Duas decisões que a exploração mudou:

- **Stripe sem uma única chamada nova.** `cus_`, `sub_`, `in_`, `pi_` já estão em
  D1; os links são concatenação. O repo não tem um único `paymentIntents.list` e
  não é esta página que o estreia.
- **Incidentes não se dividem por subscrição.** `incidents.connection_id` existe
  desde a 0009 e nenhum dos ~45 `reportIncident` o escreve. A ficha lista-os
  inteiros e diz porquê, em vez de adivinhar pelo `kind`.

### F3 — a página Conta

| Ficheiro | O que é |
|---|---|
| `backoffice/src/app/[locale]/(dashboard)/conta/page.tsx` + `components/AccountPanel.tsx` | código copiável, dados editáveis, identidade fiscal em leitura com "pedir alteração" |
| `backoffice/src/app/api/user/profile/route.ts` | GET com lista explícita de colunas (deixou de entregar `role`, `is_inactive`, `theme`, `admin_label` e as oito `acq_*`); POST com a guarda fiscal no próprio UPDATE |
| `backoffice/src/lib/profile-fiscal-lock.test.ts` | 4 testes com o UPDATE verdadeiro: o NIF não mexe para o comerciante, mexe para o operador, e o primeiro registo escreve-o |
| `backoffice/src/app/api/user/identity-request/route.ts` | grava em `config_audit` (`scope: profile_change_request`) e avisa por `callWorkerJson("/admin/notify")` |
| `backoffice/src/lib/config.ts` | `SUPPORT_EMAIL` |
| `NavLinks.tsx`, `messages/{pt,en}.json` | entrada "Conta" + namespace `conta` (38 chaves em cada idioma) |

A guarda é `CASE WHEN registration_completed = 1 AND ? = 0 THEN nif ELSE ? END`,
com a bandeira a valer `isAdmin(userId) ? 1 : 0`. Está no UPDATE e não no HTML
porque um campo desactivado é uma sugestão a quem consiga fazer POST. A aridade
dos binds passou a 13/13 (e 10/10 no fallback pré-0049).

O pedido de alteração **não** vive em `incidents`: `autoResolveStaleIncidents`
fecha aos 24 h qualquer incidente fora de `INVOICE_FAILURE_KINDS`
(`src/services/incidents.ts:600-607`) e o pedido desaparecia sozinho. O estado
deriva-se: está pendente enquanto o valor pedido diferir do que está em `users`.

---

## Coisas a não esquecer

- **Não construir a newsletter.** O código é o gancho; listas, envio e
  cancelamento são outro trabalho.
- **Não passar `connection_id` nos ~45 `reportIncident`** nesta branch. É o que
  tornaria os incidentes divisíveis por subscrição, e é um PR à parte.
- **Não apagar** `/admin/users/[id]/dev-mode` (é a caixa de ferramentas, não a
  ficha) nem a árvore `[locale]/(dashboard)/{superadmin,ops,client-rules}`.
- O código **nunca** é credencial. Se um dia abrir uma página pública, leva
  sufixo aleatório próprio, como o token de convite da 0051.
- `Casa de Celebrar a Vida` está dormente por decisão — não é falha, não aparece
  como tal em separador nenhum.
