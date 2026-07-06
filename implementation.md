# Implementation Roadmap

Roadmap dos 6 itens definidos em 2026-05-25. Ordem: 5 → 6 → 4 → 2 → 1 → 3.

Conventions:
- Critical = bloqueante de release ou de outras tarefas
- High = entrega valor visível ao utilizador
- Medium = cleanup arquitetural ou doc
- Low = nice-to-have

---

## #5 — Modularização sources/sinks (escala ≥3×3)

**Estado atual:** esqueleto modular já existe (`src/adapters/{types,registry}.ts`, `sources/shopify-source.ts`, `sources/stripe-source.ts`, `destinations/ix-destination.ts`, `handlers/generic-pipeline.ts`). Falta expandir.

**Sources alvo (da landing):** Shopify ✓, Stripe ✓, EuPago, Easypay, Ifthenpay
**Destinations alvo:** InvoiceXpress ✓, Moloni, Vendus, (Espanha → mais tarde)

### Critical
- [x] Implementar `MoloniDestination` adapter (validado contra docs api.moloni.pt; 1 TODO: sandbox URL `apidemo.moloni.pt` não confirmado)
- [x] **REPLACED** — Em vez de migrar legacy (~34h), criámos **routing-by-destination_kind** em `processShopifyBatch` (2026-05-25, commit 91d58a4). Aditivo: Shopify→IX continua pelo legacy intacto; Shopify→Moloni/Vendus vai pelo pipeline. Limitações documentadas na UI (sem VIES/B2B EU reverse-charge). Legacy big migration fica reservada para quando alguém precisar de B2B EU em Moloni — pode esperar muito tempo.

### High
- [x] Implementar `VendusDestination` adapter (re-escrito contra docs reais vendus.pt; 5 TODOs inline: sandbox URL, `/communications/` body shape, refund row mapping, Açores/Madeira tax rates, findByReference substring collision)
- [x] Adicionar `"vendus"` a `DestinationKind` em `src/storage.ts` e `src/adapters/types.ts`
- [x] Registar `MoloniDestination` e `VendusDestination` em `src/adapters/registry.ts`
- [x] Adicionar `destinationConfig?: Record<string, any>` a `AdapterCtx` e `RunPipelineInput`
- [x] `processStripeBatch` em `src/index.ts` parseia `connections.destination_config_json` e passa para `runAdapterPipeline`
- [x] Atualizar `classifyPipelineError` para reconhecer erros Vendus (regra: `"vendus" + "fail"|"finalize"`)
- [x] Implementar `EuPagoSource` adapter (Realtime Webhooks 2.0; HMAC-SHA256 via `X-Signature`; PAID→created, REFUNDED→refund; default "Consumidor Final" customer; AES encryption NOT supported, merchant deve desativar)
- [x] EuPago webhook endpoint `POST /webhooks/eupago/:userId` em worker
- [x] Route handler `/api/integrations/eupago-source` + UI `/integrations/eupago-ix` + i18n PT/EN
- [x] Integrations index: EuPago ativo, combo EuPago+IX → configurator
- [ ] Implementar `EasypaySource` adapter (gateway PT)
- [ ] Implementar `IfthenpaySource` adapter (gateway PT)
- [ ] Adicionar route handlers de connect/disconnect para Vendus em `backoffice/src/app/api/integrations/` (Moloni já feito)
- [ ] Combos EuPago+Moloni, EuPago+Vendus (replicar padrão eupago-ix)

### Medium
- [x] Criar `docs/ADAPTERS.md` — contrato + guia de extensão. 5 inconsistências do código flagged inline (kinds duplicadas em 2 ficheiros, sem pasta tests/, classifier hardcoded a destinations conhecidos, etc.)
- [ ] Testes unitários para cada novo adapter (verifyWebhook, externalId, toNormalized / createDraft, finalize, issueCredit)

### Low
- [ ] UI nas integrations page do backoffice para Moloni, Vendus, EuPago, Easypay, Ifthenpay (cards + connect flow)
- [ ] Refresh do landing card status ("planned" → "live") para os que ficarem prontos

