import type { Env } from "./env";
import type { QueueMessage, StripeQueueMessage, StripeCanonicalTopic, WebhookTopic } from "./handlers/types";
import { Context, Hono } from "hono";
import { AppStorage } from "./storage";
import { verifyShopifyWebhook } from "./shopify";
import { getSourceAdapter } from "./adapters/registry";
import { runAdapterPipeline } from "./handlers/generic-pipeline";
import { reportIncident, runIncidentDigest } from "./services/incidents";
import { handleOrderCreated } from "./handlers/orders-created";
import { handleOrderUpdated } from "./handlers/orders-updated";
import { handleOrderPaid } from "./handlers/orders-paid";
import { handleRefundCreate } from "./handlers/refunds-create";
import { getUnprocessedOrders, processOrders, reemitOrder, finalizeDrafts, deleteDraftByOrderNumber, issueCreditNoteByOrderNumber } from "./handlers/admin";
import { sendDevModeEmail } from "./handlers/notify";
import {
  getReconciliation,
  approveReconciliationMatch,
  revertReconciliationMatch,
  setReconciliationDecisionAction,
  getShopForUser,
} from "./handlers/reconciliation";
import { runViesRetry, submitInvoiceForPendingRow } from "./handlers/pending-reverse-charge";
import { delay } from "./utils";

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

  const sig = c.req.header("Stripe-Signature");
  const rawBody = await c.req.text();
  if (!sig) return c.text("Missing Stripe-Signature", 400);

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
  const appStorage = new AppStorage(c.env);
  const { isProcessed, state } = await appStorage.isWebhookProcessed(eventId, `stripe/${canonical}`);
  if (isProcessed && state !== "failed") {
    return c.text("Already processed", 200);
  }
  await appStorage.markWebhookAsProcessing(eventId, `stripe/${canonical}`);

  await c.env.STRIPE_QUEUE.send({
    topic: canonical,
    eventId,
    userId: ownerRow.user_id,
    body: event,
  } satisfies StripeQueueMessage);

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
    return c.text(`Pipeline error: ${e?.message ?? "unknown"}`, 500);
  }
});

// Admin: list unprocessed orders
app.get("/admin/unprocessed-orders", async (c) => {
  const apiKey = c.req.header("x-api-key");
  if (!apiKey || apiKey !== c.env.ADMIN_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const shop = c.req.query("shop");
  const from = c.req.query("from");
  const to = c.req.query("to");

  if (!shop || !from || !to) {
    return c.json({ error: "Missing required query params: shop, from, to" }, 400);
  }

  const appStorage = new AppStorage(c.env, shop);
  const config = await appStorage.loadConfig();

  if (!config) {
    return c.json({ error: `No config found for ${shop}` }, 404);
  }

  try {
    const result = await getUnprocessedOrders(c.env, config, from, to);
    return c.json(result);
  } catch (e) {
    console.error("[Rioko][Admin] Error fetching unprocessed orders:", e);
    return c.json({ error: String(e) }, 500);
  }
})

function requireAdmin(c: Context<{ Bindings: Env }>) {
  const apiKey = c.req.header("x-api-key");
  if (!apiKey || apiKey !== c.env.ADMIN_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return null;
}

// Admin: process (create or finalize) orders
app.post("/admin/process-orders", async (c) => {
  const unauth = requireAdmin(c);
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
    console.error("[Rioko][Admin] Error processing orders:", e);
    return c.json({ error: String(e) }, 500);
  }
})

// Admin: re-emit single order by order_number
app.post("/admin/reemit-order", async (c) => {
  const unauth = requireAdmin(c);
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
    console.error("[Rioko][Admin] Error re-emitting order:", e);
    return c.json({ error: String(e) }, 500);
  }
})

// Admin: finalize drafts
app.post("/admin/finalize-drafts", async (c) => {
  const unauth = requireAdmin(c);
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
    console.error("[Rioko][Admin] Error finalizing drafts:", e);
    return c.json({ error: String(e) }, 500);
  }
})

// Admin: per-shop logs / jobs / webhooks
app.get("/admin/logs", async (c) => {
  const unauth = requireAdmin(c);
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
    return c.json({ error: String(e) }, 500);
  }
})

// Admin: fetch single job detail (per-order results)
app.get("/admin/jobs/:id", async (c) => {
  const unauth = requireAdmin(c);
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
  const unauth = requireAdmin(c);
  if (unauth) return unauth;
  const shop = c.req.query("shop");
  if (!shop) return c.json({ error: "Missing shop" }, 400);
  const appStorage = new AppStorage(c.env, shop);
  return c.json({ emails: await appStorage.getNotifyEmails() });
})

app.put("/admin/notify-emails", async (c) => {
  const unauth = requireAdmin(c);
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
  const unauth = requireAdmin(c);
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
    return c.json({ error: String(e) }, 500);
  }
})

// Admin: issue credit note by order_number
app.post("/admin/issue-credit-note", async (c) => {
  const unauth = requireAdmin(c);
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
    return c.json({ error: String(e) }, 500);
  }
})

// Admin: get/set per-account tax override
app.get("/admin/tax-override", async (c) => {
  const unauth = requireAdmin(c);
  if (unauth) return unauth;
  const shop = c.req.query("shop");
  if (!shop) return c.json({ error: "Missing shop" }, 400);
  const appStorage = new AppStorage(c.env, shop);
  return c.json(await appStorage.getTaxOverride());
})

