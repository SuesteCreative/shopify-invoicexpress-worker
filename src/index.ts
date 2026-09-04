import type { Env } from "./env";
import type { QueueMessage, StripeQueueMessage, StripeCanonicalTopic, WebhookTopic } from "./handlers/types";
import { Context, Hono } from "hono";
import { AppStorage } from "./storage";
import type { SourceKind } from "./storage";
import { verifyShopifyWebhook } from "./shopify";
import { getSourceAdapter, getDestinationAdapter } from "./adapters/registry";
import type { AdapterCtx, DestinationKind } from "./adapters/types";
import { loadTagRoutingRules, matchTagRouting, normalizeRule, applyTagRoute } from "./services/tag-routing";
import { loadProductMappings } from "./services/product-mappings";
import { runAdapterPipeline, classifyPipelineError } from "./handlers/generic-pipeline";
import { httpStatusOf } from "./services/platform-error";
import {
  GATEWAY_ERROR_HEADER, LODGIFY_DIRECT_BASE, assertSafePathSegment, describeLodgifyEgress,
  assertSafeBookingId, isGatewayFailure, lodgifyFetch, probeLodgifyRelay, resolveLodgifyGateway,
  type LodgifyGateway,
} from "./services/lodgify-api";
import {
  firstNum,
  bookingCollectedAmount,
  isBookingFullyCollected,
  collectedSqlPredicate,
  awaitingPaymentMarkSqlPredicate,
  otaPolicyFrom,
  otaStayCollectedSqlPredicate,
  partialModeFrom,
} from "./services/lodgify-amounts";
import { readDocumentTimeline, readRecentDrifts, documentEventPurgeSql, logDocumentEvent, lookupLastEmissionError } from "./services/document-log";
import { runDocumentVerifySweep } from "./handlers/document-verify-sweep";
import { reportIncident, runIncidentDigest, autoResolveStaleIncidents, runWeeklyMerchantDigest, explainIncidentById, runWeeklyPatternReport, sendIncidentTestEmail } from "./services/incidents";
import { describeOrder } from "./services/order-label";
import { handleOrderCreated } from "./handlers/orders-created";
import { handleOrderUpdated } from "./handlers/orders-updated";
import { handleOrderPaid } from "./handlers/orders-paid";
import { handleRefundCreate } from "./handlers/refunds-create";
import { getUnprocessedOrders, processOrders, reemitOrder, finalizeDrafts, deleteDraftByOrderNumber, issueCreditNoteByOrderNumber } from "./handlers/admin";
import { checkSubscriptionGate } from "./services/subscription-gate";
import type { IRequestConfig } from "./storage";
import { runRenewalReminders, runEarlyBirdEndingReminders } from "./services/subscription-reminders";
import { processStripeBackfill, reemitStripeOrder, deleteStripeDraft, issueStripeCreditNote, finalizeStripeDrafts, externalIdFromEvent } from "./handlers/admin-stripe";
import { sendDevModeEmail } from "./handlers/notify";
import { sendEmail as sendEmailDirect } from "./services/email";
import {
  getReconciliation,
  resolveReconContext,
  approveReconciliationMatch,
  revertReconciliationMatch,
  setReconciliationDecisionAction,
  getShopForUser,
} from "./handlers/reconciliation";
import { runViesRetry, submitInvoiceForPendingRow } from "./handlers/pending-reverse-charge";
import { runReconciliationSweep, runIncidentDrivenHeal, runStripeHeal } from "./handlers/reconciliation-sweep";
import { saleReference, partialSaleReference } from "./services/document-references";
import { resolveConnectionContext, synthLegacyConfig, projectConnectionBehaviour } from "./services/connection-context";
import { buildAdapterCtx } from "./services/adapter-ctx";
import { toPreloadedFromItem, channelReference, firstStr, ymd } from "./services/lodgify-booking";
import { takeBackLodgifyDocuments } from "./handlers/lodgify-billing";
import { settleLodgifyReceipts } from "./handlers/lodgify-settlement";
import {
  connectionCapabilities, backfillConnection, reemitConnection,
  deleteConnectionDraft, creditConnectionDocument, finalizeConnectionDrafts,
  setConnectionInvoiceCutoff,
} from "./handlers/admin-connection";
import type { FinalizeDateStrategy } from "./adapters/types";
import { delay } from "./utils";
import { errorResponse, requireAdminAuth } from "./security";
import {
  resolveStripeConnection, listWebhookEndpoints, reenableWebhookEndpoint,
  deleteWebhookEndpoint, getStripeEvent, listStripeEvents,
} from "./handlers/stripe-admin";

function shopifyTopicToCanonical(topic: WebhookTopic): StripeCanonicalTopic | null {
  switch (topic) {
    case "orders/created": return "created";
    case "orders/paid": return "paid";
    case "refunds/create": return "refund";
    default: return null;
  }
}

function stripeEventToCanonical(eventType: string): StripeCanonicalTopic | null {
  // PaymentIntent flow (Kapta's primary path): payment_intent.succeeded fires
  // when a PI reaches "succeeded" — equivalent to a paid Shopify order. We
  // treat it as a combined create+(auto-finalize if configured) trigger since
  // there's no separate "created" event for PaymentIntents.
  if (eventType === "payment_intent.succeeded") return "created";
  // Legacy/standalone Charge flow.
  if (eventType === "charge.succeeded") return "created";
  if (eventType === "charge.refunded") return "refund";
  // Checkout Session: completed event lands when the buyer finishes Checkout.
  // Its payload carries custom_fields + customer_details.tax_ids which we need
  // for NIF extraction, so it's the preferred trigger when a Session exists.
  if (eventType === "checkout.session.completed") return "created";
  // Stripe-issued Invoice flow (separate lifecycle).
  if (eventType === "invoice.created" || eventType === "invoice.finalized") return "created";
  if (eventType === "invoice.paid") return "paid";
  return null;
}

const app = new Hono<{ Bindings: Env }>();

// Global error net: any unhandled throw in a route returns a consistent 500 and
// is logged (worker observability is on), instead of a bare runtime crash. This
// makes future webhook failures visible in `wrangler tail` rather than silent.
app.onError((err, c) => {
  console.error(`[Rioko] Unhandled error on ${c.req.method} ${c.req.path}:`, err);
  return c.text("Internal error", 500);
});

// Health check endpoint
/**
 * Project a connection's own "email the document to the buyer" preference onto
 * the legacy config the pipeline reads.
 *
 * `ix_send_email` lives on the legacy `integrations` row, which only exists for
 * clients who came in through Shopify→IX. A Moloni- or Vendus-only client has
 * no such row, so the synthesized fallback pinned the flag to 0 and no toggle
 * could ever turn it on. Their setting lives on the connection instead, next to
 * `auto_finalize`, and the connection must win for its own traffic: one user can
 * run a Shopify→IX shop that mails buyers and a Stripe→Moloni flow that does not.
 *
 * Absent key ⇒ leave the legacy value alone, so existing shops are unaffected.
 */
function applyConnectionEmailPref(legacy: any, destinationConfig?: Record<string, any>): any {
  if (destinationConfig && typeof destinationConfig.send_email === "boolean") {
    legacy.ix_send_email = destinationConfig.send_email ? 1 : 0;
  }
  return legacy;
}

app.get("/", (c) => c.text("OK"))

async function enqueueWebhook(c: Context<{ Bindings: Env }>, topic: WebhookTopic) {
  const webhookId = c.req.header("x-shopify-webhook-id") ?? null;
  const shopDomain = c.req.header("X-Shopify-Shop-Domain");

  if (!shopDomain) {
    console.log("[Rioko] Missing X-Shopify-Shop-Domain header");
    return c.text("Missing shop domain", 400);
  }

  const appStorage = new AppStorage(c.env, shopDomain);
  const config = await appStorage.loadConfig();

  if (!config) {
    console.log("[Rioko] No config found for shopify domain");
    return c.text("No config found", 404);
  }

  // Verify webhook signature FIRST — prevents attackers spamming webhook ids
  // to flood the webhook_info table with bogus "processing" rows.
  const hmac = c.req.header("X-Shopify-Hmac-Sha256");
  const rawBody = await c.req.text();

  if (!hmac || !await verifyShopifyWebhook(hmac, rawBody, config.shopify_webhook_secret!)) {
    console.error(`[Rioko] Invalid Webhook Signature for ${config.shopify_domain}.`);
    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic, payload: "", response: "Invalid Signature", status: 401 });
    await reportIncident(c.env, {
      user_id: config.user_id,
      severity: "critical",
      kind: "webhook_invalid_signature",
      summary: `Shopify webhook ${topic} rejeitado por assinatura inválida em ${config.shopify_domain}`,
      detail: { shop: config.shopify_domain, topic },
      connection_label: "shopify → invoicexpress",
      bucket: "daily", // signature failures cluster — one alert per day is enough
    });
    return new Response("Invalid Signature", { status: 401 });
  }

  // Only after HMAC passes do we check/mark webhook state.
  if (webhookId) {
    const { isProcessed, state } = await appStorage.isWebhookProcessed(webhookId, topic);
    if (isProcessed) {
      console.log(`[Rioko] Webhook ${webhookId} already ${state}, skipping`);
      return c.text("Webhook already processed", 200);
    }

    if (state === "failed") {
      console.log(`[Rioko] Retrying failed webhook ${webhookId}`);
    }
    await appStorage.markWebhookAsProcessing(webhookId, topic);
  }

  const body = JSON.parse(rawBody);

  console.log(`[Rioko] Webhook Received: ${topic} for ${config.shopify_domain}, enqueuing...`);

  // Send to queue for async processing
  await c.env.SHOPIFY_ORDERS_QUEUE.send({
    topic,
    webhookId,
    shopDomain,
    body,
  } satisfies QueueMessage, {
    delaySeconds: 120
  });

  return c.text("Queued", 200);
}

// Shopify orders/created webhook endpoint
app.post("/webhooks/shopify/orders-created", (c) => enqueueWebhook(c, "orders/created"))

// Shopify orders/updated webhook endpoint
app.post("/webhooks/shopify/orders-updated", (c) => enqueueWebhook(c, "orders/updated"))

// Shopify orders/paid webhook endpoint
app.post("/webhooks/shopify/orders-paid", (c) => enqueueWebhook(c, "orders/paid"))

// Shopify refunds/create webhook endpoint
app.post("/webhooks/shopify/refunds-create", (c) => enqueueWebhook(c, "refunds/create"))

// ────────────────────────────────────────────────────────────────────────────
// Stripe webhooks. Gated by STRIPE_SOURCE_ENABLED env flag — disabled by default
// in Phase 3. To enable in prod: set STRIPE_SOURCE_ENABLED=1 + set
// STRIPE_WEBHOOK_SECRET via `wrangler secret put STRIPE_WEBHOOK_SECRET`.
// ────────────────────────────────────────────────────────────────────────────
app.post("/webhooks/stripe", async (c) => {
  if (c.env.STRIPE_SOURCE_ENABLED !== "1") {
    return c.text("Stripe source disabled", 404);
  }

  // Signing secrets are per-connection: the webhook auto-install captures each
  // account's whsec_ (via the merchant's restricted key) into
  // source_config_json.webhook_secret. The optional global STRIPE_WEBHOOK_SECRET
  // is only a fallback for connections that lack their own. So we do NOT
  // fail-fast on a missing global secret — the per-connection scan below verifies
  // each event against the owning connection's secret and returns 404 if none
  // match (the loop already skips connections with no usable secret).
  const sig = c.req.header("Stripe-Signature");
  const rawBody = await c.req.text();
  if (!sig) return c.text("Missing Stripe-Signature", 400);

  // Replay-attack protection: Stripe-Signature carries `t=<unix-seconds>,v1=…`.
  // Reject events whose timestamp is more than 5 minutes old. Mitigates an
  // attacker resurfacing old events (e.g. charge.refunded) to emit duplicate
  // credit notes. Stripe docs recommend 5 minutes as the tolerance.
  const tMatch = sig.match(/(?:^|,)t=(\d+)/);
  if (tMatch) {
    const eventTsMs = Number(tMatch[1]) * 1000;
    const ageMs = Date.now() - eventTsMs;
    if (Number.isFinite(eventTsMs) && ageMs > 5 * 60_000) {
      console.warn(`[Stripe] Rejecting webhook: timestamp ${Math.round(ageMs / 1000)}s old (>5min)`);
      return c.text("Webhook timestamp too old", 400);
    }
  }

  const adapter = getSourceAdapter("stripe");
  const stripeAccount = c.req.header("Stripe-Account"); // present only for Connect platforms

  // Resolve the owning connection. Two modes:
  //   a) Stripe Connect — match by stripe_account_id from header.
  //   b) Standalone — no header; try every active connection and use whichever
  //      signature verifies. Bounded by # active stripe connections (small).
  let ownerRow: any | null = null;
  let secret: string | undefined;

  if (stripeAccount) {
    ownerRow = await c.env.DB.prepare(
      `SELECT id, user_id, source_config_json, destination_kind FROM connections
       WHERE source_kind = 'stripe' AND status = 'active'
         AND json_extract(source_config_json, '$.stripe_account_id') = ?
       LIMIT 1`
    ).bind(stripeAccount).first();
    if (ownerRow) {
      const cfg = ownerRow.source_config_json ? JSON.parse(ownerRow.source_config_json) : {};
      secret = cfg.webhook_secret || c.env.STRIPE_WEBHOOK_SECRET;
    }
  } else {
    const rows = await c.env.DB.prepare(
      `SELECT id, user_id, source_config_json, destination_kind FROM connections
       WHERE source_kind = 'stripe' AND status = 'active'`
    ).all();
    for (const row of (rows.results ?? []) as any[]) {
      const cfg = row.source_config_json ? JSON.parse(row.source_config_json) : {};
      const candidateSecret = cfg.webhook_secret || c.env.STRIPE_WEBHOOK_SECRET;
      if (!candidateSecret) continue;
      if (await adapter.verifyWebhook(rawBody, sig, candidateSecret)) {
        ownerRow = row;
        secret = candidateSecret;
        break;
      }
    }
  }

  if (!ownerRow) {
    console.log(`[Stripe] No matching connection found (header=${stripeAccount ?? "none"})`);
    return c.text("No connection found", 404);
  }
  if (!secret) {
    console.error("[Stripe] No webhook secret configured");
    return c.text("Secret not configured", 500);
  }

  // For Connect (header) path we still need to verify signature now that we
  // have the secret; the no-header path already verified during the scan.
  if (stripeAccount && !await adapter.verifyWebhook(rawBody, sig, secret)) {
    console.error("[Stripe] Invalid signature");
    await reportIncident(c.env, {
      user_id: ownerRow.user_id,
      severity: "critical",
      kind: "webhook_invalid_signature",
      summary: `Stripe webhook rejeitado por assinatura inválida (account=${stripeAccount})`,
      detail: { stripeAccount },
      connection_label: `stripe → ${ownerRow.destination_kind ?? "invoicexpress"}`,
      bucket: "daily",
    });
    return c.text("Invalid signature", 401);
  }

  const event = JSON.parse(rawBody);
  const eventId: string = event.id ?? "";
  const canonical = stripeEventToCanonical(event.type ?? "");
  if (!canonical) {
    console.log(`[Stripe] Ignoring unhandled event type: ${event.type}`);
    return c.text("Event type ignored", 200);
  }

  // Dedup by Stripe event id (use webhook_info table since it's source-agnostic
  // after Phase 2's source_kind ALTER ADD).
  const topicKey = `stripe/${canonical}`;
  const appStorage = new AppStorage(c.env);
  const { isProcessed, state } = await appStorage.isWebhookProcessed(eventId, topicKey);
  if (isProcessed && state !== "failed") {
    return c.text("Already processed", 200);
  }

  // Enqueue FIRST, then mark `processing`. If send() throws we return 500 with
  // NO `processing` row left behind, so Stripe's retry reprocesses cleanly
  // instead of short-circuiting on a stuck `processing` state (the old bug that
  // silently lost events). Events larger than the Cloudflare Queues 128KB limit
  // are spilled to KV and passed by reference.
  try {
    const queueMsg: StripeQueueMessage = { topic: canonical, eventId, userId: ownerRow.user_id, body: event };
    if (rawBody.length > 110_000) {
      const kvKey = `stripe-evt:${eventId}`;
      await c.env.INVOICE_KV.put(kvKey, rawBody, { expirationTtl: 7 * 24 * 60 * 60 });
      delete queueMsg.body;
      queueMsg.bodyRef = kvKey;
    }
    await c.env.STRIPE_QUEUE.send(queueMsg);
    await appStorage.markWebhookAsProcessing(eventId, topicKey);
  } catch (err: any) {
    console.error(`[Stripe] Failed to enqueue event ${eventId}: ${err?.message ?? err}`);
    try {
      await reportIncident(c.env, {
        user_id: ownerRow.user_id,
        severity: "critical",
        kind: "queue_retry_exhausted",
        summary: `Falha ao enfileirar evento Stripe ${eventId} (${canonical}). Evento NÃO foi processado.`,
        // `message` is the key the triage redaction reads; `error` predates it
        // and is kept so nothing already reading it breaks.
        detail: { eventId, topic: canonical, message: String(err?.message ?? err), error: String(err?.message ?? err) },
        affected_ids: [eventId],
        connection_label: `stripe → ${ownerRow.destination_kind ?? "invoicexpress"}`,
      });
    } catch (incErr) {
      console.error("[Stripe] Failed to emit enqueue-failure incident:", incErr);
    }
    // 500 → Stripe retries. No `processing` row was written, so the retry runs
    // the full path again rather than being short-circuited as "already processed".
    return c.text("Enqueue failed", 500);
  }

  return c.text("Queued", 200);
});

// ────────────────────────────────────────────────────────────────────────────
// EuPago Realtime Webhooks 2.0 — single endpoint scoped by user_id in the URL
// so the merchant can register a stable callback in the EuPago backoffice.
//   POST /webhooks/eupago/<user_id>
//   Headers: X-Signature (base64 HMAC-SHA256 of raw body, using merchant's
//            HMAC secret), Content-Type: application/json
// ────────────────────────────────────────────────────────────────────────────
app.post("/webhooks/eupago/:userId", async (c) => {
  const userId = c.req.param("userId");
  const sig = c.req.header("X-Signature");
  const rawBody = await c.req.text();
  if (!sig) return c.text("Missing X-Signature", 400);

  const conn: any = await c.env.DB.prepare(
    `SELECT id, source_config_json, destination_kind, destination_config_json
     FROM connections
     WHERE user_id = ? AND source_kind = 'eupago' AND status = 'active' LIMIT 1`
  ).bind(userId).first();
  if (!conn) {
    console.log(`[EuPago] No active connection for user ${userId}`);
    return c.text("No connection", 404);
  }

  let sourceCfg: Record<string, any> = {};
  try { sourceCfg = conn.source_config_json ? JSON.parse(conn.source_config_json) : {}; } catch { /* ignore */ }
  const hmacSecret = sourceCfg.hmac_secret;
  if (!hmacSecret) {
    console.error(`[EuPago] HMAC secret missing for user ${userId}`);
    return c.text("Secret not configured", 500);
  }
  if (sourceCfg.encrypted === true) {
    // AES-256-CBC payloads are not supported in this adapter version. Merchant
    // must disable encryption in the EuPago backoffice. We refuse to silently
    // skip — return 200 so EuPago doesn't retry, but log loudly.
    console.error(`[EuPago] Encrypted payload received for user ${userId} — not supported yet`);
    return c.text("Encryption not supported by integration", 200);
  }

  const adapter = getSourceAdapter("eupago");
  if (!await adapter.verifyWebhook(rawBody, sig, hmacSecret)) {
    console.error(`[EuPago] Invalid signature for user ${userId}`);
    await reportIncident(c.env, {
      user_id: userId,
      severity: "critical",
      kind: "webhook_invalid_signature",
      summary: "EuPago webhook rejeitado por assinatura inválida.",
      connection_label: `eupago → ${conn.destination_kind ?? "invoicexpress"}`,
      bucket: "daily",
    });
    return c.text("Invalid signature", 401);
  }

  let body: any;
  try { body = JSON.parse(rawBody); } catch { return c.text("Invalid JSON", 400); }
  const status = String(body?.status ?? "").toUpperCase();
  let canonical: "created" | "refund" | null = null;
  if (status === "PAID") canonical = "created";
  else if (status === "REFUNDED") canonical = "refund";
  if (!canonical) return c.text(`Status ${status || "unknown"} ignored`, 200);

  const externalId = adapter.externalId(body);
  const appStorage = new AppStorage(c.env);
  const { isProcessed, state } = await appStorage.isWebhookProcessed(externalId, `eupago/${canonical}` as any);
  if (isProcessed && state !== "failed") return c.text("Already processed", 200);
  await appStorage.markWebhookAsProcessing(externalId, `eupago/${canonical}` as any);

  // Behaviour toggles still come from the legacy `integrations` row (ix_*,
  // force_tax_rate, auto_finalize, etc.).
  const legacy: any = await c.env.DB.prepare("SELECT * FROM integrations WHERE user_id = ?").bind(userId).first();
  if (!legacy) {
    console.error(`[EuPago] No integrations row for user ${userId}`);
    return c.text("Integration not configured", 500);
  }

  let destinationConfig: Record<string, any> | undefined;
  try {
    destinationConfig = conn.destination_config_json ? JSON.parse(conn.destination_config_json) : undefined;
  } catch { destinationConfig = undefined; }

  try {
    await runAdapterPipeline({
      env: c.env,
      config: legacy,
      source: "eupago",
      destination: (conn.destination_kind as any) ?? "invoicexpress",
      topic: canonical,
      webhookId: externalId,
      body,
      destinationConfig,
    });
    await appStorage.markWebhookAsProcessed(externalId, `eupago/${canonical}` as any, "success");
    return c.text("OK", 200);
  } catch (e: any) {
    console.error(`[EuPago] Pipeline error for ${externalId}:`, e);
    await appStorage.markWebhookAsProcessed(externalId, `eupago/${canonical}` as any, "failed");
    // Return 500 so EuPago retries (2min×3 then hourly×24h).
    return errorResponse(c, e, "Pipeline error");
  }
});

