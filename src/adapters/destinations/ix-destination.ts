import type {
  DestinationAdapter,
  AdapterCtx,
  DestinationInvoiceCreateResult,
  DestinationCreditResult,
  NormalizedRefund,
} from "../types";
import type { Normalized } from "../../api/normalize-shopify";
import { IxApi } from "../../api/ix";
import { IxBuilder, nifHoldReason, type IxCreditNote } from "../../ix/builder";
import { reconcileTotalOrThrow } from "../reconcile";
import { sendIxDocumentEmail, describeIxEmailOutcome } from "../../services/ix-document-email";

// Sequences cache: accountName → [{id, serie}]. Survives within a Worker isolate,
// flushed on cold start. The sequences list changes rarely so this is safe.
const sequencesCache = new Map<string, Array<{ id: number; serie: string }>>();

// Resolve the IX numeric sequence_id for a named series (e.g. "RVFR").
// Falls back to null (IX uses its default series) if the name isn't found or
// the sequences API call fails.
async function resolveSequenceId(ctx: AdapterCtx, seriesName: string): Promise<number | null> {
  const account = ctx.config.ix_account_name;
  const apiKey = ctx.config.ix_api_key;
  if (!account || !apiKey) return null;

  const cacheKey = `${account}:${ctx.config.ix_environment ?? "production"}`;
  let sequences = sequencesCache.get(cacheKey);

  if (!sequences) {
    try {
      const isTest = ctx.config.ix_environment !== "production";
      const suffix = isTest ? ".macewindu.invoicexpress.com" : ".invoicexpress.com";
      const res = await fetch(`https://${account}${suffix}/sequences.json?api_key=${encodeURIComponent(apiKey)}`);
      if (!res.ok) return null;
      const data = await res.json() as { sequences?: Array<{ id: number; serie: string }> };
      sequences = data.sequences ?? [];
      // Only cache a non-empty result. An empty list on first fetch (transient
      // network hiccup) must not freeze future lookups for the isolate lifetime.
      if (sequences.length > 0) sequencesCache.set(cacheKey, sequences);
    } catch {
      return null;
    }
  }

  const target = seriesName.trim().toUpperCase();
  const match = sequences.find(s => s.serie.trim().toUpperCase() === target);
  return match?.id ?? null;
}

function ixHeadersFromCtx(ctx: AdapterCtx) {
  return {
    "x-account-name": ctx.config.ix_account_name!,
    "x-api-key": ctx.config.ix_api_key!,
    "x-env": ctx.config.ix_environment === "production" ? "prod" as const : "dev" as const,
  };
}

// The document types IX can issue through the proxy. `simplified_invoice` is
// deliberately absent: ix-proxy.kapta.app's contract stops at
// invoice | invoice_receipt | credit_note, so selecting it would 4xx. The
// backoffice therefore offers Simplified for Moloni only.
const IX_DOC_TYPES = ["invoice", "invoice_receipt"] as const;
type IxDocType = typeof IX_DOC_TYPES[number];

/**
 * Unknown values fall back to `invoice`, as they always have.
 *
 * This used to be a bare `=== "invoice_receipt"` check, which meant a tag rule
 * storing the legacy "invoice_receipt_draft" produced a finalized *invoice* —
 * wrong collection and wrong state. normalizeRule now strips that suffix before
 * it reaches config, and this stays permissive as a second line of defence.
 */
function ixDocType(ctx: AdapterCtx): IxDocType {
  const t = String(ctx.config.ix_document_type ?? "").toLowerCase();
  return (IX_DOC_TYPES as readonly string[]).includes(t) ? (t as IxDocType) : "invoice";
}

export class InvoiceXpressDestination implements DestinationAdapter {
  readonly kind = "invoicexpress" as const;

  async findByReference(reference: string, ctx: AdapterCtx) {
    const res = await IxApi.v2.documents.reference.post({
      headers: ixHeadersFromCtx(ctx),
      body: { reference },
    });
    const id = res.data?.data?.id;
    return id ? { id: String(id) } : null;
  }

