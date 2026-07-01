import type { Env } from "./env";
import type { QueueMessage, StripeQueueMessage, StripeCanonicalTopic, WebhookTopic } from "./handlers/types";
import { Context, Hono } from "hono";
import { AppStorage } from "./storage";
import { verifyShopifyWebhook } from "./shopify";
import { getSourceAdapter } from "./adapters/registry";
import { runAdapterPipeline, classifyPipelineError } from "./handlers/generic-pipeline";
import { reportIncident, runIncidentDigest, runWeeklyMerchantDigest, explainIncidentById, runWeeklyPatternReport, sendIncidentTestEmail } from "./services/incidents";
import { describeOrder } from "./services/order-label";
import { handleOrderCreated } from "./handlers/orders-created";
import { handleOrderUpdated } from "./handlers/orders-updated";
import { handleOrderPaid } from "./handlers/orders-paid";
import { handleRefundCreate } from "./handlers/refunds-create";
import { getUnprocessedOrders, processOrders, reemitOrder, finalizeDrafts, deleteDraftByOrderNumber, issueCreditNoteByOrderNumber } from "./handlers/admin";
import { checkSubscriptionGate } from "./services/subscription-gate";
import { processStripeBackfill, reemitStripeOrder, deleteStripeDraft, issueStripeCreditNote, finalizeStripeDrafts } from "./handlers/admin-stripe";
import { sendDevModeEmail } from "./handlers/notify";
import {
  getReconciliation,
  resolveReconContext,
  approveReconciliationMatch,
  revertReconciliationMatch,
  setReconciliationDecisionAction,
  getShopForUser,
} from "./handlers/reconciliation";
import { runViesRetry, submitInvoiceForPendingRow } from "./handlers/pending-reverse-charge";
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

  // Fail-fast: refuse to enter the verification path if no secret is set.
  // Without this we'd loop over every connection trying empty/undefined
  // secrets and either return a misleading 404 or 500.
  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    console.error("[Stripe] STRIPE_WEBHOOK_SECRET missing — set via `wrangler secret put STRIPE_WEBHOOK_SECRET`");
    return c.text("Stripe webhook secret not configured", 500);
  }

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
      `SELECT id, user_id, source_config_json FROM connections
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
      `SELECT id, user_id, source_config_json FROM connections
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
      connection_label: "stripe → invoicexpress",
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
        detail: { eventId, topic: canonical, error: String(err?.message ?? err) },
        affected_ids: [eventId],
        connection_label: "stripe → invoicexpress",
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
  const body = await c.req.json<{ userId: string; bookingId: string | number; booking?: Record<string, unknown> }>();
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

  const fakeBody: any = { event: "booking_new_booked", data: { bookingId: Number(body.bookingId) } };
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

  const LODGIFY = "https://api.lodgify.com";
  const workerBase = (c.env as any).WORKER_URL ?? "https://shopify-invoicexpress-worker.pedrotovarporto.workers.dev";
  const baseUrl = `${workerBase}/webhooks/lodgify/${body.userId}`;

  const toRegister = [
    { event: "booking_new_status_booked", url: baseUrl,               secretKey: "webhook_secret",          idKey: "webhook_id" },
    { event: "booking_change",             url: `${baseUrl}?e=change`, secretKey: "webhook_secret_change",   idKey: "webhook_id_change" },
    { event: "booking_status_change_declined", url: `${baseUrl}?e=declined`, secretKey: "webhook_secret_declined", idKey: "webhook_id_declined" },
  ];

  const results: Record<string, any> = {};

  // Fetch live webhook list from Lodgify to find all IDs pointing to our Worker
  const workerHost = new URL(workerBase).hostname;
  const listRes = await fetch(`${LODGIFY}/webhooks/v1/list`, { headers: { "X-ApiKey": apiKey } });
  const liveList: any[] = listRes.ok ? ((await listRes.json().catch(() => [])) as any[]) : [];
  const ourWebhooks = liveList.filter((w: any) => (w.target_url ?? w.url ?? "").includes(workerHost));

  // Delete all existing webhooks pointing to our Worker (by live ID)
  const deleteResults: Record<string, number> = {};
  for (const w of ourWebhooks) {
    const wId = w.id ?? w.webhook_id;
    // Try DELETE then POST fallback
    let status = 0;
    for (const method of ["DELETE", "POST"] as const) {
      const dr = await fetch(`${LODGIFY}/webhooks/v1/unsubscribe/${wId}`, {
        method, headers: { "X-ApiKey": apiKey },
      }).catch(() => null);
      status = dr?.status ?? 0;
      if (status >= 200 && status < 300) break;
    }
    deleteResults[wId] = status;
  }
  results["_deleted"] = deleteResults;
  results["_live_list"] = liveList.map((w: any) => ({ id: w.id, event: w.event ?? w.type, url: w.target_url ?? w.url }));

  // Small pause after deletes
  await new Promise(r => setTimeout(r, 1500));

  for (const { event, url, secretKey, idKey } of toRegister) {
    // Register new
    const res = await fetch(`${LODGIFY}/webhooks/v1/subscribe`, {
      method: "POST",
      headers: { "X-ApiKey": apiKey, "Content-Type": "application/json" },
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
  const type = (c.req.query("type") ?? "jobs") as "errors" | "webhooks" | "jobs" | "all";
  const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10) || 100, 500);

  if (!shop) return c.json({ error: "Missing required query param: shop" }, 400);

  const appStorage = new AppStorage(c.env, shop);
  try {
    if (type === "errors") {
      return c.json({ entries: await appStorage.getLogs(limit, "errors") });
    }
    if (type === "all") {
      return c.json({ entries: await appStorage.getLogs(limit, "all") });
    }
    if (type === "webhooks") {
      return c.json({ entries: await appStorage.getWebhookEvents(limit) });
    }
    return c.json({ entries: await appStorage.getDevJobs(limit) });
  } catch (e) {
    return errorResponse(c, e, "Failed to fetch logs");
  }
})