### Known TODOs (inline em código)
- Moloni: token caching (atualmente fetch fresh por invocação — ~3-4 chamadas/order), sandbox URL não verificado, `document_set_id`/`tax_id`/`country_id` precisam mapping real via setup do utilizador
- Vendus: sandbox URL não documentado, `/communications/` body UNVERIFIED, refund→original-row mapping pode falhar em refunds parciais sem SKU, `findByReference` usa substring match (pode colidir)
- Pipeline: `AdapterCtx.kv` ainda em falta → bloqueia VIES checker para reverse charge em Shopify-source
- Storage: `IRequestConfig` ainda guarda credentials IX legacy em `integrations` table — Phase 5 deve mover tudo para `connections.destination_config_json`

---

## #6 — Ativar Moloni no produto Rioko (backoffice + worker)

> **Clarificação 2026-05-25:** Rioko é o nome do produto SaaS (não um cliente). `rioko-next/` é versão legacy a deprecar; a versão atual é `src/` (worker CF) + `backoffice/` (Next.js CF Pages). #6 é ativar Moloni nessa versão atual.

### High
- [x] Route handler `backoffice/src/app/api/integrations/moloni-destination/route.ts` — POST/GET/DELETE, escreve em `connections.destination_config_json`. Warning para Shopify-source até legacy migration.
- [x] UI page `backoffice/src/app/[locale]/(dashboard)/integrations/stripe-moloni/page.tsx` — form Stripe+Moloni com client_id/secret/username/password/company_id/document_set_id/environment.
- [x] Integrations index page: Moloni ativado em `INVOICING_PLATFORMS`, `canConnect` aceita Stripe+Moloni, routing para `/integrations/stripe-moloni`.
- [x] i18n strings `stripeMoloniSetup` em `pt.json` + `en.json`.
- [x] Routing logic destination=moloni → já feito via `processStripeBatch` no #5 (lê `destination_kind` e passa pelo registry).

### Medium
- [ ] Teste end-to-end com credentials Moloni sandbox reais (criar fatura draft, finalizar, emitir nota crédito) — depende de credenciais do user.
- [ ] Validar pormenores Moloni reportados como TODO no adapter (sandbox URL `apidemo.moloni.pt`, `document_set_id` real, `country_id`/`tax_id` mapping).
- [ ] Atualizar landing card Moloni status "planned" → "live" no `backoffice/src/components/landing/Landing.tsx` **APÓS** teste end-to-end.

### Low
- [ ] Shopify-source + Moloni — bloqueado por legacy migration (DEFERRED). Reabrir quando legacy estiver migrado.
- [ ] Renomear `INVOICEXPRESS_*` env vars hardcoded em wrangler.jsonc para algo agnóstico (são fallback para destination=invoicexpress, não global).

---

## #4 — Geral & Ajuda

### High
- [x] Corrigir links "o que é?" nas integrations cards. Corrigidos 6 anchors errados em `integrations/shopify-ix/page.tsx` (`dominio-shopify`→`shopify-domain`, `access-token`→`shopify-token`, `api-version`→`shopify-api-version`, `webhook-secret`→`shopify-webhook`, `doc-type`→`ix-doc-type`, `billing-sequence`→`ix-sequence`, `manual-webhooks`→`shopify-webhook`). Anchors sem secção (`vat`, `auto-finalize`, `retention`, `exemption`) apontam agora para `/help` raiz em vez de hash quebrado.
- [ ] Criar secções dedicadas no `/help` para conceitos sem documentação: `vat` (VAT inclusivo vs exclusivo), `auto-finalize`, `retention` (IRS/IRC), `exemption` (códigos M01-M99). Depois reapontar os links das integrations para os anchors novos.
- [ ] Atualizar conteúdo da página `/help` com informações reais (ATCUD, séries, certificação AT, etc.) — sub-task expandida em #1 Blog SEO.
- [ ] Embed de vídeos tutoriais nas secções da ajuda — depende de produção de vídeos.

---