// ── Lodgify webhooks ──────────────────────────────────────────────────────────
//   POST /webhooks/lodgify/<user_id>
//   Headers: ms-signature: sha256=<hex_hmac_sha256> (fallback: x-lodgify-signature)
//   Body: { "event": "booking_new_booked", "data": { "bookingId": 12345 } }
//
//   Thin envelope — the actual booking is fetched inside LodgifySource.toNormalized()
//   via GET /v2/reservations/{bookingId} using the stored api_key.
// ────────────────────────────────────────────────────────────────────────────
app.post("/webhooks/lodgify/:userId", async (c) => {
  const userId = c.req.param("userId");
  const sig = c.req.header("ms-signature") ?? c.req.header("x-lodgify-signature") ?? "";
  const rawBody = await c.req.text();

  const conn: any = await c.env.DB.prepare(
    `SELECT id, source_config_json, destination_kind, destination_config_json
     FROM connections
     WHERE user_id = ? AND source_kind = 'lodgify' AND status = 'active' LIMIT 1`
  ).bind(userId).first();
  if (!conn) {
    console.log(`[Lodgify] No active connection for user ${userId}`);
    return c.text("No connection", 404);
  }

  const lodgifyAdapter = getSourceAdapter("lodgify");

  let sourceCfg: Record<string, any> = {};
  try { sourceCfg = conn.source_config_json ? JSON.parse(conn.source_config_json) : {}; } catch { /* ignore */ }

  // Each registered Lodgify webhook has its own secret (Lodgify requirement: unique URL per event).
  // Select the correct secret based on the URL query param injected at registration time.
  const eventParam = new URL(c.req.url).searchParams.get("e") ?? "";
  const webhookSecret: string | undefined =
    eventParam === "declined" ? sourceCfg.webhook_secret_declined :
    eventParam === "change"   ? sourceCfg.webhook_secret_change :
    sourceCfg.webhook_secret;

  if (!webhookSecret) {
    console.warn(`[Lodgify] no webhook_secret for ${userId} (e=${eventParam}) — skipping HMAC verification`);
  } else {
    if (!await lodgifyAdapter.verifyWebhook(rawBody, sig, webhookSecret)) {
      console.error(`[Lodgify] Invalid signature for user ${userId} (e=${eventParam})`);
      await reportIncident(c.env, {
        user_id: userId,
        severity: "critical",
        kind: "webhook_invalid_signature",
        summary: "Lodgify webhook rejeitado por assinatura inválida.",
        connection_label: `lodgify → ${conn.destination_kind ?? "invoicexpress"}`,
        bucket: "daily",
      });
      return c.text("Invalid signature", 401);
    }
  }

  let body: any;
  try { body = JSON.parse(rawBody); } catch { return c.text("Invalid JSON", 400); }

  // Determine pipeline topic from the event type:
  // booking_status_change_declined → "refund" (issue credit note if booking was paid)
  // booking_change / booking_new_status_booked → "created" (invoice when fully paid)
  const isDeclined = eventParam === "declined"
    || String(body?.action ?? body?.event ?? "").includes("declined");
  const pipelineTopic = isDeclined ? "refund" : "created";

  const externalId = (() => {
    try { return lodgifyAdapter.externalId(body); } catch { return null; }
  })();
  if (!externalId) return c.text("Missing bookingId in payload", 400);

  const storageTopic = `lodgify/${pipelineTopic}` as any;
  const appStorage = new AppStorage(c.env, null, userId);
  const { isProcessed, state } = await appStorage.isWebhookProcessed(externalId, storageTopic);
  if (isProcessed && state !== "failed") return c.text("Already processed", 200);
  await appStorage.markWebhookAsProcessing(externalId, storageTopic);

  let destinationConfig: Record<string, any> | undefined;
  try {
    destinationConfig = conn.destination_config_json ? JSON.parse(conn.destination_config_json) : undefined;
  } catch { destinationConfig = undefined; }

  // Lodgify users may not have an integrations row (no Shopify-IX setup).
  // Synthesize a minimal config so the pipeline can run.
  const legacy: any = (await c.env.DB.prepare("SELECT * FROM integrations WHERE user_id = ?").bind(userId).first()) ?? {
    user_id: userId,
    shopify_domain: null,
    auto_finalize: destinationConfig?.auto_finalize ? 1 : 0,
    b2b_reverse_charge: 0,
    ix_send_email: 0,
  };
  applyConnectionEmailPref(legacy, destinationConfig);

  const gate = await checkSubscriptionGate(c.env, legacy);
  if (!gate.allowed) {
    console.warn(`[Lodgify] Subscription gate blocked for ${userId}: ${gate.reason}`);
    await reportIncident(c.env, {
      user_id: userId,
      severity: "warning",
      kind: "subscription_inactive",
      summary: `Lodgify webhook bloqueado: subscrição inativa (${gate.reason}).`,
      connection_label: `lodgify → ${conn.destination_kind ?? "moloni"}`,
      bucket: "daily",
    });
    await appStorage.markWebhookAsProcessed(externalId, storageTopic, "failed");
    return c.text("Subscription inactive", 402);
  }

  try {
    await runAdapterPipeline({
      env: c.env,
      config: legacy,
      source: "lodgify",
      destination: (conn.destination_kind as any) ?? "moloni",
      topic: pipelineTopic as any,
      webhookId: externalId,
      body,
      sourceConfig: sourceCfg,
      destinationConfig,
    });
    await appStorage.markWebhookAsProcessed(externalId, storageTopic, "success");
    return c.text("OK", 200);
  } catch (e: any) {
    console.error(`[Lodgify] Pipeline error for booking ${externalId} (${pipelineTopic}):`, e);
    await appStorage.markWebhookAsProcessed(externalId, storageTopic, "failed");
    return errorResponse(c, e, "Pipeline error");
  }
});

// ── Admin: what is actually deployed ─────────────────────────────────────────
// Cloudflare tells you a version id and a timestamp, neither of which says
// which commit is serving traffic. Without this, "is the fix live?" is answered
// by lining up `git log` (Lisbon) against `wrangler deployments list` (UTC) and
// hoping — which is exactly how a deploy from the wrong branch goes unnoticed.
//
// TWO answers, because the stamp is not always there. `GIT_SHA` is set by
// `npm run deploy`, but ANY other deploy overwrites the running version without
// it — and on 2026-09-03 that turned out to include Workers Builds, which had
// resumed promoting merges to main and landed an unstamped version 13 seconds
// after a hand deploy. The endpoint then said "unknown" and nothing more, which
// is the least useful moment to have no answer.
//
// So `version_id` comes from Cloudflare's own version-metadata binding and is
// always present: cross-reference it with `wrangler versions list` to see who
// deployed what and when. `commit` stays the better answer when it exists.
app.get("/admin/version", async (c) => {
  const unauth = await requireAdminAuth(c);
  if (unauth) return unauth;
  const sha = c.env.GIT_SHA ?? null;
  const meta = c.env.CF_VERSION_METADATA;
  return c.json({
    commit: sha,
    commit_short: sha ? sha.slice(0, 7) : null,
    branch: c.env.GIT_BRANCH ?? null,
    // A deploy from a dirty tree is not reproducible from the commit alone.
    dirty: c.env.GIT_DIRTY === "1",
    built_at: c.env.BUILT_AT ?? null,
    stamped: !!sha,
    // Cloudflare's view. Survives every deploy path, ours and CI's.
    version_id: meta?.id ?? null,
    version_tag: meta?.tag ?? null,
    version_created_at: meta?.timestamp ?? null,
    ...(sha ? {} : {
      note: "Sem selo de git: este deploy não passou por `npm run deploy` "
        + "(tipicamente o Workers Builds a promover um merge). Cruzar version_id "
        + "com `wrangler versions list` para saber o que está a servir.",
    }),
  });
});

// ── Admin: Stripe webhook + event recovery (Phase 3 ops tooling) ──────────────
// All operate on the Stripe-source connection for ?userId / body.userId, using
// the connection's stored restricted_key.

// List webhook endpoints on the connection's Stripe account.
app.get("/admin/stripe/webhooks", async (c) => {
  const unauth = await requireAdminAuth(c);
  if (unauth) return unauth;
  const userId = c.req.query("userId");
  if (!userId) return c.json({ error: "Missing userId" }, 400);
  const conn = await resolveStripeConnection(c.env, userId);
  if (!conn) return c.json({ error: "No Stripe connection with a restricted_key for this user" }, 404);
  try {
    const endpoints = await listWebhookEndpoints(conn.restrictedKey);
    return c.json({ connection_id: conn.connectionId, stored_endpoint_id: conn.webhookEndpointId, endpoints });
  } catch (e) {
    return errorResponse(c, e, "Failed to list Stripe webhook endpoints");
  }
});

// Re-enable a Stripe-disabled endpoint.
app.post("/admin/stripe/webhooks/reenable", async (c) => {
  const unauth = await requireAdminAuth(c);
  if (unauth) return unauth;
  const { userId, endpoint_id } = await c.req.json<{ userId: string; endpoint_id: string }>();
  if (!userId || !endpoint_id) return c.json({ error: "Missing userId or endpoint_id" }, 400);
  const conn = await resolveStripeConnection(c.env, userId);
  if (!conn) return c.json({ error: "No Stripe connection with a restricted_key for this user" }, 404);
  try {
    const endpoint = await reenableWebhookEndpoint(conn.restrictedKey, endpoint_id);
    return c.json({ ok: true, endpoint });
  } catch (e) {
    return errorResponse(c, e, "Failed to re-enable Stripe webhook endpoint");
  }
});

// Delete a webhook endpoint (orphan / incomplete-install cleanup).
app.post("/admin/stripe/webhooks/delete", async (c) => {
  const unauth = await requireAdminAuth(c);
  if (unauth) return unauth;
  const { userId, endpoint_id } = await c.req.json<{ userId: string; endpoint_id: string }>();
  if (!userId || !endpoint_id) return c.json({ error: "Missing userId or endpoint_id" }, 400);
  const conn = await resolveStripeConnection(c.env, userId);
  if (!conn) return c.json({ error: "No Stripe connection with a restricted_key for this user" }, 404);
  try {
    const result = await deleteWebhookEndpoint(conn.restrictedKey, endpoint_id);
    return c.json({ ok: true, ...result });
  } catch (e) {
    return errorResponse(c, e, "Failed to delete Stripe webhook endpoint");
  }
});

// Replay missed Stripe event(s) into the processing queue.
//   { userId, event_id }                  → replay one event
//   { userId, type?, from?, to?, limit? }  → backfill a window (unix seconds)
app.post("/admin/stripe/replay", async (c) => {
  const unauth = await requireAdminAuth(c);
  if (unauth) return unauth;
  const body = await c.req.json<{ userId: string; event_id?: string; type?: string; from?: number; to?: number; limit?: number }>();
  if (!body.userId) return c.json({ error: "Missing userId" }, 400);
  const conn = await resolveStripeConnection(c.env, body.userId);
  if (!conn) return c.json({ error: "No Stripe connection with a restricted_key for this user" }, 404);

  try {
    let events: any[];
    if (body.event_id) {
      events = [await getStripeEvent(conn.restrictedKey, body.event_id)];
    } else {
      const types = body.type ? [body.type] : ["payment_intent.succeeded", "charge.succeeded", "charge.refunded", "checkout.session.completed"];
      events = await listStripeEvents(conn.restrictedKey, { types, from: body.from, to: body.to, limit: body.limit });
    }

    const appStorage = new AppStorage(c.env);
    const queued: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const event of events) {
      const canonical = stripeEventToCanonical(event.type ?? "");
      if (!canonical) { skipped.push({ id: event.id, reason: `unhandled type ${event.type}` }); continue; }
      // Reset dedup so the success-defense re-marks cleanly; the consumer's
      // processed_orders idempotency still blocks a duplicate invoice.
      await appStorage.resetWebhookInfo(event.id, `stripe/${canonical}`);
      await c.env.STRIPE_QUEUE.send({ topic: canonical, eventId: event.id, userId: body.userId, body: event } satisfies StripeQueueMessage);
      queued.push(event.id);
    }
    return c.json({ ok: true, queued_count: queued.length, queued, skipped });
  } catch (e) {
    return errorResponse(c, e, "Failed to replay Stripe events");
  }
});

// Admin: manually replay a Lodgify booking by ID (bypasses signature check).
app.post("/admin/lodgify/replay", async (c) => {
  const unauth = await requireAdminAuth(c);
  if (unauth) return unauth;
  const body = await c.req.json<{ userId: string; bookingId: string | number; booking?: Record<string, unknown>; force?: boolean }>();
  if (!body.userId || !body.bookingId) return c.json({ error: "Missing userId or bookingId" }, 400);

  const conn: any = await c.env.DB.prepare(
    `SELECT id, source_config_json, destination_kind, destination_config_json
     FROM connections
     WHERE user_id = ? AND source_kind = 'lodgify' AND status = 'active' LIMIT 1`
  ).bind(body.userId).first();
  if (!conn) return c.json({ error: "No active Lodgify connection for this user" }, 404);

  let sourceCfg: Record<string, any> = {};
  try { sourceCfg = conn.source_config_json ? JSON.parse(conn.source_config_json) : {}; } catch { /* ignore */ }
  let destinationConfig: Record<string, any> | undefined;
  try { destinationConfig = conn.destination_config_json ? JSON.parse(conn.destination_config_json) : undefined; } catch { /* ignore */ }

  const legacy: any = (await c.env.DB.prepare("SELECT * FROM integrations WHERE user_id = ?").bind(body.userId).first()) ?? {
    user_id: body.userId,
    shopify_domain: null,
    auto_finalize: destinationConfig?.auto_finalize ? 1 : 0,
    b2b_reverse_charge: 0,
    ix_send_email: 0,
  };
  applyConnectionEmailPref(legacy, destinationConfig);

  // `_force` skips the settlement gate, for the same reason this route skips
  // signature verification: an admin asking for a specific booking by id has
  // already made the judgement the gate exists to make. Without it, replaying a
  // booking whose payment Lodgify does not expose would silently do nothing.
  const fakeBody: any = { event: "booking_new_booked", data: { bookingId: Number(body.bookingId) }, _force: body.force !== false };
  if (body.booking) fakeBody._preloaded_booking = body.booking;
  const externalId = String(body.bookingId);
  const topic = "lodgify/created" as any;
  const appStorage = new AppStorage(c.env, null, body.userId);
  await appStorage.resetWebhookInfo(externalId, topic);

  try {
    await runAdapterPipeline({
      env: c.env,
      config: legacy,
      source: "lodgify",
      destination: (conn.destination_kind as any) ?? "moloni",
      topic: "created",
      webhookId: externalId,
      body: fakeBody,
      sourceConfig: sourceCfg,
      destinationConfig,
    });
    await appStorage.markWebhookAsProcessed(externalId, topic, "success");
    return c.json({ ok: true, bookingId: externalId });
  } catch (e: any) {
    await appStorage.markWebhookAsProcessed(externalId, topic, "failed");
    return c.json({ ok: false, error: e?.message ?? "Unknown error" }, 500);
  }
});

/**
 * Delete every Lodgify webhook that points at this Worker.
 *
 * Shared by re-registration and by connection teardown so both leave through
 * the allowlisted relay and both agree on what "ours" means (target_url carries
 * our host). Lodgify accepts DELETE on /webhooks/v1/unsubscribe/{id} for some
 * accounts and POST for others, hence the two-method attempt.
 */
async function unsubscribeOurLodgifyWebhooks(
  apiKey: string,
  gateway: LodgifyGateway,
  workerHost: string,
): Promise<{ deleted: Record<string, number>; liveList: any[] }> {
  const listRes = await lodgifyFetch("/webhooks/v1/list", { apiKey, gateway });
  const liveList: any[] = listRes.ok ? ((await listRes.json().catch(() => [])) as any[]) : [];
  const ours = liveList.filter((w: any) => (w.target_url ?? w.url ?? "").includes(workerHost));

  const deleted: Record<string, number> = {};
  for (const w of ours) {
    const wId = w.id ?? w.webhook_id;
    let status = 0;
    for (const method of ["DELETE", "POST"] as const) {
      const dr = await lodgifyFetch(
        `/webhooks/v1/unsubscribe/${assertSafePathSegment(wId, "webhook id")}`,
        { apiKey, gateway, method },
      ).catch(() => null);
      status = dr?.status ?? 0;
      if (status >= 200 && status < 300) break;
    }
    deleted[wId] = status;
  }
  return { deleted, liveList };
}

// Admin: drop this connection's Lodgify webhooks and forget the stored secrets.
//
// Exists so the backoffice never has to call Lodgify itself: Cloudflare Pages
// has no fixed egress IP either, and an onboarding or teardown request leaving
// from a rotating address is the same fingerprint that got us blocked.
app.post("/admin/lodgify/unregister-webhooks", async (c) => {
  const unauth = await requireAdminAuth(c);
  if (unauth) return unauth;
  const body = await c.req.json<{ userId: string }>().catch(() => ({} as { userId?: string }));
  if (!body.userId) return c.json({ error: "Missing userId" }, 400);

  const conn: any = await c.env.DB.prepare(
    `SELECT source_config_json FROM connections WHERE user_id = ? AND source_kind = 'lodgify' LIMIT 1`
  ).bind(body.userId).first();
  if (!conn) return c.json({ error: "No Lodgify connection" }, 404);

  let cfg: Record<string, any> = {};
  try { cfg = conn.source_config_json ? JSON.parse(conn.source_config_json) : {}; } catch { /**/ }
  const apiKey = cfg.api_key;
  if (!apiKey) return c.json({ ok: true, skipped: "no api_key stored" });

  const workerBase = (c.env as any).WORKER_URL ?? "https://shopify-invoicexpress-worker.pedrotovarporto.workers.dev";
  const { deleted } = await unsubscribeOurLodgifyWebhooks(
    apiKey, resolveLodgifyGateway(c.env), new URL(workerBase).hostname,
  );

  // Forget the secrets we can no longer verify against. The api_key stays: the
  // caller may be re-registering, and losing it would silently disable the poll.
  for (const k of ["webhook_secret", "webhook_id", "webhook_secret_change", "webhook_id_change",
    "webhook_secret_declined", "webhook_id_declined"]) delete cfg[k];
  await c.env.DB.prepare(
    `UPDATE connections SET source_config_json = ? WHERE user_id = ? AND source_kind = 'lodgify'`
  ).bind(JSON.stringify(cfg), body.userId).run();

  return c.json({ ok: true, deleted });
});

// Admin: re-register Lodgify webhooks and store secrets in DB
app.post("/admin/lodgify/reregister-webhooks", async (c) => {
  const unauth = await requireAdminAuth(c);
  if (unauth) return unauth;
  const body = await c.req.json<{ userId: string }>();
  if (!body.userId) return c.json({ error: "Missing userId" }, 400);

  const conn: any = await c.env.DB.prepare(
    `SELECT id, source_config_json FROM connections WHERE user_id = ? AND source_kind = 'lodgify' AND status = 'active' LIMIT 1`
  ).bind(body.userId).first();
  if (!conn) return c.json({ error: "No active Lodgify connection" }, 404);

  let cfg: Record<string, any> = {};
  try { cfg = conn.source_config_json ? JSON.parse(conn.source_config_json) : {}; } catch { /**/ }
  const apiKey = cfg.api_key;
  if (!apiKey) return c.json({ error: "No api_key in source_config" }, 400);

  const gateway = resolveLodgifyGateway(c.env);
  const workerBase = (c.env as any).WORKER_URL ?? "https://shopify-invoicexpress-worker.pedrotovarporto.workers.dev";
  const baseUrl = `${workerBase}/webhooks/lodgify/${body.userId}`;

  const toRegister = [
    { event: "booking_new_status_booked", url: baseUrl,               secretKey: "webhook_secret",          idKey: "webhook_id" },
    { event: "booking_change",             url: `${baseUrl}?e=change`, secretKey: "webhook_secret_change",   idKey: "webhook_id_change" },
    { event: "booking_status_change_declined", url: `${baseUrl}?e=declined`, secretKey: "webhook_secret_declined", idKey: "webhook_id_declined" },
  ];

  const results: Record<string, any> = {};

  // Drop every webhook already pointing at our Worker, then re-subscribe below.
  const { deleted, liveList } = await unsubscribeOurLodgifyWebhooks(
    apiKey, gateway, new URL(workerBase).hostname,
  );
  results["_deleted"] = deleted;
  results["_live_list"] = liveList.map((w: any) => ({ id: w.id, event: w.event ?? w.type, url: w.target_url ?? w.url }));

  // Small pause after deletes
  await new Promise(r => setTimeout(r, 1500));

  for (const { event, url, secretKey, idKey } of toRegister) {
    // Register new
    const res = await lodgifyFetch("/webhooks/v1/subscribe", {
      apiKey, gateway,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_url: url, event }),
    });
    const rawText = await res.text().catch(() => "");
    let data: any = {};
    try { data = JSON.parse(rawText); } catch { data = { raw: rawText.slice(0, 300) }; }
    if (!res.ok) {
      results[event] = { ok: false, status: res.status, error: data };
      continue;
    }
    const secret = data.secret ?? data.signing_secret ?? data.key ?? null;
    const id = String(data.id ?? data.webhook_id ?? "");
    cfg[secretKey] = secret;
    cfg[idKey] = id;
    results[event] = { ok: true, id, hasSecret: !!secret };
  }

  await c.env.DB.prepare(
    `UPDATE connections SET source_config_json = ? WHERE user_id = ? AND source_kind = 'lodgify'`
  ).bind(JSON.stringify(cfg), body.userId).run();

  return c.json({ ok: true, results });
});

// Admin: list unprocessed orders
app.get("/admin/unprocessed-orders", async (c) => {
  const unauth = await requireAdminAuth(c);
  if (unauth) return unauth;

  const shop = c.req.query("shop");
  const from = c.req.query("from");
  const to = c.req.query("to");

  if (!shop || !from || !to) {
    return c.json({ error: "Missing required query params: shop, from, to" }, 400);
  }

  const appStorage = new AppStorage(c.env, shop);
  const config = await appStorage.loadConfig();

  if (!config) {
    return c.json({ error: "Unknown shop" }, 404);
  }

  try {
    const result = await getUnprocessedOrders(c.env, config, from, to);
    return c.json(result);
  } catch (e) {
    return errorResponse(c, e, "Failed to fetch unprocessed orders");
  }
})

async function requireAdmin(c: Context<{ Bindings: Env }>) {
  return requireAdminAuth(c);
}

/**
 * The life of one sale, in order, in words — every step we took and what the
 * destination did with it, successes included.
 *
 * `external_id` is the sale, not the document: a creation that never produced a
 * document is exactly the case worth reading, and it has no invoice id to look
 * itself up by.
 */
app.get("/admin/document-log", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const externalId = c.req.query("external_id") ?? c.req.query("order_id");
  if (!externalId) return c.json({ error: "Missing external_id" }, 400);
  try {
    const events = await readDocumentTimeline(c.env, externalId, Math.min(Number(c.req.query("limit") ?? 200) || 200, 500));
    return c.json({ external_id: externalId, events });
  } catch (e) {
    return errorResponse(c, e, "Failed to read document log");
  }
})

/**
 * Run the verification sweep on demand — the same code the 04:00 cron runs.
 *
 * `dry_run` reports how many documents WOULD be checked without reading the
 * destination at all, which is how you confirm candidate selection before
 * pointing it at a merchant. Widening `days` is also how history gets
 * backfilled: there is no separate backfill mechanism to keep in step.
 */
