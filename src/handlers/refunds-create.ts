import type { Env } from "../env";
import type { IRequestConfig } from "../storage";
import { AppStorage } from "../storage";
import { Shopify } from "../shopify";
import { IxApi } from "../api/ix";
import { IxBuilder, type IxCreditNote } from "../ix/builder";

export async function handleRefundCreate(env: Env, config: IRequestConfig, webhookId: string | null, refund: any) {
  const webhookTopic = "refunds/create";
  const appStorage = new AppStorage(env, config.shopify_domain!);

  const orderId = refund.order_id;

  if (!orderId) {
    console.log("[Rioko] Missing order_id in refund payload");
    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: "Missing order_id", status: 400 });
    throw new Error("Missing order_id in refund payload");
  }

  console.log(`[Rioko] Refund received for order: ${orderId}, refund id: ${refund.id}`);

  try {
    // Normalize order using the order_id
    const shopify = new Shopify(env.NORMALIZE_SHOPIFY_ORDER_API_KEY, config);
    const normalizedOrderResponse = await shopify.normalizeOrder(String(orderId));

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

          if (config.ix_send_email) {
            if (!creditNote.client.email || !creditNote.client.fiscal_id) {
              console.error(`[Rioko] Refund has no email address or nif`);
              return;
            }

            const { error } = await IxApi.v2.documents.byId.email.post({
              body: {
                message: {
                  client: {
                    email: creditNote.client.email,
                    save: "0"
                  },
                  body: config.ix_email_body ?? undefined,
                  subject: config.ix_email_subject ?? undefined
                }
              },
              path: {
                id: Number(creditNoteId)
              },
              query: {
                type: "credit_notes"
              },
              headers: ixHeaders
            });

            if (error) {
              console.error(`[Rioko] Failed to send invoice by id ${invoice.invoice_id}:`, error);
              throw new Error(`Failed to send credit note email for invoice ${invoice.invoice_id}`);
            }
          }
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
  } catch (e) {
    console.error(`[Rioko] Error processing refund for order ${orderId}:`, e);

    // Mark webhook as failed
    if (webhookId) {
      await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "failed");
    }

    await appStorage.saveLog({ shopify_domain: config.shopify_domain, topic: webhookTopic, payload: "", response: String(e), status: 500 });
    throw e;
  }
}
