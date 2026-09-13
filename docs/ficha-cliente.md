# Ficha de cliente — ponto de situação

Em `main` e em produção desde 13/09/2026: #140–#143 (base), #147 (auditoria de
código), #148 (aviso de desfecho em impersonação), #150 (verificação contra
dados reais).
Plano completo (contexto, decisões e porquês): `C:\Users\pedro\.claude\plans\deviamos-de-implementar-um-eager-goblet.md`.

Estado: **entregue e verificado contra produção.** O que resta são decisões de
operador sobre dados, listadas em "Verificação contra produção".

Verificação no merge: `npm test` → 123 ficheiros / 1172 testes verdes;
`tsc --noEmit` limpo no worker e no backoffice; `npm run build` no backoffice
com exit 0 e as rotas novas todas dinâmicas (`/[locale]/conta`,
`/admin/clientes/[code]`, `/api/admin/clientes/[code]`). A migração foi aplicada
e verificada numa base local.

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

### 1. Migrações — FEITAS

`0058_client_code.sql` e `0059_identity_notice_seen.sql` estão aplicadas em
produção (13/09/2026). As 42 contas têm código, nenhum se repete, e todos estão
na ledger `client_codes`.

Duas notas de quem as correu, para a próxima:

- A árvore em `C:\dev\shopifyix` está numa branch antiga, por isso um ficheiro
  acabado de mergir **não está lá**. Correr a migração a partir de um worktree
  em `main`, ou copiar o ficheiro primeiro.
- `--file` sobe o SQL por um endpoint de import que devolveu
  `Authentication error [code: 10000]` com o token OAuth válido e permissões de
  super admin. Para uma migração de uma instrução, `--command` passa. Para uma
  maior, `npx wrangler login` e repetir.

### 2. Conferir contra dados reais — FEITO a 13/09/2026, sem browser

Em vez de abrir páginas, a lógica da rota correu contra a D1 de produção (só
leitura: `npx wrangler d1 execute rioko-db --remote` funciona a partir da
sessão), em duas passagens com verificação adversarial. Correcções em #148 e
#150; o que ficou por decidir está em "Verificação contra produção", abaixo.

- **Bikini Books** — a série `OL` e as isenções M05/M40 configuradas batem com
  `/admin/client-rules`. Mas os "9 documentos" eram 42 (33 gravados sem
  `user_id`), e o separador fiscal estava vazio. Ambos corrigidos.
- **Membros, códigos, NIF bloqueado** — verificados sobre as 42 contas; o único
  achado foi o código ditado com O/I/L, corrigido.

### 3. Ligar o código à newsletter — FEITO pela sessão da campanha

Cada campanha guarda `{ code, email }` no snapshot e o código vai como
propriedade do contacto no Resend (aaef575).

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

A guarda é `CASE WHEN registration_completed = 1 AND ? = 0 AND COALESCE(nif, '') <> '' THEN nif ELSE ? END`,
com a bandeira a valer `isAdmin(userId) ? 1 : 0`. Está no UPDATE e não no HTML
porque um campo desactivado é uma sugestão a quem consiga fazer POST. Só tranca
um campo **com valor**, e `registration_completed` só passa a 1 num save que
traz NIF — antes, um save da Conta sem NIF completava o registo e trancava o
NIF vazio para sempre.

O pedido de alteração **não** vive em `incidents`: `autoResolveStaleIncidents`
fecha aos 24 h qualquer incidente fora de `INVOICE_FAILURE_KINDS`
(`src/services/incidents.ts:600-607`) e o pedido desaparecia sozinho.

O ciclo do pedido é todo `config_audit`, só de acrescentar:
`profile_change_request` → `profile` (aplicado) ou `profile_change_rejected`
(motivo em `new_value`). O estado deriva-se em `identityRequestStates`
(`lib/client-record-sql.ts`), por ordem de linha e não de relógio — o
`CURRENT_TIMESTAMP` tem resolução de um segundo. O cliente sabe do desfecho por
um aviso no painel até o dispensar (`users.identity_notice_seen_at`, 0059,
janela de 30 dias). **Sem email de desfecho, por decisão**; só o operador
recebe email quando o pedido chega.

---

## Auditoria de 13/09/2026

Revisão do que foi entregue em #140–#143, corrigida na branch
`fix/customer-record-audit` (sem migrações). Achados confirmados e corrigidos:

- **Conta:** NIF vazio trancado (acima); os quatro wizards de onboarding deixavam
  editar NIF/empresa que o servidor deitava fora em silêncio — agora em leitura.