app.post("/admin/run-document-verify", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  let body: { dry_run?: boolean; days?: number; scopes?: string[] | string; limit?: number; history?: boolean } = {};
  try { body = await c.req.json(); } catch { /* empty body = defaults */ }
  const scopes = Array.isArray(body.scopes)
    ? body.scopes
    : (typeof body.scopes === "string" ? body.scopes.split(",").map(s => s.trim()).filter(Boolean) : undefined);
  try {
    return c.json(await runDocumentVerifySweep(c.env, {
      dryRun: body.dry_run === true,
      days: body.days,
      scopes,
      limit: body.limit,
      // `history: true` verifies documents issued before this log existed, from
      // processed_orders. Only the exemption code is comparable there.
      history: body.history === true,
    }));
  } catch (e) {
    return errorResponse(c, e, "Document verification sweep failed");
  }
})

/**
 * Everything that came out different from what we sent, newest first. Ops-only —
 * this is the feed a corrections queue would be built on. Includes `drift_lead`
 * rows (history-mode findings, `detail.unconfirmed = true`) so unconfirmed leads
 * are triaged from the same place; only `drift` is a verdict.
 */
app.get("/admin/document-drifts", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 7) || 7, 1), 90);
  try {
    const events = await readRecentDrifts(c.env, {
      userId: c.req.query("user_id") ?? null,
      sinceIso: new Date(Date.now() - days * 864e5).toISOString(),
      limit: Math.min(Number(c.req.query("limit") ?? 100) || 100, 500),
    });
    return c.json({ days, count: events.length, events });
  } catch (e) {
    return errorResponse(c, e, "Failed to read document drifts");
  }
})

// Admin: run the self-healing reconciliation sweep on demand (validation +
// immediate backlog heal). dry_run:true reports what WOULD happen and writes
// nothing. Same code the 04:00 cron runs.
app.post("/admin/run-reconciliation-sweep", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  let body: { dry_run?: boolean; shops?: string[] | string; days?: number } = {};
  try { body = await c.req.json(); } catch { /* empty body = defaults */ }
  const shops = Array.isArray(body.shops)
    ? body.shops
    : (typeof body.shops === "string" ? body.shops.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
  try {
    const result = await runReconciliationSweep(c.env, {
      dryRun: body.dry_run === true, // real run unless dry_run:true is passed
      shops,
      days: typeof body.days === "number" ? body.days : undefined,
    });
    return c.json(result);
  } catch (e) {
    return errorResponse(c, e, "Reconciliation sweep failed");
  }
})

// Admin: run the Lodgify booking poll on demand.
//
// Lodgify is the only source with no webhook and no healer — the */30 cron is
// the sole path by which a booking ever becomes an invoice. That left no way to
// recover a backlog without waiting for the next tick, or to tell "the cron
// isn't firing" apart from "the poll runs but emits nothing". Same function the
// cron calls, so behaviour is identical.
app.post("/admin/lodgify/poll", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  let body: { user_id?: string; bookings?: any[]; dry_run?: boolean } = {};
  try { body = await c.req.json(); } catch { /* empty body = poll every connection */ }
  if (body.bookings && !body.user_id) {
    return c.json({ error: "bookings requires user_id" }, 400);
  }
  // An empty array is truthy, so a caller whose own fetch failed and sent `[]`
  // would be telling us "this account has no bookings" — the mirror would go
  // untouched, nothing would bill, and nothing would complain. Make it explicit.
  if (body.bookings && body.bookings.length === 0) {
    return c.json({ error: "bookings must not be empty — omit the field to fetch from Lodgify" }, 400);
  }
  try {
    const result = await pollLodgifyBookings(c.env, { userId: body.user_id, bookings: body.bookings, dryRun: body.dry_run });
    return c.json({ ranAt: new Date().toISOString(), ...result });
  } catch (e) {
    return errorResponse(c, e, "Lodgify poll failed");
  }
})


// Admin: take back Lodgify documents that were issued before the booking was
// paid for — the cleanup for reservations billed under the old settlement rule
// (`amount_due == 0` read as "paid", which fires the day an OTA booking is
// created). Re-asks the CURRENT rule about every booking that has a document and
// removes the ones that should never have had one; they re-issue by themselves
// on the poll once the merchant records the payment, so nothing is lost.
//
// dry_run defaults to TRUE — this deletes documents from a merchant's account,
// so it reports first and only acts when explicitly told to.
app.post("/admin/lodgify/unbill-premature", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  let body: { user_id?: string; dry_run?: boolean } = {};
  try { body = await c.req.json(); } catch { /* empty body = defaults */ }
  if (!body.user_id) return c.json({ error: "Missing user_id" }, 400);
  const dryRun = body.dry_run !== false;

  const conn: any = await c.env.DB.prepare(
    `SELECT user_id, source_config_json, destination_kind, destination_config_json
       FROM connections WHERE user_id = ? AND source_kind = 'lodgify' AND status = 'active' LIMIT 1`
  ).bind(body.user_id).first();
  if (!conn) return c.json({ error: "No active Lodgify connection" }, 404);

  let sourceCfg: Record<string, any> = {};
  try { sourceCfg = conn.source_config_json ? JSON.parse(conn.source_config_json) : {}; } catch { /* ignore */ }
  let destinationConfig: Record<string, any> | undefined;
  try { destinationConfig = conn.destination_config_json ? JSON.parse(conn.destination_config_json) : undefined; } catch { destinationConfig = undefined; }
  const destination: DestinationKind = (conn.destination_kind as DestinationKind) ?? "moloni";
  const legacy: any = (await c.env.DB.prepare("SELECT * FROM integrations WHERE user_id = ?").bind(body.user_id).first()) ?? {
    user_id: body.user_id, shopify_domain: null,
    auto_finalize: destinationConfig?.auto_finalize ? 1 : 0, b2b_reverse_charge: 0, ix_send_email: 0,
  };

  const rows = ((await c.env.DB.prepare(
    `SELECT id, status, total_amount, amount_paid, amount_due, arrival, departure, guest_name
       FROM lodgify_bookings WHERE user_id = ?`
  ).bind(body.user_id).all())?.results ?? []) as any[];

  const report: any[] = [];
  let deleted = 0, finalized = 0;
  for (const b of rows) {
    const bookingId = String(b.id);
    const storage = new AppStorage(c.env, null, body.user_id);
    const partials = await storage.getPartialInvoices(body.user_id, bookingId);
    const standard = await storage.getInvoiceByOrderId(bookingId);
    if (!standard?.invoice_id && partials.length === 0) continue;

    // How much this booking has been billed so far, across both paths.
    const billed = partials.length > 0
      ? partials.reduce((s, p) => s + p.invoiced_amount, 0)
      : Number(b.total_amount ?? 0);

    // Premature = we billed more than the current rule says has been collected.
    // Covers "billed 100% while nothing was recorded" AND the subtler "billed
    // the full total when only a deposit had landed".
    const { collected, basis } = bookingCollectedAmount(b);
    if (billed <= collected + 0.01) continue;

    const entry: any = {
      booking_id: bookingId, guest: b.guest_name, status: b.status,
      total: b.total_amount, arrival: b.arrival, departure: b.departure,
      billed, collected, basis,
    };
    const r = await takeBackLodgifyDocuments(c.env, {
      userId: body.user_id, bookingId, destination, config: legacy,
      sourceCfg, destinationConfig, dryRun,
    });
    entry.invoice_ids = r.invoiceIds;
    if (!dryRun) {
      entry.deleted = r.deleted;
      entry.finalized = r.finalized;
      deleted += r.deleted.length;
      finalized += r.finalized.length;
    }
    report.push(entry);
  }

  return c.json({
    dry_run: dryRun,
    bookings_scanned: rows.length,
    premature: report.length,
    documents_deleted: dryRun ? null : deleted,
    documents_finalized_left: dryRun ? null : finalized,
    rows: report,
  });
})

// Admin: record the money received against Lodgify invoices that are already
// closed, as Moloni Recibos.
//
// The other half of `invoice_plus_receipts`: a part-paid stay is invoiced in
// full as a Fatura (a Fatura states a debt, so issuing it is honest while half
// the money is outstanding), and each payment is recorded against it here. It
// cannot be part of issuing, because Moloni only associates a Recibo to a CLOSED
// document — so this runs after the finalize pass, and again whenever the next
// payment lands.
//
// Idempotent: the adapter settles the difference between what Lodgify says has
// been collected and what Moloni has already reconciled against the document,
// so running it twice settles once. `dry_run` defaults to TRUE — it issues
// fiscal documents in a merchant's account.
app.post("/admin/lodgify/settle-receipts", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  let body: { user_id?: string; dry_run?: boolean; booking_ids?: string[]; limit?: number; force?: boolean } = {};
  try { body = await c.req.json(); } catch { /* empty body = defaults */ }
  if (!body.user_id) return c.json({ error: "Missing user_id" }, 400);
  const dryRun = body.dry_run !== false;

  const conn: any = await c.env.DB.prepare(
    `SELECT user_id, source_config_json, destination_kind, destination_config_json
       FROM connections WHERE user_id = ? AND source_kind = 'lodgify' AND status = 'active' LIMIT 1`
  ).bind(body.user_id).first();
  if (!conn) return c.json({ error: "No active Lodgify connection" }, 404);

  let sourceCfg: Record<string, any> = {};
  try { sourceCfg = conn.source_config_json ? JSON.parse(conn.source_config_json) : {}; } catch { /* ignore */ }
  let destinationConfig: Record<string, any> | undefined;
  try { destinationConfig = conn.destination_config_json ? JSON.parse(conn.destination_config_json) : undefined; } catch { destinationConfig = undefined; }

  // Gated on the connection having asked for this. Without the gate, a run
  // against any Lodgify merchant would start receipting documents their own
  // process settles by hand.
  const mode = partialModeFrom(destinationConfig);
  if (mode !== "invoice_plus_receipts") {
    return c.json({
      error: `A ligação não está em invoice_plus_receipts (está em "${mode}") — nada a liquidar aqui`,
    }, 400);
  }

  const destination: DestinationKind = (conn.destination_kind as DestinationKind) ?? "moloni";
  if (!getDestinationAdapter(destination).settleDocument) {
    return c.json({ error: `${destination} não sabe registar pagamentos sobre um documento fechado` }, 400);
  }
  const legacy: any = (await c.env.DB.prepare("SELECT * FROM integrations WHERE user_id = ?").bind(body.user_id).first())
    ?? synthLegacyConfig(body.user_id);

  try {
    // The same function the poll runs, with `mirrorSourced` so the freshness
    // guard applies: an operator running this after a week of dead polls would
    // otherwise settle on week-old numbers, and "still Booked" is least
    // trustworthy exactly then.
    const result = await settleLodgifyReceipts(c.env, {
      userId: body.user_id,
      destination,
      config: projectConnectionBehaviour(legacy, destinationConfig),
      sourceCfg,
      destinationConfig,
      connLabel: `lodgify → ${destination}`,
      bookingIds: body.booking_ids,
      force: body.force === true,
      dryRun,
      limit: body.limit,
      actor: "admin:settle-receipts",
    });
    return c.json({
      ranAt: new Date().toISOString(),
      dry_run: dryRun,
      documents_scanned: result.scanned,
      settled: dryRun ? null : result.settled,
      skipped: result.skipped,
      blocked: result.blocked,
      errors: result.errors,
      rows: result.rows,
    });
  } catch (e) {
    return errorResponse(c, e, "Settle receipts failed");
  }
})

// Admin: what Lodgify actually knows about ONE booking's money.
//
// The mirror stores the v1 LIST item, which reports a single `total_amount` and
// a payment pair that reads 0/0 for the whole life of an OTA booking. That is
// the input to every settlement decision we make, and it is not enough to
// answer the question a merchant asks: did the channel pay all of this, or part
// of it? The detail endpoints may carry a breakdown the list omits — the v2
// booking is where `subtotals` lives — and nobody has ever looked.
//
// Read-only, one booking at a time, through the relay like all Lodgify traffic.
// Returns the payment-shaped fields plus the full key list of each payload, so
// a field we do not know about yet shows up as a name rather than staying
// invisible. Guest contact details are not returned: this answers a question
// about money.
app.post("/admin/lodgify/booking-detail", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  let body: { user_id?: string; booking_id?: string } = {};
  try { body = await c.req.json(); } catch { /* */ }
  if (!body.user_id || !body.booking_id) return c.json({ error: "Missing user_id / booking_id" }, 400);

  const conn: any = await c.env.DB.prepare(
    `SELECT source_config_json FROM connections WHERE user_id = ? AND source_kind = 'lodgify' LIMIT 1`
  ).bind(body.user_id).first();
  if (!conn) return c.json({ error: "No Lodgify connection" }, 404);
  let sourceCfg: Record<string, any> = {};
  try { sourceCfg = conn.source_config_json ? JSON.parse(conn.source_config_json) : {}; } catch { /* ignore */ }
  const apiKey = sourceCfg.api_key;
  if (!apiKey) return c.json({ error: "No api_key" }, 400);

  const bookingId = assertSafeBookingId(body.booking_id);
  const gateway = resolveLodgifyGateway(c.env);

  // Field names that could carry money, across both API versions. Matched on the
  // name so a payload we have not seen before still surfaces its own vocabulary.
  const MONEY = /(amount|paid|due|balance|total|subtotal|price|deposit|payment|transaction|prepaid|payout|quote|fee)/i;
  const pick = (obj: any): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (!obj || typeof obj !== "object") return out;
    for (const [k, v] of Object.entries(obj)) {
      if (!MONEY.test(k)) continue;
      if (v === null || typeof v !== "object") out[k] = v;
      else out[k] = JSON.parse(JSON.stringify(v));
    }
    return out;
  };

  const out: any[] = [];
  for (const path of [`/v1/reservation/booking/${bookingId}`, `/v2/reservations/bookings/${bookingId}`]) {
    try {
      const res = await lodgifyFetch(path, { apiKey, gateway });
      const text = await res.text();
      let data: any = null;
      try { data = JSON.parse(text); } catch { /* non-JSON body */ }
      out.push({
        path,
        status: res.status,
        keys: data && typeof data === "object" ? Object.keys(data).sort() : null,
        money: pick(data),
        body_preview: data ? undefined : text.slice(0, 200),
      });
    } catch (e: any) {
      out.push({ path, error: String(e?.message ?? e) });
    }
  }

  return c.json({ ranAt: new Date().toISOString(), booking_id: bookingId, results: out });
})

// Admin: diagnose Lodgify reachability FROM the Worker.
//
// Lodgify 429s the Worker's egress while the same API key returns 200 from a
// normal network, so the difference cannot be reproduced locally — it has to be
// measured here. Probes the same paths BOTH ways, direct and through the relay,
// and reports status + Cloudflare ray + Retry-After. Read-only.
app.post("/admin/lodgify/diag", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  let body: { user_id?: string } = {};
  try { body = await c.req.json(); } catch { /* */ }
  if (!body.user_id) return c.json({ error: "Missing user_id" }, 400);

  const conn: any = await c.env.DB.prepare(
    `SELECT source_config_json FROM connections WHERE user_id = ? AND source_kind = 'lodgify' LIMIT 1`
  ).bind(body.user_id).first();
  if (!conn) return c.json({ error: "No Lodgify connection" }, 404);
  let sourceCfg: Record<string, any> = {};
  try { sourceCfg = conn.source_config_json ? JSON.parse(conn.source_config_json) : {}; } catch { /* */ }
  const apiKey = sourceCfg.api_key;
  if (!apiKey) return c.json({ error: "No api_key" }, 400);

  const out: any[] = [];

  // Two probes over the same paths: DIRECT (today's rotating Cloudflare egress)
  // and through the RELAY (the fixed IPv4 Lodgify allowlists). That pair is the
  // go/no-go for the cutover: direct 429 + relay 200 proves the allowlist works,
  // and nothing else does — the difference cannot be reproduced locally, which
  // is why this route exists. Read-only: one item per path, invoices nothing.
  //
  // The header-variant sweep this replaced sent a spoofed Chrome User-Agent.
  // Removed deliberately: it was written to characterise the block, which is now
  // understood, and a browser UA in a burst against an API is an evasion
  // signature. Sending it FROM the address we asked Lodgify to trust is the
  // fastest way to lose the allowlist. All traffic now carries one honest,
  // identifiable UA (LODGIFY_USER_AGENT) — being recognisable is the point.
  const probes: Array<{ name: string; gateway: LodgifyGateway }> = [
    { name: "direct (no fixed IP)", gateway: { base: LODGIFY_DIRECT_BASE, key: null, relayed: false } },
  ];
  try {
    // Ask for the relay explicitly, whatever the deployed mode says: before the
    // cutover the mode is still "direct", and this route is how we test.
    const relay = resolveLodgifyGateway({
      LODGIFY_EGRESS_MODE: "gateway",
      LODGIFY_GATEWAY_URL: c.env.LODGIFY_GATEWAY_URL,
      LODGIFY_GATEWAY_KEY: c.env.LODGIFY_GATEWAY_KEY,
    });
    probes.push({ name: `relay ${relay.base}`, gateway: relay });
  } catch (e: any) {
    out.push({ probe: "relay", error: String(e?.message ?? e) });
  }

  const paths = [
    "/v1/reservation?offset=0&limit=1&trash=False",
    "/v2/reservations/bookings?page=1&size=1",
  ];
  for (const p of probes) {
    for (const path of paths) {
      try {
        const res = await lodgifyFetch(path, { apiKey, gateway: p.gateway });
        const text = await res.text();
        out.push({
          probe: p.name,
          path: path.split("?")[0],
          status: res.status,
          // Set only by our own relay, so a 502 here is our box, not Lodgify.
          gateway_error: res.headers.get(GATEWAY_ERROR_HEADER),
          cf_ray: res.headers.get("cf-ray"),
          server: res.headers.get("server"),
          retry_after: res.headers.get("retry-after"),
          cf_mitigated: res.headers.get("cf-mitigated"),
          body: text.slice(0, 600),
        });
      } catch (e: any) {
        out.push({ probe: p.name, path: path.split("?")[0], error: String(e?.message ?? e) });
      }
      await delay(500);
    }
  }
  return c.json({ ranAt: new Date().toISOString(), results: out });
})

// Admin: run the incident-driven auto-heal on demand. dry_run:true reports what
// WOULD be re-emitted (the open-incident orders still missing an invoice) and
// writes nothing. shops:[] restricts to specific domains. This is the reliable
// nightly primary — bounded to the flagged-missing set, so it completes even for
// high-volume shops the full scan can't finish.
app.post("/admin/run-incident-heal", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  let body: { dry_run?: boolean; shops?: string[] | string } = {};
  try { body = await c.req.json(); } catch { /* empty body = defaults */ }
  const shops = Array.isArray(body.shops)
    ? body.shops
    : (typeof body.shops === "string" ? body.shops.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
  try {
    const result = await runIncidentDrivenHeal(c.env, { dryRun: body.dry_run === true, shops });
    return c.json(result);
  } catch (e) {
    return errorResponse(c, e, "Incident-driven heal failed");
  }
})

// Admin: run the weekly merchant digest on demand. dry_run:true previews the
// per-merchant recipients + counts and sends NOTHING (also skips incident
// auto-close). user_id scopes to a single merchant. Same code the Friday 16:00
// cron runs.
app.post("/admin/run-weekly-digest", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  let body: { dry_run?: boolean; user_id?: string } = {};
  try { body = await c.req.json(); } catch { /* empty body = defaults */ }
  try {
    const result = await runWeeklyMerchantDigest(c.env, {
      dryRun: body.dry_run === true,
      userId: body.user_id,
    });
    return c.json(result);
  } catch (e) {
    return errorResponse(c, e, "Weekly digest failed");
  }
})

// Admin: process (create or finalize) orders
app.post("/admin/process-orders", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;

  const body = await c.req.json<{
    shop: string;
    type: "create_orders" | "finalize_orders";
    order_ids?: number[];
    from?: string;
    to?: string;
    dry_run?: boolean;
    since_last_processed?: boolean;
    notify_emails?: string[];
    triggered_by?: string;
    reason?: string;
  }>();

  if (!body.shop || !body.type) {
    return c.json({ error: "Missing required fields: shop, type" }, 400);
  }

  if (!["create_orders", "finalize_orders"].includes(body.type)) {
    return c.json({ error: "type must be 'create_orders' or 'finalize_orders'" }, 400);
  }

  if (!body.order_ids?.length && !body.since_last_processed && (!body.from || !body.to)) {
    return c.json({ error: "Either order_ids, since_last_processed, or from/to date range is required" }, 400);
  }

  const appStorage = new AppStorage(c.env, body.shop);
  const config = await appStorage.loadConfig();

  if (!config) {
    return c.json({ error: `No config found for ${body.shop}` }, 404);
  }

  try {
    const result = await processOrders(c.env, config, body.type, body.order_ids, body.from, body.to, {
      dry_run: body.dry_run,
      since_last_processed: body.since_last_processed,
      notify_emails: body.notify_emails,
      triggered_by: body.triggered_by ?? null,
      reason: body.reason ?? null,
    });
    return c.json(result);
  } catch (e) {
    return errorResponse(c, e, "Failed to process orders");
  }
})

// Admin: re-emit single order by order_number
app.post("/admin/reemit-order", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;

  const body = await c.req.json<{
    shop: string;
    order_number: number;
    force?: boolean;
    reason?: string;
    triggered_by?: string;
    notify_emails?: string[];
  }>();

  if (!body.shop || !body.order_number) {
    return c.json({ error: "Missing required fields: shop, order_number" }, 400);
  }

  const appStorage = new AppStorage(c.env, body.shop);
  const config = await appStorage.loadConfig();
  if (!config) return c.json({ error: `No config found for ${body.shop}` }, 404);

  try {
    const result = await reemitOrder(c.env, config, body.order_number, {
      force: body.force,
      reason: body.reason ?? null,
      triggered_by: body.triggered_by ?? null,
      notify_emails: body.notify_emails,
    });
    // Map result.status → HTTP status so callers (UI) can detect failures
    // without parsing the payload. 200 = created/skipped (both terminal OK);
    // 422 = error (something we can't recover from automatically).
    const httpStatus = (result as any).status === "error" ? 422 : 200;
    return c.json(result, httpStatus);
  } catch (e) {
    return errorResponse(c, e, "Failed to re-emit order");
  }
})