## #2 — Responsividade Mobile

**Audit estático 2026-05-25:** 8 critical, 28 high, 20 medium, 8 low = 64 issues.

### Critical — todos resolvidos
- [x] Sidebar drawer mobile (`Sidebar.tsx` novo client component + layout server simplificado).
- [x] Faturacao table envolto em `overflow-x-auto` + `min-w-[640px]`.
- [x] `SubscriptionCard` plan picker `grid-cols-1 sm:grid-cols-2` + checkout button `w-full lg:w-auto`.
- [x] Popovers `w-80` → `w-[90vw] max-w-[20rem]` em shopify-ix + stripe-ix.
- [x] `stripe-moloni` grid `grid-cols-1 sm:grid-cols-2` + action row `flex-col sm:flex-row`.
- [x] `superadmin` dividers/min-widths gated em `lg:` + `text-5xl` step-down + padding responsivo.
- [x] `client-rules` header `flex-col md:flex-row` + status pills wrap + `text-5xl` step-down.
- [x] `text-5xl` global step-down em 7 ficheiros (`text-3xl sm:text-4xl lg:text-5xl`).
- [x] `help/page.tsx` `ml-16` → `ml-0 sm:ml-16` (reclama 64px horizontal).

### High Landing — top wins resolvidos
- [x] Pricing grid `gap-8 md:gap-4` para ribbon não sobrepor.
- [x] Nav padding tightened + logo width responsive + Start CTA smaller mobile.
- [x] Final CTA padding step-down.
- [x] 5 section paddings step-down (`pt-20 sm:pt-32 md:pt-44`).
- [x] Hero stats grid step-down.
- [x] Pipeline pills `grid-cols-2 sm:grid-cols-4`.

### High dashboard — resolvidos
- [x] Heavy `p-8/10/12/16/20` flat padding em ~50 sítios — sweep automatizado adicionou `sm:` prefix.
- [x] Invoices page: `sticky` → `md:sticky`.
- [x] Sub-12px fonts (~30 promoções `text-[7-9px]` → `text-[10px]`).
- [x] NavLinks tooltips: inline mobile + popover desktop.
- [x] Clerk sign-in/sign-up widget wrap em `max-w-[440px]`.

### Medium / Low — resolvidos
- [x] Landing code block font step-down (`text-[12px]` → `text-[11px] sm:text-[12px]` para Steps code blocks).
- [x] PricingCard padding step-down (`p-8` → `p-6 sm:p-8`).
- [x] PT translations long buttons — verificado, sort buttons em superadmin/client-rules estão dentro de `flex flex-wrap` parent, wrappam OK em mobile sem overflow.
- [x] Layout main padding (`px-4 py-6 md:px-12 md:py-16`) já ajustado em d966d68.

### Restante DEFERRED (cosmetic, não bloqueante)
- [ ] Sample real visual em browser (Playwright em 320/375/768) — confirmação dinâmica do audit estático. Recomendado antes de release marketing significativo.
- [ ] LOW polish items (hover effects, jittery animations narrow viewport, decorative spacing) — listados em audit transcript.
- [ ] Tooltips com info importante em outras componentes (não NavLinks) — auditar quando aparecerem.

---

## #1 — Blog SEO

### Medium
- [ ] Setup técnico do blog (MDX em `backoffice/src/app/[locale]/blog/`)
- [ ] Schema: BlogPosting + Article para Google
- [ ] Sitemap dinâmico + robots.txt
- [ ] Primeiros artigos: "Como criar utilizador ATCUD", "Como criar séries certificadas", "Comunicação à AT pré-vs-pós-fatura", "IVA OSS vs reverse charge", "Reconciliação Shopify → InvoiceXpress"

---

## #3 — Sistema de Email

### Medium
- [ ] Schema DB: tabela `email_campaigns`, `email_recipients`, `email_templates`
- [ ] Selector de utilizadores no backoffice (filtros: sem integração, com integração mas sem fatura emitida, etc.)
- [ ] Templates: "Marcar reunião onboarding", "Convite reativação", "Newsletter blog"
- [ ] Provider: Resend ou Postmark (decisão a tomar)
- [ ] Tracking básico (opens, clicks)

