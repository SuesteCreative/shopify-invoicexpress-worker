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
- [ ] **DEFERRED** — Migrar legacy Shopify handlers para pipeline. Plano detalhado em conversa de 2026-05-25 (~34-38h). Gaps críticos identificados: pipeline sem VIES, sem reverse-charge no destination, sem refund dedup, sem `awaitInvoiceVisibility`, `AdapterCtx` sem KV. Decisão: ship Moloni/Vendus para Stripe-source primeiro (não precisa VIES/reverse-charge); legacy migration depois de #1-#4.

### High
- [x] Implementar `VendusDestination` adapter (re-escrito contra docs reais vendus.pt; 5 TODOs inline: sandbox URL, `/communications/` body shape, refund row mapping, Açores/Madeira tax rates, findByReference substring collision)
- [x] Adicionar `"vendus"` a `DestinationKind` em `src/storage.ts` e `src/adapters/types.ts`
- [x] Registar `MoloniDestination` e `VendusDestination` em `src/adapters/registry.ts`
- [x] Adicionar `destinationConfig?: Record<string, any>` a `AdapterCtx` e `RunPipelineInput`
- [x] `processStripeBatch` em `src/index.ts` parseia `connections.destination_config_json` e passa para `runAdapterPipeline`
- [x] Atualizar `classifyPipelineError` para reconhecer erros Vendus (regra: `"vendus" + "fail"|"finalize"`)
- [ ] Implementar `EuPagoSource` adapter (gateway PT — callback após pagamento)
- [ ] Implementar `EasypaySource` adapter (gateway PT)
- [ ] Implementar `IfthenpaySource` adapter (gateway PT)
- [ ] Adicionar route handlers de connect/disconnect para Moloni e Vendus em `backoffice/src/app/api/integrations/`

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
- [ ] Corrigir links "o que é?" nas integrations cards (atualmente apontam mal para secções da ajuda)
- [ ] Atualizar conteúdo da página `/help` com informações reais (ATCUD, séries, certificação AT, etc.)
- [ ] Embed de vídeos tutoriais nas secções da ajuda

---

## #2 — Responsividade Mobile

### High
- [ ] Audit completo das páginas do backoffice em viewport mobile (320px, 375px, 414px, 768px)
- [ ] Fix de overflow horizontal em tabelas (incidents, processed invoices, logs)
- [ ] Fix de nav/header em mobile
- [ ] Fix de modais e drawers
- [ ] Audit da landing page em mobile

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