// Admin: finalize drafts
app.post("/admin/finalize-drafts", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;

  const body = await c.req.json<{
    shop: string;
    dry_run?: boolean;
    limit?: number;
    reason?: string;
    triggered_by?: string;
    notify_emails?: string[];
    date_strategy?: "today" | "closest_available";
    from_order_number?: number | null;
    to_order_number?: number | null;
    from_date?: string | null;
    to_date?: string | null;
  }>();

  if (!body.shop) return c.json({ error: "Missing required field: shop" }, 400);

  const appStorage = new AppStorage(c.env, body.shop);
  const config = await appStorage.loadConfig();
  if (!config) return c.json({ error: `No config found for ${body.shop}` }, 404);

  try {
    const result = await finalizeDrafts(c.env, config, {
      dry_run: body.dry_run,
      limit: body.limit,
      reason: body.reason ?? null,
      triggered_by: body.triggered_by ?? null,
      notify_emails: body.notify_emails,
      date_strategy: body.date_strategy,
      from_order_number: body.from_order_number,
      to_order_number: body.to_order_number,
      from_date: body.from_date,
      to_date: body.to_date,
    });
    return c.json(result);
  } catch (e) {
    return errorResponse(c, e, "Failed to finalize drafts");
  }
})

// Admin: on-demand advisory AI diagnosis for an incident (Phase 4b). Reuses the
// same redact + diagnose path as the real-time alert email. Advisory only.
app.post("/admin/incidents/:id/explain", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;

  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing incident id" }, 400);

  try {
    const result = await explainIncidentById(c.env, id);
    return result.ok ? c.json(result) : c.json(result, 422);
  } catch (e) {
    return errorResponse(c, e, "Failed to explain incident");
  }
})

// Admin: re-send the real alert email for an incident (QA preview) — full live
// path incl. AI diagnosis, to KAPTA_DEV_EMAILS. Does not touch the incident row.
app.post("/admin/incidents/:id/test-email", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;

  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing incident id" }, 400);

  try {
    const result = await sendIncidentTestEmail(c.env, id);
    return result.ok ? c.json(result) : c.json(result, 422);
  } catch (e) {
    return errorResponse(c, e, "Failed to send test email");
  }
})

// Admin: per-shop logs / jobs / webhooks
app.get("/admin/logs", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;

  const shop = c.req.query("shop");
  const userId = c.req.query("user_id");
  const type = (c.req.query("type") ?? "jobs") as "errors" | "webhooks" | "jobs" | "all";
  const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10) || 100, 500);

  // `shop` stays the primary key so every existing caller behaves byte-for-byte
  // as before. `user_id` is the connection-based equivalent: rows for a Stripe or
  // Lodgify merchant carry a user_id and a NULL shopify_domain, so the shop-keyed
  // queries can never see them.
  if (!shop && !userId) return c.json({ error: "Missing required query param: shop or user_id" }, 400);

  const appStorage = new AppStorage(c.env, shop ?? null, userId ?? undefined);
  try {
    if (shop) {
      if (type === "errors") return c.json({ entries: await appStorage.getLogs(limit, "errors") });
      if (type === "all") return c.json({ entries: await appStorage.getLogs(limit, "all") });
      if (type === "webhooks") return c.json({ entries: await appStorage.getWebhookEvents(limit) });
      return c.json({ entries: await appStorage.getDevJobs(limit) });
    }
    if (type === "errors") return c.json({ entries: await appStorage.getLogsByUser(userId!, limit, "errors") });
    if (type === "all") return c.json({ entries: await appStorage.getLogsByUser(userId!, limit, "all") });
    if (type === "webhooks") return c.json({ entries: await appStorage.getWebhookEventsByUser(userId!, limit) });
    return c.json({ entries: await appStorage.getDevJobsByUser(userId!, limit) });
  } catch (e) {
    return errorResponse(c, e, "Failed to fetch logs");
  }
})

// Admin: fetch single job detail (per-order results)
app.get("/admin/jobs/:id", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;

  const shop = c.req.query("shop");
  const userId = c.req.query("user_id");
  const id = c.req.param("id");
  if (!shop && !userId) return c.json({ error: "Missing shop or user_id" }, 400);

  // getDevJob already scopes by shopDomain, then user_id, then bare id.
  const appStorage = new AppStorage(c.env, shop ?? null, userId ?? undefined);
  const job = await appStorage.getDevJob(id);
  if (!job) return c.json({ error: "Not found" }, 404);
  return c.json(job);
})

// Admin: get/set per-account notify emails
app.get("/admin/notify-emails", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const shop = c.req.query("shop");
  if (!shop) return c.json({ error: "Missing shop" }, 400);
  const appStorage = new AppStorage(c.env, shop);
  return c.json({ emails: await appStorage.getNotifyEmails() });
})

app.put("/admin/notify-emails", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<{ shop: string; emails: string[] }>();
  if (!body.shop) return c.json({ error: "Missing shop" }, 400);
  const emails = (body.emails ?? []).filter(e => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  const appStorage = new AppStorage(c.env, body.shop);
  await appStorage.setNotifyEmails(emails);
  return c.json({ emails });
})

// Admin: delete draft by order_number
app.post("/admin/delete-draft", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<{ shop: string; order_number: number; reason?: string; triggered_by?: string; notify_emails?: string[] }>();
  if (!body.shop || !body.order_number) return c.json({ error: "Missing shop or order_number" }, 400);
  const appStorage = new AppStorage(c.env, body.shop);
  const config = await appStorage.loadConfig();
  if (!config) return c.json({ error: `No config found for ${body.shop}` }, 404);
  try {
    const result = await deleteDraftByOrderNumber(c.env, config, body.order_number, {
      reason: body.reason ?? null,
      triggered_by: body.triggered_by ?? null,
      notify_emails: body.notify_emails,
    });
    return c.json(result);
  } catch (e) {
    return errorResponse(c, e, "Failed to delete draft");
  }
})

// Admin: issue credit note by order_number
app.post("/admin/issue-credit-note", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<{ shop: string; order_number: number; reason?: string; triggered_by?: string; notify_emails?: string[] }>();
  if (!body.shop || !body.order_number) return c.json({ error: "Missing shop or order_number" }, 400);
  const appStorage = new AppStorage(c.env, body.shop);
  const config = await appStorage.loadConfig();
  if (!config) return c.json({ error: `No config found for ${body.shop}` }, 404);
  try {
    const result = await issueCreditNoteByOrderNumber(c.env, config, body.order_number, {
      reason: body.reason ?? null,
      triggered_by: body.triggered_by ?? null,
      notify_emails: body.notify_emails,
    });
    return c.json(result);
  } catch (e) {
    return errorResponse(c, e, "Failed to issue credit note");
  }
})

// ────────────────────────────────────────────────────────────────────────────
// Admin: the generic recovery surface. One set of routes for every
// (source × destination) connection, keyed on `user_id` plus an optional
// source/destination discriminator.
//
// The per-source routes below (/admin/process-orders, /admin/stripe/*, …) stay
// exactly as they are: they have script and ops callers, and a recovery tool is
// the wrong thing to break while proving its replacement.
// ────────────────────────────────────────────────────────────────────────────

interface ConnectionRouteBody {
  user_id?: string;
  source?: SourceKind;
  destination?: DestinationKind;
  external_id?: string;
  from?: string;
  to?: string;
  dry_run?: boolean;
  limit?: number;
  /** Backfill only: also bill sales from before the connection's invoice_cutoff. */
  ignore_cutoff?: boolean;
  /** /invoice-cutoff only: the new cutoff (YYYY-MM-DD or ISO), null to clear. */
  invoice_cutoff?: string | null;
  force?: boolean;
  reason?: string;
  triggered_by?: string;
  notify_emails?: string[];
  date_strategy?: FinalizeDateStrategy;
  from_date?: string;
  to_date?: string;
  from_order_number?: number;
  to_order_number?: number;
}

/**
 * Resolve the connection a request means, refusing to guess.
 *
 * With several active connections and no discriminator we answer 409 with the
 * list rather than picking one: issuing a document to the wrong destination is
 * not an error you can undo by pressing the button again.
 */
async function resolveRouteConnection(c: Context<{ Bindings: Env }>, body: ConnectionRouteBody) {
  if (!body.user_id) return { error: c.json({ error: "Missing user_id" }, 400) };

  const resolved = await resolveConnectionContext(c.env, {
    userId: body.user_id, source: body.source, destination: body.destination,
  });
  if (resolved.ok) return { ctx: resolved.ctx };

  if (resolved.error === "ambiguous") {
    return {
      error: c.json({
        error: "Several active connections — say which one with source + destination.",
        options: resolved.options,
      }, 409),
    };
  }
  return { error: c.json({ error: `No active connection for user ${body.user_id}` }, 404) };
}

app.get("/admin/connection/capabilities", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const userId = c.req.query("user_id");
  if (!userId) return c.json({ error: "Missing user_id" }, 400);
  try {
    return c.json(await connectionCapabilities(c.env, userId));
  } catch (e) {
    return errorResponse(c, e, "Failed to read connection capabilities");
  }
})

app.post("/admin/connection/backfill", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<ConnectionRouteBody>();
  const resolved = await resolveRouteConnection(c, body);
  if ("error" in resolved) return resolved.error;
  if (!body.from || !body.to) return c.json({ error: "Missing from/to" }, 400);
  try {
    return c.json(await backfillConnection(c.env, resolved.ctx, {
      from: body.from, to: body.to,
      dry_run: body.dry_run, limit: body.limit,
      ignore_cutoff: body.ignore_cutoff,
      reason: body.reason ?? null, triggered_by: body.triggered_by ?? null,
      notify_emails: body.notify_emails,
    }));
  } catch (e) {
    return errorResponse(c, e, "Backfill failed");
  }
})

app.post("/admin/connection/reemit", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<ConnectionRouteBody>();
  const resolved = await resolveRouteConnection(c, body);
  if ("error" in resolved) return resolved.error;
  if (!body.external_id) return c.json({ error: "Missing external_id" }, 400);
  try {
    const result = await reemitConnection(c.env, resolved.ctx, body.external_id, {
      force: body.force,
      reason: body.reason ?? null, triggered_by: body.triggered_by ?? null,
      notify_emails: body.notify_emails,
    });
    // 422 for "we understood you and could not do it", matching the legacy
    // re-emit route the conciliação page already handles.
    return c.json(result, result.status === "error" ? 422 : 200);
  } catch (e) {
    return errorResponse(c, e, "Re-emit failed");
  }
})

app.post("/admin/connection/delete-draft", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<ConnectionRouteBody>();
  const resolved = await resolveRouteConnection(c, body);
  if ("error" in resolved) return resolved.error;
  if (!body.external_id) return c.json({ error: "Missing external_id" }, 400);
  // Deleting a document is not undoable by pressing the button again.
  if (!body.reason) return c.json({ error: "Missing reason — say why this draft is being deleted" }, 400);
  try {
    const result = await deleteConnectionDraft(c.env, resolved.ctx, body.external_id, {
      reason: body.reason, triggered_by: body.triggered_by ?? null, notify_emails: body.notify_emails,
    });
    return c.json(result, result.status === "error" ? 422 : 200);
  } catch (e) {
    return errorResponse(c, e, "Delete draft failed");
  }
})

app.post("/admin/connection/issue-credit-note", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<ConnectionRouteBody>();
  const resolved = await resolveRouteConnection(c, body);
  if ("error" in resolved) return resolved.error;
  if (!body.external_id) return c.json({ error: "Missing external_id" }, 400);
  // A credit note is a fiscal document. It gets a reason.
  if (!body.reason) return c.json({ error: "Missing reason — say why this document is being credited" }, 400);
  try {
    const result = await creditConnectionDocument(c.env, resolved.ctx, body.external_id, {
      reason: body.reason, dry_run: body.dry_run,
      triggered_by: body.triggered_by ?? null, notify_emails: body.notify_emails,
    });
    return c.json(result, result.status === "error" ? 422 : 200);
  } catch (e) {
    return errorResponse(c, e, "Credit note failed");
  }
})

app.post("/admin/connection/finalize-drafts", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<ConnectionRouteBody>();
  const resolved = await resolveRouteConnection(c, body);
  if ("error" in resolved) return resolved.error;
  try {
    return c.json(await finalizeConnectionDrafts(c.env, resolved.ctx, {
      dry_run: body.dry_run, limit: body.limit,
      date_strategy: body.date_strategy,
      from_date: body.from_date ?? null, to_date: body.to_date ?? null,
      from_order_number: body.from_order_number ?? null, to_order_number: body.to_order_number ?? null,
      reason: body.reason ?? null, triggered_by: body.triggered_by ?? null,
      notify_emails: body.notify_emails,
    }));
  } catch (e) {
    return errorResponse(c, e, "Finalize drafts failed");
  }
})

/**
 * Move the connection's `invoice_cutoff` — the date it starts invoicing from.
 *
 * Stamped from the Stripe subscription's start at activation, which is wrong for
 * any merchant whose subscription was created after the sales Rioko is meant to
 * bill: everything older is skipped as "Anterior ao início da facturação". This
 * is how that is corrected, deliberately, per connection.
 */
app.post("/admin/connection/invoice-cutoff", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<ConnectionRouteBody>();
  const resolved = await resolveRouteConnection(c, body);
  if ("error" in resolved) return resolved.error;
  try {
    return c.json(await setConnectionInvoiceCutoff(
      c.env, resolved.ctx, body.invoice_cutoff ?? null, { triggered_by: body.triggered_by ?? null },
    ));
  } catch (e) {
    return errorResponse(c, e, "Could not set invoice cutoff");
  }
})

// ────────────────────────────────────────────────────────────────────────────
// Admin: Stripe Dev Mode parity. Stripe-only users have no shopify_domain, so
// these routes key off `user_id`.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The config for a user's Stripe connection.
 *
 * This used to be a bare `SELECT * FROM integrations WHERE user_id = ?`, which
 * returns nothing for a client who never came in through Shopify→IX. Four of the
 * five Stripe recovery routes then 404'd with "No integrations row found" for
 * precisely the Moloni-only clients they exist to serve. Resolving through the
 * shared connection context synthesizes the missing legacy row and projects the
 * connection's own auto_finalize/send_email onto it.
 *
 * `pick_latest` mirrors the LIMIT 1 the Stripe handlers already use when a user
 * somehow has more than one Stripe connection.
 */
async function loadConfigForUser(c: Context<{ Bindings: Env }>, userId: string) {
  const resolved = await resolveConnectionContext(c.env, {
    userId, source: "stripe", onAmbiguous: "pick_latest",
  });
  return resolved.ok ? resolved.ctx.config : null;
}

app.post("/admin/stripe/backfill", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<{
    user_id: string;
    from?: string;
    to?: string;
    dry_run?: boolean;
    since_last_processed?: boolean;
    notify_emails?: string[];
    triggered_by?: string;
    reason?: string;
  }>();
  if (!body.user_id) return c.json({ error: "Missing user_id" }, 400);
  const config = await loadConfigForUser(c, body.user_id);
  if (!config) return c.json({ error: `No Stripe connection found for user ${body.user_id}` }, 404);
  try {
    const result = await processStripeBackfill(c.env, config, {
      from: body.from,
      to: body.to,
      dry_run: body.dry_run,
      since_last_processed: body.since_last_processed,
      notify_emails: body.notify_emails,
      triggered_by: body.triggered_by ?? null,
      reason: body.reason ?? null,
    });
    return c.json(result);
  } catch (e) {
    return errorResponse(c, e, "Failed to run Stripe backfill");
  }
})

// Admin: Stripe self-heal on demand (parity with the Shopify reconciliation
// sweep). Re-emits any succeeded Stripe payment in the window with no
// processed_orders row, across all active Stripe connections (or a user
// allowlist). dry_run=true reports what WOULD be created without writing.
//   { dry_run?: boolean, days?: number, users?: string[] }
app.post("/admin/stripe/heal", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<{ dry_run?: boolean; days?: number; users?: string[] }>().catch(() => ({} as any));
  try {
    const result = await runStripeHeal(c.env, { dryRun: body.dry_run === true, days: body.days, users: body.users });
    return c.json(result);
  } catch (e) {
    return errorResponse(c, e, "Failed to run Stripe heal");
  }
})

// Admin: run the renewal-reminder sweep on demand (testing / manual send).
//   { dry_run?: boolean, window_days?: number }
// dry_run=true lists who is due without sending; window_days overrides the
// default 7-day lookahead (e.g. to verify a far-future subscription is caught).
app.post("/admin/billing/renewal-reminders", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<{ dry_run?: boolean; window_days?: number }>().catch(() => ({} as any));
  try {
    const result = await runRenewalReminders(c.env, {
      dryRun: body.dry_run === true,
      windowDays: typeof body.window_days === "number" ? body.window_days : undefined,
    });
    return c.json(result);
  } catch (e) {
    return errorResponse(c, e, "Failed to run renewal reminders");
  }
})

// Admin: dry-run / force the early-bird wind-down sequence. `as_of` lets us
// preview a future send date (e.g. 2026-08-15) without waiting for the cron.
app.post("/admin/billing/early-bird-reminders", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<{ dry_run?: boolean; as_of?: string }>().catch(() => ({} as any));
  try {
    const asOf = body.as_of ? new Date(body.as_of) : undefined;
    if (asOf && Number.isNaN(asOf.getTime())) return c.json({ error: "as_of is not a valid date" }, 400);
    const result = await runEarlyBirdEndingReminders(c.env, { dryRun: body.dry_run !== false, now: asOf });
    return c.json(result);
  } catch (e) {
    return errorResponse(c, e, "Failed to run early-bird reminders");
  }
})

app.post("/admin/stripe/reemit", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<{
    user_id: string;
    stripe_id: string;
    force?: boolean;
    reason?: string;
    triggered_by?: string;
    notify_emails?: string[];
  }>();
  if (!body.user_id || !body.stripe_id) return c.json({ error: "Missing user_id or stripe_id" }, 400);
  // The synth-a-minimal-config fallback that used to live here now lives in
  // loadConfigForUser, so every Stripe route gets it, not just this one.
  const config = await loadConfigForUser(c, body.user_id);
  if (!config) return c.json({ error: `No Stripe connection found for user ${body.user_id}` }, 404);
  try {
    const result = await reemitStripeOrder(c.env, config, body.stripe_id, {
      force: body.force,
      reason: body.reason ?? null,
      triggered_by: body.triggered_by ?? null,
      notify_emails: body.notify_emails,
    });
    return c.json(result);
  } catch (e) {
    return errorResponse(c, e, "Failed to re-emit Stripe order");
  }
})

app.post("/admin/stripe/delete-draft", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<{
    user_id: string;
    stripe_id: string;
    reason?: string;
    triggered_by?: string;
    notify_emails?: string[];
  }>();
  if (!body.user_id || !body.stripe_id) return c.json({ error: "Missing user_id or stripe_id" }, 400);
  const config = await loadConfigForUser(c, body.user_id);
  if (!config) return c.json({ error: `No Stripe connection found for user ${body.user_id}` }, 404);
  try {
    const result = await deleteStripeDraft(c.env, config, body.stripe_id, {
      reason: body.reason ?? null,
      triggered_by: body.triggered_by ?? null,
      notify_emails: body.notify_emails,
    });
    return c.json(result);
  } catch (e) {
    return errorResponse(c, e, "Failed to delete Stripe draft");
  }
})

app.post("/admin/stripe/issue-credit-note", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<{
    user_id: string;
    stripe_id: string;
    reason?: string;
    triggered_by?: string;
    notify_emails?: string[];
  }>();
  if (!body.user_id || !body.stripe_id) return c.json({ error: "Missing user_id or stripe_id" }, 400);
  const config = await loadConfigForUser(c, body.user_id);
  if (!config) return c.json({ error: `No Stripe connection found for user ${body.user_id}` }, 404);
  try {
    const result = await issueStripeCreditNote(c.env, config, body.stripe_id, {
      reason: body.reason ?? null,
      triggered_by: body.triggered_by ?? null,
      notify_emails: body.notify_emails,
    });
    return c.json(result);
  } catch (e) {
    return errorResponse(c, e, "Failed to issue Stripe credit note");
  }
})

app.post("/admin/stripe/finalize-drafts", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<{
    user_id: string;
    dry_run?: boolean;
    limit?: number;
    reason?: string;
    triggered_by?: string;
    notify_emails?: string[];
    date_strategy?: "today" | "closest_available";
    from_date?: string | null;
    to_date?: string | null;
  }>();
  if (!body.user_id) return c.json({ error: "Missing user_id" }, 400);
  const config = await loadConfigForUser(c, body.user_id);
  if (!config) return c.json({ error: `No Stripe connection found for user ${body.user_id}` }, 404);
  try {
    const result = await finalizeStripeDrafts(c.env, config, {
      dry_run: body.dry_run,
      limit: body.limit,
      reason: body.reason ?? null,
      triggered_by: body.triggered_by ?? null,
      notify_emails: body.notify_emails,
      date_strategy: body.date_strategy,
      from_date: body.from_date,
      to_date: body.to_date,
    });
    return c.json(result);
  } catch (e) {
    return errorResponse(c, e, "Failed to finalize Stripe drafts");
  }
})

// Admin: get/set per-account tax override
app.get("/admin/tax-override", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const shop = c.req.query("shop");
  if (!shop) return c.json({ error: "Missing shop" }, 400);
  const appStorage = new AppStorage(c.env, shop);
  return c.json(await appStorage.getTaxOverride());
})

app.put("/admin/tax-override", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<{
    shop: string;
    force_tax_rate: number | null;
    force_shipping_tax_rate: number | null;
    oss_enabled: boolean;
    b2b_reverse_charge?: boolean;
    ix_b2b_exemption_reason?: string;
  }>();
  if (!body.shop) return c.json({ error: "Missing shop" }, 400);
  const validate = (r: number | null | undefined, label: string) => {
    if (r != null && (typeof r !== "number" || r < 0 || r > 100)) {
      return c.json({ error: `${label} must be a number between 0 and 100, or null` }, 400);
    }
    return null;
  };
  const e1 = validate(body.force_tax_rate, "force_tax_rate");
  if (e1) return e1;
  const e2 = validate(body.force_shipping_tax_rate, "force_shipping_tax_rate");
  if (e2) return e2;
  const reason = body.ix_b2b_exemption_reason && body.ix_b2b_exemption_reason.trim().length > 0
    ? body.ix_b2b_exemption_reason.trim().slice(0, 16)
    : "M16";
  const appStorage = new AppStorage(c.env, body.shop);
  await appStorage.setTaxOverride(
    body.force_tax_rate ?? null,
    body.force_shipping_tax_rate ?? null,
    !!body.oss_enabled,
    !!body.b2b_reverse_charge,
    reason,
  );
  return c.json(await appStorage.getTaxOverride());
})

// Admin: list pending reverse-charge rows for a shop (pending status only).
app.get("/admin/pending-reverse-charge", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const shop = c.req.query("shop");
  if (!shop) return c.json({ error: "Missing shop" }, 400);
  const result = await c.env.DB.prepare(
    "SELECT id, order_id, vat_id, country_code, attempts, status, next_retry_at, last_error, incident_id, created_at, updated_at FROM pending_reverse_charge WHERE shopify_domain = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 100"
  ).bind(shop).all();
  return c.json({ rows: result.results ?? [] });
})