// Admin: fetch single job detail (per-order results)
app.get("/admin/jobs/:id", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;

  const shop = c.req.query("shop");
  const id = c.req.param("id");
  if (!shop) return c.json({ error: "Missing shop" }, 400);

  const appStorage = new AppStorage(c.env, shop);
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
// Admin: Stripe Dev Mode parity. Stripe-only users have no shopify_domain, so
// these routes key off `user_id` and resolve the IRequestConfig via
// AppStorage.loadConfigByUser instead of the shop-keyed loadConfig().
// ────────────────────────────────────────────────────────────────────────────

async function loadConfigForUser(c: Context<{ Bindings: Env }>, userId: string) {
  const storage = new AppStorage(c.env, undefined, userId);
  return storage.loadConfigByUser(userId);
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
  if (!config) return c.json({ error: `No integrations row found for user ${body.user_id}` }, 404);
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
  const config = await loadConfigForUser(c, body.user_id);
  if (!config) return c.json({ error: `No integrations row found for user ${body.user_id}` }, 404);
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
  if (!config) return c.json({ error: `No integrations row found for user ${body.user_id}` }, 404);
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
  if (!config) return c.json({ error: `No integrations row found for user ${body.user_id}` }, 404);
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
  if (!config) return c.json({ error: `No integrations row found for user ${body.user_id}` }, 404);
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
    const result = await getReconciliation(c.env, ctx, from, to);
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

// Admin: ad-hoc test notify
app.post("/admin/notify", async (c) => {
  const unauth = await requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<{ recipients: string[]; subject: string; body?: string; html?: string }>();
  if (!body.recipients?.length) return c.json({ error: "Missing recipients" }, 400);
  const res = await sendDevModeEmail({ recipients: body.recipients, subject: body.subject, body: body.body ?? "", html: body.html, env: c.env });
  return c.json(res, res.ok ? 200 : 500);
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
    "normalize_fail", "nif_invalid", "subscription_inactive",
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
            detail: { message: (e as any)?.message, orderRef, clientName, externalId, topic, shopDomain, attempts, permanent },
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

      // Load legacy `integrations` row for now — Phase 5 will project the full
      // config out of `connections.destination_config_json`. For Phase 3 we
      // reuse the existing per-user IX credentials so behavior stays identical.
      const legacy: any = await env.DB.prepare(
        "SELECT * FROM integrations WHERE user_id = ?"
      ).bind(userId).first();

      if (!legacy) {
        console.error(`[Stripe] No legacy integrations row for user ${userId}, acking`);
        message.ack();
        continue;
      }

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
    const externalId: string = String(body?.eventId ?? body?.body?.id ?? body?.body?.order_number ?? "unknown");
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
    try {
      await reportIncident(env, {
        user_id: userId,
        severity: "critical",
        kind: "queue_retry_exhausted",
        summary: `Retries esgotadas em ${sourceQueue} (${topic}) para ${orderLabel}${clientName ? ` — ${clientName}` : ""}. Encomenda NÃO foi facturada.`,
        detail: { sourceQueue, topic, orderRef, clientName, externalId, shopDomain, messageBody: JSON.stringify(body).slice(0, 1000) },
        affected_ids: [externalId],
        connection_label: sourceQueue === "stripeeventsqueue" ? "stripe → invoicexpress" : "shopify → invoicexpress",
        merchant_name: shopDomain ?? undefined,
        order_ref: orderRef,
        client_name: clientName,
      });
    } catch (e) {
      console.error("[DLQ] Failed to emit incident:", e);
    }

    // ack() — do not bounce back to the DLQ. The incident is the record.
    message.ack();
  }
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

    // Phase 4a.1 — daily incident digest. Sends one summary email per merchant
    // with all open + un-notified incidents from the last 24h, and auto-resolves
    // stale incidents (no recurrence in 24h). Gated by INCIDENT_DIGEST_ENABLED.
    if (env.INCIDENT_DIGEST_ENABLED === "1") {
      try {
        const result = await runIncidentDigest(env);
        console.log(`[Cron] Incident digest: ${result.digestsSent} sent, ${result.autoResolved} auto-resolved`);
      } catch (e: any) {
        console.error(`[Cron] Incident digest failed: ${e.message}`);
      }
    }

    // VIES retry sweep — picks up pending_reverse_charge rows whose retry
    // window has expired, re-checks VIES, submits or escalates to incident.
    try {
      const result = await runViesRetry(env);
      console.log(`[Cron] VIES retry: retried=${result.retried} resolved=${result.resolved} deferred=${result.deferred} incidents=${result.incidents}`);
    } catch (e: any) {
      console.error(`[Cron] VIES retry failed: ${e.message}`);
    }

    // TTL purge of replay-protection tables. webhook_info and billing_events
    // grow unbounded — keys are external (Shopify webhook id, Stripe event id)
    // so retention beyond ~90 days adds no dedup value but does enlarge the
    // replay surface. 90d covers the longest Stripe/Shopify retry windows.
    try {
      const wi = await env.DB.prepare(
        "DELETE FROM webhook_info WHERE created_at < datetime('now', '-90 day')"
      ).run();
      const be = await env.DB.prepare(
        "DELETE FROM billing_events WHERE created_at < datetime('now', '-90 day')"
      ).run();
      console.log(`[Cron] TTL purge: webhook_info=${wi.meta?.changes ?? 0} billing_events=${be.meta?.changes ?? 0}`);
    } catch (e: any) {
      console.error(`[Cron] TTL purge failed: ${e.message}`);
    }
  },
}
