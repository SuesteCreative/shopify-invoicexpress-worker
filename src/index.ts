import { Hono } from "hono";
import { AppStorage } from "./storage";
import { Env } from "./env";
import { Shopify, verifyShopifyWebhook } from "./shopify";
import { IxApi } from "./api/ix";
import { IxBuilder } from "./ix/builder";

const app = new Hono<{ Bindings: Env }>();

// Health check endpoint
app.get("/", (c) => c.text("OK"))

// Shopify orders/created webhook endpoint
app.post("/webhooks/shopify/orders-created", async (c) => {
  const webhookTopic = "orders/paid";
  const appStorage = new AppStorage(c);

  const config = await appStorage.loadConfig();

  if (!config) {
    console.log("[Rioko] No config found for shopify domain")
    return c.text("No config found", 404)
  };
  const shopify = new Shopify(c, config);

  console.log(`[Rioko] Webhook Received: ${webhookTopic} for ${config.shopify_domain}`);
  const isWebhookValid = await shopify.verifyWebhook();

  if (!isWebhookValid) {
    console.error(`[Rioko] Invalid Webhook Signature for ${config.shopify_domain}.`);
    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Invalid Signature", status: 401 });
    return new Response("Invalid Signature", { status: 401 });
  }

  // Get order object from request body
  const order = await c.req.json();
  const orderId = order.id;
  console.log(`[Rioko] Order received: ${orderId}`);

  // Check if order was already processed.
  const alreadyExists = await appStorage.isInvoiceAlreadyProcessed(orderId);
  if (alreadyExists) {
    console.log(`[Rioko] Invoice already processed for order ${orderId}`);
    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Already processed", status: 401 });
    return c.text("Invoice already processed", 200);
  }

  const ixRef = `Order #${order.order_number}`;
  const ixHeaders = {
    "x-account-name": config.ix_account_name!,
    "x-api-key": config.ix_api_key!,
    "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
  };
  // Check if invoice already exists in InvoiceXpress system
  const ixExisting = await IxApi.v2.documents.reference.post({
    headers: ixHeaders,
    body: {
      reference: ixRef,
    },
  });

  if (ixExisting.data?.data?.id) {
    console.log(`[Rioko] Invoice already exists for order ${orderId}`);
    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Already exists", status: 401 });
    return c.text("Invoice already exists", 200);
  }

  const normalizedOrderResponse = await shopify.normalizeOrder(order);

  if (!normalizedOrderResponse) {
    console.log(`[Rioko] Failed to normalize order for order ${orderId}`);
    return c.text("Failed to normalize order", 400);
  }

  const ixBuilder = new IxBuilder(config);

  const { invoice } = ixBuilder.createInvoiceFromNormalizedOrder(normalizedOrderResponse.normalized);

  const ixCreateResponse = await IxApi.v2.documents.post({
    headers: ixHeaders,
    body: {
      data: invoice,
      type: config.ix_document_type === "invoice_receipt" ? "invoice_receipt" : "invoice"
    },
  });

  if (ixCreateResponse.data?.data?.id) {
    console.log(`[Rioko] Invoice created for order ${orderId}`);
    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Created", status: 200 });
    return c.text("Invoice created", 200);
  } else {
    console.log(`[Rioko] Failed to create invoice for order ${orderId}`);
    console.log(ixCreateResponse);
    return c.text("Failed to create invoice", 400);
  }
})

// Shopify orders/updated webhook endpoint
app.post("/webhooks/shopify/orders-updated", (c) => {
  return c.text("OK", 200);
})

// Shopify orders/paid webhook endpoint
app.post("/webhooks/shopify/orders-paid", (c) => {
  return c.text("OK", 200);
})


// Shopify refunds/create webhook endpoint
app.post("/webhooks/shopify/refunds-create", (c) => {
  return c.text("OK", 200);
})

export default app;
