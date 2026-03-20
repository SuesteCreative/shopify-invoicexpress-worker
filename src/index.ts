import type { Env } from "./env";
import { Hono } from "hono";
import { AppStorage } from "./storage";
import { Shopify } from "./shopify";
import { IxApi } from "./api/ix";
import { IxBuilder, type IxCreditNote } from "./ix/builder";
import pRetry from "p-retry";

const app = new Hono<{ Bindings: Env }>();

// Health check endpoint
app.get("/", (c) => c.text("OK"))

// Shopify orders/created webhook endpoint
app.post("/webhooks/shopify/orders-created", async (c) => {
  const webhookTopic = "orders/created";
  const webhookId = c.req.header("x-shopify-webhook-id");
  const appStorage = new AppStorage(c);

  const config = await appStorage.loadConfig();

  if (!config) {
    console.log("[Rioko] No config found for shopify domain")
    return c.text("No config found", 404)
  };

  // Check for duplicate webhook and mark as processing immediately
  if (webhookId) {
    const { isProcessed, state } = await appStorage.isWebhookProcessed(webhookId, webhookTopic);
    if (isProcessed) {
      console.log(`[Rioko] Webhook ${webhookId} already ${state}, skipping`);
      return c.text("Webhook already processed", 200);
    }

    // Mark as processing immediately to prevent duplicate processing
    if (state === "failed") {
      console.log(`[Rioko] Retrying failed webhook ${webhookId}`);
    }
    await appStorage.markWebhookAsProcessing(webhookId, webhookTopic);
  }

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
  console.log(order);

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

  const normalizedOrderResponse = await shopify.normalizeOrder(orderId);

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
    query: {
      resolvers: "on_tax_fallback_search_tax_by_value"
    },
  });

  if (ixCreateResponse.data?.data?.id) {
    console.log(`[Rioko] Invoice created for order ${orderId}`);

    // Save processed invoice to database
    await appStorage.saveProcessedInvoice(orderId, String(ixCreateResponse.data.data.id));

    // Mark webhook as processed
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "success");
    }

    await appStorage.saveLog({
      shopify_domain: config.shopify_domain, topic: webhookTopic, payload: JSON.stringify({
        orderId,
        invoice: ixCreateResponse.data?.data
      }), response: "Created", status: 200
    });
    return c.text("Invoice created", 200);
  } else {
    console.log(`[Rioko] Failed to create invoice for order ${orderId}`);
    console.log(ixCreateResponse);

    // Mark webhook as failed
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "failed");
    }

    return c.text("Failed to create invoice", 400);
  }
})

