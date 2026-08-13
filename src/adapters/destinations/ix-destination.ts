import type {
  DestinationAdapter,
  AdapterCtx,
  DestinationInvoiceCreateResult,
  DestinationCreditResult,
  DestinationDocument,
  DocumentState,
  CreditFullResult,
  FinalizeBatch,
  FinalizeDateStrategy,
  FinalizeOutcome,
  NormalizedRefund,
} from "../types";
import { parseIxDate } from "../../ix/date";
import { prepareIxFinalizeBatch, finalizeIxDraft, type IxFinalizeBatch } from "./ix-finalize";
import type { Normalized } from "../../api/normalize-shopify";
import { IxApi } from "../../api/ix";
import { IxBuilder, nifHoldReason, type IxCreditNote } from "../../ix/builder";
import { reconcileTotalOrThrow } from "../reconcile";
import { sendIxDocumentEmail, describeIxEmailOutcome } from "../../services/ix-document-email";
import { refundReference } from "../../services/document-references";

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

/**
 * IX is telling us the document does not exist, as opposed to failing to answer.
 *
 * Only a definite 404 (or IX's own "not found" wording) counts. Anything else —
 * a 5xx, a proxy timeout, an auth problem — is an unanswered question, and
 * treating it as "gone" is what lets a live document be forgotten and reissued.
 */
function isNotFoundIxError(error: unknown, response?: Response): boolean {
  if (response?.status === 404) return true;
  const s = JSON.stringify(error ?? "").toLowerCase();
  return s.includes("not found") || s.includes("não encontrado") || s.includes("nao encontrado");
}

/**
 * The proxy's envelope, per its OpenAPI spec (src/api/ix/client/types.gen.ts):
 * every response — including a 200 — carries `success` and a nullable `error`
 * alongside `data`. So a failed read can arrive as HTTP 200 with `success:false`
 * and no `data` at all, which a bare `data?.data` check reads as "the document
 * isn't there". It is not the same thing, and the difference is a duplicate
 * invoice.
 */
export function ixEnvelopeError(body: unknown): { message: string | null; code: string } | null {
  const b = body as any;
  if (!b) return null;
  if (b.success === false) return b.error ?? { message: "unknown failure", code: "UNKNOWN" };
  return b.error ?? null;
}

