import type { Env } from "../env";
import type { IRequestConfig } from "../storage";
import { AppStorage } from "../storage";
import { Shopify } from "../shopify";
import { IxApi } from "../api/ix";
import { IxBuilder } from "../ix/builder";
import { makeViesChecker } from "../ix/vies";

export async function handleOrderUpdated(env: Env, config: IRequestConfig, webhookId: string | null, order: any) {
  const webhookTopic = "orders/updated";
  const appStorage = new AppStorage(env, config.shopify_domain!);

  const orderId = order.order_edit?.order_id ?? order.order_edit?.id ?? order.order_id ?? order.id;
  console.log(`[Rioko] Order received: ${orderId}`);
  console.log(order);

  try {
    // Normalize order
    const shopify = new Shopify(env.NORMALIZE_SHOPIFY_ORDER_API_KEY, config);
    const normalizedOrderResponse = await shopify.normalizeOrder(orderId);

    if (!normalizedOrderResponse) {
      console.log(`[Rioko] Failed to normalize order for order ${orderId}`);
      await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Failed to normalize order", status: 400 });
      throw new Error(`Failed to normalize order for order ${orderId}`);
    }

    // Search for invoice — if not found, throw so the queue retries in 60s
    const invoice = await appStorage.getInvoiceByOrderId(String(normalizedOrderResponse.normalized.order.id));

    if (!invoice || !invoice.invoice_id) {
      throw new Error(`Invoice not found by order.id=${normalizedOrderResponse.normalized.order.id}`);
    }

    const viesChecker = config.b2b_reverse_charge === 1 ? makeViesChecker(env.INVOICE_KV) : undefined;
    const ixBuilder = new IxBuilder(config, viesChecker);
    const build = await ixBuilder.createInvoiceFromNormalizedOrderAsync(normalizedOrderResponse.normalized);

    if (build.status === "deferred") {
      // Update path: keep the existing invoice as-is; queue a pending row so
      // the cron can decide later. We don't PUT until VIES gives a definitive
      // answer or a human approves/rejects.
      const nextRetryAt = new Date(Date.now() + 15 * 60_000).toISOString();
      await appStorage.enqueuePendingReverseCharge({
        shopify_domain: config.shopify_domain!,
        order_id: String(normalizedOrderResponse.normalized.order.id),
        vat_id: build.vatNumber,
        country_code: build.countryCode,
        normalized_json: JSON.stringify(normalizedOrderResponse.normalized),
        webhook_topic: webhookTopic,
        webhook_id: webhookId,
        next_retry_at: nextRetryAt,
      });
      if (webhookId) await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "success");
      await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Deferred: VIES retry queued", status: 202 });
      return;
    }
    const { invoice: invoiceData } = build;

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
  } catch (e) {
    console.error(`[Rioko] Error updating invoice for order ${orderId}:`, e);

    // Mark webhook as failed
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "failed");
    }

    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: String(e), status: 500 });
    throw e;
  }
}