// Shopify orders/updated webhook endpoint
app.post("/webhooks/shopify/orders-updated", async (c) => {
  const webhookTopic = "orders/updated";
  const webhookId = c.req.header("x-shopify-webhook-id");
  const appStorage = new AppStorage(c);

  const config = await appStorage.loadConfig();

  if (!config) {
    console.log("[Rioko] No config found for shopify domain");
    return c.text("No config found", 404);
  }

  // Check for duplicate webhook
  if (webhookId) {
    const { isProcessed, state } = await appStorage.isWebhookProcessed(webhookId, webhookTopic);
    if (isProcessed) {
      console.log(`[Rioko] Webhook ${webhookId} already ${state}, skipping`);
      return c.text("Webhook already processed", 200);
    }

    // Mark as processing
    if (state === "failed") {
      console.log(`[Rioko] Retrying failed webhook ${webhookId}`);
    }
    await appStorage.markWebhookAsProcessing(webhookId, webhookTopic);
  }

  const shopify = new Shopify(c, config);

  console.log(`[Rioko] Webhook Received: ${webhookTopic} for ${config.shopify_domain}`);
  const isWebhookValid = await shopify.verifyWebhook();

  if (!isWebhookValid) {
    console.error(`[Rioko] Invalid Webhook Signature for ${config.shopify_domain}.`);
    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Invalid Signature", status: 401 });
    return new Response("Invalid Signature", { status: 401 });
  }

  const order = await c.req.json();
  const orderId = order.id;
  console.log(`[Rioko] Order received: ${orderId}`);
  console.log(order);

  try {
    // Normalize order
    const normalizedOrderResponse = await shopify.normalizeOrder(orderId);

    if (!normalizedOrderResponse) {
      console.log(`[Rioko] Failed to normalize order for order ${orderId}`);
      await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Failed to normalize order", status: 400 });
      return c.text("Failed to normalize order", 400);
    }

    // Search for invoice with retry logic
    const invoice = await pRetry(async () => {
      const invoiceRef = await appStorage.getInvoiceByOrderId(String(normalizedOrderResponse.normalized.order.id));

      if (!invoiceRef || !invoiceRef.invoice_id) {
        throw new Error(`Invoice not found by order.id=${normalizedOrderResponse.normalized.order.id}`);
      }

      return invoiceRef;
    }, {
      retries: 10,
    });

    const ixBuilder = new IxBuilder(config);
    const { invoice: invoiceData } = ixBuilder.createInvoiceFromNormalizedOrder(normalizedOrderResponse.normalized);

    const ixHeaders = {
      "x-account-name": config.ix_account_name!,
      "x-api-key": config.ix_api_key!,
      "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
    };

    // Update the invoice
    const { error } = await IxApi.v2.documents.byId.put({
      body: {
        type: config.ix_document_type === "invoice_receipt" ? "invoice_receipt" : "invoice",
        data: invoiceData
      },
      path: {
        id: Number(invoice.invoice_id)
      },
      query: {
        resolvers: "on_tax_fallback_search_tax_by_value"
      },
      headers: ixHeaders
    });

    console.log(`[Rioko] Invoice updated for order ${orderId}`, { error });

    // Mark webhook as processed
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "success");
    }

    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Updated", status: 200 });
    return c.text("Invoice updated", 200);
  } catch (e) {
    console.error(`[Rioko] Error updating invoice for order ${orderId}:`, e);

    // Mark webhook as failed
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "failed");
    }

    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: String(e), status: 500 });
    return c.text("Error updating invoice", 500);
  }
})

// Shopify orders/paid webhook endpoint
app.post("/webhooks/shopify/orders-paid", async (c) => {
  const webhookTopic = "orders/paid";
  const webhookId = c.req.header("x-shopify-webhook-id");
  const appStorage = new AppStorage(c);

  const config = await appStorage.loadConfig();

  if (!config) {
    console.log("[Rioko] No config found for shopify domain");
    return c.text("No config found", 404);
  }

  // Check for duplicate webhook
  if (webhookId) {
    const { isProcessed, state } = await appStorage.isWebhookProcessed(webhookId, webhookTopic);
    if (isProcessed) {
      console.log(`[Rioko] Webhook ${webhookId} already ${state}, skipping`);
      return c.text("Webhook already processed", 200);
    }

    // Mark as processing
    if (state === "failed") {
      console.log(`[Rioko] Retrying failed webhook ${webhookId}`);
    }
    await appStorage.markWebhookAsProcessing(webhookId, webhookTopic);
  }

  const shopify = new Shopify(c, config);

  console.log(`[Rioko] Webhook Received: ${webhookTopic} for ${config.shopify_domain}`);
  const isWebhookValid = await shopify.verifyWebhook();

  if (!isWebhookValid) {
    console.error(`[Rioko] Invalid Webhook Signature for ${config.shopify_domain}.`);
    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Invalid Signature", status: 401 });
    return new Response("Invalid Signature", { status: 401 });
  }

  const order = await c.req.json();
  const orderId = order.id;
  console.log(`[Rioko] Order received: ${orderId}`);
  console.log(order);

  try {
    // Normalize order
    const normalizedOrderResponse = await shopify.normalizeOrder(orderId);

    if (!normalizedOrderResponse) {
      console.log(`[Rioko] Failed to normalize order for order ${orderId}`);
      await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Failed to normalize order", status: 400 });
      return c.text("Failed to normalize order", 400);
    }

    // Let's delay
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Search for invoice with retry logic
    const invoice = await pRetry(async () => {
      const invoiceRef = await appStorage.getInvoiceByOrderId(String(normalizedOrderResponse.normalized.order.id));

      if (!invoiceRef || !invoiceRef.invoice_id) {
        throw new Error(`Invoice not found by order.id=${normalizedOrderResponse.normalized.order.id}`);
      }

      return invoiceRef;
    }, {
      retries: 10,
    });

    // Check if auto_finalize is enabled
    const finalize = config.auto_finalize === 1;

    // Skip if we don't auto-finalize invoices
    if (!finalize) {
      console.log(`[Rioko] Auto-finalize disabled, skipping for order ${orderId}`);
      await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Auto-finalize disabled", status: 200 });
      return c.text("Auto-finalize disabled", 200);
    }

    const ixHeaders = {
      "x-account-name": config.ix_account_name!,
      "x-api-key": config.ix_api_key!,
      "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
    };

    // Finalize the invoice
    const { data, error } = await IxApi.v2.changeState.post({
      body: {
        type: config.ix_document_type === "invoice_receipt" ? "invoice_receipt" : "invoice",
        id: Number(invoice.invoice_id),
        state: "finalized"
      },
      headers: ixHeaders
    });

    console.log(`[Rioko] Invoice finalized for order ${orderId}`, { data, error });

    // Mark webhook as processed
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "success");
    }

    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Finalized", status: 200 });
    return c.text("Invoice finalized", 200);
  } catch (e) {
    console.error(`[Rioko] Error finalizing invoice for order ${orderId}:`, e);

    // Mark webhook as failed
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "failed");
    }

    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: String(e), status: 500 });
    return c.text("Error finalizing invoice", 500);
  }
})


