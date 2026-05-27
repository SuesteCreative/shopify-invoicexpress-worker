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
- [ ] Shopify→Moloni: document/fix `vat_included` semantics — normalized items are always net per IX convention; remove ambiguous strip-VAT branch in `buildMoloniLineItems`

### High
- [ ] Stripe→IX: enforce single-line reconciliation (`amount_received == unit_price * qty`) since `raw_order` is absent and `reconcileOrThrow` skips
- [ ] EuPago→IX: replace hardcoded 23% in `eupago-source.ts` with `ctx.config.force_tax_rate` lookup (fall back to 23%)
