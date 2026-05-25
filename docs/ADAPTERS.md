# Adapter Architecture

## Overview

The adapter system decouples the webhook source (Shopify, Stripe, …) from the invoicing destination (InvoiceXpress, Moloni, …). Every source converts its native payload into a single canonical shape — `Normalized` — and every destination consumes that shape. New sources or destinations plug in without touching the orchestration, the gates, or the idempotency layer.

The flow is **Source → Normalized → Destination**. A webhook arrives at an HTTP route in `src/index.ts`, is verified, enqueued on a Cloudflare Queue, then picked up by a batch processor that calls `runAdapterPipeline` in `src/handlers/generic-pipeline.ts`. The pipeline resolves the adapters from `src/adapters/registry.ts`, runs pause + subscription gates, dispatches on the canonical topic (`created` / `paid` / `refund`), and orchestrates the destination calls. Errors are classified into `IncidentKind`s and re-thrown so the queue retries.

Legacy Shopify handlers (`src/handlers/orders-created.ts`, `orders-paid.ts`, `refunds-create.ts`) still exist and run the same logic against `IxApi` directly. They are scheduled to be removed; the `DESTINATION_VIA_ADAPTER` env flag flips Shopify traffic onto `runAdapterPipeline` instead.

## The Normalized contract

Every source MUST produce a `Normalized` value (or `null` to skip silently). The interface lives at `src/api/normalize-shopify.ts` — the filename is historical, the shape itself is destination-agnostic and is the canonical input every destination receives.

Top-level shape:

```ts
interface Normalized {
  order: Order;           // single order/transaction (one invoice's worth)
  refunds: Refund[];      // line-level refunds (Shopify shape)
  exchanges: any[];       // reserved
  credits: Credit[];      // what destinations consume to issue credit notes
  debits: any[];          // reserved
  raw_order?: any;
}
```

`order` carries `id`, `reference`, `order_number`, totals, currency, `customer`, `billing_address`, `shipping_address`, `items[]`, `note_attributes[]` (where NIF/VAT fuzzy-matching looks), `meta.source_name`, and `global_discount`. See the full interface in `src/api/normalize-shopify.ts` (lines 1–100 cover the canonical fields).

`credits[]` is what the `refund` topic consumes — each entry has `refund_id`, `amount`, and `line_items[]` (`{ id, quantity, subtotal, total_tax }`). The pipeline derives `NormalizedRefund` (`{ refundId, itemsIds, amountToRefund }`) from each credit before calling `destination.issueCredit`.

## Source adapters

### Interface

From `src/adapters/types.ts`:

```ts
export interface SourceAdapter {
  readonly kind: SourceKind;
  verifyWebhook(rawBody: string, signature: string, secret: string): Promise<boolean>; // HMAC check on raw body
  externalId(parsedBody: any): string;                                                  // stable id for idempotency
  toNormalized(parsedBody: any, ctx: AdapterCtx): Promise<Normalized | null>;           // payload → canonical shape, or null to skip
}
```

`AdapterCtx` carries `apiKey` (the `NORMALIZE_SHOPIFY_ORDER_API_KEY` env), the per-account `IRequestConfig`, and an optional `sourceConfig: Record<string, any>` parsed from `connections.source_config_json` (the Stripe adapter reads `restricted_key` from it).

### How to add a new source

