import type { Env } from "./env";
import type { QueueMessage, WebhookTopic } from "./handlers/types";
import { Hono } from "hono";
import { AppStorage } from "./storage";
import { verifyShopifyWebhook } from "./shopify";
import { handleOrderCreated } from "./handlers/orders-created";
import { handleOrderUpdated } from "./handlers/orders-updated";
import { handleOrderPaid } from "./handlers/orders-paid";
import { handleRefundCreate } from "./handlers/refunds-create";
import { delay } from "./utils";

const app = new Hono<{ Bindings: Env }>();

// Health check endpoint
app.get("/", (c) => c.text("OK"))

async function enqueueWebhook(c: any, topic: WebhookTopic) {
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
  } satisfies QueueMessage);

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

        console.log(`[Rioko] Config found for ${shopDomain}, processing message. Delayin for 30 seconds`);
        await delay(30000);

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
        message.retry();
      }
    }
  },
}
