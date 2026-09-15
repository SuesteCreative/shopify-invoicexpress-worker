import type { Env } from "../env";
import type { IRequestConfig } from "../storage";
import { AppStorage } from "../storage";
import { Shopify } from "../shopify";
import { IxApi } from "../api/ix";
import { IxBuilder, type IxCreditNote } from "../ix/builder";
import { resolveExemptionCode } from "../ix/exemption";
import { makeViesChecker } from "../ix/vies";
import { isIntegrationPaused } from "../services/pause-gate";
import { loadProductOverrides } from "../services/product-overrides";
import { reportIncident } from "../services/incidents";
import { refundReference } from "../services/document-references";
import { ixEnvelopeError, ixRelatedDocuments } from "../adapters/destinations/ix-destination";
import { isAlreadyFinalizedIxError, isIxValidationRefusal } from "../adapters/destinations/ix-finalize";
import { mirrorItemsFromIxDocument, moneyRefunded, planRefundCredit, type LineSource } from "../ix/credit-mirror";
import { logDocumentEvent } from "../services/document-log";

/**
 * Whether a refund arriving with no invoice behind it is simply nothing to do.
 *
 * `only_invoice_when_paid` holds an unpaid order at orders/created, so a return
 * registered against one has no document to credit and never will. Shopify
 * fires refunds/create regardless (Angel #4814: 234,20 € awaiting Multibanco, a
 * 0,00 € refund logged against it, six retries and a critical alert about a
 * credit note nobody could have issued).
 *
 * Narrow on purpose: a PAID order whose refund lands before its invoice was
 * written is a transient race that must keep retrying, and an absent status
 * (the raw Shopify fetch failed) is unknown rather than unpaid.
 */