// Admin: manual VIES decisions for pending reverse-charge rows.
// Both routes idempotently submit the deferred invoice and resolve the row.
app.post("/admin/pending-reverse-charge/:id/approve", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const id = c.req.param("id");
  const appStorage = new AppStorage(c.env);
  const row = await appStorage.getPendingById(id);
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.status !== "pending") return c.json({ ok: true, alreadyResolved: row.status });
  const result = await submitInvoiceForPendingRow(c.env, row, "apply");
  if (!result.ok) return c.json({ error: result.error }, 500);
  return c.json({ ok: true, invoiceId: result.invoiceId, disposition: "apply" });
})

app.post("/admin/pending-reverse-charge/:id/reject", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const id = c.req.param("id");
  const appStorage = new AppStorage(c.env);
  const row = await appStorage.getPendingById(id);
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.status !== "pending") return c.json({ ok: true, alreadyResolved: row.status });
  const result = await submitInvoiceForPendingRow(c.env, row, "reject");
  if (!result.ok) return c.json({ error: result.error }, 500);
  return c.json({ ok: true, invoiceId: result.invoiceId, disposition: "reject" });
})

// Admin: reconciliation list. Accepts either ?shop= (Shopify back-compat) or
// ?user_id= (resolves the user's active connection: Shopify→IX, Lodgify→Moloni…).
app.get("/admin/reconciliation", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const shop = c.req.query("shop");
  const userId = c.req.query("user_id");
  const from = c.req.query("from");
  const to = c.req.query("to");
  if ((!shop && !userId) || !from || !to) return c.json({ error: "Missing shop|user_id/from/to" }, 400);

  const ctx = await resolveReconContext(c.env, { shop, userId });
  if (!ctx) return c.json({ error: `No integration found for ${shop ?? userId}` }, 404);

  try {
    // `refresh=1` ignores the cached reference lookups for this request. It
    // exists because a bad "MISS" used to be cached for an hour, so there was no
    // way to re-ask without waiting it out — and no way to prove a fix. It skips
    // only the cache READ; the budget and concurrency caps still apply, so it
    // cannot be used to hammer the destination.
    const result = await getReconciliation(c.env, ctx, from, to, {
      skipRefCache: c.req.query("refresh") === "1",
    });
    return c.json(result);
  } catch (e) {
    return errorResponse(c, e, "Failed to load reconciliation");
  }
})

app.post("/admin/reconciliation/approve", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<{ shop?: string; user_id?: string; order_id: string; invoice_id: string; approved_by?: string }>();
  if ((!body.shop && !body.user_id) || !body.order_id || !body.invoice_id) return c.json({ error: "Missing shop|user_id/order_id/invoice_id" }, 400);
  const ctx = await resolveReconContext(c.env, { shop: body.shop, userId: body.user_id });
  if (!ctx) return c.json({ error: `No integration found for ${body.shop ?? body.user_id}` }, 404);
  try {
    return c.json(await approveReconciliationMatch(c.env, ctx.scope, body.order_id, body.invoice_id, body.approved_by ?? null));
  } catch (e) { return errorResponse(c, e, "Admin operation failed"); }
})

app.delete("/admin/reconciliation/approve", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const shop = c.req.query("shop");
  const userId = c.req.query("user_id");
  const orderId = c.req.query("order_id");
  if ((!shop && !userId) || !orderId) return c.json({ error: "Missing shop|user_id/order_id" }, 400);
  const ctx = await resolveReconContext(c.env, { shop, userId });
  if (!ctx) return c.json({ error: `No integration found for ${shop ?? userId}` }, 404);
  try {
    return c.json(await revertReconciliationMatch(c.env, ctx.scope, orderId));
  } catch (e) { return errorResponse(c, e, "Admin operation failed"); }
})

app.post("/admin/reconciliation/decision", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<{ shop?: string; user_id?: string; order_id: string; decision: string | null; reason?: string; decided_by?: string }>();
  if ((!body.shop && !body.user_id) || !body.order_id) return c.json({ error: "Missing shop|user_id/order_id" }, 400);
  const ctx = await resolveReconContext(c.env, { shop: body.shop, userId: body.user_id });
  if (!ctx) return c.json({ error: `No integration found for ${body.shop ?? body.user_id}` }, 404);
  try {
    return c.json(await setReconciliationDecisionAction(c.env, ctx.scope, body.order_id, body.decision ?? null, body.reason ?? null, body.decided_by ?? null));
  } catch (e) { return errorResponse(c, e, "Admin operation failed"); }
})

app.get("/admin/user-shop", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const userId = c.req.query("user_id");
  if (!userId) return c.json({ error: "Missing user_id" }, 400);
  try {
    return c.json(await getShopForUser(c.env, userId));
  } catch (e) { return errorResponse(c, e, "Admin operation failed"); }
})

// Admin: ad-hoc notify. `from_name` / `from_email` are for merchant-facing mail —
// the default sender is "Rioko Dev Mode", which is right for QA blasts and wrong
// for anything a customer reads. `cc` lets ops stay on the thread.
app.post("/admin/notify", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<{
    recipients: string[]; subject: string; body?: string; html?: string;
    cc?: string[]; from_name?: string; from_email?: string; reply_to?: string;
  }>();
  if (!body.recipients?.length) return c.json({ error: "Missing recipients" }, 400);
  const res = await sendEmailDirect(c.env, {
    to: body.recipients,
    cc: body.cc,
    subject: body.subject,
    html: body.html ?? `<pre style="font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap">${body.body ?? ""}</pre>`,
    text: body.body,
    fromName: body.from_name ?? "Rioko Dev Mode",
    fromEmail: body.from_email,
    replyTo: body.reply_to,
  });
  return c.json({ ok: res.ok, status: res.status, provider: res.provider, id: res.id, detail: res.detail }, res.ok ? 200 : 500);
})

// Admin: render + send a quota email (warning|reached) for QA / preview.
app.post("/admin/test-quota-email", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<{ recipient: string; kind?: "warning" | "reached"; merchantName?: string; ixAccount?: string }>();
  if (!body.recipient) return c.json({ error: "Missing recipient" }, 400);
  const { renderQuotaEmail } = await import("./services/email-templates");
  const { sendEmail } = await import("./services/email");
  const tpl = renderQuotaEmail({
    kind: body.kind === "warning" ? "warning" : "reached",
    merchantName: body.merchantName ?? "Zoo de Lagos",
    ixAccount: body.ixAccount ?? "pelicanzooparquez",
    periodStart: "30/05/2026",
    periodEnd: "30/06/2026",
  });
  const res = await sendEmail(c.env, { to: body.recipient, subject: `[TEST] ${tpl.subject}`, html: tpl.html });
  return c.json({ ok: res.ok, provider: res.provider, id: res.id, kind: body.kind ?? "reached" }, res.ok ? 200 : 500);
})

// Admin: render an incident template and send it via Resend. Bypasses the
// incident dedup bucket so it can fire repeatedly for QA.
app.post("/admin/test-incident-email", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;

  const body = await c.req.json<{
    recipient: string;
    kind?: string;
    severity?: "info" | "warning" | "error" | "critical";
    merchantName?: string;
    connectionLabel?: string;
  }>();

  if (!body.recipient) return c.json({ error: "Missing recipient" }, 400);

  const { renderIncidentTemplate, type: _t } = await import("./services/email-templates") as any;
  const { sendEmail } = await import("./services/email");

  const kinds = [
    "auth_failure_destination", "auth_failure_source", "destination_reject",
    "normalize_fail", "nif_invalid", "nif_invalid_draft", "credit_note_on_draft", "subscription_inactive",
    "queue_retry_exhausted", "webhook_invalid_signature",
  ];
  const kind = body.kind && kinds.includes(body.kind) ? body.kind : "webhook_invalid_signature";

  const now = new Date().toISOString();
  const tpl = renderIncidentTemplate(kind, {
    merchantName: body.merchantName ?? "Pedro Porto",
    connectionLabel: body.connectionLabel ?? "stripe → invoicexpress",
    occurrences: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    summary: "Test render — verifying mobile dark-mode title visibility.",
    severity: body.severity ?? "critical",
    affectedIds: ["test_order_001", "test_order_002"],
    dashboardUrl: "https://rioko.online",
  });

  const result = await sendEmail(c.env, {
    to: body.recipient,
    subject: `[TEST] ${tpl.subject}`,
    html: tpl.html,
  });
  return c.json({ ok: result.ok, provider: result.provider, id: result.id, detail: result.detail, kind }, result.ok ? 200 : 500);
})

// ── Moloni API proxy ──────────────────────────────────────────────────────────
// CF Pages edge functions cannot reach api.moloni.pt reliably. These routes run
// on the Worker (which can) and accept credentials in the POST body. Security:
// valid Moloni credentials are required to get any data back.

app.post("/moloni-proxy/companies", async (c) => {
  const body = await c.req.json<{
    client_id: string; client_secret: string; username: string; password: string; environment?: string;
  }>().catch(() => null);
  if (!body?.client_id || !body?.client_secret || !body?.username || !body?.password) {
    return c.json({ error: "Missing Moloni credentials" }, 400);
  }
  const baseUrl = body.environment === "sandbox" ? "https://apidemo.moloni.pt/v1" : "https://api.moloni.pt/v1";
  // AbortSignal.timeout is natively supported in CF Workers (not available in Next.js edge runtime).
  const signal = AbortSignal.timeout(10_000);
  try {
    const tokenUrl = new URL(`${baseUrl}/grant/`);
    tokenUrl.searchParams.set("grant_type", "password");
    tokenUrl.searchParams.set("client_id", body.client_id);
    tokenUrl.searchParams.set("client_secret", body.client_secret);
    tokenUrl.searchParams.set("username", body.username);
    tokenUrl.searchParams.set("password", body.password);
    const tokenRes = await fetch(tokenUrl.toString(), { method: "POST", headers: { "Accept": "application/json" }, signal });
    if (!tokenRes.ok) {
      const rawText = await tokenRes.text().catch(() => "");
      let err: any = {};
      try { err = JSON.parse(rawText); } catch { /* html or plain-text */ }
      const desc = err?.error_description ?? err?.message ?? (rawText.slice(0, 120) || "check credentials");
      return c.json({ error: `Moloni auth failed (${tokenRes.status}): ${desc}`, raw: rawText.slice(0, 500) }, 502);
    }
    const tokenData: any = await tokenRes.json();
    const token = tokenData?.access_token;
    if (!token) return c.json({ error: "Moloni auth returned no token" }, 502);
    const companiesRes = await fetch(
      `${baseUrl}/companies/getAll/?access_token=${encodeURIComponent(token)}&json=true`,
      { method: "POST", headers: { "Accept": "application/json" }, signal }
    );
    const data: any = await companiesRes.json().catch(() => []);
    const companies = Array.isArray(data)
      ? data.map((c: any) => ({ id: String(c.company_id ?? c.id), name: String(c.name ?? c.company_name ?? c.company_id ?? c.id) }))
      : [];
    return c.json({ companies });
  } catch (e: any) {
    const msg = (e?.name === "AbortError" || e?.name === "TimeoutError")
      ? "Moloni API did not respond in 10s — check credentials or contact Moloni support."
      : `Moloni proxy error: ${e?.message ?? "unknown"}`;
    return c.json({ error: msg }, 502);
  }
});

app.post("/moloni-proxy/document-sets", async (c) => {
  const body = await c.req.json<{
    client_id: string; client_secret: string; username: string; password: string; environment?: string; company_id: string;
  }>().catch(() => null);
  if (!body?.client_id || !body?.client_secret || !body?.username || !body?.password || !body?.company_id) {
    return c.json({ error: "Missing Moloni credentials or company_id" }, 400);
  }
  const baseUrl = body.environment === "sandbox" ? "https://apidemo.moloni.pt/v1" : "https://api.moloni.pt/v1";
  const signal = AbortSignal.timeout(10_000);
  try {
    const tokenUrl = new URL(`${baseUrl}/grant/`);
    tokenUrl.searchParams.set("grant_type", "password");
    tokenUrl.searchParams.set("client_id", body.client_id);
    tokenUrl.searchParams.set("client_secret", body.client_secret);
    tokenUrl.searchParams.set("username", body.username);
    tokenUrl.searchParams.set("password", body.password);
    const tokenRes = await fetch(tokenUrl.toString(), { method: "POST", headers: { "Accept": "application/json" }, signal });
    if (!tokenRes.ok) {
      const rawText2 = await tokenRes.text().catch(() => "");
      let err2: any = {};
      try { err2 = JSON.parse(rawText2); } catch { /* html */ }
      const desc2 = err2?.error_description ?? err2?.message ?? (rawText2.slice(0, 120) || "check credentials");
      return c.json({ error: `Moloni auth failed (${tokenRes.status}): ${desc2}`, raw: rawText2.slice(0, 500) }, 502);
    }
    const tokenData: any = await tokenRes.json();
    const token = tokenData?.access_token;
    if (!token) return c.json({ error: "Moloni auth returned no token" }, 502);
    const dsRes = await fetch(
      `${baseUrl}/documentSets/getAll/?access_token=${encodeURIComponent(token)}&json=true`,
      { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify({ company_id: Number(body.company_id) }), signal }
    );
    const data: any = await dsRes.json().catch(() => []);
    const documentSets = Array.isArray(data)
      ? data.map((d: any) => ({ id: String(d.document_set_id ?? d.id), name: String(d.name ?? d.document_set_name ?? d.id) }))
      : [];
    return c.json({ documentSets });
  } catch (e: any) {
    const msg = (e?.name === "AbortError" || e?.name === "TimeoutError")
      ? "Moloni API did not respond in 10s — check credentials or contact Moloni support."
      : `Moloni proxy error: ${e?.message ?? "unknown"}`;
    return c.json({ error: msg }, 502);
  }
});

// Stuck *transient* errors (not destination 5xx) give up after this many queue
// attempts instead of grinding to the 25→10 DLQ. ~6 × 360s ≈ 30min, ample for
// the orders/created→orders/paid race to self-heal.
const TRANSIENT_GIVEUP_ATTEMPTS = 6;

async function processShopifyBatch(batch: MessageBatch<QueueMessage>, env: Env) {
  for (const message of batch.messages) {
    const { topic, webhookId, shopDomain, body } = message.body;

    console.log(`[Rioko] Queue processing: ${topic} for ${shopDomain}`);

    try {
      const appStorage = new AppStorage(env, shopDomain);
      const config = await appStorage.loadConfig();

      if (!config) {
        console.error(`[Rioko] No config found for ${shopDomain}, acking message`);
        message.ack();
        continue;
      }

      // Routing-by-destination (additive). If the merchant has an active
      // `connections` row with destination_kind in ("moloni","vendus") for
      // their Shopify source, route THIS webhook through the adapter pipeline
      // with that destination. Otherwise fall through to legacy IX-direct
      // handlers — Shopify→InvoiceXpress stays on the comprovado legacy path
      // until the full legacy migration lands (~34h work, deferred).
      //
      // Known limitations of the pipeline path for Shopify-source (UI warns
      // the merchant before activating Moloni/Vendus on Shopify):
      //   - No VIES check / reverse-charge deferral (legacy uses IxBuilder.async)
      //   - No awaitInvoiceVisibility pad before paid lookup
      //   - No existing-credit-note dedup defense-in-depth in refunds
      // These mostly affect EU B2B; PT B2C ships fine.
      const connRow = config.user_id ? await env.DB.prepare(
        `SELECT destination_kind, destination_config_json FROM connections
         WHERE user_id = ? AND source_kind = 'shopify' AND status = 'active' LIMIT 1`
      ).bind(config.user_id).first<{ destination_kind: string; destination_config_json: string | null } | null>() : null;

      const routedDestination = connRow?.destination_kind && connRow.destination_kind !== "invoicexpress"
        ? (connRow.destination_kind as "moloni" | "vendus")
        : null;

      if (routedDestination) {
        const canonical = shopifyTopicToCanonical(topic);
        if (canonical) {
          let destinationConfig: Record<string, any> | undefined;
          try {
            destinationConfig = connRow!.destination_config_json
              ? JSON.parse(connRow!.destination_config_json)
              : undefined;
          } catch {
            destinationConfig = undefined;
          }
          await runAdapterPipeline({
            env, config, source: "shopify", destination: routedDestination,
            topic: canonical, webhookId, body, destinationConfig,
          });
          message.ack();
          continue;
        }
        // "orders/updated" still falls through to legacy until pipeline supports it.
      }

      // Legacy global flag (kept for staged-rollout testing). When "1", route
      // Shopify+IX through the adapter pipeline too. Defaults "0".
      if (env.DESTINATION_VIA_ADAPTER === "1") {
        const canonical = shopifyTopicToCanonical(topic);
        if (canonical) {
          await runAdapterPipeline({
            env, config, source: "shopify", destination: "invoicexpress",
            topic: canonical, webhookId, body,
          });
          message.ack();
          continue;
        }
      }

      switch (topic) {
        case "orders/created":
          await handleOrderCreated(env, config, webhookId, body);
          break;
        case "orders/updated":
          await handleOrderUpdated(env, config, webhookId, body);
          break;
        case "orders/paid":
          await handleOrderPaid(env, config, webhookId, body);
          break;
        case "refunds/create":
          await handleRefundCreate(env, config, webhookId, body);
          break;
        default:
          console.error(`[Rioko] Unknown topic: ${topic}`);
      }

      message.ack();
    } catch (e) {
      console.error(`[Rioko] Queue handler error for ${topic}:`, e);
      const { kind, severity, permanent } = classifyPipelineError(e);
      try {
        const appStorage = new AppStorage(env, shopDomain);
        if (webhookId) {
          await appStorage.markWebhookAsProcessed(webhookId, topic, "failed");
        }
        await appStorage.saveLog({
          shopify_domain: shopDomain,
          topic,
          payload: "",
          response: String(e),
          status: permanent ? 422 : 500,
        });
      } catch (logErr) {
        console.error("[Rioko] Failed to persist failure log:", logErr);
      }
      // Give up when the error is permanent, OR when a *stuck* transient error
      // (normalize service down, or a paid/refund whose invoice never gets
      // created) has burned enough attempts that more retries won't help. We
      // exempt destination_reject (likely a recoverable IX/Moloni 5xx outage),
      // which keeps the full retry budget. ~6 attempts ≈ 30min at 360s delay —
      // far cheaper than grinding to the DLQ.
      const attempts = message.attempts ?? 1;
      const giveUpTransient = !permanent && kind !== "destination_reject" && attempts >= TRANSIENT_GIVEUP_ATTEMPTS;
      if (permanent || giveUpTransient) {
        try {
          const rawOrder = message.body?.body as any;
          const externalId = String(rawOrder?.id ?? rawOrder?.order_number ?? "unknown");
          // Name the order (#1234) and end-client in the alert, and resolve the
          // owning merchant from shop_domain so the email isn't an anonymous id
          // dump. (config from the try-block is out of scope here — re-resolve.)
          const { orderRef, clientName } = describeOrder(rawOrder);
          let userId: string | undefined;
          let merchantName: string | undefined;
          try {
            const cfg = await new AppStorage(env, shopDomain).loadConfig();
            userId = cfg?.user_id ?? undefined;
          } catch { /* best-effort — email still goes to the ops team */ }
          merchantName = shopDomain ?? undefined;
          const orderLabel = orderRef ?? externalId;
          await reportIncident(env, {
            user_id: userId,
            // A stuck transient that gives up = an order that will NOT be invoiced.
            // Escalate to critical so it triggers the real-time ops alert, not just
            // the Friday digest (the gap that let the client find the incident first).
            severity: permanent ? severity : "critical",
            kind: permanent ? kind : "queue_retry_exhausted",
            summary: `${topic} ${orderLabel}${clientName ? ` — ${clientName}` : ""}: ${(e as any)?.message ?? String(e)}`.slice(0, 500),
            // `raw` carries the offending address-line-2 text so the merchant
            // email can quote the exact value instead of saying "invalid NIF".
            detail: { message: (e as any)?.message, http_status: httpStatusOf(e), raw: (e as any)?.raw, field: (e as any)?.field, orderRef, clientName, externalId, topic, shopDomain, attempts, permanent },
            affected_ids: [externalId],
            connection_label: "shopify → invoicexpress",
            merchant_name: merchantName,
            order_ref: orderRef,
            client_name: clientName,
          });
        } catch (incErr) {
          console.error("[Rioko] Failed to emit failure incident:", incErr);
        }
        message.ack();
      } else {
        message.retry({ delaySeconds: 360 });
      }
    }
  }
}