---

## Audit — 2026-05-25 (kickoff)

Não há issues de audit — esta é a snapshot inicial do roadmap. Adicionar entradas dated abaixo conforme audits forem corridos.

## Audit — 2026-05-27 (invoice total = paid invariant)

Source-of-truth invariant: invoice gross MUST equal source amount paid, em todos os combos Stripe/Shopify/EuPago × IX/Moloni/Vendus. Auditoria detectou drift silencioso em 4 adapters críticos + 2 paths sem reconciliação.

### Critical
- [x] Extract `reconcileOrThrow()` from IxBuilder to shared `src/adapters/reconcile.ts` so all destinations can call it
- [x] Stripe→Moloni: add pre-POST reconciliation `sum(lines) == normalized.order.total` (throw if drift > 1¢)
- [x] Stripe→Vendus + Shopify→Vendus: fix `gross_price = unit_price` assumption — normalized items are NET; either divide by `(1 + tax/100)` or send as net with tax_id; add reconciliation
- [x] Shopify→Moloni: document/fix `vat_included` semantics — normalized items are always net per IX convention; remove ambiguous strip-VAT branch in `buildMoloniLineItems`

### High
- [x] Stripe→IX: enforce single-line reconciliation (`amount_received == unit_price * qty`) since `raw_order` is absent and `reconcileOrThrow` skips
- [x] EuPago→IX: emit NET `unit_price` (was gross with tax=23 → IX inflated by 23%). `force_tax_rate` override already supported; now applied correctly to derive net.

## Audit — 2026-05-27 (live API smoke test)

Confirmed against real Stripe/Moloni/Vendus test accounts. Found a blocker that meant the Moloni adapter could never have worked in production.

### Critical
- [x] Moloni adapter sends JSON body but the Moloni API only accepts `application/x-www-form-urlencoded` with PHP-style bracket nesting for arrays (`products[0][name]=...&products[0][taxes][0][tax_id]=...`). Every Moloni call would have returned `Forbidden, No company_id received`. Patched `moloniCall` with a `formEncode` helper and switched the Content-Type header.
- [x] Moloni `/invoices/insert/` requires every line to reference an existing `product_id`. Sending lines with `product_id: 0` or no product_id returns the terse validation error `["1 products"]`. Adapter does find-or-create on a per-company product catalog: reference derived from the source item (SKU verbatim, else `RIOKO-VARIANT-<id>`, else `RIOKO-PRODUCT-<id>`, else `RIOKO-SHIPPING` for shipping lines, else `RIOKO-PLACEHOLDER` for synthetic lines). Repeated SKUs across invoices reuse the same Moloni product row — no per-invoice clutter, Moloni's product catalog mirrors Shopify/Stripe.
- [x] `moloniCall` now rejects 200-OK responses whose body is a non-empty array of plain strings — Moloni's field-validation error shape. Was silently treated as success.

## Audit — 2026-06-02 (per-merchant invoice failures, legacy Shopify→IX)

Prod log/incident sweep (`rioko-db`) after the IX country-name fix. All four active merchants
affected by distinct bugs in the legacy Shopify→IX path: Fabrica Coffee Roasters,
Vanessa Holler (soulkrave), Stella Carvalho, Benedita Homem de Gouveia.

### High
- [x] `orders/paid` "Invoice not found by order.id" → permanent-failure retry storm (Fabrica ~600, Benedita ~960). Root: `orders/created` returned without persisting `processed_orders` when the IX doc already exists, and any create failure left no row. Fix: `orders-created` now saves the existing IX doc id on the "already exists" branch + marks success; `orders-paid` looks up by raw `orderId` and **self-heals** (runs the idempotent create flow, re-looks-up) instead of throwing; `saveProcessedInvoice` made `INSERT OR REPLACE`.
- [x] "Invoice total mismatch" on Stella Carvalho — **already fixed, no new code**. Real root was NOT an unallocated discount: these are **Spain (ES) reverse-charge / VAT-not-collected** orders (`tax_lines.rate=0.21, price=0.00, total_tax=0`). The deployed guard `028afdf` (`taxCollected>0 ? declaredRate : 0`) already issues a net invoice matching `total_price`. Verified: **zero `total mismatch` logs since 2026-05-29**. (Proper intra-EU reverse-charge exemption codes = separate feature; `b2b_reverse_charge=0` for her.)

