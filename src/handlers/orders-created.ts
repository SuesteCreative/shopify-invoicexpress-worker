import type { Env } from "../env";
import type { IRequestConfig } from "../storage";
import { AppStorage } from "../storage";
import { Shopify } from "../shopify";
import { IxApi } from "../api/ix";
import { IxBuilder } from "../ix/builder";

export async function handleOrderCreated(env: Env, config: IRequestConfig, webhookId: string | null, order: any) {
  const webhookTopic = "orders/created";
  const appStorage = new AppStorage(env, config.shopify_domain!);

  const orderId = order.id;
  console.log(`[Rioko] Order received: ${orderId}`);
  console.log(order);

  // Check if order was already processed.
  const alreadyExists = await appStorage.isInvoiceAlreadyProcessed(orderId);
  if (alreadyExists) {
    console.log(`[Rioko] Invoice already processed for order ${orderId}`);
    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Already processed", status: 401 });
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
    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Already exists", status: 401 });
    return;
  }

  const shopify = new Shopify(env.NORMALIZE_SHOPIFY_ORDER_API_KEY, config);
  const normalizedOrderResponse = await shopify.normalizeOrder(orderId);

  if (!normalizedOrderResponse) {
    console.log(`[Rioko] Failed to normalize order for order ${orderId}`);
    throw new Error(`Failed to normalize order for order ${orderId}`);
  }

  console.log(normalizedOrderResponse);

  const ixBuilder = new IxBuilder(config);

  const { invoice } = ixBuilder.createInvoiceFromNormalizedOrder(normalizedOrderResponse.normalized);

  console.log(`[Rioko] Built follwoing invoice`);
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