async function processStripeBatch(batch: MessageBatch<StripeQueueMessage>, env: Env) {
  for (const message of batch.messages) {
    const { topic, eventId, userId, bodyRef } = message.body;
    console.log(`[Stripe] Queue processing: ${topic} event=${eventId} user=${userId}`);

    try {
      // Hydrate the payload: small events travel inline as `body`; oversized ones
      // were spilled to KV by the webhook handler and arrive as a `bodyRef` key.
      let body = message.body.body;
      if (body === undefined && bodyRef) {
        const raw = await env.INVOICE_KV.get(bodyRef);
        if (!raw) throw new Error(`Stripe event payload missing from KV (${bodyRef})`);
        body = JSON.parse(raw);
      }

      // Stripe-source connection drives config + destination choice. We also
      // pull source_config_json so the adapter can use the restricted_key to
      // expand Customer.tax_ids for B2B native VAT collection.
      const connRow: any = await env.DB.prepare(
        `SELECT destination_kind, destination_config_json, behavior_json, source_config_json
         FROM connections WHERE user_id = ? AND source_kind = 'stripe' AND status = 'active' LIMIT 1`
      ).bind(userId).first();

      if (!connRow) {
        console.error(`[Stripe] No active connection for user ${userId}, acking`);
        message.ack();
        continue;
      }

      let sourceConfig: Record<string, any> | undefined;
      try {
        sourceConfig = connRow.source_config_json ? JSON.parse(connRow.source_config_json) : undefined;
      } catch {
        sourceConfig = undefined;
      }

      // Destination credentials (Moloni OAuth, Vendus API key, etc.) live here.
      // IX still reads from `legacy.integrations` so destination_config_json may
      // be NULL for IX-only connections.
      let destinationConfig: Record<string, any> | undefined;
      try {
        destinationConfig = connRow.destination_config_json ? JSON.parse(connRow.destination_config_json) : undefined;
      } catch {
        destinationConfig = undefined;
      }

      // Config resolution. IX-origin clients carry their behavior toggles in the
      // legacy `integrations` row. A Moloni/Vendus-only client (no Shopify/IX
      // history) has no such row — synthesize a minimal one (mirroring the
      // Lodgify poller) instead of dropping the event, which would leave a paid
      // order silently uninvoiced. Non-IX destinations store auto_finalize in the
      // connection's destination_config (the setup wizard writes it there), so
      // project it over the base — the pipeline reads config.auto_finalize.
      // (exemption_reason is read straight from destination_config by the Moloni
      // adapter.)
      const legacyRow: any = await env.DB.prepare(
        "SELECT * FROM integrations WHERE user_id = ?"
      ).bind(userId).first();

      // The connection's own settings, projected through the ONE function that
      // knows how to read them. This used to be hand-rolled here and copied
      // `auto_finalize` alone, which meant every other switch a merchant set on
      // their connection — the whole of migrations 0037 and 0038 — was written
      // to the database, shown as on in the console, and never reached a live
      // webhook. Measured on SenteMente 04/09/2026: a 13,00 € booking with
      // `stripe_routing_hints` on was invoiced into the default document set,
      // because the flag never arrived and the hints its rule matches on were
      // therefore never built.
      //
      // synthLegacyConfig for the fallback, for the same reason: it defines
      // every flag the pipeline reads, and the inline object here defined four.
      const legacy: any = legacyRow ?? synthLegacyConfig(userId);
      projectConnectionBehaviour(legacy, destinationConfig);
      applyConnectionEmailPref(legacy, destinationConfig);

      await runAdapterPipeline({
        env,
        config: legacy,
        source: "stripe",
        destination: connRow.destination_kind ?? "invoicexpress",
        topic,
        webhookId: eventId,
        body,
        sourceConfig,
        destinationConfig,
      });

      // Defense: ensure the row never lingers in `processing`. The pipeline marks
      // success on its own paths, but a path that returns without marking would
      // otherwise leave a stuck row; re-marking is idempotent (INSERT OR REPLACE).
      try { await new AppStorage(env).markWebhookAsProcessed(eventId, `stripe/${topic}`, "success"); } catch { /* best-effort */ }

      message.ack();
    } catch (e) {
      console.error(`[Stripe] Queue handler error for event ${eventId}:`, e);
      const { permanent } = classifyPipelineError(e);
      try {
        const appStorage = new AppStorage(env);
        if (eventId) {
          await appStorage.markWebhookAsProcessed(eventId, `stripe/${topic}`, "failed");
        }
        await appStorage.saveLog({
          shopify_domain: null,
          topic: `stripe/${topic}`,
          payload: "",
          response: String(e),
          status: permanent ? 422 : 500,
        });
      } catch (logErr) {
        console.error("[Stripe] Failed to persist failure log:", logErr);
      }
      // Stripe always routes via runAdapterPipeline, which reports its own
      // incidents and returns (no throw) on permanent failures. Anything
      // reaching this catch with permanent=true is an outlier (DB lookup,
      // unknown kind) — ack to stop the retry storm; transient retries.
      if (permanent) message.ack();
      else message.retry({ delaySeconds: 360 });
    }
  }
}

/**
 * Dead-letter queue consumer. Every message that exhausted its retries
 * (25 for Shopify, 10 for Stripe) lands here. We emit a critical incident
 * so the merchant — and Rioko ops — get an immediate notification rather
 * than the failure dying silently. We do NOT re-throw / re-retry: this IS
 * the terminal state.
 */
async function processDeadLetterBatch(batch: MessageBatch<any>, env: Env) {
  for (const message of batch.messages) {
    const body = message.body ?? {};
    // Best-effort key extraction (message shape varies by source queue).
    const sourceQueue: string =
      body?.eventId ? "stripeeventsqueue"
      : body?.shopDomain ? "shopifyordersqueue"
      : "unknown";
    // The affected id must be the SALE the merchant can look up — the payment
    // intent / order — never the Stripe *event* id. `evt_…` exists in no
    // invoice table, so an incident carrying it can never be verified as
    // resolved and nags in the weekly digest until the 90-day window expires
    // (seen live: a refund whose credit note DID get issued still reported as
    // "por emitir" for weeks). Fall back to the event id only when the body was
    // spilled to KV and we have nothing else.
    const stripeSaleId = sourceQueue === "stripeeventsqueue" && body?.body
      ? externalIdFromEvent(body.body)
      : "";
    const externalId: string = String(stripeSaleId || body?.eventId || body?.body?.id || body?.body?.order_number || "unknown");
    const eventId: string | null = body?.eventId ? String(body.eventId) : null;
    const topic: string = String(body?.topic ?? "unknown");
    const shopDomain: string | null = body?.shopDomain ?? null;

    // Resolve owning user_id when possible so the incident lands in the
    // right merchant's inbox. Stripe path stores it on the message; Shopify
    // path needs a config lookup by shop_domain.
    let userId: string | undefined = body?.userId;
    if (!userId && shopDomain) {
      try {
        const appStorage = new AppStorage(env, shopDomain);
        const cfg = await appStorage.loadConfig();
        userId = cfg?.user_id;
      } catch (e) {
        console.warn("[DLQ] Could not resolve user_id from shop_domain:", e);
      }
    }

    console.error(`[DLQ] Terminal failure — source=${sourceQueue} topic=${topic} externalId=${externalId} userId=${userId ?? "unknown"}`);

    const { orderRef, clientName } = describeOrder(body?.body);
    const orderLabel = orderRef ?? externalId;

    // The queue tells us the retries ran out; it never says what they failed on.
    // Both write sites persisted the destination's own words before rethrowing,
    // so read them back — otherwise this, the loudest alert the platform sends,
    // is also the only one with nothing in it to act on.
    const lastError = await lookupLastEmissionError(env, externalId, { shopifyDomain: shopDomain, userId });

    try {
      await reportIncident(env, {
        user_id: userId,
        severity: "critical",
        kind: "queue_retry_exhausted",
        // A refund that dies in the DLQ leaves the SALE invoiced and the credit
        // note missing — saying "não foi facturada" there sends the merchant
        // hunting for an invoice that exists.
        summary: `Retries esgotadas em ${sourceQueue} (${topic}) para ${orderLabel}${clientName ? ` — ${clientName}` : ""}. ${
          topic.toLowerCase().includes("refund") ? "Nota de crédito NÃO foi emitida." : "Encomenda NÃO foi facturada."
        }${lastError ? ` Último erro do destino: ${lastError.message.slice(0, 200)}` : ""}`.slice(0, 500),
        detail: {
          sourceQueue, topic, orderRef, clientName, externalId, eventId, shopDomain,
          message: lastError?.message,
          http_status: lastError?.http_status,
          last_error_source: lastError?.source,
          last_error_at: lastError?.at,
          messageBody: JSON.stringify(body).slice(0, 1000),
        },
        affected_ids: [externalId],
        connection_label: sourceQueue === "stripeeventsqueue" ? "stripe → invoicexpress" : "shopify → invoicexpress",
        merchant_name: shopDomain ?? undefined,
        order_ref: orderRef,
        client_name: clientName,
      });
    } catch (e) {
      console.error("[DLQ] Failed to emit incident:", e);
    }

    // A sale that died of exhausted retries has no `create_failed` row when the
    // failures were transient — the pipeline only writes that event for
    // permanent ones. Without a row the timeline simply stops mid-story, which
    // is the failure mode this log exists to end. Recorded here, at the point
    // where "transient" has definitively become "never".
    if (!lastError && externalId !== "unknown") {
      await logDocumentEvent(env, {
        externalId,
        event: "create_failed",
        dedupKey: `create_failed:dlq:${externalId}`,
        userId,
        shopifyDomain: shopDomain,
        sourceKind: sourceQueue === "stripeeventsqueue" ? "stripe" : "shopify",
        actor: "dlq",
        summary: `As tentativas de processar ${topic} para ${orderLabel} esgotaram-se sem que o destino chegasse a aceitar o documento. Nenhum erro do destino ficou registado — a falha foi de transporte (rede, timeout ou indisponibilidade), não uma recusa.`,
        detail: { sourceQueue, topic, eventId },
      });
    }

    // ack() — do not bounce back to the DLQ. The incident is the record.
    message.ack();
  }
}

// ── Lodgify booking poller (cron) ─────────────────────────────────────────────
// Lodgify does not expose webhook registration to user-level API keys (partner
// OAuth only), so new-customer bookings never arrive via /webhooks/lodgify/*.
// This poll lists Booked bookings per active connection and drives the SAME
// pipeline the webhook uses (with a preloaded booking), deduped on the shared
// `lodgify/created` webhook-info key so a booking is invoiced at most once
// regardless of which path sees it first.

// First non-empty trimmed string among vals, or null. Used to pull the guest
// comment (where the NIF is typed) out of whichever field Lodgify carries it in.
// Normalize a v1 `/v1/reservation` item to the v2-shaped fields the poll, the
// invoice gate (bookingAmountDue) and the D1 mirror (upsertLodgifyBookings) were
// written against. The v1 list is the COMPLETE booking set (see
// listLodgifyBookings) but names its payment fields differently; alias them so
// nothing downstream needs to change:
//   amount_to_pay → amount_due   (outstanding balance; ≈0 ⇒ settled, incl. OTA
//                                 stays where Booking.com/Airbnb collected)
//   total_paid    → amount_paid
//   currency{code}→ currency_code (v1 nests currency as an object)
// Every original v1 field is preserved (status, guest.name/email, property_id,
// source, arrival/departure, created_at, rooms) — those already line up.
function normalizeLodgifyV1Item(v1: any): any {
  const cur = v1?.currency;
  const currency_code = typeof cur === "string" ? cur : (cur?.code ?? "EUR");
  return {
    ...v1,
    amount_due: firstNum(v1?.amount_to_pay, v1?.amount_due),
    amount_paid: firstNum(v1?.total_paid, v1?.amount_paid),
    currency_code,
  };
}

// List ALL Lodgify bookings for the account via the v1 `/v1/reservation`
// endpoint (offset/limit paging, exposes a `total`). We use v1 — NOT v2
// `/v2/reservations/bookings` — because the v2 list silently OMITS bookings
// (confirmed live: OTA reservations absent from v2 even with a wide
// updatedSince, which left them off conciliação AND un-invoiced). v1 returns the
// full set; each item is normalized to the v2 shape the rest of the poll reads.
// `trash=False` drops trashed bookings. Retries 429 with Retry-After backoff and
// paces pages; on exhaustion returns what it has rather than throwing (a
// background sync must never crash the whole poll over a transient limit).
async function listLodgifyBookings(apiKey: string, gateway: LodgifyGateway): Promise<any[]> {
  const out: any[] = [];
  const limit = 50;
  for (let page = 0; page < 40; page++) {
    const path = `/v1/reservation?offset=${page * limit}&limit=${limit}&trash=False`;
    let items: any[] | null = null;
    let lastFailure = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await lodgifyFetch(path, { apiKey, gateway });
      if (res.ok) {
        const raw = await res.text();
        let data: any = null;
        try { data = JSON.parse(raw); } catch { /* handled below */ }
        if (data == null) {
          // A 200 whose body isn't JSON is a bot/WAF challenge or an outage
          // page, NOT "this account has no bookings". Treating it as an empty
          // list is how a dead poll looks identical to an idle one.
          lastFailure = `200 with unparseable body: ${raw.slice(0, 120)}`;
          break;
        }
        items = Array.isArray(data?.items) ? data.items
          : Array.isArray(data) ? data
          : [];
        break;
      }
      lastFailure = `${res.status} ${res.statusText}`;
      // The RELAY failed, not Lodgify. Not a rate limit, will not heal by
      // backing off, and must not be read as an IP block — the remedy is our
      // box, not Lodgify. Name it so the incident says which.
      if (isGatewayFailure(res)) {
        throw new Error(
          `LODGIFY_RELAY_DOWN: ${describeLodgifyEgress(gateway)} → ${res.status} `
          + `(${res.headers.get(GATEWAY_ERROR_HEADER)})`,
        );
      }
      if (res.status === 429) {
        // Lodgify returns 429 for BOTH a transient rate limit and a permanent IP
        // block ("flagged as an unregistered API user requesting data for
        // multiple Lodgify end users"). Retrying the latter is pointless and it
        // needs a completely different response from us, so separate them here.
        // Which response depends on the egress: from a rotating Cloudflare
        // address the remedy is the relay; from the ALLOWLISTED relay IP it
        // means the allowlist itself was revoked — stop polling and talk to
        // Lodgify. `relayed` is carried into the message for exactly that.
        const blockBody = await res.text().catch(() => "");
        if (/unregistered API user|lodgify\.com\/partners|has been blocked/i.test(blockBody)) {
          throw new Error(
            `LODGIFY_IP_BLOCKED via ${describeLodgifyEgress(gateway)}: ${blockBody.slice(0, 300)}`,
          );
        }
        const ra = Number(res.headers.get("retry-after"));
        await delay(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 6000) : 700 * (attempt + 1));
        continue;
      }
      console.error(`[LodgifyPoll] v1 list ${res.status} ${res.statusText}`);
      break;
    }
    // Never return a short list as if it were the truth. Page 0 failing means we
    // know nothing about this account — throw so the caller reports an incident
    // instead of silently "finding no bookings" (the failure mode that let the
    // poll look healthy while fetching nothing at all). A later page failing
    // would silently truncate the set, which the invoice loop would read as
    // "these bookings no longer exist", so treat it the same way.
    if (items == null) {
      throw new Error(`Lodgify v1 list failed at offset ${page * limit}: ${lastFailure || "no response"}`);
    }
    for (const it of items) out.push(normalizeLodgifyV1Item(it));
    if (items.length < limit) break;
    await delay(250); // pace pages to avoid re-tripping the rate limit
  }
  return out;
}

// Emit one instalment (partial) invoice for a booking via the destination
// adapter, billing only `deltaAmount` under a distinct reference "Order #N-seq"
// and a "parcela" note. Respects tag-routing (series/doc-type) the same way the
// standard pipeline does. Idempotent: dedups on the reference at the destination
// so a crash between create and record doesn't duplicate.
async function emitLodgifyPartialInvoice(env: Env, o: {
  config: any;
  sourceCfg: Record<string, any>;
  destinationConfig: Record<string, any> | undefined;
  destination: any;
  productMappings: Map<string, number> | undefined;
  tagRoutingRules: import("./services/tag-routing").TagRoutingRule[];
  bookingItem: any;
  bookingId: string;
  seq: number;
  deltaAmount: number;
  totalAmount: number;
}): Promise<string> {
  const orderNum = Number(String(o.bookingId).replace(/\D/g, "").slice(-12)) || 0;
  const reference = partialSaleReference(orderNum, o.seq);
  const pct = o.totalAmount > 0 ? Math.round((o.deltaAmount / o.totalAmount) * 100) : 0;
  const note = o.seq > 1
    ? `Parcela ${o.seq} — ${pct}% da reserva LOD-${o.bookingId} (ref. ${saleReference(orderNum)}; 1ª parcela: ${partialSaleReference(orderNum, 1)})`
    : `Parcela ${o.seq} — ${pct}% da reserva LOD-${o.bookingId} (ref. ${saleReference(orderNum)})`;

  const sourceAdapter = getSourceAdapter("lodgify");
  const destAdapter = getDestinationAdapter(o.destination);

  let ctx: any = {
    apiKey: env.NORMALIZE_SHOPIFY_ORDER_API_KEY,
    config: o.config,
    sourceConfig: o.sourceCfg,
    destinationConfig: o.destinationConfig,
    productMappings: o.productMappings,
  };

  // Normalize the v2 item to the shape LodgifySource reads (maps total_amount →
  // total, rooms[].room_type_id, keeps property_id/source for tag-routing). The
  // _partial.amount then overrides the gross with this instalment's delta.
  // `data.bookingId` is REQUIRED: LodgifySource.externalId() reads booking.id /
  // data.bookingId / bookingId and throws without one. Omitting it made every
  // progressive invoice throw "Lodgify webhook missing booking.id /
  // data.bookingId" before it reached the destination — the standard path has
  // always sent it, this path never did, and the swallowed catch meant
  // progressive invoicing failed 100% of the time in silence.
  const body = {
    event: "booking_new_status_booked",
    data: { bookingId: o.bookingId },
    _preloaded_booking: toPreloadedFromItem(o.bookingItem),
    _partial: { seq: o.seq, amount: o.deltaAmount, reference, note },
  };
  const normalized = await sourceAdapter.toNormalized(body, ctx);
  if (!normalized) throw new Error(`[LodgifyPoll] partial normalize failed for ${o.bookingId} seq ${o.seq}`);

  // Tag routing — route this instalment to the property's series / doc type.
  // Shares applyTagRoute with generic-pipeline.ts; this used to be a private
  // copy that only handled Moloni and only understood the `_draft` suffix.
  const tagMatch = matchTagRouting(normalized.order, o.tagRoutingRules);
  if (tagMatch) ctx = applyTagRoute(ctx, o.destination, normalizeRule(tagMatch));

  // Idempotency: if this instalment's reference already exists at the
  // destination (crash after create, before we recorded it), reuse it.
  if (destAdapter.findByReference) {
    const found = await destAdapter.findByReference(reference, ctx);
    if (found) return found.id;
  }

  const { invoiceId } = await destAdapter.createDraft(normalized, ctx);
  await logDocumentEvent(env, {
    externalId: String(o.bookingId),
    event: "built",
    dedupKey: `built:${invoiceId}`,
    invoiceId,
    userId: o.config?.user_id ?? null,
    shopifyDomain: null,
    sourceKind: "lodgify",
    destinationKind: String(o.destination),
    actor: "cron:lodgify-poll",
    summary: `Documento ${invoiceId} emitido por ${o.deltaAmount.toFixed(2)} € — parcela ${o.seq} da reserva LOD-${o.bookingId}, referência ${reference}.`,
    detail: {
      intent: {
        total: Number.isFinite(o.deltaAmount) ? o.deltaAmount : null,
        reference,
        exemptionCode: null,
      },
      seq: o.seq,
    },
  });
  if (ctx.config?.auto_finalize === 1) {
    try {
      await destAdapter.finalize(invoiceId, ctx);
      await logDocumentEvent(env, {
        externalId: String(o.bookingId),
        event: "finalized",
        dedupKey: `finalized:${invoiceId}`,
        invoiceId,
        userId: o.config?.user_id ?? null,
        shopifyDomain: null,
        sourceKind: "lodgify",
        destinationKind: String(o.destination),
        actor: "cron:lodgify-poll",
        summary: `Documento ${invoiceId} (parcela ${o.seq} da reserva LOD-${o.bookingId}) fechado no destino.`,
      });
    } catch (e: any) {
      // The document EXISTS and is recorded — rethrowing here would make the
      // caller believe the instalment was never billed and bill it again on the
      // next poll. So the create stands and the finalize failure is escalated
      // instead of being a console line nobody reads: the merchant is left with
      // a draft that will never certify itself, which is exactly the shape of
      // failure this integration keeps being bitten by.
      const detail = String(e?.message ?? e).slice(0, 400);
      console.error(`[LodgifyPoll] finalize partial ${reference} failed: ${detail}`);
      await reportIncident(env, {
        user_id: o.config?.user_id ?? null,
        severity: "error",
        kind: "destination_reject",
        dedup_key: String(invoiceId),
        summary: `A prestação ${reference} da reserva ${o.bookingId} foi emitida (documento ${invoiceId}) mas ficou por fechar: ${detail}`,
        detail: { booking_id: o.bookingId, seq: o.seq, reference, invoiceId, error: detail },
        affected_ids: [String(o.bookingId)],
        connection_label: `lodgify → ${o.destination}`,
        order_ref: `#${o.bookingId}`,
        bucket: "daily",
      });
    }
  }
  return invoiceId;
}

/**
 * Take back the documents issued for a booking that has since been cancelled.
 *
 * The merchant's objection, in their words: "até lá podem ainda ser canceladas e
 * depois já temos as faturas emitidas." Waiting for the payment to be recorded
 * (see `bookingCollectedAmount`) makes this rare, but not impossible — a guest
 * can still cancel a stay that was already paid and billed, and the fleet has
 * older documents issued under the previous rule.
 *
 * Drafts are deleted outright: nothing fiscal has happened to them, so removing
 * one is a clean undo. A FINALIZED document is never touched — it is AT-hashed
 * and only a credit note can undo it, which is a decision with a human on the
 * other end of it, so that raises an incident instead.
 *
 * Returns true when something was actually reversed.
 */
async function reverseCancelledLodgifyBooking(env: Env, o: {
  userId: string;
  bookingId: string;
  connLabel: string;
  destination: DestinationKind;
  config: any;
  sourceCfg: Record<string, any>;
  destinationConfig: Record<string, any> | undefined;
}): Promise<boolean> {
  const r = await takeBackLodgifyDocuments(env, { ...o, dryRun: false });
  if (r.invoiceIds.length === 0) return false;

  if (r.finalized.length > 0) {
    await reportIncident(env, {
      user_id: o.userId,
      severity: "error",
      kind: "booking_cancelled_after_invoice",
      summary: `Reserva ${o.bookingId} foi cancelada mas ${r.finalized.length} documento(s) já estão finalizados — é preciso emitir nota de crédito manualmente.`,
      detail: { booking_id: o.bookingId, finalized: r.finalized, deleted: r.deleted },
      affected_ids: [o.bookingId],
      connection_label: o.connLabel,
      order_ref: `#${o.bookingId}`,
      // The poll runs every 30 min and a finalized document stays finalized, so
      // this condition re-fires forever until a human issues the credit note.
      // Daily bucket = one reminder a day, not 48.
      bucket: "daily",
    });
  } else {
    console.log(`[LodgifyPoll] booking ${o.bookingId} cancelled — removed ${r.deleted.length} draft(s)`);
  }
  return true;
}


interface LodgifyPollResult {
  connections: number; scanned: number; invoiced: number; skipped: number; failed: number; synced: number;
  /** Documents taken back because their booking was cancelled after we billed it. */
  reversed: number;
  /** Payments recorded against already-certified documents (Moloni Recibos). */
  settled: number;
  /** Documents a guard refused and parked for a human. Silence here is the point. */
  settleBlocked: number;
  settleErrors: number;
  /**
   * Dry-run only: the bookings this run WOULD have billed, in the order it would
   * have billed them. Exists so a caller outside the Worker (the Lodgify feeder,
   * which fetches the list from a non-blocked network) can learn which handful of
   * bookings is worth enriching with a per-booking detail call — without
   * reimplementing a single settlement rule on its side.
   */
  wouldInvoice?: Array<{ booking_id: string; path: "standard" | "partial"; seq?: number; amount: number }>;
}

/**
 * Has this connection ever actually issued an invoice?
 *
 * Distinguishes two states the gate treats identically: a merchant who was
 * invoicing and went dark (a regression — alert), versus one who has never
 * issued anything and is simply awaiting activation under pay-to-activate
 * (expected — alerting daily on it is pure noise). Pre-existing external markers
 * in lodgify_partial_invoices carry invoice_id NULL and don't count.
 *
 * Errs toward `true` on failure: the point of this whole path is to stop being
 * silent, so an unknown state should alert rather than swallow.
 */