1. **Pick a kind id.** Lowercase, kebab-allowed (e.g. `woocommerce`).
2. **Add the kind to both unions.** `SourceKind` in `src/storage.ts` (line 88) AND `SourceKind` in `src/adapters/types.ts` (line 4) — they are declared twice and must stay in sync.
3. **Create `src/adapters/sources/<kind>-source.ts`** implementing `SourceAdapter`. Export a class (see `ShopifySource`, `StripeSource`). The `kind` field must use `as const` so TS narrows it.
4. **Register in `src/adapters/registry.ts`** by adding an instance to the `sourceInstances` map. `getSourceAdapter` throws on unknown kinds.
5. **Add a webhook route** in `src/index.ts`. The Stripe route at `/webhooks/stripe` (line 143) is the reference: read raw body before parsing, look up the owning connection via `source_config_json`, call `adapter.verifyWebhook(rawBody, sig, secret)`, dedup by event id via `appStorage.isWebhookProcessed`, then `appStorage.markWebhookAsProcessing` and push onto a Cloudflare Queue. The queue batch handler then calls `runAdapterPipeline`. Shopify uses `enqueueWebhook(c, "orders/...")` at line 130–136 (older style; raw-body verification happens inside that helper).
6. **Add a queue + binding** in `wrangler.jsonc`, and a batch handler in `src/index.ts` modeled on `processStripeBatch` (line 792). The handler resolves the active `connections` row, parses `source_config_json`, loads the legacy `integrations` row for IX credentials, and calls `runAdapterPipeline({ env, config, source, destination, topic, webhookId, body, sourceConfig })`.
7. **SQL migration** under `migrations/`. The schema for source credentials is the `connections` table (see `migrations/0007_connections.sql`); credentials go into `source_config_json` as opaque JSON. If you need new columns on `processed_orders` or `webhook_info` add them via additive ALTER (those tables already track `source_kind` since 0007).
8. **Backoffice UI** under `backoffice/src/app/api/integrations/<kind>-source/route.ts` plus a connect/install route (Stripe has `stripe-source/install-webhook/route.ts` as a reference) and the React components that drive the connect flow.

> TODO: There is currently no `tests/` directory in the repo, so step "add unit tests" has no home — see *Testing a new adapter* below.

### Webhook verification contract

`verifyWebhook(rawBody, signature, secret)` is called **on the raw request body** before any parsing. Both built-in adapters compute HMAC-SHA256 but they differ:

- **Shopify** (`ShopifySource`): delegates to `verifyShopifyWebhook(signature, rawBody, secret)` in `src/shopify.ts`. The header `X-Shopify-Hmac-Sha256` carries a base64 MAC of the raw body.
- **Stripe** (`StripeSource`): parses `Stripe-Signature` header `t=…,v1=…`, computes HMAC of `${t}.${rawBody}` and checks at least one `v1=` matches in constant time. Also enforces a 5-minute timestamp window. Implementation is local in `stripe-source.ts` (`verifyStripeSignature`); does not rely on the official SDK.

Callers (the webhook route) are responsible for capturing `rawBody` as text before any JSON parsing — if Hono parses the body first the MAC will not match.

### externalId contract

`externalId` returns the **idempotency key**. The pipeline writes it into `processed_orders.id` and the KV key `${sourceKind}_order:${id}`. The same logical order must hash to the same id across:

- webhook delivery retries (Shopify/Stripe both retry on non-2xx)
- different topics that touch the same order (created → paid → refund all map to the same row)

Concrete rules:

- **Shopify** uses `String(body.id)` — Shopify's numeric order id is stable across all three topics.
- **Stripe** prefers `payment_intent`:
  - `charge.refunded` → `obj.payment_intent` (so the refund matches the PI used at create time)
  - `checkout.session.completed` → `obj.payment_intent` (so the session event and `payment_intent.succeeded` collapse to one row)
  - everything else → `obj.id`

When designing a new source, pick the id that the source emits identically on the create event AND on any later refund/paid event.

### toNormalized contract

`toNormalized(parsedBody, ctx)` converts the source-native payload into `Normalized`. Returning `null` means "skip silently, this event is not actionable" — the pipeline treats null as a no-op for `created` but throws `Failed to normalize` for `paid` and `refund` (which then surfaces as an `incident_kind: normalize_fail`).

The method MAY call source APIs. `StripeSource.toNormalized` calls `fetchCustomerTaxIds(customerId, restrictedKey)` to expand `tax_ids` for PaymentIntent/Charge events because that data is not on the event payload. Failures are swallowed inside the adapter — a missing VAT is better than a missing invoice.

`ShopifySource.toNormalized` is a one-liner: it instantiates `new Shopify(ctx.apiKey, ctx.config)` and calls `shopify.normalizeOrder(String(body.id))` — the actual Shopify→Normalized mapping lives in `src/shopify.ts`. Only the **adapter shell** is in `src/adapters/sources/shopify-source.ts`.

## Destination adapters

### Interface

From `src/adapters/types.ts`:

```ts
export interface DestinationAdapter {
  readonly kind: DestinationKind;
  createDraft(normalized: Normalized, ctx: AdapterCtx): Promise<DestinationInvoiceCreateResult>; // → { invoiceId }
  finalize(invoiceId: string, ctx: AdapterCtx): Promise<void>;                                   // draft → issued
  issueCredit(invoiceId: string, refund: NormalizedRefund, normalized: Normalized, ctx: AdapterCtx): Promise<DestinationCreditResult>; // credit note
  emailDocument?(invoiceId: string, ctx: AdapterCtx): Promise<void>;                             // optional: mail to client
  findByReference?(reference: string, ctx: AdapterCtx): Promise<{ id: string } | null>;          // optional: dedup probe
}
```

### How to add a new destination

1. **Pick a kind id** (e.g. `sage`).
2. **Add to both unions:** `DestinationKind` in `src/storage.ts` (line 89) AND in `src/adapters/types.ts` (line 5).
3. **Create `src/adapters/destinations/<kind>-destination.ts`** implementing `DestinationAdapter`. See `InvoiceXpressDestination` in `ix-destination.ts` for the canonical example.
4. **Register in `src/adapters/registry.ts`** by adding the instance to `destinationInstances`.
5. **Credentials storage.** Destination credentials live on the **legacy `integrations` row** today (`ix_account_name`, `ix_api_key`, `ix_environment`, `ix_document_type`, `ix_email_body`, etc. — see `IRequestConfig` in `src/storage.ts`, lines 3–68). The forward-looking home is `connections.destination_config_json`, but as of Phase 3 the Stripe queue handler still loads the legacy `integrations` row and passes it as `config` (see `src/index.ts` line 822, comment "Phase 5 will project the full config out of `connections.destination_config_json`"). For a new destination today: add nullable columns to `integrations` via a migration AND plan to also accept config from `connections.destination_config_json` once Phase 5 lands.
6. **Update the error classifier** in `src/handlers/generic-pipeline.ts` `classifyPipelineError` (lines 29–57). Your error messages must follow a pattern the classifier recognizes — see *Error classification* below.
7. **Backoffice UI** for credential entry and OAuth/connection setup.

### createDraft contract

