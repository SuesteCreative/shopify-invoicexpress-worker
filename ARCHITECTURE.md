# Architecture — Rioko Invoicing Engine

> **What this is:** a single Git repo (`shopify-invoicexpress-worker`) that contains **three independently-deployed applications** plus shared tooling. Understanding that split is the key to not "pushing garbage to main" — see [Deploy Topology](#deploy-topology) and [Git Hygiene](#git-hygiene--why-garbage-reaches-main).

Last reviewed: 2026-06-11.

---

## 1. The 30-second model

Rioko turns **payment events** (a Shopify order, a Stripe charge, an EuPago payment) into **fiscal documents** (an InvoiceXpress / Moloni / Vendus invoice or credit note), automatically, per merchant, with idempotency, reconciliation and incident alerting.

```
 Source (payment)                Rioko Worker (this repo, /src)              Destination (invoicing)
┌──────────────────┐   webhook   ┌──────────────────────────────────┐  API  ┌────────────────────┐
│ Shopify          │ ──────────▶ │  HTTP route → verify HMAC →      │ ────▶ │ InvoiceXpress (IX) │
│ Stripe           │             │  enqueue → Queue consumer →      │       │ Moloni             │
│ EuPago           │             │  Adapter pipeline OR legacy path │       │ Vendus             │
└──────────────────┘             └──────────────────────────────────┘       └────────────────────┘
                                          │            │
                                   D1 (SQL) + KV     Incidents → email (Resend) + AI triage
```

The **backoffice** (`/backoffice`, Next.js on Cloudflare Pages, `rioko.online`) is the merchant + admin UI. It does **not** process invoices — it configures connections, shows reconciliation, runs dev-mode tooling, and handles billing. It talks to the same D1 database the worker writes to, and the worker calls one backoffice cron endpoint daily.

---

## 2. Repo layout — what deploys, what's tooling, what's dead weight

| Path | What it is | Deploys to | Status |
|---|---|---|---|
| `src/` + `wrangler.jsonc` | **The Worker** — webhook ingest, queues, adapter pipeline, cron | Cloudflare **Workers** | ✅ active, primary |
| `backoffice/` | **Merchant + admin UI** — Next.js 15 + `@cloudflare/next-on-pages`, Clerk auth, Stripe billing | Cloudflare **Pages** (`rioko` project → `rioko.online`) | ✅ active |
| `rioko-next/` | A **second, older Next.js app** — uses `@vercel/kv` + `@vercel/postgres` (Vercel, not Cloudflare) | Vercel (legacy) | ⚠️ likely superseded by `backoffice/` — confirm + remove |
| `migrations/` | D1 SQL migrations `0001`…`0015` | applied via `wrangler d1` | ✅ active |
| `scripts/` | Ops + diagnostic scripts (`.mjs`) | run locally | mixed — see below |
| `functions/` | Cloudflare Pages Functions dir | — | empty (`functions/webhooks/` has no files) — remove |
| `clients/` | JSON order/invoice fixtures (`order_1288_payload.json`, …) | — | ⚠️ **PII in git**, see [Git Hygiene](#git-hygiene--why-garbage-reaches-main) |
| `docs/` | `ADAPTERS.md`, security/onboarding docs (some `.html`) | — | reference |
| `assets/`, `public/` | static assets, OG images, favicons | bundled | ✅ |
| `backup-before-0007.sql`, `stripe-banner.ai` | 8.9 MB DB dump, 946 KB Illustrator file | — | ⚠️ should not be in repo (the `.ai` **is** tracked) |

**`scripts/` is two different things in one folder:**
- **Real, tracked tooling** (keep): `pre-deploy-backup.mjs`, `healthcheck.mjs`, `security-self-check.mjs`, `recover-reemit.mjs`, `generate-og-image.mjs`, and the `test-*.mjs` end-to-end harnesses.
- **Throwaway scratch** (should be ignored): the **21 `diag-*.mjs`** files (`diag-tax-probe`, `diag-zoolagos`, `diag-truth`, …) and one-off `reemit-26.mjs` / `reemit-other-accounts.mjs`. These are the files that keep showing up as untracked and get swept into commits.

---

## 3. Deploy Topology

**Three deploy targets, two different triggers. This is the source of the "I pushed but nothing/the wrong thing deployed" confusion.**

| App | Trigger | Mechanism | Notes |
|---|---|---|---|
| **Worker** (`src/`) | push to `main` **and/or** manual | Cloudflare Workers Build on `main`; manual = `npm run deploy` (`wrangler deploy`, reads `wrangler.jsonc`) | Feature-branch push ≠ prod. Hotfix without merge: `wrangler versions deploy <id>@100`. |
| **backoffice** (`rioko` Pages) | push to `main` | Cloudflare Pages git integration | Feature-branch push = **preview** deploy only. Prod = `main`. |
| **rioko-next** | (Vercel, if still wired) | — | Legacy; verify before touching. |

There is **no `.github/workflows`** — all automation is Cloudflare's git integration, not GitHub Actions.

### ⚠️ Known config bug (fix this)
`package.json` `dev` and `build` scripts reference **`wrangler.worker.toml`, which does not exist** in the repo — only `wrangler.jsonc` does:

```json
"dev":   "wrangler dev -c wrangler.worker.toml",   // ❌ file missing → broken
"build": "wrangler deploy --dry-run -c wrangler.worker.toml", // ❌ broken
"deploy":"wrangler deploy"                          // ✅ works (uses wrangler.jsonc)
```
Either restore `wrangler.worker.toml` or repoint these at `wrangler.jsonc`. Until then, only `npm run deploy` / `npm run deploy:safe` are reliable.

### Mental rule
- Editing **`src/`** → the **Worker**. Verify with `wrangler tail`. Don't assume a `git push` shipped it unless Workers Build is confirmed connected; otherwise `wrangler deploy`.
- Editing **`backoffice/`** → **Pages**, on merge to `main`. `wrangler deploy` does **nothing** for it.
- Always run `npm run deploy:safe` (backs up D1 first) for worker deploys that could touch data.

---

## 4. Worker runtime (`src/index.ts`)

Single Hono app exporting `{ fetch, queue, scheduled }`.

### 4.1 Ingest (HTTP)
Every webhook route does the same shape: **verify signature first** (HMAC), dedup, then **enqueue** — never process inline.

| Route | Source | Auth |
|---|---|---|
| `POST /webhooks/shopify/{orders-created,orders-updated,orders-paid,refunds-create}` | Shopify | HMAC-SHA256 vs per-shop `shopify_webhook_secret` |
| `POST /webhooks/stripe` | Stripe (gated by `STRIPE_SOURCE_ENABLED=1`) | Stripe signature + 5-min replay window; resolves owning `connections` row |
| `POST /webhooks/eupago/:userId` | EuPago | base64 HMAC vs per-user `hmac_secret` |
| `GET /` | health check | none |
| `/admin/*` | dev-mode + ops tooling | `requireAdminAuth` (admin key) |

Shopify orders are enqueued with `delaySeconds: 120` so the `orders/created` → `orders/paid` race self-heals before processing. Oversized Stripe payloads (>110 KB) spill to KV (`stripe-evt:<id>`) and travel by reference.

### 4.2 Queue consumers
One `queue()` handler dispatches by queue name:
- `shopifyordersqueue` → `processShopifyBatch` (batch 10, up to 25 retries → DLQ)
- `stripeeventsqueue` → `processStripeBatch` (batch 1, up to 10 retries → DLQ)
- `my-queue-dlq` → `processDeadLetterBatch` — terminal: emits a **critical incident**, acks (no re-bounce).

Retry policy: permanent errors and *stuck transient* errors (≥`TRANSIENT_GIVEUP_ATTEMPTS = 6`, ~30 min) give up early with an incident instead of grinding to the DLQ; `destination_reject` keeps its full retry budget (likely a recoverable IX/Moloni 5xx).

### 4.3 The dual processing path (important)
For each Shopify message the consumer decides between **two code paths**:

```
Shopify msg
  ├─ connections row w/ destination = moloni|vendus?  → ADAPTER PIPELINE (new)
  ├─ env DESTINATION_VIA_ADAPTER == "1"?              → ADAPTER PIPELINE (staged rollout)
  └─ else                                              → LEGACY IX-DIRECT HANDLERS
```

- **Legacy IX-direct** (`src/handlers/orders-*.ts`, `refunds-create.ts` + `src/ix/*`): the *comprovado* Shopify→InvoiceXpress path. Still the default for Shopify→IX. Has VIES reverse-charge deferral, invoice-visibility padding, credit-note dedup.
- **Adapter pipeline** (`src/handlers/generic-pipeline.ts` → `runAdapterPipeline`): the unified path for any `(source, destination)` pair. **Stripe and EuPago always use it.** Shopify→IX migration to it is deferred (~34h); the pipeline path for Shopify-source still lacks some legacy B2B niceties (documented inline at `index.ts:1037`).

> Both paths converge on `src/ix/*` for IX output, so the IX builder is shared.

### 4.4 Scheduled (cron)
`wrangler.jsonc` crons: `0 8 * * *` (daily) and `0 16 * * 5` (Friday).
- **Daily 08:00 UTC:** call backoffice `GET /api/cron/ix-match` (IX reference retry); incident digest (gated); VIES retry sweep (`pending_reverse_charge`); TTL purge of `webhook_info` + `billing_events` > 90 days.
- **Friday 16:00 UTC:** weekly per-merchant "unprocessed invoices" digest; optional AI cross-incident pattern report.

---

## 5. Adapter model (`src/adapters/`)

Pluggable sources and destinations behind two interfaces, wired by `registry.ts`.

- **`SourceAdapter`**: `verifyWebhook(body, sig, secret)`, `externalId(body)`, `toNormalized(body, ctx) → Normalized | null`.
  Implementations: `sources/shopify-source.ts`, `stripe-source.ts`, `eupago-source.ts`.
- **`DestinationAdapter`**: `createDraft(normalized, ctx) → {invoiceId}`, `finalize(invoiceId, ctx)`, `issueCredit(...)`, optional `emailDocument?`, `findByReference?`.
  Implementations: `destinations/ix-destination.ts`, `moloni-destination.ts`, `vendus-destination.ts`.
- **`reconcile.ts`** — `reconcileTotalOrThrow(...)`: per-line math vs the source's actually-paid amount, 1¢ tolerance. Drift → permanent-failure incident. (IX rounds the **total once**, not per line — the root cause of historic tax-excluded drift.)

`runAdapterPipeline` order: pause gate → subscription gate → dedup (D1+KV) → `source.toNormalized` → `destination.createDraft` → finalize (if `auto_finalize`) → email (optional) → refunds (per-credit dedup → `issueCredit`) → on error, `classifyPipelineError` + `reportIncident`.

---

## 6. Services (`src/services/`)

| File | Role |
|---|---|
| `incidents.ts` | `reportIncident` (bucketed upsert, critical→instant email, else digest), digests, `explainIncidentById` |
| `email.ts` | `sendEmail` via Resend (`noreply@rioko.online`) |
| `email-templates.ts` | HTML per incident kind + digests |
| `anthropic.ts` | Claude-based incident diagnosis + weekly pattern report (advisory, gated) |
| `triage-knowledge.ts` | context doc fed to AI triage |
| `subscription-gate.ts` | blocks pipeline if merchant's Stripe subscription inactive |
| `pause-gate.ts` | merchant kill-switch (`is_paused`) — checked first |
| `product-mappings.ts` | SKU → Moloni product id bindings (Map, 1 D1 read) |
| `product-overrides.ts` | per-SKU tax/VAT/name overrides (Map, 1 D1 read) |
| `stripe.ts` | thin Stripe REST wrapper (restricted key) for `tax_ids` expansion |
| `order-label.ts` | `describeOrder` → `{orderRef, clientName}` for human-readable alerts |

---

## 7. Data model

### D1 (`DB`, database `rioko-db`) — accessed via `src/storage.ts` `AppStorage`
| Table | Purpose |
|---|---|
| `integrations` | legacy per-user config: IX/Shopify creds, behaviour flags (`vat_included`, `auto_finalize`, `force_tax_rate`, `b2b_reverse_charge`, `is_paused`, retention…) |
| `connections` | multi source/destination tuples: `source_kind`, `destination_kind`, `source_config_json`, `destination_config_json`, `status` |
| `processed_orders` | idempotency — 1 row per order/refund → invoice mapping |
| `webhook_info` | replay protection (`webhook_id`/`event_id`, `topic`, state: processing/success/failed) |
| `logs` | per-shop diagnostic history |
| `dev_jobs` | dev-mode batch job history |
| `incidents` | bucketed incident tracking + notify/resolve lifecycle |
| `product_mappings`, `product_overrides` | SKU bindings + per-line overrides |
| `pending_reverse_charge` | deferred B2B VIES decisions, cron-retried |
| `billing_events` | Stripe billing audit (TTL 90d) |

Migrations live in `migrations/0001…0015_*.sql`; apply in order with `wrangler d1`. `backoffice/migrations/` also exists — keep the two in mind when changing schema.

### KV (`INVOICE_KV`)
`{source}_order:{id}` (fast idempotency) · `ixmeta:{invoiceId}` (24h) · `ixref:{account}:{reference}` (1h) · `stripe-evt:{eventId}` (7d payload spill).

### Bindings & env (`src/env.ts`, `wrangler.jsonc`)
`DB` (D1), `INVOICE_KV` (KV), `SHOPIFY_ORDERS_QUEUE` + `STRIPE_QUEUE` (queues). Secrets via `wrangler secret put` (`STRIPE_WEBHOOK_SECRET`, IX keys, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `ADMIN_API_KEY`/`CRON_SECRET`). Feature flags in `vars`: `STRIPE_SOURCE_ENABLED`, `DESTINATION_VIA_ADAPTER`, `*_DIGEST_ENABLED`.

---

## 8. Git Hygiene — why garbage reaches `main`

Three compounding causes (all currently true):

1. **One repo, multiple apps, no workspace tooling.** `git add .` from the root stages worker + backoffice + scratch indiscriminately.
2. **`.gitignore` doesn't cover what actually accumulates.** It ignores `scripts/.gen/` but **not** `scripts/diag-*.mjs` (21 untracked right now), `clients/*.json` (already-tracked order payloads = **PII in git**), root binaries (`stripe-banner.ai` is tracked), or `.DS_Store` (tracked).
3. **`main` auto-deploys.** Worker Build + Pages both build from `main`, so anything merged is in a prod build immediately — there's no CI gate to catch junk.

### Fix (recommended)
**a. Extend `.gitignore`:**
```gitignore
# scratch diagnostics (keep test-*.mjs and ops tooling)
scripts/diag-*.mjs
scripts/reemit-*.mjs

# local fixtures / PII payloads
clients/

# editor / OS / build junk
.DS_Store
*.tsbuildinfo

# stray binaries & db dumps (belong in object storage, not git)
*.ai
backup-*.sql
```

**b. Untrack what's already committed (history stays, future commits clean):**
```bash
git rm --cached .DS_Store stripe-banner.ai
git rm --cached -r clients/          # PII order payloads
git commit -m "chore: stop tracking scratch fixtures, binaries, OS junk"
```
> `clients/*.json` contains real order/customer data — treat removal as a privacy fix. To purge it from *history* you'd need `git filter-repo`; do that separately if required.

**c. Park scratch where it's ignored.** Put `diag-*.mjs` under `scripts/.gen/` (already ignored) or keep the new `scripts/diag-*` rule above. Never commit a `diag-*`.

**d. Keep the branch flow you already have, add one gate.** Branches like `fix/…`, `feat/…`, `hotfix/…` already exist — good. The discipline that's missing:
- Never `git add .` at root. Stage explicit paths (`git add src/...`).
- `git status` must be clean of `diag-*` / `clients/` before commit.
- Merge to `main` only via reviewed PR (run `/code-review` on the diff). Because `main` = prod, treat a merge as a deploy.
- Decide `rioko-next/` and `functions/`: if dead, delete them so they stop being commit noise.

---

## 9. Where to start for common tasks

| Task | Start here |
|---|---|
| New payment source | `src/adapters/sources/` + `registry.ts` + a route in `index.ts` |
| New invoicing destination | `src/adapters/destinations/` + `registry.ts` |
| Change Shopify→IX invoice logic | `src/ix/builder.ts` + `src/handlers/orders-*.ts` (legacy path) |
| Tax / reconciliation drift | `src/adapters/reconcile.ts`, `src/ix/builder.ts` |
| Merchant UI / onboarding | `backoffice/src/app/` |
| Alerts / email | `src/services/incidents.ts` + `email-templates.ts` |
| Schema change | add `migrations/00NN_*.sql`, apply with `wrangler d1`, mirror in `backoffice/migrations` if the UI reads it |
| Deploy worker | `npm run deploy:safe` (or `wrangler versions deploy` for hotfix) |
| Deploy backoffice | merge to `main` (Pages auto-build) |