### Medium
- [x] Normalize SPOF resilience: `fetchNormalized` now wraps the external call in a 10s `AbortSignal.timeout` + 2 retries (backoff) on network/5xx; a definitive Shopify **404 / "Unable to fetch order"** throws a permanent error that `classifyPipelineError` acks once with an incident instead of retrying ~25×.

### Deferred (this pass)
- [ ] Shopify `webhook_invalid_signature` (Vanessa's stale per-shop secret) — skipped per user. Blocks her NEW orders auto-enqueueing; existing backlog still recoverable via conciliação/backfill.

---

## Audit — 2026-06-09 — Incidente zoolagos "faturas por emitir"

Cliente Pedro Botelho (`zoolagos.myshopify.com`, IX `pelicanzooparquez`, bilheteira de zoo).
Verificação autoritativa: 253 pagas (90d) · 222 com invoice_id · **213+ confirmadas no IX, 0 perdidas** · **26 PT‑6% mesmo por emitir** · ~120 estrangeiras emitidas a 0%.

**Estado 2026-06-09 (resolvido a maior parte):** worker version `459cf9b7` (os 3 fixes) **promovida a 100% em produção**. As **26 reemitidas com sucesso** via fallback sanitized-client (#1054 foi timeout-mas-criou, sincronizado id 259579346). Sobra só #1264 (nova, pós-deploy → pipeline trata) + 5 testes €0,64 pré-arranque. **Pendente: (a) landar os 3 commits em `main` (worker live é versão promovida, não main → um deploy de main reverte-os); (b) #4 as ~111 estrangeiras; (c) #Medium cache.**

### Critical
- [x] **Phantom "Sem fatura"** — `getReconciliation` dispara 1 fetch/fatura via `Promise.all` sem cap (200+ GETs paralelos ao proxy `ix-proxy.kapta.app`); sob carga muitos devolvem null e faturas EMITIDAS são mostradas como "Sem fatura emitida". Fix: cap de concorrência (6) + retry, e **nunca** marcar "none" quando há `invoice_id` na BD (estado `meta_unavailable`). Worker `src/handlers/reconciliation.ts` + frontend `ReconciliationRow.tsx`.
- [x] **Erros IX engolidos** — `orders-created.ts:157` fazia `console.log(ixCreateResponse)` (efémero) mas gravava só "Failed to create invoice" na BD. Fix: persistir `ixCreateResponse.error` num log status=500 + embebê-lo no Error lançado (propaga ao log/incidente do consumer). orders/paid self-heal passa pelo mesmo ramo → coberto.
- [x] **26 PT‑6% por emitir** (3–8 jun) — causa: IX recusa o documento com **DOC010 "Cliente/Fiscal não é válido"** no passo de resolução do cliente, apesar de os dados (raw+normalizado+localizationExtensions) não terem NIF e serem idênticos a pedidos que passaram → estado partido do cliente no IX (provável match por `code`=customer.id a um registo com fiscal inválido). Fix [CODE]: `src/ix/create-invoice.ts` — retry transitório + fallback que recria com cliente limpo (drop fiscal_id/code/phone → "Consumidor Final") no erro DOC010. Ligado em orders-created.ts + admin.ts (reemit). **Reemissão das 26 = [OPS] pendente de deploy.** Lista: 1037,1038,1039,1054,1056,1064,1066,1070,1072,1074,1090,1091,1098,1100,1102,1128,1133,1146,1149,1188,1189,1193,1206,1216,1218,1229.

### High
- [x] **Fix FORWARD estrangeiras a 0%** — causa: builder envia taxa como número → resolver IX faz fallback Isento p/ clientes não‑PT (IVA6 é região PT). **Testado live**: draft p/ cliente France forçando `{id:1072450,name:"IVA6",value:6}` → IX honrou 6% (draft apagado). Fix [CODE] `src/ix/create-invoice.ts` `resolveExplicitForcedTax`: quando `force_tax_rate > 0`, resolve a taxa para o objeto explícito da conta (GET /v2/taxes, match por valor) antes do POST. **Gated em `>0` → afeta SÓ zoolagos** (mindfulmuse force=0 intacto). Ligado em orders-created.ts + admin.ts.
- [ ] **Corrigir ~111 estrangeiras antigas (settled) a 0%** — [OPS, sensível] nota de crédito + reemissão a 6% (~298€ IVA). Lista em `scripts/diag-foreign-0pct.mjs`. **Só com OK do contabilista** + confirmar treatment.

### Medium
- [x] **Cache de meta de fatura** — conciliação refazia todos os GETs ao IX a cada load (causa-raiz da carga no proxy → phantom). Feito via **KV** (sem migração, evitando o caos de migrations 0012): `getReconciliation` lê `ixmeta:{id}` do KV primeiro; em miss vai ao IX (capped+retry) e grava no KV (TTL 24h). Aquece sozinha; loads seguintes são proxy-free. `AppStorage.getCachedInvoiceMetas`/`cacheInvoiceMeta`. NB: migrations em estado sujo (0012_user_id_scoping pendente+uncommitted, colisão de nº 0012) — resolver à parte.

---

## Audit — 2026-06-11 — Pre-onboarding health check (Shopify→IX)

Ran the REAL bundled `IxBuilder` over ~2,180 real paid orders for the 4 live clients + 11 IX
sandbox drafts (`ultramegasonico`, x-env dev). Harness: `scripts/healthcheck.mjs` (offline drift
matrix, zero writes) + `scripts/draft-e2e.mjs` (sandbox drafts only). 3/4 clients clean (zoolagos,
fabrica-coffee-roaster, mwi1cr-7t — 0 drift across ~1,800 orders incl. forced-tax/foreign/POS).
**Only 2d0604-3 (OSS + reverse-charge, VAT-EXCLUDED) drifts: 15/385 orders blocked by the 1¢ reconcile
guard** — confirmed in prod logs (real 422 "Invoice total mismatch" + 944× "Invoice not found" cascade).

### Critical
- [x] **F-ROUND** — tax-EXCLUDED multi-line orders blocked by the 1¢ reconcile guard -> never invoiced.
  Root cause (found via sandbox): **IX rounds the total ONCE** (`total = round2(Σ unit·qty·(1-d/100)·
  (1+r/100))`, full-precision sum — returned `tax_amount` is unrounded), but the shared
  `computeExpectedGross` rounds PER LINE, so it mis-predicted IX by a few cents on multi-line orders.
  Fix: (1) new `ixExpectedGross` round-once model used by `computeIxExpectedTotal` + `reconcileOrThrow`
  (round-once guard now agrees with IX); (2) `absorbReconcileResidual` re-targets the highest-gross line
  in full precision so IX's total lands exactly on Shopify `total_price`; scoped to tax-EXCLUDED only
  (vat-included clients skip it -> zero risk) and only pure rounding noise (`|residual| <= 0.01·nLines +
  0.10`) — larger gaps fall through to reconcile. **Validated against IX sandbox: 11/11 drift orders now
  total EXACTLY == paid (incl. a 137-line, 1194.60€ order); 3 clean clients unchanged; 2d0604-3 15->1
  (the last is F-SHIP).**

### High
- [x] **F1** — non-raw fallback (raw Shopify fetch failed) emitted IX-ignored `discount_amount` AND
  skipped the reconcile guard -> silent over-invoice on discounted orders. Fix: reconcile the non-raw
  path against `normalized.order.total` too (throws -> retry instead of issuing a wrong total).
- [x] **F-SHIP** — shipping line taxed entirely at `tax_lines[0].rate`; mixed-rate shipping (OSS basket
  with items at 2 VAT rates -> Shopify splits the shipping tax across them) was mis-taxed (#4172: +0.50EUR).
  Fix: when a shipping line's collected tax spans >1 distinct rate (and no forced rate / discount), split
  it into one IX sub-line per rate, each sized from that rate's own tax basis. Single-rate shipping
  unchanged. Validated: #4172 reconciles to paid exactly (74.19); synthetic 23%+6% split POSTed to IX
  sandbox -> total exact, each portion taxed at its own rate. (#4172 only fails the PT *sandbox* because
  that test account lacks a 10% tax; the prod OSS account has it.)
- [x] **F2** — refund->credit-note path had NO reconcile guard and uses the non-raw builder; the
  `amountToRefund = amount - sum(subtotal)` line can double-count tax on partial line-item refunds. Fix:
  thread the gross refund `amount` through and reconcile the assembled credit-note total against it
  (round-once `computeIxExpectedTotal`) before POST; abort on >1c drift -> queue retry + DLQ incident
  instead of a fiscally-wrong credit note. Verified `amount` = gross refunded against a live refund;
  regression: clean full + matched-partial refunds pass, double-counted-tax + dropped-discount notes
  blocked.

### Medium
- [x] **F3** — forced-tax explicit resolution covered products only -> a foreign client's shipping at
  `force_shipping_tax_rate` fell back to Isento 0%. Fix: resolve the union of forced product+shipping
  rates to explicit account-tax objects. Sandbox-proven (FR client, product@21% + shipping@6% kept).
  Inert for all 4 current clients (none set `force_shipping_tax_rate`).
- [x] **F-NULL** — `pickInvoiceAddress` NPE'd on `customer: null` (guest/POS) -> order never invoiced.
  Fix: default null customer to `{}`.

---

## Audit — 2026-07-06 (Stripe→Moloni onboarding verification)

Found while verifying the Stripe→Moloni path before onboarding a new Moloni-only
client (no Shopify/IX history → no legacy `integrations` row). Root cause is the
split config source-of-truth: the setup wizard writes to
`connections.destination_config_json`, but the worker reads several settings from
the legacy `integrations` row.

### Critical
- [x] **BUG 0** — global `STRIPE_WEBHOOK_SECRET` fail-fast (`src/index.ts` `/webhooks/stripe`)
  returns 500 for ALL Stripe events before the per-connection secret logic runs. Live probe:
  `POST /webhooks/stripe → 500 "Stripe webhook secret not configured"`. Signing secrets are
  per-connection (auto-installed via the merchant's restricted key), so the global gate is dead
  weight. Fix: drop the fail-fast; the per-connection scan verifies and 404s gracefully.
- [x] **BUG A** — `processStripeBatch` drops events (`message.ack()` + skip) when a user has no
  legacy `integrations` row. A Moloni-only client's paid order is silently never invoiced, no
  incident. Fix: synthesize a minimal config from `destination_config` (mirror the Lodgify poller).

### High
- [x] **BUG B** — `auto_finalize` read from legacy `integrations` row (`generic-pipeline.ts`),
  but the Moloni wizard saves it to `destination_config`. Wizard toggle ignored → invoices stay
  draft. Fixed by BUG A's config projection (project `destinationConfig.auto_finalize` over base).
- [ ] **BUG C** — `exemption_reason` read from `ctx.config.ix_exemption_reason`
  (`moloni-destination.ts`, 4 sites), but the wizard saves `destination_config.exemption_reason`.
  Never read → wrong fiscal exemption code (always falls back to M01). Affects Stripe AND Lodgify→Moloni.
  Fix: read exemption from `destinationConfig` first, legacy as fallback.

### Medium
- [ ] **BUG D** — incident `connection_label` hardcoded `"stripe → invoicexpress"` in the Stripe
  webhook handler (`src/index.ts`), mislabels Moloni/Vendus clients. Fix: pull `destination_kind`
  from the connection row and interpolate.