Receives the normalized order plus `AdapterCtx` (which carries the merchant's `IRequestConfig`). Returns `{ invoiceId: string }` — the pipeline writes this into `processed_orders.invoice_id` keyed by `externalId`.

Idempotency is the pipeline's job, not the destination's: by the time `createDraft` is called the pipeline has already checked `isInvoiceAlreadyProcessed` AND (if `findByReference` is defined) probed the destination for `Order #<order_number>`. Duplicates short-circuit before this method runs.

On failure, **throw with a message that contains the destination name**. The IX adapter throws `InvoiceXpress create failed: …`. The classifier uses substring matches on the lowercased message to assign `IncidentKind`. See *Error classification*.

### finalize contract

Transitions an invoice from draft to issued/finalized in the destination's state machine. For IX this is `POST /v2/change-state { state: "finalized" }`.

Some destinations don't have a separate draft/final state — Vendus or Stripe-as-destination (charges) effectively "finalize on create". The pipeline handles this with the `finalizeInSameFlow` branch in `runPipelineCore` (`generic-pipeline.ts` line 157):

```ts
const finalizeInSameFlow = source !== "shopify" && config.auto_finalize === 1;
```

When true, the `created` topic also calls `finalize` (and optionally `emailDocument`) right after `createDraft`. Shopify keeps the legacy two-step flow because it emits a separate `orders/paid` webhook. For sources like Stripe Charges where the payment-confirmation event IS the create event, finalize happens in-line.

Throw `<Destination> finalize failed: …` so the classifier maps it to `destination_reject`.

### issueCredit contract

Receives `(invoiceId, refund, normalized, ctx)` where `refund` is `{ refundId, itemsIds, amountToRefund }` (the pipeline computes this from each entry in `normalized.credits`). The implementation must:

- Build credit-note line items from `normalized.order.items` filtered by `refund.itemsIds`.
- If `refund.amountToRefund > 0` (the credit amount exceeds the sum of line items, i.e. a shipping/discount refund), append a synthetic "Refund amount" line.
- Set `reference = "OrderRefund #<refundId>"` so the pipeline's de-dup logic (and `findByReference`) can detect existing credits on retry.
- POST the credit note AND, if the destination separates draft/final states for credit notes, transition it to finalized inside this method. The IX adapter calls `changeState` with `type: "credit_note", state: "finalized"` right after creating the credit (see `ix-destination.ts` line 109).

Returns `{ creditId: string }`.

### emailDocument and findByReference

Both are optional. The pipeline guards every call with `if (destAdapter.emailDocument)` / `if (destAdapter.findByReference)`. Omit them if the destination has no equivalent. `emailDocument` is invoked only when `config.ix_send_email` is truthy. `findByReference` is invoked at the start of the `created` topic to detect invoices already created out-of-band.

## The pipeline (`generic-pipeline.ts`)

`runAdapterPipeline(input: RunPipelineInput)` is the single entry point for all adapter-routed traffic. In sequence:

1. **Resolve adapters** — `getSourceAdapter(source)`, `getDestinationAdapter(destination)`, compute `externalId = sourceAdapter.externalId(body)`.
2. **Pause gate** — `isIntegrationPaused(env, config, logTopic, externalId)`. Reads `integrations.is_paused`; if 1, log and return (no incident). This precedes the subscription gate so paused users with active subs still short-circuit silently.
3. **Subscription gate** — `checkSubscriptionGate(env, config)`. Blocks emission for inactive Kapta subscriptions and emits a `subscription_inactive` critical incident.
4. **Topic dispatch** (`runPipelineCore`):
   - **`created`** — check `isInvoiceAlreadyProcessed(externalId, source)` against D1 + KV; if not seen, optionally probe the destination with `findByReference(\`Order #${body.order_number ?? externalId}\`)`. Then `toNormalized` → `createDraft` → `saveProcessedInvoice(externalId, invoiceId, { sourceKind, destinationKind })`. If `finalizeInSameFlow`, also `finalize` + `emailDocument`.
   - **`paid`** — `toNormalized` → look up the invoice via `getInvoiceByOrderId(externalId)` (throws "Invoice not found" if missing, triggering queue retry → eventually `normalize_fail` info incident). If `config.auto_finalize === 1`, call `finalize` + optional `emailDocument`.
   - **`refund`** — `toNormalized` → look up invoice → for each `credit` in `normalized.credits`, compute `amountToRefund = credit.amount - Σ line_items.subtotal` and call `issueCredit`.
5. **Webhook bookkeeping** — `markWebhookAsProcessed(webhookId, logTopic, "success")` and `saveLog({...status: 200})` after a successful run.
6. **Error path** — any thrown error is caught in `runAdapterPipeline`, classified via `classifyPipelineError`, reported via `reportIncident`, then **re-thrown** so the queue handler (which wraps the call in try/catch) calls `message.retry({ delaySeconds: 360 })`.

## Error classification

`classifyPipelineError(err)` (`generic-pipeline.ts` lines 29–57) does substring matching on the lowercased error message. Outcomes and triggers:

| `IncidentKind`                 | Severity   | Triggered when message contains…                                                                                              |
|--------------------------------|------------|-------------------------------------------------------------------------------------------------------------------------------|
| `nif_invalid`                  | `error`    | (`"invoicexpress create failed"` OR `"invoicexpress credit create failed"` OR `"moloni"+"fail"`) AND (`"fiscal"` OR `"nif"`)   |
| `auth_failure_destination`     | `critical` | same destination-fail prefix AND (`"401"` OR `"unauthorized"` OR `"autenticação"`)                                            |
| `destination_reject`           | `error`    | destination-fail prefix (any other reason) OR `"invoicexpress finalize failed"` OR `"moloni"+"finalize"` OR fallback default  |
| `normalize_fail`               | `warning`  | `"failed to normalize"`                                                                                                       |
| `normalize_fail` (info)        | `info`     | `"invoice not found"` (paid/refund arrived before created; self-heals via retry)                                              |

Full set of `IncidentKind` values is declared in `src/services/email-templates.ts` lines 14–23: `auth_failure_destination`, `auth_failure_source`, `destination_reject`, `normalize_fail`, `nif_invalid`, `subscription_inactive`, `queue_retry_exhausted`, `webhook_invalid_signature`, `vies_unconfirmed`.

**Naming guidance for new destinations:** prefix all errors with the destination kind verbatim — e.g. `"Sage create failed: …"`, `"Sage finalize failed: …"`, `"Sage credit create failed: …"`. The current classifier only knows `invoicexpress` and `moloni` strings — you must either add a branch to `classifyPipelineError` for your kind or every error from your destination will fall through to the catch-all `destination_reject` (still routed to incidents, but `nif_invalid` and `auth_failure_destination` won't be detected). Vague messages like `"Could not invoice"` are not matched and will default-classify.

## Cross-cutting concerns

### Idempotency

The D1 `processed_orders` table is the source of truth (`id` = externalId, `invoice_id` = destination-side id, plus `source_kind` / `destination_kind` from migration 0007). KV mirrors it at key `${sourceKind}_order:${externalId}` for fast lookups; legacy keys `shopify_order:<id>` are read as a fallback (`AppStorage.isInvoiceAlreadyProcessed` lines 147–170). The pipeline checks this before `createDraft`. As a second line of defense, `findByReference(\`Order #<n>\`)` queries the destination directly when defined.

### Pause gate and subscription gate

Both run before any destination call inside `runAdapterPipeline`. `isIntegrationPaused` (`src/services/pause-gate.ts`) returns silently if `integrations.is_paused === 1`. `checkSubscriptionGate` (`src/services/subscription-gate.ts`) blocks paying-feature use when the merchant's own Kapta/Stripe subscription is inactive, with admin exemptions. A blocked subscription emits a `subscription_inactive` critical incident; a paused integration does NOT emit an incident.

### Logging

After each step the pipeline calls `AppStorage.saveLog({ shopify_domain, topic, payload, response, status })`. Status code conventions:

| status | meaning                                                                 |
|--------|-------------------------------------------------------------------------|
| 200    | success (Created / Created+Finalized / Finalized / Credit notes issued) |
| 202    | deferred (legacy VIES retry queue — handlers only)                      |
| 401    | duplicate / already processed / already exists at destination           |
| 402    | subscription gate blocked                                               |
| 400/500| error                                                                   |

### Webhook routing to pipeline

Routing into the pipeline lives in `src/index.ts`'s queue batch handlers:

- **`processShopifyBatch`** (line 735) gates on `env.DESTINATION_VIA_ADAPTER === "1"`. When set, `created` / `paid` / `refund` topics are mapped via `shopifyTopicToCanonical` and dispatched to `runAdapterPipeline`. `orders/updated` always falls through to the legacy switch because the generic pipeline does not yet handle that topic. When the flag is unset (default), all four topics use the legacy handlers in `src/handlers/`.
- **`processStripeBatch`** (line 792) always routes to `runAdapterPipeline` — Stripe has no legacy direct path. It loads the `connections` row by `(user_id, source_kind = 'stripe', status = 'active')`, parses `source_config_json`, then loads the legacy `integrations` row for the destination credentials.

The legacy direct handlers (`orders-created.ts`, `orders-paid.ts`, `refunds-create.ts`) are being deprecated in favor of `runAdapterPipeline`. They still contain logic the generic pipeline does not yet implement — notably the VIES deferral + `pending_reverse_charge` enqueue flow on B2B reverse charge. Until that lands in the pipeline, flipping `DESTINATION_VIA_ADAPTER=1` for Shopify loses the VIES retry path.

> TODO: `runAdapterPipeline` has no equivalent of the legacy VIES-deferred branch (see `handleOrderCreated` lines 64–90 and `handleRefundCreate` lines 89–109). Porting this is a prerequisite to fully deprecating the legacy handlers.

## Testing a new adapter

Recommended coverage:

- **`verifyWebhook`** — unit test with a real captured payload + signature header and the corresponding secret. For Stripe, also assert that a timestamp older than 5 minutes is rejected and a tampered body fails.
- **`externalId`** — assert the same id is returned for at least 3 payloads that represent the same logical order across delivery retries and across topics (e.g. for Stripe: `checkout.session.completed` and `payment_intent.succeeded` for the same purchase MUST collapse to the same id).
- **`toNormalized`** — at least 3 fixtures: a `created`-equivalent payload, a `paid`-equivalent (if separate), and a `refund`-equivalent. Assert the returned `Normalized.order.reference`, `total`, `currency`, `items[]` quantities and prices, and that `note_attributes[]` contains any NIF/VAT fields the source exposes. Assert that filtered/unsupported event types return `null`.
- **End-to-end** — recorded webhook payload → enqueue → `runAdapterPipeline` with a stubbed `DestinationAdapter` (assert which methods got called with which args). Use the existing `InvoiceXpressDestination` as a reference for the call shapes.

> TODO: there is no `tests/` directory in the repo as of this writing. The first adapter to add tests will need to introduce a test runner (vitest or node:test) and CI wiring.