  async createDraft(normalized: Normalized, ctx: AdapterCtx): Promise<DestinationInvoiceCreateResult> {
    const viesChecker = ctx.config.b2b_reverse_charge === 1 && ctx.viesChecker ? ctx.viesChecker : undefined;
    const builder = new IxBuilder(ctx.config, viesChecker, ctx.productOverrides);
    const { invoice, nifHold } = builder.createInvoiceFromNormalizedOrder(normalized);

    // IxBuilder reconciles internally on the raw_order path. For non-raw
    // sources (Stripe, EuPago) raw_order is absent, so we reconcile here
    // against normalized.order.total — the source's paid amount.
    if (!normalized.raw_order) {
      reconcileTotalOrThrow(
        Number(normalized.order.total),
        invoice.items.map((it: any) => ({
          name: it.name,
          quantity: Number(it.quantity),
          unit_price: Number(it.unit_price),
          tax_rate: typeof it.tax === "number" ? it.tax : Number(it.tax?.value ?? 0),
          discount_percent: Number(it.discount ?? 0),
        })),
        { context: `→IX order#${normalized.order.order_number}` },
      );
    }

    // Inject sequence_id when a series override is configured (tag routing or
    // global ix_sequence_name). IX v2 accepts this field even though it is not
    // captured in the generated TypeScript types.
    if (ctx.config.ix_sequence_name) {
      const sequenceId = await resolveSequenceId(ctx, ctx.config.ix_sequence_name);
      if (sequenceId) (invoice as any).sequence_id = sequenceId;
    }

    const res = await IxApi.v2.documents.post({
      headers: ixHeadersFromCtx(ctx),
      body: { data: invoice, type: ixDocType(ctx) },
      query: { resolvers: "on_tax_fallback_search_tax_by_value" },
    });

    const id = res.data?.data?.id;
    if (!id) {
      const detail = JSON.stringify({ body: res.data, error: res.error });
      throw new Error(`InvoiceXpress create failed: ${detail.slice(0, 500)}`);
    }
    return { invoiceId: String(id), holdReason: nifHold ? nifHoldReason(nifHold) : null };
  }

  async finalize(invoiceId: string, ctx: AdapterCtx): Promise<void> {
    const { error } = await IxApi.v2.changeState.post({
      body: { type: ixDocType(ctx), id: Number(invoiceId), state: "finalized" },
      headers: ixHeadersFromCtx(ctx),
    });
    if (error) throw new Error(`InvoiceXpress finalize failed: ${JSON.stringify(error)}`);
  }

  async issueCredit(invoiceId: string, refund: NormalizedRefund, normalized: Normalized, ctx: AdapterCtx): Promise<DestinationCreditResult> {
    const viesChecker = ctx.config.b2b_reverse_charge === 1 && ctx.viesChecker ? ctx.viesChecker : undefined;
    const builder = new IxBuilder(ctx.config, viesChecker, ctx.productOverrides);
    const { invoice } = builder.createInvoiceFromNormalizedOrder(normalized);

    const refundItems = normalized.order.items.filter(item => refund.itemsIds.includes(item.id));
    const items = builder.buildInvoiceItems(refundItems);

    if (refund.amountToRefund > 0) {
      const taxes = invoice.items.map(i => i.tax);
      const maxTax = taxes.reduce((a, b) =>
        (typeof a === "number" ? a : a.value) >= (typeof b === "number" ? b : b.value) ? a : b
      ) ?? 0;
      const taxPercentage = (typeof maxTax === "number" ? maxTax : maxTax.value) / 100;

      items.push({
        quantity: 1,
        tax: maxTax,
        unit_price: refund.amountToRefund / (1 + taxPercentage),
        description: `Refund amount of ${refund.amountToRefund}`,
        name: `Refund amount (#${refund.refundId})`,
      });
    }

    const requireTaxExemption = items.some(i =>
      typeof i.tax === "number" ? i.tax === 0 : i.tax.value === 0
    );

    const creditNote: IxCreditNote = {
      ...invoice,
      items,
      reference: `OrderRefund #${refund.refundId}`,
      tax_exemption_reason: requireTaxExemption ? ctx.config.ix_exemption_reason ?? undefined : undefined,
      owner_invoice_id: Number(invoiceId),
    };

    const { data, error } = await IxApi.v2.creditNotes.post({
      headers: ixHeadersFromCtx(ctx),
      body: { credit_note: creditNote },
      query: { resolvers: "on_tax_fallback_search_tax_by_value" },
    });
    if (error) throw new Error(`InvoiceXpress credit create failed: ${JSON.stringify(error)}`);

    const creditId = (data?.data as any)?.id
      ?? (data?.data as any)?.credit_note?.id
      ?? (data?.data as any)?.creditNote?.id;
    if (!creditId) throw new Error("InvoiceXpress credit returned no id");

    await IxApi.v2.changeState.post({
      body: { type: "credit_note", id: Number(creditId), state: "finalized" },
      headers: ixHeadersFromCtx(ctx),
    });

    return { creditId: String(creditId) };
  }

  async emailDocument(invoiceId: string, ctx: AdapterCtx, opts?: { holdReason?: string | null }): Promise<void> {
    const outcome = await sendIxDocumentEmail(ctx.config, invoiceId, { holdReason: opts?.holdReason });
    console.log(`[IX] ${describeIxEmailOutcome(invoiceId, outcome)}`);
  }
}