// Shopify refunds/create webhook endpoint
app.post("/webhooks/shopify/refunds-create", async (c) => {
  const webhookTopic = "refunds/create";
  const webhookId = c.req.header("x-shopify-webhook-id");
  const appStorage = new AppStorage(c);

  const config = await appStorage.loadConfig();

  if (!config) {
    console.log("[Rioko] No config found for shopify domain");
    return c.text("No config found", 404);
  }

  // Check for duplicate webhook
  if (webhookId) {
    const { isProcessed, state } = await appStorage.isWebhookProcessed(webhookId, webhookTopic);
    if (isProcessed) {
      console.log(`[Rioko] Webhook ${webhookId} already ${state}, skipping`);
      return c.text("Webhook already processed", 200);
    }

    // Mark as processing
    if (state === "failed") {
      console.log(`[Rioko] Retrying failed webhook ${webhookId}`);
    }
    await appStorage.markWebhookAsProcessing(webhookId, webhookTopic);
  }

  const shopify = new Shopify(c, config);

  console.log(`[Rioko] Webhook Received: ${webhookTopic} for ${config.shopify_domain}`);
  const isWebhookValid = await shopify.verifyWebhook();

  if (!isWebhookValid) {
    console.error(`[Rioko] Invalid Webhook Signature for ${config.shopify_domain}.`);
    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Invalid Signature", status: 401 });
    return new Response("Invalid Signature", { status: 401 });
  }

  const refund = await c.req.json();
  const orderId = refund.order_id;

  if (!orderId) {
    console.log("[Rioko] Missing order_id in refund payload");
    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Missing order_id", status: 400 });
    return c.text("Missing order_id", 400);
  }

  console.log(`[Rioko] Refund received for order: ${orderId}, refund id: ${refund.id}`);

  try {
    // Normalize order using the order_id
    const normalizedOrderResponse = await shopify.normalizeOrder(String(orderId));

    if (!normalizedOrderResponse) {
      console.log(`[Rioko] Failed to normalize order for order ${orderId}`);
      await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Failed to normalize order", status: 400 });
      return c.text("Failed to normalize order", 400);
    }

    // Search for invoice with retry logic
    const invoice = await pRetry(async () => {
      const invoiceRef = await appStorage.getInvoiceByOrderId(String(normalizedOrderResponse.normalized.order.id));

      if (!invoiceRef || !invoiceRef.invoice_id) {
        throw new Error(`Invoice not found by order.id=${normalizedOrderResponse.normalized.order.id}`);
      }

      return invoiceRef;
    }, {
      retries: 10,
    });

    const ixHeaders = {
      "x-account-name": config.ix_account_name!,
      "x-api-key": config.ix_api_key!,
      "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
    };

    // Get the invoice from InvoiceXpress
    const { data: ixInvoice } = await IxApi.v2.documents.byId.get({
      headers: ixHeaders,
      path: {
        id: Number(invoice.invoice_id),
      }
    });

    // Get existing credit notes
    const { data: creditNotesData } = await IxApi.v2.documents.byId.related.get({
      headers: ixHeaders,
      path: {
        id: Number(invoice.invoice_id)
      }
    });

    const creditNotes = (creditNotesData?.data?.documents ?? [])
      .filter(document => document.type === "CreditNote");

    // Process each credit/refund
    const credits = normalizedOrderResponse.normalized.credits.map(credit => {
      const lineItems = credit.line_items;
      const sum = lineItems.reduce((acc, item) => acc + item.subtotal, 0);
      const amount = credit.amount;

      return {
        refundId: credit.refund_id,
        itemsIds: lineItems.map(item => item.id),
        amountToRefund: amount - sum
      };
    }).filter(credit =>
      !creditNotes.some(note => note.reference === `OrderRefund #${credit.refundId}`)
    );

    const ixBuilder = new IxBuilder(config);
    const invoiceBuildResult = ixBuilder.createInvoiceFromNormalizedOrder(normalizedOrderResponse.normalized);

    // Create credit notes for each refund
    await Promise.all(
      credits.map(async credit => {
        // Get normalized items for this credit
        const normalizedItems = normalizedOrderResponse.normalized.order.items.filter(item =>
          credit.itemsIds.includes(item.id)
        );
        const items = ixBuilder.buildInvoiceItems(normalizedItems);

        // Add refund amount as a line item if there's a difference
        if (credit.amountToRefund > 0) {
          const taxes = invoiceBuildResult.invoice.items.map(item => item.tax);
          const maxTax = taxes.reduce((a, b) =>
            (typeof a === "number" ? a : a.value) >= (typeof b === "number" ? b : b.value) ? a : b
          ) ?? 0;

          const taxPercentage = (typeof maxTax === "number" ? maxTax : maxTax.value) / 100;

          items.push({
            quantity: 1,
            tax: maxTax,
            unit_price: credit.amountToRefund / (1 + taxPercentage),
            description: `Refund amount of ${credit.amountToRefund}`,
            name: `Refund amount (#${credit.refundId})`,
          });
        }

        const requireTaxExemption = items.some(item =>
          typeof item.tax === "number" ? item.tax === 0 : item.tax.value === 0
        );

        const creditNote: IxCreditNote = {
          ...invoiceBuildResult.invoice,
          items: items,
          reference: `OrderRefund #${credit.refundId}`,
          tax_exemption_reason: requireTaxExemption
            ? ixInvoice?.data?.tax_exemption ?? config.ix_exemption_reason ?? undefined
            : undefined,
          owner_invoice_id: Number(invoice.invoice_id)
        };

        // Create credit note
        const { data: creditNoteResponse, error } = await IxApi.v2.creditNotes.post({
          headers: ixHeaders,
          body: {
            credit_note: creditNote
          },
          query: {
            resolvers: "on_tax_fallback_search_tax_by_value"
          }
        });

        // Finalize credit note
        const creditNoteId = (creditNoteResponse?.data as any)?.id ??
          (creditNoteResponse?.data as any)?.credit_note?.id ??
          (creditNoteResponse?.data as any)?.creditNote?.id;

        if (creditNoteId) {
          await IxApi.v2.changeState.post({
            body: {
              type: "credit_note",
              id: creditNoteId,
              state: "finalized"
            },
            headers: ixHeaders
          });
        }

        console.log(`[Rioko] Credit note created for refund ${credit.refundId}`, { error });
      })
    );

    console.log(`[Rioko] Refund processed for order ${orderId}`);

    // Mark webhook as processed
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "success");
    }

    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Processed", status: 200 });
    return c.text("Refund processed", 200);
  } catch (e) {
    console.error(`[Rioko] Error processing refund for order ${orderId}:`, e);

    // Mark webhook as failed
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "failed");
    }

    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: String(e), status: 500 });
    return c.text("Error processing refund", 500);
  }
})

export default app;