// Document lifecycle per the InvoiceXpress docs: a GET reads back `status`
// (draft | final | settled | canceled | second_copy — note "final", while
// change_state is POSTed the verb "finalized"). `deleted` is a state you can
// move a draft TO, not one you normally read back, and it is mapped here so a
// proxy that does surface it is not mistaken for a certified document.
export function ixDocumentState(rawStatus: unknown): DocumentState {
  const s = String(rawStatus ?? "").toLowerCase();
  if (s === "draft") return "draft";
  if (s === "canceled" || s === "cancelled") return "canceled";
  if (s === "deleted") return "deleted";
  return "finalized";
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

  readonly capabilities = {
    drafts: true,
    deleteDraft: true,
    creditFullDocument: true,
    finalizeWithDate: true,
    emailDocument: true,
    readDocument: true,
  } as const;

  /**
   * Read a document back from IX.
   *
   * Returns null ONLY when IX positively answers "no such document". A failed
   * read throws, and that distinction is the whole point: every caller that
   * treats "I could not reach IX" as "it isn't there" goes on to delete the
   * processed_orders row, and the next backfill then issues a duplicate against
   * a document that was there all along.
   */
  async getDocument(invoiceId: string, ctx: AdapterCtx): Promise<DestinationDocument | null> {
    const { data, error, response } = await IxApi.v2.documents.byId.get({
      headers: ixHeadersFromCtx(ctx),
      path: { id: Number(invoiceId) },
    });

    if (error) {
      if (isNotFoundIxError(error, response)) return null;
      throw new Error(`InvoiceXpress read failed for document ${invoiceId}: ${JSON.stringify(error).slice(0, 300)}`);
    }

    // A 200 that carries an error envelope is a failed read wearing a success
    // code — see ixEnvelopeError.
    const envelopeError = ixEnvelopeError(data);
    if (envelopeError) {
      if (isNotFoundIxError(envelopeError, response)) return null;
      throw new Error(`InvoiceXpress read failed for document ${invoiceId}: ${JSON.stringify(envelopeError).slice(0, 300)}`);
    }

    const d = data?.data as any;
    // Success with no document is a contract violation, not an absence. Throwing
    // keeps the caller from clearing its record on the strength of a malformed
    // answer.
    if (!d) throw new Error(`InvoiceXpress answered 200 with no document for id ${invoiceId}`);

    const total = Number(d.total);
    return {
      id: String(d.id ?? invoiceId),
      state: ixDocumentState(d.status),
      date: parseIxDate(d.date),
      total: Number.isFinite(total) ? total : null,
      reference: d.reference != null ? String(d.reference) : null,
      // `sequence_number` is the document's human number; it is only meaningful
      // once the document leaves draft, so empty reads as "not numbered yet".
      number: d.sequence_number ? String(d.sequence_number) : null,
      permalink: d.permalink ? String(d.permalink) : null,
      raw: d,
    };
  }

  /**
   * Take back a draft. Refuses a certified document — that one is AT-hashed and
   * can only be undone with a credit note.
   *
   * Throws when IX cannot be read or the delete fails, rather than reporting
   * "already_gone": see getDocument. `reemitOrder` wraps its call in a try/catch
   * because for IT a failed tidy-up must not sink the re-emit; an operator
   * pressing "apagar rascunho" needs the truth.
   */
  async deleteDraft(invoiceId: string, ctx: AdapterCtx): Promise<"deleted" | "already_gone" | "finalized"> {
    const doc = await this.getDocument(invoiceId, ctx);
    // A canceled document has already been undone: there is nothing left to take
    // back, and reporting it as "finalized" would send the caller off to issue a
    // credit note against a void.
    if (!doc || doc.state === "deleted" || doc.state === "canceled") return "already_gone";
    if (doc.state !== "draft") return "finalized";

    const { error } = await IxApi.v2.changeState.post({
      body: { type: ixDocType(ctx), id: Number(invoiceId), state: "deleted" },
      headers: ixHeadersFromCtx(ctx),
    });
    if (error) {
      throw new Error(`InvoiceXpress delete failed for draft ${invoiceId}: ${JSON.stringify(error).slice(0, 300)}`);
    }
    return "deleted";
  }

  /**
   * Credit a document in full, mirroring its OWN lines back as a finalized
   * credit note linked to it.
   *
   * Used when an operator cancels a sale after the fact and there is no refund
   * at the source to build a NormalizedRefund from. Note what it does NOT do:
   * refetch the order and rebuild the lines. A document must be credited for
   * what IT says, not for what the order says today — the two drift (an edited
   * order, a changed tax rule) and the difference would be a credit note that
   * does not undo the invoice it is attached to.
   */
  async creditFullDocument(
    invoiceId: string,
    ctx: AdapterCtx,
    opts: { reference: string; matchReferences?: string[]; reason?: string | null; dryRun?: boolean },
  ): Promise<CreditFullResult> {
    const headers = ixHeadersFromCtx(ctx);

    // Idempotency: IX's own related-documents link is authoritative here, and it
    // is checked against every historical spelling of the cancel reference so a
    // document credited under an older convention is never credited twice.
    const matchRefs = opts.matchReferences ?? [opts.reference];
    const { data: rel } = await IxApi.v2.documents.byId.related.get({
      headers, path: { id: Number(invoiceId) },
    });
    const existing = (rel?.data?.documents ?? []).find(
      (d: any) => d.type === "CreditNote" && matchRefs.includes(d.reference),
    );
    if (existing) {
      return { creditId: String((existing as any).id), number: (existing as any).sequence_number ?? null, alreadyExisted: true };
    }

    const doc = await this.getDocument(invoiceId, ctx);
    if (!doc) throw new Error(`InvoiceXpress document ${invoiceId} not found — nothing to credit`);
    if (doc.state === "draft") {
      throw new Error(`Document ${invoiceId} is still a draft. Delete it instead of crediting it.`);
    }
    if (doc.state === "canceled" || doc.state === "deleted") {
      throw new Error(`Document ${invoiceId} is already ${doc.state} — nothing left to credit.`);
    }
    const inv = doc.raw as any;

    const items = Array.isArray(inv.items) ? inv.items.map((it: any) => ({
      quantity: Number(it.quantity ?? 1),
      name: String(it.name ?? "Refund"),
      ...(it.description ? { description: String(it.description) } : {}),
      unit_price: Number(it.unit_price ?? 0),
      tax: it.tax?.id
        ? { id: Number(it.tax.id), name: String(it.tax.name ?? ""), value: Number(it.tax.value ?? 0) }
        : { name: String(it.tax?.name ?? "VAT"), value: Number(it.tax?.value ?? 0) },
    })) : [];

    // IX rejects a 0% line unless a razão de isenção travels with it. Prefer the
    // code the document itself carries over the shop's configured default.
    const requireTaxExemption = items.some((it: any) => Number(it.tax?.value ?? 0) === 0);

    const today = new Date().toISOString().slice(0, 10);
    const creditNote: any = {
      date: today,
      due_date: today,
      client: inv.client
        ? {
            ...(inv.client.id ? { id: Number(inv.client.id) } : {}),
            name: String(inv.client.name ?? ""),
            ...(inv.client.email ? { email: String(inv.client.email) } : {}),
            ...(inv.client.fiscal_id ? { fiscal_id: String(inv.client.fiscal_id) } : {}),
            ...(inv.client.address ? { address: String(inv.client.address) } : {}),
            ...(inv.client.postal_code ? { postal_code: String(inv.client.postal_code) } : {}),
            ...(inv.client.country ? { country: String(inv.client.country) } : {}),
            ...(inv.client.city ? { city: String(inv.client.city) } : {}),
          }
        : { name: "" },
      items,
      reference: opts.reference,
      ...(opts.reason ? { observations: String(opts.reason) } : {}),
      tax_exemption_reason: requireTaxExemption
        ? inv?.tax_exemption ?? ctx.config.ix_exemption_reason ?? undefined
        : undefined,
      owner_invoice_id: Number(invoiceId),
    };

    if (opts.dryRun) {
      return { creditId: "", number: null, alreadyExisted: false, preview: creditNote };
    }

    const { data: cnResp, error: cnErr } = await IxApi.v2.creditNotes.post({
      headers,
      body: { credit_note: creditNote },
      query: { resolvers: "on_tax_fallback_search_tax_by_value" },
    });
    if (cnErr) throw new Error(`InvoiceXpress credit note create failed: ${JSON.stringify(cnErr).slice(0, 300)}`);

    const cnId = (cnResp?.data as any)?.id
      ?? (cnResp?.data as any)?.credit_note?.id
      ?? (cnResp?.data as any)?.creditNote?.id;
    if (!cnId) throw new Error(`InvoiceXpress credit note create returned no id for document ${invoiceId}`);

    await IxApi.v2.changeState.post({
      body: { type: "credit_note", id: Number(cnId), state: "finalized" },
      headers,
    });

    return { creditId: String(cnId), number: null, alreadyExisted: false };
  }

  async prepareFinalizeBatch(ctx: AdapterCtx, opts?: { strategy?: FinalizeDateStrategy }): Promise<FinalizeBatch> {
    return prepareIxFinalizeBatch(
      ctx.config,
      ixHeadersFromCtx(ctx),
      ixDocType(ctx),
      opts?.strategy ?? "closest_available",
    );
  }

  async finalizeWithDate(
    invoiceId: string,
    ctx: AdapterCtx,
    opts: {
      strategy: FinalizeDateStrategy;
      paidTotal?: number | null;
      batch?: FinalizeBatch;
      dateMovedNote?: (originalDate: string) => string | null;
      dryRun?: boolean;
    },
  ): Promise<FinalizeOutcome> {
    const headers = ixHeadersFromCtx(ctx);
    const docKind = ixDocType(ctx);
    const batch = (opts.batch as IxFinalizeBatch | undefined)
      ?? await prepareIxFinalizeBatch(ctx.config, headers, docKind, opts.strategy);

    const doc = await this.getDocument(invoiceId, ctx).catch((e) => {
      // Keep the never-throw contract callers rely on to keep walking a batch.
      return { error: String(e?.message ?? e) } as any;
    });
    if (!doc) return { status: "error", message: `Document ${invoiceId} not found at InvoiceXpress` };
    if ("error" in doc) return { status: "error", message: `Fetch failed: ${doc.error}` };

    return finalizeIxDraft(ctx, invoiceId, docKind, headers, doc.raw, {
      strategy: opts.strategy,
      batch,
      paidTotal: opts.paidTotal,
      dateMovedNote: opts.dateMovedNote,
      dryRun: opts.dryRun,
    });
  }

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
      reference: refundReference(refund.refundId),
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
