import type { Env } from "../env";
import type { IRequestConfig } from "../storage";
import { AppStorage } from "../storage";
import { Shopify } from "../shopify";
import { IxApi } from "../api/ix";
import { IxBuilder } from "../ix/builder";
import { makeViesChecker } from "../ix/vies";
import { isIntegrationPaused } from "../services/pause-gate";
import { loadProductOverrides } from "../services/product-overrides";

export async function handleOrderCreated(env: Env, config: IRequestConfig, webhookId: string | null, order: any) {
  const webhookTopic = "orders/created";
  const appStorage = new AppStorage(env, config.shopify_domain!);

  const orderId = order.id;
  console.log(`[Rioko] Order received: ${orderId}`);
  console.log(order);

  // Pause switch: merchant turned the integration off — log and exit.
  if (await isIntegrationPaused(env, config, webhookTopic, orderId)) return;

  // Check if order was already processed.
  const alreadyExists = await appStorage.isInvoiceAlreadyProcessed(orderId);
  if (alreadyExists) {
    console.log(`[Rioko] Invoice already processed for order ${orderId}`);
    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Already processed", status: 401 });
    return;
  }

  // Zero-amount short-circuit. PT fiscal rules don't require invoicing 0€
  // orders (gift cards, 100% discount, test orders) and IX would reject the
  // creation anyway. Mark the webhook as success so the queue stops retrying.
  const orderTotal = parseFloat(String(order.total_price ?? order.current_total_price ?? "0"));
  if (!Number.isFinite(orderTotal) || orderTotal <= 0) {
    console.log(`[Rioko] Skipping zero-amount order ${orderId} (total=${orderTotal})`);
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "success");
    }
    await appStorage.saveLog({
      shopify_domain: config.shopify_domain,
      topic: webhookTopic,
      payload: JSON.stringify({ orderId, total: orderTotal }),
      response: "Skipped: zero-amount order — no invoice required",
      status: 200,
    });
    return;
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
    // Persist the mapping. Without this, orders/paid can never find the invoice
    // (the IX doc exists but processed_orders has no row) and retries forever
    // with "Invoice not found by order.id".
    await appStorage.saveProcessedInvoice(orderId, String(ixExisting.data.data.id));
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "success");
    }
    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: JSON.stringify({ orderId, invoiceId: ixExisting.data.data.id }), response: "Already exists — linked", status: 200 });
    return;
  }

  const shopify = new Shopify(env.NORMALIZE_SHOPIFY_ORDER_API_KEY, config);
  const normalizedOrderResponse = await shopify.normalizeOrder(orderId);

  if (!normalizedOrderResponse) {
    console.log(`[Rioko] Failed to normalize order for order ${orderId}`);
    throw new Error(`Failed to normalize order for order ${orderId}`);
  }

  console.log(normalizedOrderResponse);

  const viesChecker = config.b2b_reverse_charge === 1 ? makeViesChecker(env.INVOICE_KV) : undefined;
  const productOverrides = config.user_id
    ? await loadProductOverrides(env, config.user_id, "shopify", "invoicexpress")
    : undefined;
  const ixBuilder = new IxBuilder(config, viesChecker, productOverrides);

  const build = await ixBuilder.createInvoiceFromNormalizedOrderAsync(normalizedOrderResponse.normalized);

  if (build.status === "deferred") {
    // VIES couldn't confirm in time. Queue for retry; do NOT create an invoice
    // yet. The 15-min cron will pick this up.
    const nextRetryAt = new Date(Date.now() + 15 * 60_000).toISOString();
    await appStorage.enqueuePendingReverseCharge({
      shopify_domain: config.shopify_domain!,
      order_id: String(orderId),
      vat_id: build.vatNumber,
      country_code: build.countryCode,
      normalized_json: JSON.stringify(normalizedOrderResponse.normalized),
      webhook_topic: webhookTopic,
      webhook_id: webhookId,
      next_retry_at: nextRetryAt,
    });
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "success");
    }
    await appStorage.saveLog({
      shopify_domain: config.shopify_domain,
      topic: webhookTopic,
      payload: JSON.stringify({ orderId, vat: `${build.countryCode}${build.vatNumber}` }),
      response: "Deferred: VIES retry queued",
      status: 202,
    });
    console.log(`[Rioko] Order ${orderId} deferred for VIES retry (vat=${build.countryCode}${build.vatNumber})`);
    return;
  }

  const { invoice, reverseCharge } = build;

  console.log(`[Rioko] Built follwoing invoice (reverseCharge=${reverseCharge})`);
  console.log(invoice);

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
  } else {
    console.log(`[Rioko] Failed to create invoice for order ${orderId}`);
    console.log(ixCreateResponse);

    // Mark webhook as failed
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "failed");
    }

    throw new Error(`Failed to create invoice for order ${orderId}`);
  }
}