async function hasEverInvoiced(env: Env, userId: string): Promise<boolean> {
  try {
    const processed: any = await env.DB.prepare(
      "SELECT 1 AS hit FROM processed_orders WHERE user_id = ? LIMIT 1"
    ).bind(userId).first();
    if (processed?.hit) return true;
    const partial: any = await env.DB.prepare(
      "SELECT 1 AS hit FROM lodgify_partial_invoices WHERE user_id = ? AND invoice_id IS NOT NULL LIMIT 1"
    ).bind(userId).first();
    return !!partial?.hit;
  } catch {
    return true;
  }
}

export interface LodgifyPollOptions {
  /** Restrict the run to one connection. */
  userId?: string;
  /**
   * RAW v1 `/v1/reservation` items, used INSTEAD of fetching from Lodgify.
   * Requires userId. Recovery lever for when Lodgify rate-limits the Worker's
   * egress (it 429s Cloudflare's shared IPs while the same key succeeds from
   * elsewhere) — the caller fetches the list from a working network and the
   * worker still runs the real normalization, cutoff, dedup and invoice logic,
   * so nothing fiscal is reimplemented outside this code path.
   */
  bookings?: any[];
  /**
   * Sync and decide, but issue nothing: the mirror is still refreshed (that half
   * is safe and is the whole point of a sync), every gate still runs, and the
   * bookings that would have been billed come back in `wouldInvoice` instead of
   * becoming documents. Cancellation reversal is skipped too — it DELETES
   * documents, which is not a dry run by any reading.
   */
  dryRun?: boolean;
}

async function pollLodgifyBookings(env: Env, opts: LodgifyPollOptions = {}): Promise<LodgifyPollResult> {
  const result: LodgifyPollResult = {
    connections: 0, scanned: 0, invoiced: 0, skipped: 0, failed: 0, synced: 0, reversed: 0,
    settled: 0, settleBlocked: 0, settleErrors: 0,
  };
  const dryRun = !!opts.dryRun;
  if (dryRun) result.wouldInvoice = [];

  // Resolved once: every connection in this run leaves by the same door, and a
  // missing gateway config should stop the run here rather than have each
  // connection decide for itself. Throws when the egress is misconfigured —
  // deliberately, see resolveLodgifyGateway.
  const gateway = resolveLodgifyGateway(env);
  const egress = describeLodgifyEgress(gateway);

  const baseSql =
    `SELECT id, user_id, source_config_json, destination_kind, destination_config_json, invoice_cutoff
     FROM connections WHERE source_kind = 'lodgify' AND status = 'active'`;
  const conns = opts.userId
    ? await env.DB.prepare(`${baseSql} AND user_id = ?`).bind(opts.userId).all()
    : await env.DB.prepare(baseSql).all();
  const rows = (conns?.results ?? []) as any[];

  for (const conn of rows) {
    result.connections++;

    let sourceCfg: Record<string, any> = {};
    try { sourceCfg = conn.source_config_json ? JSON.parse(conn.source_config_json) : {}; } catch { /* ignore */ }
    // Connection-level failures below use a DAILY bucket: the poll runs every
    // 30 min, so an hourly bucket would email 24×/day for one dead connection.
    // Daily = one alert per day until it's fixed.
    const connLabel = `lodgify → ${conn.destination_kind ?? "moloni"}`;

    const apiKey = sourceCfg.api_key;
    if (!apiKey) {
      console.warn(`[LodgifyPoll] user ${conn.user_id}: no api_key in source_config — skipping`);
      await reportIncident(env, {
        user_id: conn.user_id,
        severity: "critical",
        kind: "auth_failure_source",
        summary: "Ligação Lodgify sem chave de API — nenhuma reserva pode ser facturada.",
        connection_label: connLabel,
        bucket: "daily",
      });
      continue;
    }

    let destinationConfig: Record<string, any> | undefined;
    try { destinationConfig = conn.destination_config_json ? JSON.parse(conn.destination_config_json) : undefined; } catch { destinationConfig = undefined; }

    // Don't invoice bookings created before the connection's cutoff (the
    // subscription start date, stamped when the account activates by payment).
    // NULL cutoff = invoice everything (existing behaviour).
    const cutoffMs = conn.invoice_cutoff ? Date.parse(String(conn.invoice_cutoff)) : null;

    // Same synthesized legacy config + subscription gate the webhook route uses.
    const legacy: any = (await env.DB.prepare("SELECT * FROM integrations WHERE user_id = ?").bind(conn.user_id).first()) ?? {
      user_id: conn.user_id,
      shopify_domain: null,
      auto_finalize: destinationConfig?.auto_finalize ? 1 : 0,
      b2b_reverse_charge: 0,
      ix_send_email: 0,
    };
    applyConnectionEmailPref(legacy, destinationConfig);
    const gate = await checkSubscriptionGate(env, legacy);
    if (!gate.allowed) {
      console.warn(`[LodgifyPoll] user ${conn.user_id}: subscription gate blocked (${gate.reason}) — skipping`);
      // Previously console-only: a merchant that WAS invoicing and goes dark
      // because its subscription lapsed did so in total silence. Alert on that.
      // A connection that never issued anything is awaiting activation
      // (pay-to-activate) — an expected state, not an incident.
      if (await hasEverInvoiced(env, conn.user_id)) {
        await reportIncident(env, {
          user_id: conn.user_id,
          severity: "critical",
          kind: "subscription_inactive",
          summary: `Subscrição inactiva (${gate.reason}). Reservas Lodgify deixaram de ser facturadas.`,
          connection_label: connLabel,
          bucket: "daily",
        });
      }
      continue;
    }

    // Full-list sync from Lodgify v1 (`/v1/reservation`). v1 has no reliable
    // updated-since filter (its `updated_at` is frequently unset), and the list
    // is small enough (a few offset pages) to pull whole each poll — the upsert
    // is idempotent and the invoice loop dedups, so re-seeing a booking is cheap.
    // Pulling the full v1 set is what makes EVERY booking reach the mirror /
    // conciliação; the old v2 list silently dropped some.
    let bookings: any[];
    if (opts.bookings && opts.userId === conn.user_id) {
      // Caller supplied the raw v1 list; normalize it exactly as the fetch path
      // does so every downstream rule behaves identically.
      bookings = opts.bookings.map(normalizeLodgifyV1Item);
      console.log(`[LodgifyPoll] user ${conn.user_id}: using ${bookings.length} caller-supplied booking(s)`);
    } else try {
      bookings = await listLodgifyBookings(apiKey, gateway);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      console.error(`[LodgifyPoll] user ${conn.user_id}: list failed: ${msg}`);
      await reportLodgifyFetchFailure(env, {
        userId: conn.user_id, connLabel, message: msg, egress, relayed: gateway.relayed,
      });
      continue;
    }

    // Mirror every fetched booking into D1 so the conciliação view reads locally
    // (no Lodgify call on page load → no 429). Best-effort: a sync failure must
    // not stop invoicing.
    try {
      const synced = await new AppStorage(env, null, conn.user_id).upsertLodgifyBookings(conn.user_id, bookings);
      result.synced += synced;
    } catch (e: any) {
      console.error(`[LodgifyPoll] user ${conn.user_id}: booking sync failed: ${e?.message ?? e}`);
    }

    const storageTopic = "lodgify/created";
    const destination = (conn.destination_kind as any) ?? "moloni";

    // Progressive (instalment) invoicing — opt-in per connection. When on, a
    // booking is invoiced for each newly-paid amount (e.g. 50% deposit, then
    // 50% balance) under distinct references, instead of once at 100% paid.
    // Read through `partialModeFrom` rather than the raw boolean so the poll and
    // the admin paths cannot disagree about which mode a connection is on — and
    // so a connection moved to `invoice_plus_receipts` stops instalment-billing
    // even if the old boolean is still sitting in its config.
    const partialMode = partialModeFrom(destinationConfig);
    const partialEnabled = partialMode === "instalment_invoices" && destination === "moloni";
    // Bookings already billed as instalments, for a connection that has since
    // moved to `invoice_plus_receipts`.
    //
    // They must STAY on the instalment path. The instalment ledger lives in
    // `lodgify_partial_invoices` and is invisible to the standard path's dedup
    // (which reads processed_orders and the webhook marker), so letting them
    // fall through would issue a second document for the WHOLE total of a stay
    // that already has documents for part of it — 23 bookings and 23.160,01 €
    // of them on the one connection this applies to. Skipping them instead
    // would be the opposite fault: the next instalment would never be billed.
    const legacyInstalmentBookings = partialMode === "invoice_plus_receipts" && destination === "moloni"
      ? await new AppStorage(env, null, conn.user_id).listBookingIdsWithPartials(conn.user_id)
      : new Set<string>();
    // Opt-in per connection: bill an OTA stay once it has happened, for hosts
    // whose channel money never reaches Lodgify and who therefore have nothing
    // to mark as paid. Deliberately not applied to the progressive path — that
    // one bills recorded amounts, and there are none to instal.
    const otaPolicy = otaPolicyFrom(destinationConfig);
    const partialCtx = partialEnabled || legacyInstalmentBookings.size > 0
      ? {
          productMappings: await loadProductMappings(env, conn.user_id, "lodgify").catch(() => undefined),
          tagRoutingRules: await loadTagRoutingRules(env, conn.user_id, "lodgify", destination).catch(() => []),
        }
      : null;

    for (const item of bookings) {
      const status = String(item?.status ?? "").toLowerCase();
      const bookingId = String(item?.id ?? item?.booking_id ?? item?.reservation_id ?? "");
      if (!bookingId) continue;

      // A booking that stopped being "Booked" after we billed it must have that
      // document taken back. The declined → credit-note branch lives on the
      // Lodgify webhook, which never fires here (user API keys cannot register
      // webhooks — partner OAuth only), so before this the poll simply skipped
      // cancelled bookings and left their documents standing forever.
      if (status !== "booked") {
        // Reversal deletes drafts and clears markers — never on a dry run.
        if (!dryRun && (status === "declined" || status === "cancelled" || status === "canceled")) {
          const reversed = await reverseCancelledLodgifyBooking(env, {
            userId: conn.user_id, bookingId, connLabel, destination,
            config: legacy, sourceCfg, destinationConfig,
          });
          if (reversed) result.reversed++;
        }
        continue;
      }
      result.scanned++;
      const appStorage = new AppStorage(env, null, conn.user_id);

      // Retroactive-invoicing guard: never invoice bookings created before the
      // connection's cutoff (the subscription start date). The mirror already
      // stored them for reconciliação; we simply don't bill pre-subscription
      // history. Covers both the progressive and standard paths below.
      if (cutoffMs != null && Number.isFinite(cutoffMs)) {
        const createdMs = Date.parse(String(item?.created_at ?? ""));
        if (Number.isFinite(createdMs) && createdMs < cutoffMs) { result.skipped++; continue; }
      }

      // ── Progressive path: bill each newly-paid delta ──────────────────────
      // Either the connection is on instalments, or it has moved off them and
      // this booking is one of the ones left mid-ledger (see above).
      const useProgressive = partialEnabled || legacyInstalmentBookings.has(bookingId);
      if (useProgressive && partialCtx) {
        const total = Number(item?.total_amount ?? 0);
        // Money recorded in Lodgify is the only trigger. For OTA stays the
        // merchant marks the booking paid by hand once the channel pays out;
        // until then there is nothing to bill. Reading amount_due==0 as "paid"
        // is what billed a fleet of future reservations.
        const { collected: paid, basis } = bookingCollectedAmount(item);
        if (paid <= 0.01) {
          console.log(`[LodgifyPoll] booking ${bookingId} held (${basis})`);
          result.skipped++; continue;
        }
        const partials = await appStorage.getPartialInvoices(conn.user_id, bookingId);
        // Transition guard: a booking already invoiced by the STANDARD flow
        // lives under processed_orders / "Order #N" — the instalment dedup
        // ("Order #N-seq") wouldn't see it, so billing it progressively would
        // DUPLICATE. Leave those to the old flow; only bookings with no prior
        // standard invoice (or already mid-instalment) go progressive.
        if (partials.length === 0) {
          const standard = await appStorage.getInvoiceByOrderId(bookingId);
          if (standard?.invoice_id) { result.skipped++; continue; }
        }
        const already = partials.reduce((s, p) => s + p.invoiced_amount, 0);
        const delta = Math.round((paid - already) * 100) / 100;
        if (delta <= 0.01) { result.skipped++; continue; }             // no new payment to bill
        const seq = partials.length + 1;
        if (dryRun) {
          result.wouldInvoice!.push({ booking_id: bookingId, path: "partial", seq, amount: delta });
          continue;
        }
        try {
          const invoiceId = await emitLodgifyPartialInvoice(env, {
            config: legacy, sourceCfg, destinationConfig, destination,
            productMappings: partialCtx.productMappings, tagRoutingRules: partialCtx.tagRoutingRules,
            bookingItem: item, bookingId, seq, deltaAmount: delta, totalAmount: total,
          });
          const orderNum = Number(String(bookingId).replace(/\D/g, "").slice(-12)) || 0;
          await appStorage.upsertPartialInvoice(conn.user_id, bookingId, seq, invoiceId, delta, partialSaleReference(orderNum, seq));
          result.invoiced++;
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          console.error(`[LodgifyPoll] user ${conn.user_id}: partial invoice failed for ${bookingId} seq ${seq}: ${msg}`);
          // The progressive path calls emitLodgifyPartialInvoice directly rather
          // than runAdapterPipeline, so it never inherited the pipeline's incident
          // reporting — every failure here was swallowed into a counter. Report it
          // the same way the standard path does.
          const { kind, severity } = classifyPipelineError(e);
          await reportIncident(env, {
            user_id: conn.user_id,
            severity,
            kind,
            summary: `Factura progressiva falhou para a reserva ${bookingId} (prestação ${seq}): ${msg}`.slice(0, 500),
            detail: { booking_id: bookingId, seq, delta, error: msg },
            affected_ids: [bookingId],
            connection_label: connLabel,
            order_ref: `#${bookingId}`,
          });
          result.failed++;
        }
        continue;
      }

      // ── Standard path: one document for the whole total, so it may only fire
      // once the WHOLE total is collected. Same settlement rule as the
      // progressive path above — the two must never disagree about whether a
      // booking has been paid for, only about how many documents that produces.
      // `otaPolicy` (opt-in per connection) additionally accepts an OTA stay
      // that has already happened: the channel collected the money and it never
      // passes through Lodgify, so there is no payment for the merchant to
      // record. Off everywhere it is not configured.
      // `invoice_plus_receipts` is the exception, and only for a stay with money
      // already recorded against it: the whole stay is invoiced as a Fatura (a
      // debt, not a payment) and each payment is then receipted against it by
      // /admin/lodgify/settle-receipts. Holding it here would leave the merchant
      // with a deposit in the bank and nothing issued for the stay.
      const pollSettlement = bookingCollectedAmount(item);
      const receiptsModeBillable = partialMode === "invoice_plus_receipts"
        && pollSettlement.basis === "instalment";
      if (!receiptsModeBillable && !isBookingFullyCollected(item, otaPolicy)) {
        console.log(`[LodgifyPoll] booking ${bookingId} held (${pollSettlement.basis})`);
        result.skipped++; continue;
      }

      // Shared dedup with the webhook path — invoice a booking at most once.
      const { isProcessed, state } = await appStorage.isWebhookProcessed(bookingId, storageTopic);
      if (isProcessed && state !== "failed") { result.skipped++; continue; }

      // Defensive dedup: the v1 list surfaces bookings the old v2 list omitted —
      // some already invoiced out-of-band (a manual admin re-emit, or a run whose
      // webhook_info write was lost). If an invoice is already mapped for this
      // booking, don't create a second one; heal the processed marker instead.
      const existingInvoice = await appStorage.getInvoiceByOrderId(bookingId);
      if (existingInvoice?.invoice_id) {
        await appStorage.markWebhookAsProcessed(bookingId, storageTopic, "success");
        result.skipped++; continue;
      }

      if (dryRun) {
        result.wouldInvoice!.push({ booking_id: bookingId, path: "standard", amount: Number(item?.total_amount ?? 0) });
        continue;
      }

      await appStorage.markWebhookAsProcessing(bookingId, storageTopic);
      const body = { event: "booking_new_status_booked", data: { bookingId }, _preloaded_booking: toPreloadedFromItem(item) };
      try {
        await runAdapterPipeline({
          env,
          config: legacy,
          source: "lodgify",
          destination,
          topic: "created" as any,
          webhookId: bookingId,
          body,
          sourceConfig: sourceCfg,
          destinationConfig,
        });
        await appStorage.markWebhookAsProcessed(bookingId, storageTopic, "success");
        result.invoiced++;
      } catch (e: any) {
        console.error(`[LodgifyPoll] user ${conn.user_id}: pipeline failed for booking ${bookingId}: ${e?.message ?? e}`);
        await appStorage.markWebhookAsProcessed(bookingId, storageTopic, "failed");
        result.failed++;
      }
    }

    // Record the money on documents that are already certified.
    //
    // Here, and not on a cron of its own, because this pass needs exactly what
    // the loop above just fetched: how much Lodgify says has come in, and
    // whether the stay is still Booked. Reading that back from the mirror would
    // work on a good day and settle a cancelled booking on a bad one — and if
    // the Lodgify list failed, this connection already `continue`d long before
    // here, so there is no version of this that runs on stale numbers.
    //
    // After the billing loop, wrapped, and capped: a settlement failure must
    // never cost an invoice, and whatever is deferred is picked up in 30 minutes.
    if (!dryRun && destination === "moloni" && partialMode === "invoice_plus_receipts"
        && env.LODGIFY_SETTLE_AUTO === "1") {
      try {
        const settle = await settleLodgifyReceipts(env, {
          userId: conn.user_id,
          destination,
          config: projectConnectionBehaviour(legacy, destinationConfig),
          sourceCfg,
          destinationConfig,
          connLabel,
          items: bookings,
          dryRun: false,
          limit: Number.isFinite(Number(env.LODGIFY_SETTLE_MAX_DOCS))
            && String(env.LODGIFY_SETTLE_MAX_DOCS ?? "").trim() !== ""
            ? Number(env.LODGIFY_SETTLE_MAX_DOCS)
            : undefined,
          actor: "cron:lodgify-poll",
        });
        result.settled += settle.settled;
        result.settleBlocked += settle.blocked;
        result.settleErrors += settle.errors;
        if (settle.settled > 0 || settle.errors > 0 || settle.blocked > 0) {
          console.log(`[LodgifyPoll] user ${conn.user_id}: settled ${settle.settled}, blocked ${settle.blocked}, errors ${settle.errors}`);
        }
      } catch (e: any) {
        result.settleErrors++;
        console.error(`[LodgifyPoll] user ${conn.user_id}: settlement pass failed: ${String(e?.message ?? e)}`);
      }
    }

    // Backlog check — runs after the mirror is fresh for this connection.
    await reportLodgifyBacklog(env, conn.user_id, conn.invoice_cutoff, connLabel, otaPolicy);

    // Record that ingestion actually completed for this connection. Deliberately
    // NOT on dry runs: the feeder's cycle is dry-then-real, so marking the dry
    // half would keep the light green while every real run failed.
    if (!dryRun) await markLodgifyIngest(env, conn.user_id);
  }

  return result;
}

/**
 * Report a failure to obtain the booking list from Lodgify.
 *
 * One path now: this Worker's own fetch, through the egress relay. The external
 * feeder that used to share this (and the two admin routes that served it, one
 * of which handed out every merchant's plaintext API key) is gone — a second,
 * unallowlisted IP pulling several end users' bookings is the exact behaviour
 * Lodgify's block text names, so it could not survive the relay.
 */
async function reportLodgifyFetchFailure(
  env: Env,
  o: { userId: string; connLabel: string; message: string; egress?: string; relayed?: boolean },
): Promise<void> {
  // A rejected key is permanent until re-authed; anything else is likely a
  // transient Lodgify outage that the next poll clears. Both used to be
  // console-only, so a revoked key looked identical to "nothing to do".
  const isRelayDown = o.message.includes("LODGIFY_RELAY_DOWN");
  const isBlocked = o.message.includes("LODGIFY_IP_BLOCKED")
    || /unregistered API user|lodgify\.com\/partners|has been blocked/i.test(o.message);
  const isAuth = /\b(401|403)\b|unauthorized|forbidden|invalid api key/i.test(o.message);

  // An alert that names the wrong action is worse than no alert. A block on a
  // rotating Cloudflare address and a block on the ALLOWLISTED relay IP look
  // identical in the response body and have opposite remedies, so branch on
  // which egress actually made the call.
  const blockedSummary = o.relayed
    ? `Lodgify bloqueou o IP FIXO do relay (${o.egress ?? "relay"}). O allowlist foi revogado: PARAR o polling e falar com o suporte da Lodgify. NÃO trocar de IP.`
    : "Lodgify BLOQUEOU o IP do servidor: integrador não registado como parceiro. Nenhuma reserva pode ser sincronizada até registar em lodgify.com/partners.";

  await reportIncident(env, {
    user_id: o.userId,
    severity: isRelayDown || isBlocked || isAuth ? "critical" : "error",
    // A dead relay is ours to fix, not a credentials problem and not Lodgify's.
    kind: isRelayDown ? "lodgify_relay_down" : "auth_failure_source",
    summary: isRelayDown
      ? `O relay de saída da Lodgify não respondeu (${o.egress ?? "relay"}). Nenhuma reserva pode ser sincronizada enquanto estiver em baixo.`
      : isBlocked
        ? blockedSummary
        : isAuth
          ? "Lodgify rejeitou a chave de API — reservas não estão a ser sincronizadas nem facturadas."
          : `Não foi possível obter reservas do Lodgify: ${o.message}`.slice(0, 500),
    detail: { error: o.message, egress: o.egress ?? null },
    connection_label: o.connLabel,
    // An outage gets the default hourly bucket: a daily one would sit on it for
    // the rest of the day. Everything else stays daily, as before.
    ...(isRelayDown ? {} : { bucket: "daily" as const }),
  });
}

/**
 * The relay is down (or unconfigured), so no connection can be polled at all.
 *
 * One ops incident for the platform rather than one per merchant: the cause is
 * shared, and N identical criticals would bury it. Hourly bucket — this is an
 * outage, and the 08:00 stale-ingestion check is six hours too late to be the
 * first thing that notices.
 */
async function reportLodgifyRelayDown(
  env: Env,
  probe: { base: string; status?: number; error?: string },
): Promise<void> {
  const detail = probe.error ?? `HTTP ${probe.status ?? "?"}`;
  await reportIncident(env, {
    severity: "critical",
    kind: "lodgify_relay_down",
    summary: `O relay de saída da Lodgify não responde (${probe.base}): ${detail}. `
      + `Nenhuma reserva é sincronizada nem facturada até voltar. `
      + `Rollback: LODGIFY_EGRESS_MODE="direct" (volta ao estado bloqueado, sem falha nova).`,
    detail: { base: probe.base, status: probe.status ?? null, error: probe.error ?? null },
    connection_label: "lodgify → (todas)",
  });
}

