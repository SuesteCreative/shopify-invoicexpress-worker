import type { Env } from "../env";
import type { IRequestConfig } from "../storage";
import { AppStorage } from "../storage";
import { Shopify } from "../shopify";
import { IxApi } from "../api/ix";
import pRetry from "p-retry";

export async function handleOrderPaid(env: Env, config: IRequestConfig, webhookId: string | null, order: any) {
  const webhookTopic = "orders/paid";
  const appStorage = new AppStorage(env, config.shopify_domain!);

  const orderId = order.id;
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

    // Search for invoice with retry logic
    const invoice = await pRetry(async () => {
      const invoiceRef = await appStorage.getInvoiceByOrderId(String(normalizedOrderResponse.normalized.order.id));

      if (!invoiceRef || !invoiceRef.invoice_id) {
        throw new Error(`Invoice not found by order.id=${normalizedOrderResponse.normalized.order.id}`);
      }

      return invoiceRef;
    }, {
      retries: 360,
      factor: 1,
      minTimeout: 1000,
      maxTimeout: 1000
    });

    // Check if auto_finalize is enabled
    const finalize = config.auto_finalize === 1;

    // Skip if we don't auto-finalize invoices
    if (!finalize) {
      console.log(`[Rioko] Auto-finalize disabled, skipping for order ${orderId}`);
      await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Auto-finalize disabled", status: 200 });
      return;
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

    if (config.ix_send_email) {
      const { data: invoiceData, error: invoiceError } = await IxApi.v2.documents.byId.get({
        headers: ixHeaders,
        path: {
          id: Number(invoice.invoice_id)
        }
      });

      if (invoiceError) {
        console.error(`[Rioko] Failed to get invoice by id ${invoice.invoice_id}:`, invoiceError);
        throw new Error(`Failed to get invoice by id ${invoice.invoice_id}`);
      }

      if (!invoiceData.data.client.email || !invoiceData.data.client.fiscal_id) {
        console.error(`[Rioko] Invoice ${invoice.invoice_id} has no email address or nif`);
        return;
      }

      const { error } = await IxApi.v2.documents.byId.email.post({
        body: {
          message: {
            client: {
              email: invoiceData.data.client.email,
              save: "0"
            },
            body: config.ix_email_body ?? undefined,
            subject: config.ix_email_subject ?? undefined
          }
        },
        path: {
          id: Number(invoice.invoice_id)
        },
        query: {
          type: config.ix_document_type === "invoice_receipt" ? "invoice_receipts" : "invoices"
        },
        headers: ixHeaders
      });

      if (error) {
        console.error(`[Rioko] Failed to send invoice by id ${invoice.invoice_id}:`, error);
        throw new Error(`Failed to send invoice by id ${invoice.invoice_id}`);
      }
    }
  } catch (e) {
    console.error(`[Rioko] Error finalizing invoice for order ${orderId}:`, e);

    // Mark webhook as failed
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "failed");
    }

    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: String(e), status: 500 });
    throw e;
  }
}