app.put("/admin/tax-override", async (c) => {
  const unauth = requireAdmin(c);
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
  const unauth = requireAdmin(c);
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
  const unauth = requireAdmin(c);
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
  const unauth = requireAdmin(c);
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

// Admin: reconciliation list
app.get("/admin/reconciliation", async (c) => {
  const unauth = requireAdmin(c);
  if (unauth) return unauth;
  const shop = c.req.query("shop");
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!shop || !from || !to) return c.json({ error: "Missing shop/from/to" }, 400);

  const appStorage = new AppStorage(c.env, shop);
  const config = await appStorage.loadConfig();
  if (!config) return c.json({ error: `No config found for ${shop}` }, 404);

  try {
    const result = await getReconciliation(c.env, config, from, to);
    return c.json(result);
  } catch (e) {
    console.error("[Rioko][Recon] error:", e);
    return c.json({ error: String(e) }, 500);
  }
})

app.post("/admin/reconciliation/approve", async (c) => {
  const unauth = requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<{ shop: string; order_id: string; invoice_id: string; approved_by?: string }>();
  if (!body.shop || !body.order_id || !body.invoice_id) return c.json({ error: "Missing shop/order_id/invoice_id" }, 400);
  const appStorage = new AppStorage(c.env, body.shop);
  const config = await appStorage.loadConfig();
  if (!config) return c.json({ error: `No config found for ${body.shop}` }, 404);
  try {
    return c.json(await approveReconciliationMatch(c.env, config, body.order_id, body.invoice_id, body.approved_by ?? null));
  } catch (e) { return c.json({ error: String(e) }, 500); }
})

app.delete("/admin/reconciliation/approve", async (c) => {
  const unauth = requireAdmin(c);
  if (unauth) return unauth;
  const shop = c.req.query("shop");
  const orderId = c.req.query("order_id");
  if (!shop || !orderId) return c.json({ error: "Missing shop or order_id" }, 400);
  const appStorage = new AppStorage(c.env, shop);
  const config = await appStorage.loadConfig();
  if (!config) return c.json({ error: `No config found for ${shop}` }, 404);
  try {
    return c.json(await revertReconciliationMatch(c.env, config, orderId));
  } catch (e) { return c.json({ error: String(e) }, 500); }
})

app.post("/admin/reconciliation/decision", async (c) => {
  const unauth = requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<{ shop: string; order_id: string; decision: string | null; reason?: string; decided_by?: string }>();
  if (!body.shop || !body.order_id) return c.json({ error: "Missing shop/order_id" }, 400);
  const appStorage = new AppStorage(c.env, body.shop);
  const config = await appStorage.loadConfig();
  if (!config) return c.json({ error: `No config found for ${body.shop}` }, 404);
  try {
    return c.json(await setReconciliationDecisionAction(c.env, config, body.order_id, body.decision ?? null, body.reason ?? null, body.decided_by ?? null));
  } catch (e) { return c.json({ error: String(e) }, 500); }
})

app.get("/admin/user-shop", async (c) => {
  const unauth = requireAdmin(c);
  if (unauth) return unauth;
  const userId = c.req.query("user_id");
  if (!userId) return c.json({ error: "Missing user_id" }, 400);
  try {
    return c.json(await getShopForUser(c.env, userId));
  } catch (e) { return c.json({ error: String(e) }, 500); }
})

// Admin: ad-hoc test notify
app.post("/admin/notify", async (c) => {
  const unauth = requireAdmin(c);
  if (unauth) return unauth;
  const body = await c.req.json<{ recipients: string[]; subject: string; body: string }>();
  if (!body.recipients?.length) return c.json({ error: "Missing recipients" }, 400);
  const res = await sendDevModeEmail({ recipients: body.recipients, subject: body.subject, body: body.body });
  return c.json(res, res.ok ? 200 : 500);
})

// Admin: render an incident template and send it via Resend. Bypasses the
// incident dedup bucket so it can fire repeatedly for QA.
app.post("/admin/test-incident-email", async (c) => {
  const unauth = requireAdmin(c);
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
          status: 500,
        });
      } catch (logErr) {
        console.error("[Rioko] Failed to persist failure log:", logErr);
      }
      message.retry({ delaySeconds: 360 });
    }
  }
}

async function processStripeBatch(batch: MessageBatch<StripeQueueMessage>, env: Env) {
  for (const message of batch.messages) {
    const { topic, eventId, userId, body } = message.body;
    console.log(`[Stripe] Queue processing: ${topic} event=${eventId} user=${userId}`);

    try {
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

      message.ack();
    } catch (e) {
      console.error(`[Stripe] Queue handler error for event ${eventId}:`, e);
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
          status: 500,
        });
      } catch (logErr) {
        console.error("[Stripe] Failed to persist failure log:", logErr);
      }
      message.retry({ delaySeconds: 360 });
    }
  }
}

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<QueueMessage | StripeQueueMessage>, env: Env) {
    // Dispatch by queue name. Stripe and Shopify queues share this consumer
    // but have different message shapes + retry policies.
    if (batch.queue === "stripeeventsqueue") {
      await processStripeBatch(batch as MessageBatch<StripeQueueMessage>, env);
      return;
    }
    await processShopifyBatch(batch as MessageBatch<QueueMessage>, env);
  },
  async scheduled(_event: ScheduledEvent, env: Env & { CRON_SECRET?: string; BACKOFFICE_URL?: string }, _ctx: ExecutionContext) {
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
  },
}