export function refundHasNothingToCredit(
  financialStatus: string | null | undefined,
  onlyInvoiceWhenPaid: number | null | undefined,
): boolean {
  if (onlyInvoiceWhenPaid !== 1) return false;
  const status = String(financialStatus ?? "").trim();
  if (!status) return false;
  return !["paid", "partially_refunded", "refunded"].includes(status);
}

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
      // See refundHasNothingToCredit: a return on an order that was never paid
      // has no document to credit, and never will.
      const financialStatus = String(normalizedOrderResponse.normalized.raw_order?.financial_status ?? "");
      if (refundHasNothingToCredit(financialStatus, config.only_invoice_when_paid)) {
        console.log(`[Rioko] Refund on never-paid order ${orderId} (financial_status=${financialStatus}) — nothing to credit`);
        if (webhookId) await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "success");
        await appStorage.saveLog({
          shopify_domain: config.shopify_domain,
          topic: webhookTopic,
          payload: JSON.stringify({ orderId, refundId: refund.id, financial_status: financialStatus }),
          response: "Skipped: order never paid — no invoice to credit",
          status: 200,
        });
        // The sale's own timeline is where "why is there no credit note" gets
        // answered, months later, by someone with no memory of today.
        await logDocumentEvent(env, {
          externalId: String(orderId),
          event: "skipped",
          dedupKey: `skipped:refund-unpaid:${refund.id}`,
          userId: config.user_id,
          shopifyDomain: config.shopify_domain,
          sourceKind: "shopify",
          destinationKind: "invoicexpress",
          actor: "pipeline",
          summary: `Devolução registada numa encomenda que nunca chegou a ser paga (${financialStatus}), por isso nunca foi facturada — não há documento para creditar. Nada a fazer.`,
          detail: { refundId: String(refund.id), financial_status: financialStatus },
        });
        return;
      }

      throw new Error(`Invoice not found by order.id=${normalizedOrderResponse.normalized.order.id}`);
    }

    const ixHeaders = {
      "x-account-name": config.ix_account_name!,
      "x-api-key": config.ix_api_key!,
      "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
    };

    // Get the invoice from InvoiceXpress
    const { data: ixInvoice, error: ixReadError } = await IxApi.v2.documents.byId.get({
      headers: ixHeaders,
      path: {
        id: Number(invoice.invoice_id),
      }
    });

    // An unreadable document is NOT a finalized one.
    //
    // `error` used not to be destructured at all, so a failed read produced
    // `ownerStatus = ""`, which is not "draft", which meant the guard below let
    // it through and we went on to credit a document whose state we did not
    // know. Refuse instead: the queue retries, and a refund is never lost by
    // waiting.
    const ixReadEnvelopeError = ixEnvelopeError(ixInvoice);
    if (ixReadError || ixReadEnvelopeError || !(ixInvoice as any)?.data) {
      const detail = JSON.stringify(ixReadError ?? ixReadEnvelopeError ?? "empty body").slice(0, 400);
      console.error(`[Rioko] Refund for order ${orderId}: could not read document ${invoice.invoice_id}: ${detail}`);
      await appStorage.saveLog({
        shopify_domain: config.shopify_domain,
        topic: webhookTopic,
        payload: JSON.stringify({ orderId, invoiceId: invoice.invoice_id }),
        response: `InvoiceXpress read failed for document ${invoice.invoice_id}: ${detail}`,
        status: 500,
      });
      if (webhookId) await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "failed");
      throw new Error(`InvoiceXpress read failed for document ${invoice.invoice_id}: ${detail}`);
    }

    // A credit note can only be issued against a FINALIZED document — there is
    // nothing to correct on a draft, and InvoiceXpress rejects the attempt. The
    // remedy for a refunded draft is to edit it or delete it, which is a human
    // decision (the merchant may want to reissue with the right amount, or drop
    // the document entirely), so we surface it instead of guessing.
    //
    // This is not an edge case: 7 of the 14 Shopify shops run with auto_finalize
    // off, so every one of their invoices is a draft. Without this guard each
    // refund on those shops burned the full queue retry budget on an attempt IX
    // was always going to refuse.
    const ownerStatus = String((ixInvoice?.data as any)?.status ?? "").toLowerCase();
    if (ownerStatus === "draft" || invoice.hold_reason) {
      const why = invoice.hold_reason
        ? `o documento está em rascunho retido (${invoice.hold_reason})`
        : "o documento ainda está em rascunho";
      console.log(`[Rioko] Refund for order ${orderId}: skipping credit note — ${why}`);
      await reportIncident(env, {
        user_id: config.user_id,
        severity: "warning",
        kind: "credit_note_on_draft",
        dedup_key: String(invoice.invoice_id),
        summary: `Reembolso na encomenda ${normalizedOrderResponse.normalized.order.order_number ?? orderId} não gerou nota de crédito porque ${why}. Corrija ou apague o rascunho ${invoice.invoice_id}.`,
        detail: { orderId: String(orderId), invoiceId: String(invoice.invoice_id), status: ownerStatus, holdReason: invoice.hold_reason ?? null },
        affected_ids: [String(orderId)],
        connection_label: "shopify → invoicexpress",
        order_ref: normalizedOrderResponse.normalized.order.order_number != null ? `#${normalizedOrderResponse.normalized.order.order_number}` : undefined,
      });
      if (webhookId) await appStorage.markWebhookAsProcessed(webhookId, webhookTopic, "success");
      await logDocumentEvent(env, {
        externalId: String(orderId),
        event: "skipped",
        dedupKey: `skipped:credit_held:${invoice.invoice_id}`,
        invoiceId: String(invoice.invoice_id),
        userId: config.user_id,
        shopifyDomain: config.shopify_domain,
        sourceKind: "shopify",
        destinationKind: "invoicexpress",
        actor: "pipeline",
        summary: `Reembolso sem nota de crédito: ${why}. Um rascunho corrige-se ou apaga-se; só um documento fechado se credita.`,
        detail: { invoiceId: String(invoice.invoice_id), status: ownerStatus, holdReason: invoice.hold_reason ?? null },
      });
      await appStorage.saveLog({
        shopify_domain: config.shopify_domain,
        topic: webhookTopic,
        payload: JSON.stringify({ orderId, invoiceId: invoice.invoice_id, status: ownerStatus }),
        response: `Skipped credit note: ${why} — corrigir/apagar o rascunho`,
        status: 200,
      });
      return;
    }

    // What InvoiceXpress already holds against this invoice — ADVISORY now.
    //
    // This read used to be the only thing standing between a retry and a second
    // credit note, and its error was discarded, so a failed read meant "there
    // are none". That is how one Bikini Books refund became 22 credit notes on
    // 2026-09-14. The authority is now the local ledger (`credit_notes`), and
    // this stays only because it still catches a note issued by another path
    // (an admin cancel, a previous integrator) that the ledger never saw.
    const { data: creditNotesData, error: relatedError } = await IxApi.v2.documents.byId.related.get({
      headers: ixHeaders,
      path: {
        id: Number(invoice.invoice_id)
      }
    });
    if (relatedError || ixEnvelopeError(creditNotesData)) {
      console.warn(
        `[Rioko] Could not read related documents of ${invoice.invoice_id}: `
        + JSON.stringify(relatedError ?? ixEnvelopeError(creditNotesData)).slice(0, 300)
        + " — continuing on the local ledger",
      );
    }

    const creditNotes = ixRelatedDocuments(creditNotesData)
      .filter((document: any) => document.type === "CreditNote")
      .filter((document: any) => {
        const s = String(document?.status ?? "").toLowerCase();
        return s !== "canceled" && s !== "cancelled" && s !== "deleted";
      });

    // The credit note mirrors the invoice, so all a refund has to carry is which
    // articles came back and how much money went out. The arithmetic that used
    // to live here — Σ(subtotal + total_tax), and an `amountToRefund` remainder
    // billed as an extra line — is gone: on a VAT-inclusive shop it counted the
    // tax twice, and closing the gap it opened is what produced a 23% "Refund
    // amount" line in place of a 6% book.
    const rawRefunds = Array.isArray(normalizedOrderResponse.normalized.raw_order?.refunds)
      ? normalizedOrderResponse.normalized.raw_order.refunds
      : [];
    const credits = normalizedOrderResponse.normalized.credits.map(credit => ({
      refundId: credit.refund_id,
      lineItems: credit.line_items,
      amount: credit.amount,
      rawRefund: rawRefunds.find((r: any) => String(r?.id) === String(credit.refund_id)) ?? null,
    })).filter(credit =>
      !creditNotes.some(note => note.reference === refundReference(credit.refundId))
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

    // The document as InvoiceXpress actually holds it, and the rebuild of the
    // order through the same builder that produced it. The first is what the
    // credit note mirrors; the second only says which line of it corresponds to
    // each returned article, and is cross-checked against the first so an
    // invoice edited by hand after issue cannot silently mis-attach a refund.
    const trace: LineSource[] = [];
    const rebuilt = normalizedOrderResponse.normalized.raw_order
      ? ixBuilder.buildInvoiceItemsFromRaw(normalizedOrderResponse.normalized.raw_order, {
          forceZeroTax: build.reverseCharge,
          trace,
        })
      : undefined;
    const taxesIncluded = normalizedOrderResponse.normalized.raw_order?.taxes_included === true;
    // What the order is worth NOW, in Shopify's own terms — the floor no credit
    // note may take the invoice below. Only comparable with an invoice in euros.
    const rawOrderNow = normalizedOrderResponse.normalized.raw_order;
    const orderCurrentTotal = rawOrderNow?.currency === "EUR" && Number.isFinite(Number(rawOrderNow?.current_total_price))
      ? Number(rawOrderNow.current_total_price)
      : null;
    const ownerTotal = Number((ixInvoice?.data as any)?.total);
    // The ledger is keyed per account, not per shop: a connection may have no
    // shop domain, and the credit note belongs to the account either way.
    const ledgerScope = config.user_id || config.shopify_domain || "";

    // Sequentially, NOT Promise.all: two refunds of the same order arrive in one
    // batch and both have to be measured against what the other one has already
    // taken off the invoice. Which is exactly this order — 15 € of shipping and
    // 42 € of book against a 57 € invoice.
    for (const credit of credits) {
        // May we issue this one at all? Local, durable and fail-closed — see
        // AppStorage.claimRefundCredit.
        // What the transactions paid back — for the ledger and for every message
        // below. Never the normalizer's `amount`, which can count the tax twice
        // (it called a 0,00 € refund "103,07 €").
        const paidBack = moneyRefunded(credit.rawRefund, Number(credit.amount));
        const claim = await appStorage.claimRefundCredit(
          ledgerScope, credit.refundId, String(invoice.invoice_id), paidBack,
        );
        if (claim.status === "blocked") {
          throw new Error(
            `Não consegui ler o registo de notas de crédito para o reembolso ${credit.refundId} — `
            + `não emito às cegas. A fila volta a tentar.`,
          );
        }
        if (claim.status === "done") {
          console.log(`[Rioko] Refund ${credit.refundId} already ${claim.state} (credit note ${claim.creditNoteId ?? "—"}) — nothing to do`);
          continue;
        }
        if (claim.status === "held") {
          console.log(`[Rioko] Refund ${credit.refundId} is being issued elsewhere${claim.creditNoteId ? ` (document ${claim.creditNoteId})` : ""} — leaving it alone`);
          continue;
        }

        const alreadyCredited = await appStorage.creditedTotalForInvoice(ledgerScope, String(invoice.invoice_id));
        if (alreadyCredited == null) {
          await appStorage.releaseRefundCredit(ledgerScope, credit.refundId);
          throw new Error(
            `Não consegui somar as notas de crédito já emitidas sobre ${invoice.invoice_id} — `
            + `não emito sem saber quanto já foi creditado.`,
          );
        }

        // Refusing is a real outcome, not an error: it means no credit note can
        // mirror this refund, and a person has to decide. It must never throw —
        // a throw is what sent the whole order back through the queue 42 times.
        // `incident: false` is for a refund with nothing to credit (no money went
        // back): recorded once so redeliveries stay quiet, but nobody is alerted,
        // because there is nothing for anyone to do.
        const refuse = async (reason: string, detailExtra: Record<string, unknown> = {}, opts: { incident?: boolean } = {}) => {
          console.warn(`[Rioko] Refund ${credit.refundId} on order ${orderId}: ${reason}`);
          await appStorage.markRefundCreditRefused(ledgerScope, credit.refundId, reason);
          if (opts.incident !== false) await reportIncident(env, {
            user_id: config.user_id,
            severity: "warning",
            kind: "credit_note_not_mirrored",
            dedup_key: String(credit.refundId),
            summary: `Reembolso de ${paidBack.toFixed(2)} € na encomenda `
              + `${normalizedOrderResponse.normalized.order.order_number ?? orderId} sem nota de crédito: ${reason}. `
              + `O documento ${invoice.invoice_id} tem de ser creditado à mão.`,
            detail: { orderId: String(orderId), invoiceId: String(invoice.invoice_id), refundId: String(credit.refundId), amount: paidBack, ...detailExtra },
            affected_ids: [String(orderId)],
            connection_label: "shopify → invoicexpress",
            order_ref: normalizedOrderResponse.normalized.order.order_number != null ? `#${normalizedOrderResponse.normalized.order.order_number}` : undefined,
          });
          await logDocumentEvent(env, {
            externalId: String(orderId),
            event: "skipped",
            dedupKey: `skipped:credit_not_mirrored:${credit.refundId}`,
            invoiceId: String(invoice.invoice_id),
            userId: config.user_id,
            shopifyDomain: config.shopify_domain,
            sourceKind: "shopify",
            destinationKind: "invoicexpress",
            actor: "pipeline",
            summary: opts.incident === false
              ? `Reembolso ${credit.refundId} sem nota de crédito: ${reason}.`
              : `Reembolso ${credit.refundId} sem nota de crédito: ${reason}. `
                + `Uma nota de crédito é o espelho da fatura, e este reembolso não se espelha nela — decisão para uma pessoa.`,
            detail: { refundId: String(credit.refundId), amount: paidBack, reason },
          });
          await appStorage.saveLog({
            shopify_domain: config.shopify_domain,
            topic: webhookTopic,
            payload: JSON.stringify({ orderId, refundId: credit.refundId, invoiceId: invoice.invoice_id }),
            response: `Skipped credit note: ${reason}`,
            status: 200,
          });
        };

        // The invoice's own lines. If the read-back cannot even reproduce the
        // document's total, there is nothing safe to mirror.
        let docItems;
        try {
          docItems = mirrorItemsFromIxDocument(ixInvoice?.data).items;
        } catch (e) {
          await refuse(String((e as Error)?.message ?? e));
          continue;
        }

        const plan = planRefundCredit({
          docTotal: ownerTotal,
          docItems,
          sources: trace,
          refund: { refundId: credit.refundId, amount: Number(credit.amount), lineItems: credit.lineItems as any },
          rawRefund: credit.rawRefund,
          taxesIncluded,
          alreadyCredited,
          orderCurrentTotal,
          rebuilt: rebuilt as any,
        });

        if (!plan.ok) {
          await refuse(plan.reason, plan.detail, { incident: !plan.nothingToCredit });
          continue;
        }

        const items = plan.items as any[];

        // A 0% line can only be here because the invoice itself carries one, so
        // the code that goes with it is the document's own — which is what
        // resolveExemptionCode prefers. Reverse charge needs no special case any
        // more: a reverse-charge invoice is already all-zero-rated, and its
        // mirror inherits that.
        const requireTaxExemption = items.some(item =>
          typeof item.tax === "number" ? item.tax === 0 : item.tax.value === 0
        );

        const reverseChargeReason = build.reverseCharge
          ? (config.ix_b2b_exemption_reason ?? "M16")
          : null;

        const creditNote: IxCreditNote = {
          ...invoiceBuildResult.invoice,
          items: items,
          reference: refundReference(credit.refundId),
          tax_exemption_reason: reverseChargeReason
            ?? (requireTaxExemption
              ? resolveExemptionCode(ixInvoice?.data?.tax_exemption, config.ix_exemption_reason) ?? undefined
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

        // Did the credit note get created?
        //
        // `error` was destructured and never read. When IX refused, `creditNoteId`
        // came out undefined, the whole finalize/email block below was skipped,
        // and the only trace was a console line — while the outer flow went on to
        // write "Processed" with status 200. A refund the buyer already received
        // ended up with no credit note and no record saying so.
        const creditEnvelopeError = ixEnvelopeError(creditNoteResponse);
        const creditNoteId = (creditNoteResponse?.data as any)?.id ??
          (creditNoteResponse?.data as any)?.credit_note?.id ??
          (creditNoteResponse?.data as any)?.creditNote?.id;

        if (error || creditEnvelopeError || !creditNoteId) {
          const detail = JSON.stringify(error ?? creditEnvelopeError ?? "no id in response").slice(0, 500);
          console.error(`[Rioko] Credit note refused for refund ${credit.refundId} (invoice ${invoice.invoice_id}): ${detail}`);
          // Nothing was created, so a later delivery may legitimately try again
          // — unless InvoiceXpress refused the document itself, in which case it
          // will refuse it identically for ever and the ledger says so once.
          if (isIxValidationRefusal(detail)) {
            await refuse(`o InvoiceXpress recusou a nota de crédito: ${detail}`);
            continue;
          }
          await appStorage.releaseRefundCredit(ledgerScope, credit.refundId);
          throw new Error(`InvoiceXpress credit create failed for refund ${credit.refundId}: ${detail}`);
        }

        {
          // Finalize credit note. Its refusal was discarded too — an unfinalized
          // credit note is not a fiscal document.
          const { data: cnFinalizeData, error: cnFinalizeError } = await IxApi.v2.changeState.post({
            body: {
              type: "credit_note",
              id: creditNoteId,
              state: "finalized"
            },
            headers: ixHeaders
          });
          const cnFinalizeEnvelope = ixEnvelopeError(cnFinalizeData);
          const cnProblem = cnFinalizeError ?? cnFinalizeEnvelope;
          if (cnProblem && !isAlreadyFinalizedIxError(cnProblem)) {
            const detail = JSON.stringify(cnProblem).slice(0, 500);
            console.error(`[Rioko] Credit note ${creditNoteId} created but not finalized: ${detail}`);

            // Take the draft back out before giving up. A credit note that
            // never finalized is not a fiscal document, but it IS a row in the
            // merchant's InvoiceXpress account, and the queue is about to retry
            // and make another one. Leaving them is how Estrela accumulated
            // eleven identical drafts against a single refund.
            //
            // Best-effort on purpose: if the delete fails there is nothing more
            // this can do, and the finalize error is the one worth reporting.
            // `changeState` to "deleted" is how a draft is withdrawn here —
            // there is no REST delete for a document (see IxDestination.deleteDraft).
            let withdrawn = false;
            try {
              const { data: cnDeleteData, error: cnDeleteError } = await IxApi.v2.changeState.post({
                body: { type: "credit_note", id: Number(creditNoteId), state: "deleted" },
                headers: ixHeaders,
              });
              const deleteProblem = cnDeleteError ?? ixEnvelopeError(cnDeleteData);
              if (deleteProblem) {
                console.error(`[Rioko] Could not remove unfinalized credit note ${creditNoteId}: ${JSON.stringify(deleteProblem).slice(0, 300)}`);
              } else {
                withdrawn = true;
              }
            } catch (deleteError) {
              console.error(`[Rioko] Could not remove unfinalized credit note ${creditNoteId}: ${deleteError}`);
            }

            // Whether a retry may make another one depends entirely on whether
            // this one is really gone. Withdrawn → give the ledger row back.
            // Still there → write its id into the row, which is what makes the
            // claim untakeable, so the next delivery reports the stranded draft
            // instead of putting a twin beside it.
            if (withdrawn && isIxValidationRefusal(detail)) {
              // Gone from the account, and refused for its content — "O total não
              // pode ser superior ao total dos documentos relacionados" when the
              // invoice is already credited by notes this ledger never saw. The
              // next delivery would be refused identically, so say it once and stop.
              await refuse(`o InvoiceXpress recusou certificar a nota de crédito: ${detail}`);
              continue;
            } else if (withdrawn) {
              await appStorage.releaseRefundCredit(ledgerScope, credit.refundId);
            } else {
              await appStorage.noteRefundCreditDraft(
                ledgerScope, credit.refundId, creditNoteId,
                `rascunho ${creditNoteId} não certificado e não removido: ${detail}`,
              );
            }

            throw new Error(`InvoiceXpress finalize failed for credit note ${creditNoteId}: ${detail}`);
          }
        }

        // The document is fiscal from here on. The ledger is written BEFORE the
        // log and before the email, because everything after this point may fail
        // without making the credit note any less issued — and a retry that
        // found the row missing would issue a second one.
        await appStorage.markRefundCredited(ledgerScope, credit.refundId, creditNoteId, plan.total);

        // Written before the email block, whose missing-address path skips the
        // rest — the credit note exists and is finalized at this point.
        await logDocumentEvent(env, {
          externalId: String(orderId),
          event: "credit_issued",
          dedupKey: `credit_issued:${credit.refundId}`,
          invoiceId: String(invoice.invoice_id),
          userId: config.user_id,
          shopifyDomain: config.shopify_domain,
          sourceKind: "shopify",
          destinationKind: "invoicexpress",
          actor: "pipeline",
          summary: `Nota de crédito ${creditNoteId} emitida e fechada por ${plan.total.toFixed(2)} € sobre o documento ${invoice.invoice_id} (reembolso ${credit.refundId}).`,
          detail: { creditNoteId, refundId: credit.refundId, amount: plan.total },
        });

        if (config.ix_send_email) {
            // if (!creditNote.client.email || !creditNote.client.fiscal_id) {
            if (!creditNote.client.email) {
              // console.error(`[Rioko] Refund has no email address or nif`);
              console.error(`[Rioko] Refund has no email address`);
              continue;
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

        console.log(`[Rioko] Credit note ${creditNoteId} issued and finalized for refund ${credit.refundId}`);
    }

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
