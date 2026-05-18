import type { Env } from "./env";
import type { QueueMessage, WebhookTopic } from "./handlers/types";
import { Context, Hono } from "hono";
import { AppStorage } from "./storage";
import { verifyShopifyWebhook } from "./shopify";
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
import { delay } from "./utils";

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

  // Check for duplicate webhook
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

  // Verify webhook signature
  const hmac = c.req.header("X-Shopify-Hmac-Sha256");
  const rawBody = await c.req.text();

  if (!hmac || !await verifyShopifyWebhook(hmac, rawBody, config.shopify_webhook_secret!)) {
    console.error(`[Rioko] Invalid Webhook Signature for ${config.shopify_domain}.`);
    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic, payload: "", response: "Invalid Signature", status: 401 });
    return new Response("Invalid Signature", { status: 401 });
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
    return c.json(result);
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
  const body = await c.req.json<{ shop: string; force_tax_rate: number | null; force_shipping_tax_rate: number | null; oss_enabled: boolean }>();
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
  const appStorage = new AppStorage(c.env, body.shop);
  await appStorage.setTaxOverride(body.force_tax_rate ?? null, body.force_shipping_tax_rate ?? null, !!body.oss_enabled);
  return c.json(await appStorage.getTaxOverride());
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

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<QueueMessage>, env: Env) {
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

        // console.log(`[Rioko] Config found for ${shopDomain}, processing message. Delayin for 45 seconds`);
        // await delay(45000);

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
        // 60 seconds
        message.retry({ delaySeconds: 360 });
      }
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env & { CRON_SECRET?: string; BACKOFFICE_URL?: string }, _ctx: ExecutionContext) {
    const baseUrl = env.BACKOFFICE_URL || "https://rioko.online";
    const key = env.CRON_SECRET || env.ADMIN_API_KEY;
    if (!key) {
      console.error("[Cron] CRON_SECRET missing — skipping IX match retry");
      return;
    }
    try {
      const res = await fetch(`${baseUrl}/api/cron/ix-match?key=${encodeURIComponent(key)}`);
      const body = await res.text();
      console.log(`[Cron] IX match retry: ${res.status} ${body.slice(0, 200)}`);
    } catch (e: any) {
      console.error(`[Cron] IX match retry failed: ${e.message}`);
    }
  },
}