/** sweep_state key under which a connection's last completed ingestion is stamped. */
function lodgifyIngestKey(userId: string): string {
  return `lodgify-ingest:${userId}`;
}

/**
 * Stamp "ingestion completed" for a Lodgify connection.
 *
 * Reuses `sweep_state` — a table that already answers exactly this question
 * ("when did this periodic job last finish for this subject") — under a
 * namespaced key, rather than adding a table and a hand-applied migration for
 * one timestamp. The column is named `shopify_domain` for historical reasons;
 * it is a plain TEXT primary key.
 *
 * Why a marker and not `MAX(lodgify_bookings.synced_at)`: a dormant merchant
 * (no bookings at all, or paused for the season) upserts no rows, so mirror
 * freshness would page every day about a connection that is perfectly healthy.
 * A completed run is the thing worth watching, and it is independent of whether
 * the merchant sold anything.
 */
async function markLodgifyIngest(env: Env, userId: string): Promise<void> {
  const nowIso = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO sweep_state (shopify_domain, last_started_at, last_completed_at, last_status, last_detail_json)
       VALUES (?1, ?2, ?2, 'ok', NULL)
       ON CONFLICT(shopify_domain) DO UPDATE SET
         last_started_at   = excluded.last_started_at,
         last_completed_at = excluded.last_completed_at,
         last_status       = excluded.last_status`
    ).bind(lodgifyIngestKey(userId), nowIso).run();
  } catch (e: any) {
    // Never let bookkeeping break a poll that already did its real work.
    console.warn(`[LodgifyPoll] ingest marker failed for ${userId}: ${e?.message ?? e}`);
  }
}

/**
 * Alert when settled bookings are piling up uninvoiced.
 *
 * The failure this catches: every per-poll counter can look healthy while
 * nothing is actually being billed. Overbuilding sat at 269 bookings / 0
 * invoices for 26 days and no metric noticed, because "skipped" is the normal
 * outcome for most bookings on most polls. This asks the only question that
 * matters — are there settled, post-cutoff bookings with no invoice? — straight
 * against the D1 mirror, so it is immune to whichever code path is broken.
 *
 * 48h grace keeps brand-new bookings (payment still settling, OTA sync lag) out
 * of the count. Daily bucket: one alert per day while a backlog persists.
 */
async function reportLodgifyBacklog(
  env: Env,
  userId: string,
  invoiceCutoff: string | null,
  connLabel: string,
  otaPolicy?: ReturnType<typeof otaPolicyFrom>,
): Promise<void> {
  const graceIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const otaSql = otaStayCollectedSqlPredicate(otaPolicy);
  const notBilled =
    `AND NOT EXISTS (SELECT 1 FROM lodgify_partial_invoices p WHERE p.booking_id = b.id)
     AND NOT EXISTS (SELECT 1 FROM processed_orders o WHERE o.id = b.id AND o.invoice_id IS NOT NULL)`;
  try {
    // (1) Money recorded in Lodgify that we never turned into a document. Same
    // rule as the invoice gate, expressed against the mirror. This used to read
    // `amount_due <= 0.01`, which counts every future OTA booking as "paid but
    // unbilled" — it would have paged daily about precisely the reservations the
    // poll is now correctly holding.
    const row: any = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MIN(b.created_at) AS oldest, SUM(COALESCE(b.total_amount,0)) AS value
         FROM lodgify_bookings b
        WHERE b.user_id = ?1
          AND b.status = 'Booked'
          AND (?2 IS NULL OR b.created_at >= ?2)
          AND ${otaSql ? `(${collectedSqlPredicate()} OR ${otaSql})` : collectedSqlPredicate()}
          AND b.created_at <= ?3
          ${notBilled}`
    ).bind(userId, invoiceCutoff ?? null, graceIso).first();

    const n = Number(row?.n ?? 0);
    if (n > 0) {
      console.warn(`[LodgifyPoll] user ${userId}: ${n} paid booking(s) still uninvoiced (oldest ${row?.oldest})`);
      await reportIncident(env, {
        user_id: userId,
        severity: "critical",
        kind: "queue_retry_exhausted",
        summary: `${n} reserva(s) Lodgify pagas continuam por facturar (mais antiga: ${String(row?.oldest ?? "?").slice(0, 10)}).`,
        detail: {
          uninvoiced: n, oldest: row?.oldest, value: row?.value,
          // Aggregate alert: there is no single destination error behind it, so
          // say what the condition IS rather than leaving triage with nothing.
          message: `${n} reserva(s) Lodgify pagas sem documento emitido (mais antiga: ${String(row?.oldest ?? "?").slice(0, 10)}, valor total ${row?.value ?? "?"}). Não houve recusa do destino — as reservas nunca chegaram a ser facturadas.`,
        },
        connection_label: connLabel,
        bucket: "daily",
      });
    }

    // (2) The counterweight to a manual trigger. Invoicing waits for the
    // merchant to mark a booking paid in Lodgify, so a forgotten booking is
    // simply never billed — silently, which is exactly how 14 of 16 bookings
    // went unbilled for 26 days. A stay that ended days ago with no payment
    // recorded is the signature of that, so say so while it can still be fixed.
    // Deliberately NOT a trigger to invoice: a finished stay is not a payment.
    //
    // On a connection that bills OTA stays on check-out, those bookings are NOT
    // waiting on the merchant for anything — telling them to go mark a Booking
    // .com stay as paid would be advice to ignore, on repeat, daily. Excluded
    // here; query (1) above already counts them if they end up unbilled.
    const stale: any = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MIN(b.departure) AS oldest, SUM(COALESCE(b.total_amount,0)) AS value
         FROM lodgify_bookings b
        WHERE b.user_id = ?1
          AND b.status = 'Booked'
          AND (?2 IS NULL OR b.created_at >= ?2)
          AND ${awaitingPaymentMarkSqlPredicate(3)}
          ${otaSql ? `AND NOT ${otaSql}` : ""}
          ${notBilled}`
    ).bind(userId, invoiceCutoff ?? null).first();

    const m = Number(stale?.n ?? 0);
    if (m > 0) {
      console.warn(`[LodgifyPoll] user ${userId}: ${m} finished stay(s) with no payment recorded (oldest ${stale?.oldest})`);
      await reportIncident(env, {
        user_id: userId,
        severity: "warning",
        kind: "lodgify_payment_not_marked",
        summary: `${m} reserva(s) já terminadas continuam sem pagamento registado no Lodgify — não podem ser facturadas até serem marcadas como pagas (mais antiga saiu a ${String(stale?.oldest ?? "?").slice(0, 10)}).`,
        detail: { awaiting_mark: m, oldest_departure: stale?.oldest, value: stale?.value },
        connection_label: connLabel,
        bucket: "daily",
      });
    }
  } catch (e: any) {
    console.error(`[LodgifyPoll] backlog check failed for ${userId}: ${e?.message ?? e}`);
  }
}

/**
 * Alert when a Lodgify connection has gone too long without a completed
 * ingestion — the "nobody is fetching any more" alarm.
 *
 * Reads the marker `markLodgifyIngest` writes, NOT the mirror's freshness: a
 * merchant can legitimately have zero new bookings for weeks (seasonal, paused,
 * dormant), and paging about that trains everyone to ignore the alert. A run
 * that completed is what we actually require, and it happens whether or not the
 * merchant sold anything.
 *
 * 6h threshold against an hourly feeder = five consecutive missed runs before
 * anyone is woken. Daily bucket, so a dead feeder costs one email per day.
 */
async function reportStaleLodgifyIngest(env: Env): Promise<{ checked: number; stale: number; skipped: number }> {
  const out = { checked: 0, stale: 0, skipped: 0 };
  const rows = await env.DB.prepare(
    `SELECT user_id, destination_kind FROM connections WHERE source_kind = 'lodgify' AND status = 'active'`
  ).all();

  const staleMs = 6 * 60 * 60 * 1000;
  for (const conn of (rows?.results ?? []) as any[]) {
    // A client we would not invoice for cannot have an ingestion problem worth
    // waking anyone at 08:00 for. Even if every booking arrived on time the gate
    // would refuse to document them, so silence is the correct state and not a
    // symptom — `connections.status` stays "active" long after a subscription
    // ends, which is why the row alone cannot answer this.
    //
    // Casa de Celebrar a Vida is the case: cancelled, dormant until 2027, and
    // sending one critical "as reservas não estão a chegar" every single day.
    // Alarms that are known-wrong are worse than no alarm, because they teach
    // you to skim the ones that are right.
    const gate = await checkSubscriptionGate(env, { user_id: conn.user_id } as IRequestConfig);
    if (!gate.allowed) { out.skipped++; continue; }

    out.checked++;
    const state: any = await env.DB.prepare(
      "SELECT last_completed_at FROM sweep_state WHERE shopify_domain = ?"
    ).bind(lodgifyIngestKey(conn.user_id)).first();

    const lastMs = state?.last_completed_at ? Date.parse(String(state.last_completed_at)) : NaN;
    const ageMs = Number.isFinite(lastMs) ? Date.now() - lastMs : Infinity;
    if (ageMs <= staleMs) continue;

    out.stale++;
    const hours = Number.isFinite(ageMs) ? Math.round(ageMs / 3600000) : null;
    await reportIncident(env, {
      user_id: conn.user_id,
      severity: "critical",
      kind: "auth_failure_source",
      summary: hours == null
        ? "Nenhuma sincronização Lodgify alguma vez concluída para esta ligação — as reservas não estão a chegar."
        : `Sem sincronização Lodgify há ${hours}h — as reservas deixaram de chegar e nada está a ser facturado.`,
      detail: { last_completed_at: state?.last_completed_at ?? null, threshold_hours: 6 },
      connection_label: `lodgify → ${conn.destination_kind ?? "moloni"}`,
      bucket: "daily",
    });
  }
  return out;
}

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<QueueMessage | StripeQueueMessage>, env: Env) {
    // Dispatch by queue name. Stripe + Shopify queues share this consumer;
    // the DLQ ("my-queue-dlq") is also routed here so failures get visibility.
    if (batch.queue === "my-queue-dlq") {
      await processDeadLetterBatch(batch as MessageBatch<any>, env);
      return;
    }
    if (batch.queue === "stripeeventsqueue") {
      await processStripeBatch(batch as MessageBatch<StripeQueueMessage>, env);
      return;
    }
    await processShopifyBatch(batch as MessageBatch<QueueMessage>, env);
  },
  async scheduled(event: ScheduledController, env: Env & { CRON_SECRET?: string; BACKOFFICE_URL?: string }, _ctx: ExecutionContext) {
    // Every 30 min — Lodgify booking poll. Lodgify user-level API keys cannot
    // register webhooks (partner OAuth only), so bookings are polled and
    // invoiced here. Runs on its own cron so it never rides the ops sweep.
    if (event.cron === "*/30 * * * *") {
      if (env.LODGIFY_POLL_ENABLED === "0") {
        console.log("[Cron] Lodgify poll disabled (LODGIFY_POLL_ENABLED=0)");
        return;
      }
      // Is our own egress alive, before spending the poll on it? Every Lodgify
      // invoice depends on that one box, and the only other detector is stale
      // ingestion at 08:00 with a six-hour floor — a Saturday-night outage
      // would surface on Sunday morning. One request every 30 minutes buys
      // minutes instead of hours, and skipping the poll while it is down keeps
      // 40 pages × N connections of doomed retries out of the log.
      const probe = await probeLodgifyRelay(env);
      if (probe.relayed && !probe.ok) {
        console.error(`[Cron] Lodgify relay down (${probe.base}): ${probe.error ?? probe.status}`);
        await reportLodgifyRelayDown(env, probe);
        return;
      }

      try {
        const r = await pollLodgifyBookings(env);
        console.log(`[Cron] Lodgify poll: synced=${r.synced} scanned=${r.scanned} invoiced=${r.invoiced} skipped=${r.skipped} reversed=${r.reversed} failed=${r.failed} across ${r.connections} connection(s)`);
      } catch (e: any) {
        // Was console-only. A throw here is the whole poll failing — a
        // misconfigured egress, or D1 unreachable — and it used to be
        // invisible until someone noticed the bookings had stopped.
        console.error(`[Cron] Lodgify poll failed: ${e.message}`);
        await reportLodgifyRelayDown(env, {
          base: probe.relayed ? probe.base : "direct (no fixed IP)",
          error: String(e?.message ?? e).slice(0, 500),
        }).catch(() => { /* incident reporting must not mask the original failure */ });
      }
      return;
    }

    // Friday 16:00 UTC — weekly per-merchant "unprocessed invoices" digest only.
    // Runs on its own cron so it doesn't ride along with the daily ops sweep.
    if (event.cron === "0 16 * * 5") {
      if (env.WEEKLY_MERCHANT_DIGEST_ENABLED === "1") {
        try {
          const r = await runWeeklyMerchantDigest(env);
          console.log(`[Cron] Weekly merchant digest: ${r.merchantsNotified} merchant(s) emailed, ${r.totalMissing} unprocessed invoice(s), ${r.skippedNoEmail} skipped (no email on file)`);
        } catch (e: any) {
          console.error(`[Cron] Weekly merchant digest failed: ${e.message}`);
        }
      } else {
        console.log("[Cron] Weekly merchant digest disabled (WEEKLY_MERCHANT_DIGEST_ENABLED != 1)");
      }
      // Weekly AI cross-incident pattern report (ops-only). Independent flag so it
      // ships dark; advisory and best-effort — never blocks the digest path.
      if (env.AI_PATTERN_REPORT_ENABLED === "1") {
        try {
          const p = await runWeeklyPatternReport(env);
          console.log(`[Cron] Weekly pattern report: ${p.patterns} pattern(s) over ${p.totalIncidents} incident(s)`);
        } catch (e: any) {
          console.error(`[Cron] Weekly pattern report failed: ${e.message}`);
        }
      }
      return;
    }

    // Daily 04:00 UTC — self-healing invoice reconciliation sweep. Re-emits any
    // paid Shopify order missing its IX invoice (drop from a normalize outage,
    // never-delivered webhook, etc.) via the double-guarded reemit path. Runs on
    // its own cron so it never rides the 08:00 ops sweep. Ships dark.
    if (event.cron === "0 4 * * *") {
      if (env.RECON_SWEEP_ENABLED === "1") {
        // PRIMARY: incident-driven heal — re-attempts exactly the orders with an
        // open failure incident. Bounded + reliable, so high-volume shops always
        // get healed (the full scan below can't finish for them). Runs first so
        // the critical work is done even if the backstop later hits its budget.
        try {
          const h = await runIncidentDrivenHeal(env);
          console.log(`[Cron] Incident-driven heal: shops=${h.shopsScanned} candidates=${h.totals.candidates} created=${h.totals.created} skipped=${h.totals.skipped} errors=${h.totals.errors}`);
        } catch (e: any) {
          console.error(`[Cron] Incident-driven heal failed: ${e.message}`);
        }
        // BACKSTOP: full 90-day history scan for anything that dropped without an
        // incident. Time-budgeted so it can never starve the fleet.
        try {
          const r = await runReconciliationSweep(env);
          console.log(`[Cron] Reconciliation sweep: shops=${r.shopsScanned} created=${r.totals.created} finalized=${r.totals.finalized} skipped=${r.totals.skipped} errors=${r.totals.errors}`);
        } catch (e: any) {
          console.error(`[Cron] Reconciliation sweep failed: ${e.message}`);
        }
      } else {
        console.log("[Cron] Reconciliation sweep disabled (RECON_SWEEP_ENABLED != 1)");
      }
      // Stripe→(Moloni/IX/Vendus) self-heal — independent flag so it ships dark and
      // runs separately from the Shopify sweep. Re-emits any succeeded Stripe
      // payment in the window that has no processed_orders row (orphan from a
      // deleted draft or an undelivered webhook). Keeps drafts; no finalize.
      if (env.STRIPE_HEAL_ENABLED === "1") {
        try {
          const s = await runStripeHeal(env);
          console.log(`[Cron] Stripe heal: connections=${s.connectionsScanned} created=${s.totals.created} skipped=${s.totals.skipped} errors=${s.totals.errors}`);
        } catch (e: any) {
          console.error(`[Cron] Stripe heal failed: ${e.message}`);
        }
      }

      // Hold every document issued since the last run to what we said we were
      // issuing. Runs LAST in this block on purpose: it only reads, so if the
      // budget is already spent by the heals — which fix things — it can wait
      // for tomorrow without anything being lost.
      if (env.DOC_VERIFY_ENABLED === "1") {
        try {
          const v = await runDocumentVerifySweep(env);
          console.log(`[Cron] Document verify: candidates=${v.candidates} matched=${v.matched} drifted=${v.drifted} unreadable=${v.unreadable}`);
        } catch (e: any) {
          console.error(`[Cron] Document verify failed: ${e.message}`);
        }
      }
      return;
    }

    // Daily ops sweep (0 8 * * *) below.
    const baseUrl = env.BACKOFFICE_URL || "https://rioko.online";
    const key = env.CRON_SECRET || env.ADMIN_API_KEY;
    if (!key) {
      console.error("[Cron] CRON_SECRET missing — skipping IX match retry");
    } else {
      try {
        const res = await fetch(`${baseUrl}/api/cron/ix-match?key=${encodeURIComponent(key)}`);
        const body = await res.text();
        console.log(`[Cron] IX match retry: ${res.status} ${body.slice(0, 200)}`);
      } catch (e: any) {
        console.error(`[Cron] IX match retry failed: ${e.message}`);
      }
    }

    // Close incidents that stopped happening. Deliberately OUTSIDE the digest
    // flag: whether we email a merchant is a judgement about noise, whether the
    // incidents table tells the truth is not. This lived inside the digest, the
    // digest has been off for months, and so nothing ever closed — 180
    // signature failures and 56 exhausted-retry buckets still open, some since
    // June, drowning the two that were real.
    try {
      const { autoResolved } = await autoResolveStaleIncidents(env);
      if (autoResolved > 0) console.log(`[Cron] Incidents auto-resolved: ${autoResolved}`);
    } catch (e: any) {
      console.error(`[Cron] Incident auto-resolve failed: ${e.message}`);
    }

    // Phase 4a.1 — daily incident digest. Sends one summary email per merchant
    // with all open + un-notified incidents from the last 24h. Gated by
    // INCIDENT_DIGEST_ENABLED.
    if (env.INCIDENT_DIGEST_ENABLED === "1") {
      try {
        const result = await runIncidentDigest(env);
        console.log(`[Cron] Incident digest: ${result.digestsSent} sent, ${result.autoResolved} auto-resolved`);
      } catch (e: any) {
        console.error(`[Cron] Incident digest failed: ${e.message}`);
      }
    }

    // Lodgify ingestion dead-man's switch. With the poll disabled and the list
    // fetched by an external feeder, a feeder that simply stops running takes
    // invoicing down in complete silence — no failure to report, no incident to
    // raise, every counter healthy at zero. This is the only check that fires on
    // an absence.
    try {
      const r = await reportStaleLodgifyIngest(env);
      if (r.stale > 0) console.warn(`[Cron] Lodgify ingestion stale for ${r.stale}/${r.checked} connection(s)`);
      if (r.skipped > 0) console.log(`[Cron] Lodgify staleness: ${r.skipped} connection(s) skipped (subscription inactive)`);
    } catch (e: any) {
      console.error(`[Cron] Lodgify ingest check failed: ${e.message}`);
    }

    // VIES retry sweep — picks up pending_reverse_charge rows whose retry
    // window has expired, re-checks VIES, submits or escalates to incident.
    try {
      const result = await runViesRetry(env);
      console.log(`[Cron] VIES retry: retried=${result.retried} resolved=${result.resolved} deferred=${result.deferred} incidents=${result.incidents}`);
    } catch (e: any) {
      console.error(`[Cron] VIES retry failed: ${e.message}`);
    }

    // Subscription renewal reminders — email the customer + ops ~7 days before an
    // ending (cancel_at_period_end=1) subscription lapses. On by default.
    if (env.RENEWAL_REMINDER_ENABLED !== "0") {
      try {
        const r = await runRenewalReminders(env);
        console.log(`[Cron] Renewal reminders: ${r.sent} sent, ${r.failed} failed (${r.checked} due)`);
      } catch (e: any) {
        console.error(`[Cron] Renewal reminders failed: ${e.message}`);
      }
    }

    // Early-bird wind-down — three touches (17 / 7 / 1 days before each pilot's
    // own trial_end) prompting them to pick a plan before invoicing pauses.
    if (env.RENEWAL_REMINDER_ENABLED !== "0") {
      try {
        const r = await runEarlyBirdEndingReminders(env);
        console.log(`[Cron] Early-bird reminders: ${r.sent} sent, ${r.failed} failed (${r.checked} due)`);
      } catch (e: any) {
        console.error(`[Cron] Early-bird reminders failed: ${e.message}`);
      }
    }

    // TTL purge of replay-protection tables. webhook_info and billing_events
    // grow unbounded — keys are external (Shopify webhook id, Stripe event id)
    // so retention beyond ~90 days adds no dedup value but does enlarge the
    // replay surface. 90d covers the longest Stripe/Shopify retry windows.
    // EXCEPTION: the payment ledger the faturação page renders (invoice.paid /
    // payment_failed / charge.refunded) is kept — those are the customer's
    // billing history (e.g. a once-a-year annual payment) and must not vanish
    // after 90 days. Only the ephemeral dedup rows (subscription.*/checkout.*)
    // are purged.
    try {
      const wi = await env.DB.prepare(
        "DELETE FROM webhook_info WHERE created_at < datetime('now', '-90 day')"
      ).run();
      const be = await env.DB.prepare(
        `DELETE FROM billing_events
         WHERE created_at < datetime('now', '-90 day')
           AND type NOT IN ('invoice.paid','invoice.payment_failed','charge.refunded')`
      ).run();
      // Document events age in two tiers. A `verified` says "we checked this
      // three months ago and it matched" — true, and of no use to anyone now. A
      // `drift` is evidence about a document that may still be open with the AT,
      // and that question gets asked a year later. See RETENTION_TIER.
      const deRoutine = await env.DB.prepare(documentEventPurgeSql("routine")).run();
      const deEvidence = await env.DB.prepare(documentEventPurgeSql("evidence")).run();
      console.log(`[Cron] TTL purge: webhook_info=${wi.meta?.changes ?? 0} billing_events=${be.meta?.changes ?? 0} document_events=${(deRoutine.meta?.changes ?? 0) + (deEvidence.meta?.changes ?? 0)}`);
    } catch (e: any) {
      console.error(`[Cron] TTL purge failed: ${e.message}`);
    }
  },
}