- **Ficha:** cartão Shopify→IX fantasma só com `ix_authorized` (agora exige
  loja); a linha legada saía inteira (colunas fiscais) a superadmins — agora só
  identidade; a checklist de credenciais ignorava `source_config_json` (Stripe);
  ligação sem subscrição própria aparecia activa enquanto o worker a recusa —
  agora avisa; links Stripe mandavam `pi_`/`ch_` para `/invoices/`; o portão lia
  o papel da conta impersonada; `document-log?user_id` não verificava papel; o
  aviso de membro não sobrevivia ao redirect; o filtro "Sem ligação" estava
  sempre vazio; uma recusa lia-se no registo como o NIF a mudar para o motivo.
- **Pedido fiscal:** pedido e recusa respondiam sucesso com a escrita em
  `config_audit` falhada; um membro dispensava o aviso do dono; `decided_by`
  chegava ao comerciante; aviso e histórico mostravam o valor pedido em vez do
  gravado e a data do pedido como data da decisão.
- **Código:** uma conta apagada e recriada com o mesmo id Clerk recebia um
  segundo número — agora recupera o primeiro da `client_codes`.
- **Referral:** a auditoria apanhou o `SubscriptionCard` a rebentar com
  `ui_state = "reward"`. Não é corrigido aqui: o PR #145 da sessão da campanha
  tira `"reward"` de `SubscriptionUIState` (fica `trialing`), que resolve na raiz.

Refutados: 0058 meio aplicada; janela `LIMIT 40`; `users.nif` não ser o NIF do
emparelhador.

---

## Verificação contra produção (13/09/2026)

A lógica da ficha correu contra a D1 real, só em leitura, com um verificador
adversarial por achado; o diff das correcções foi revisto do mesmo modo antes do
merge.

Corrigido em #148 e #150:

- **Aviso de desfecho em impersonação** voltava em cada separador (ficava em
  sessionStorage). Agora fica dispensado no browser de quem o dispensou; o
  cliente continua a vê-lo até ser ele a dispensar.
- **"Subscrito"** passou a ser o veredicto do gate e não "tem linha". Oito
  ligações ficaram a vermelho, todas confirmadas como recusadas pelo worker, e o
  aviso diz porquê.
- **Credenciais** por tipo de ligação, com o par IX lido como o worker o lê
  (ligação, depois linha legada).
- **Regras fiscais** do par legado visíveis, pela lista que a consola usa, agora
  partilhada em `lib/redact`.
- **Documentos e Registos** incluem as linhas gravadas sem `user_id` da loja da
  conta. Sem dupla contagem: nenhum domínio está em duas contas.
- **Stripe**: uma linha por pagamento, aviso com os dois documentos quando as
  cópias divergem, tentativas falhadas a vermelho, clientes também a partir dos
  pagamentos.
- **link-subscription** deixou de criar a segunda linha `invoice.paid` para um
  pagamento que a conta já tem, e nunca escreve na linha de outra conta.
- **Conta e registo**: data de consentimento só no primeiro aceite; o Clerk deixa
  de repor o nome de uma conta registada; um código ditado com O/I/L resolve.
- **Client rules**: a secção legada deixou de mostrar quatro interruptores que não
  são colunas ali.

### Por decidir — dados, não código

- **Lojas recusadas pelo gate**: RIO-876537, RIO-A25582, RIO-50FEC0 e RIO-8E2DD7
  (early-bird até 31/08) e RIO-904EDB (até 11/09). Shopify activo, sem
  subscrição Stripe; o varrimento das 04:00 salta as encomendas. Também
  RIO-BAC43C (stripe:moloni cancelada, em rascunho).
- **Bikini Books, 8 faturas com M99** em vez de M05: 48–50/OL e 54–58/OL, do lote
  de 09/07, detectadas pela verificação de 15/08 e nunca regularizadas.
- **Ligações IX pagas sem credenciais IX**: RIO-17DC06 (stripe_connect, dois
  `create_failed`) e RIO-2A7209 (lodgify).
- **Documentos Kapta**: o pagamento `in_1UE8NeJwZ8gzmNr4zJmIgdNd` da RIO-2A7209
  tem dois documentos, 269945806 e 269945971; e os documentos 262819737,
  263589335, 265162803 e 265775051 estão cada um ligado a dois pagamentos.
- **`user_id` NULL** em 11.118 `processed_orders` e 4.471 `document_events`: os
  handlers Shopify constroem `AppStorage` só com o domínio (`orders-created.ts`,
  `orders-paid.ts`, reconciliação). A ficha já atribui pelo domínio; falta
  corrigir o writer e fazer o backfill.
- **Pedido fiscal feito em impersonação** aparece ao cliente como pedido dele.
- **Pessoas singulares**: a Conta mostra o nome fiscal vazio, porque o nome que
  sai na fatura vive em `users.name`, que é editável.

Deixado de fora de propósito: a janela de 200 eventos nos Registos pode deixar
prova antiga de fora nas contas maiores.

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
