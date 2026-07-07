import type { Env } from "../env";
import type { IRequestConfig } from "../storage";
import { AppStorage } from "../storage";
import { Shopify } from "../shopify";
import { IxApi } from "../api/ix";
import { IxBuilder, type IxCreditNote } from "../ix/builder";
import { makeViesChecker } from "../ix/vies";
import { isIntegrationPaused } from "../services/pause-gate";
import { loadProductOverrides } from "../services/product-overrides";

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

  // Pause switch — silently skip credit-note creation when paused.
  if (await isIntegrationPaused(env, config, webhookTopic, orderId)) return;

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
      // GROSS sum of the returned lines. `credit.amount` is tax-INCLUSIVE, and
      // the item lines we rebuild below already carry their own tax, so the
      // "extra" amount to bill separately is only what the refund covers BEYOND
      // the returned lines (shipping / a discretionary cash amount) — i.e.
      // amount − Σ(subtotal + total_tax). Using the net subtotal here (the old
      // bug) left Σtax as a phantom extra line, inflating the credit note by the
      // tax and tripping the reconcile guard so no credit note was ever emitted
      // for a normal line-item refund.
      const sum = lineItems.reduce((acc, item) => acc + item.subtotal + (item.total_tax ?? 0), 0);
      const amount = credit.amount;

      return {
        refundId: credit.refund_id,
        itemsIds: lineItems.map(item => item.id),
        // Carry the refunded lines through so the credit note is built from the
        // amounts ACTUALLY refunded (qty/subtotal/total_tax), not the order's
        // full-price lines — see buildCreditItemsFromRefund below.
        lineItems,
        amountToRefund: amount - sum,
        // Carry the gross refund amount through so the credit-note total can be
        // reconciled against it before POST (see guard below).
        amount,
      };
    }).filter(credit =>
      !creditNotes.some(note => note.reference === `OrderRefund #${credit.refundId}`)
    );

    const viesChecker = config.b2b_reverse_charge === 1 ? makeViesChecker(env.INVOICE_KV) : undefined;
    const productOverrides = config.user_id
      ? await loadProductOverrides(env, config.user_id, "shopify", "invoicexpress")
      : undefined;
    const ixBuilder = new IxBuilder(config, viesChecker, productOverrides);
    const build = await ixBuilder.createInvoiceFromNormalizedOrderAsync(normalizedOrderResponse.normalized);

    if (build.status === "deferred") {
      // Refund came in before VIES validation finished. Queue a pending row;
      // the cron + manual approval will eventually issue the credit note via
      // a follow-up path. (For v1 we defer the credit-note creation entirely;
      // when reverse-charge is finally decided, this refund will be retried
      // via the orders/updated re-emission.)
      const nextRetryAt = new Date(Date.now() + 15 * 60_000).toISOString();
      await appStorage.enqueuePendingReverseCharge({
        shopify_domain: config.shopify_domain ?? null,
        user_id: config.user_id,
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
    const invoiceBuildResult = { invoice: build.invoice, requestTaxExemptionReason: build.requestTaxExemptionReason };

    // Build one credit-note line per REFUNDED line item, from the refund's own
    // numbers (qty, net subtotal, total_tax) — NOT the order's full-price lines.
    // This is what makes partial refunds (partial quantity, discounted lines,
    // multi-line orders) reconcile to the amount actually refunded: line gross =
    // subtotal + total_tax, so Σ lines + (non-line-item remainder) = credit.amount.
    // The order item is looked up only for the human name / SKU. reverseCharge
    // forces the rate to 0 (M16 exemption stamped separately).
    const orderItemsById = new Map(
      normalizedOrderResponse.normalized.order.items.map(it => [it.id, it]),
    );
    const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const buildCreditItemsFromRefund = (
      refundLines: Array<{ id: number; quantity: number; subtotal: number; total_tax: number }>,
      forceZeroTax: boolean,
    ): any[] => {
      const out: any[] = [];
      for (const li of refundLines) {
        const qty = Number(li.quantity) || 1;
        const net = Number(li.subtotal);        // net amount refunded for this line
        const tax = Number(li.total_tax ?? 0);  // tax refunded for this line
        if (!(net > 0) && !(tax > 0)) continue;
        const rate = forceZeroTax ? 0 : (net > 0 ? round2((tax / net) * 100) : 0);
        const oi: any = orderItemsById.get(li.id);
        const name = (oi
          ? (oi.variant_title ? `${oi.title} / ${oi.variant_title}` : oi.title)
          : `Item devolvido #${li.id}`) || "Item devolvido";
        const line: any = { quantity: qty, tax: rate, unit_price: round4(net / qty), name: String(name).slice(0, 200) };
        if (oi?.sku) line.description = `SKU: ${oi.sku}`.slice(0, 200);
        out.push(line);
      }
      return out;
    };

    // Create credit notes for each refund
    await Promise.all(
      credits.map(async credit => {
        const items = buildCreditItemsFromRefund(credit.lineItems as any, build.reverseCharge);

        // Reconcile the reconstructed lines to the GROSS actually refunded.
        // Recompute the lines' gross with IX's own round-once model, then close
        // the gap to credit.amount:
        //   • remainder > 0  → the refund covered something beyond the returned
        //     lines (shipping / discretionary cash): add one extra line for it.
        //   • remainder < 0  → the refund gave back LESS than the returned lines'
        //     value (restocking fee / partial-value refund): scale the lines down
        //     with a uniform positive discount so the note totals what was paid.
        const grossLines = items.length > 0 ? ixBuilder.computeIxExpectedTotal(items as any) : 0;
        const remainder = round2(Number(credit.amount) - grossLines);
        if (remainder > 0.01) {
          const taxes = invoiceBuildResult.invoice.items.map(item => item.tax);
          const maxTax = build.reverseCharge ? 0 : (taxes.reduce((a, b) =>
            (typeof a === "number" ? a : a.value) >= (typeof b === "number" ? b : b.value) ? a : b
          ) ?? 0);

          const taxPercentage = (typeof maxTax === "number" ? maxTax : maxTax.value) / 100;

          items.push({
            quantity: 1,
            tax: maxTax,
            unit_price: remainder / (1 + taxPercentage),
            description: `Refund amount of ${remainder}`,
            name: `Refund amount (#${credit.refundId})`,
          });
        } else if (remainder < -0.01 && grossLines > 0) {
          const discountPct = round4(Math.max(0, (1 - Number(credit.amount) / grossLines) * 100));
          for (const it of items) {
            (it as any).discount = discountPct;
          }
        }

        // Guard: the credit-note total MUST equal the amount actually refunded
        // (credit.amount = gross refunded, verified against live refunds). The
        // invoice path reconciles; this path historically did not, so a wrong
        // total — e.g. the `amountToRefund` line double-counting tax on a partial
        // line-item refund, or a dropped discount (IX ignores items[].discount_amount)
        // — would ship a fiscally-wrong credit note. Abort instead: the queue
        // retries and the DLQ raises an incident, rather than issuing a bad doc.
        // Uses IX's round-once model (computeIxExpectedTotal) so it agrees with
        // what IX will actually compute.
        const refundAmount = Number(credit.amount);
        if (Number.isFinite(refundAmount) && refundAmount > 0) {
          const expectedCredit = ixBuilder.computeIxExpectedTotal(items as any);
          const creditDrift = Math.abs(expectedCredit - refundAmount);
          if (creditDrift > 0.01) {
            throw new Error(
              `[Shopify→IX credit note #${credit.refundId}] invoice total mismatch: refund=${refundAmount.toFixed(2)} expected=${expectedCredit.toFixed(2)} drift=${creditDrift.toFixed(2)}. Items=${JSON.stringify(items)}`,
            );
          }
        }

        const requireTaxExemption = items.some(item =>
          typeof item.tax === "number" ? item.tax === 0 : item.tax.value === 0
        );

        const reverseChargeReason = build.reverseCharge
          ? (config.ix_b2b_exemption_reason ?? "M16")
          : null;

        const creditNote: IxCreditNote = {
          ...invoiceBuildResult.invoice,
          items: items,
          reference: `OrderRefund #${credit.refundId}`,
          tax_exemption_reason: reverseChargeReason
            ?? (requireTaxExemption
              ? ixInvoice?.data?.tax_exemption ?? config.ix_exemption_reason ?? undefined
              : undefined),
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
            // if (!creditNote.client.email || !creditNote.client.fiscal_id) {
            if (!creditNote.client.email) {
              // console.error(`[Rioko] Refund has no email address or nif`);
              console.error(`[Rioko] Refund has no email address`);
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
