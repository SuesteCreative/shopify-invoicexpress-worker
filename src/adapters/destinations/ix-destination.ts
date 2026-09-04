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
import { resolveExemptionCode } from "../../ix/exemption";
import { classifyExemption, type FiscalClassification } from "../../ix/fiscal-classification";
import { createIxInvoiceWithFallback } from "../../ix/create-invoice";
import { prepareIxFinalizeBatch, finalizeIxDraft, type IxFinalizeBatch } from "./ix-finalize";
import type { Normalized } from "../../api/normalize-shopify";
import { IxApi } from "../../api/ix";
import { findViaInvoiceXpress } from "../../services/ix-find-reference";
import { IxBuilder, nifHoldReason, type IxCreditNote } from "../../ix/builder";
import { reconcileTotalOrThrow } from "../reconcile";
import { sendIxDocumentEmail, describeIxEmailOutcome } from "../../services/ix-document-email";
import { refundReference } from "../../services/document-references";
import { platformError } from "../../services/platform-error";

/**
 * One row of InvoiceXpress's `sequences.json`. The shape that matters is the
 * one nobody read: a "series" is not a single sequence, it is a FAMILY, and it
 * carries a separate numeric id per document type.
 */
export interface IxSequenceRow {
  id: number;
  serie: string;
  current_invoice_sequence_id?: number;
  current_invoice_receipt_sequence_id?: number;
  current_simplified_invoice_sequence_id?: number;
  current_credit_note_sequence_id?: number;
  current_debit_note_sequence_id?: number;
  current_receipt_sequence_id?: number;
}

// Sequences cache: accountName → rows. Survives within a Worker isolate,
// flushed on cold start. The sequences list changes rarely so this is safe.
const sequencesCache = new Map<string, IxSequenceRow[]>();

/**
 * The id to send for THIS document type.
 *
 * Measured against the IX sandbox on 2026-09-04. A series named
 * INVOICEXPRESSDEMO answers with `id: 47734` and, inside it,
 * `current_invoice_sequence_id: 47734`, `current_invoice_receipt_sequence_id:
 * 47736`, `current_credit_note_sequence_id: 47739`. The top-level `id` is the
 * INVOICE id — so sending it on an invoice-receipt is rejected outright:
 *
 *   POST /v2/documents type=invoice_receipt sequence_id=47734
 *     → HTTP 400 "A série não corresponde ao tipo de documento"
 *   POST /v2/documents type=invoice_receipt sequence_id=47736
 *     → HTTP 200
 *
 * Which means any connection issuing invoice-receipts into a named series has
 * been failing the create entirely, leaving the sale unbilled — and a merchant
 * filing one series per destination country would have hit it on every sale.
 * Falls back to the top-level id when a type-specific one is absent, which is
 * the previous behaviour and correct for plain invoices.
 */
export function pickSequenceId(row: IxSequenceRow, docType: string): number | null {
  const byType: Record<string, number | undefined> = {
    invoice: row.current_invoice_sequence_id,
    invoice_receipt: row.current_invoice_receipt_sequence_id,
    simplified_invoice: row.current_simplified_invoice_sequence_id,
    credit_note: row.current_credit_note_sequence_id,
    debit_note: row.current_debit_note_sequence_id,
    receipt: row.current_receipt_sequence_id,
  };
  const specific = byType[docType];
  if (typeof specific === "number" && specific > 0) return specific;
  return typeof row.id === "number" && row.id > 0 ? row.id : null;
}

// Resolve the IX numeric sequence_id for a named series (e.g. "RVFR"), for the
// document type being issued. Falls back to null (IX uses its default series)
// if the name isn't found or the sequences API call fails.
async function resolveSequenceId(
  ctx: AdapterCtx,
  seriesName: string,
  docType: string = "invoice",
): Promise<number | null> {
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
      const data = await res.json() as { sequences?: IxSequenceRow[] };
      sequences = data.sequences ?? [];
      // Only cache a non-empty result. An empty list on first fetch (transient
      // network hiccup) must not freeze future lookups for the isolate lifetime.
      if (sequences.length > 0) sequencesCache.set(cacheKey, sequences);
    } catch {
      return null;
    }
  }

  const target = seriesName.trim().toUpperCase();
  const match = sequences.find(s => String(s.serie ?? "").trim().toUpperCase() === target);
  return match ? pickSequenceId(match, docType) : null;
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
      // What IX STORED, which is not always what we sent — see
      // DestinationDocument.exemption_code. An empty string reads as "no code
      // known", not as a code: reported literally it makes the verify sweep
      // announce a drift from "M10" to "" on a document nobody touched.
      exemption_code: resolveExemptionCode(d.tax_exemption, null),
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
      // Same trap as the date PUT: IX reads an exemption back as `tax_exemption`
      // and sometimes as "", which `??` would keep and the wire would then drop,
      // leaving IX to stamp M99 on the credit note. See resolveExemptionCode.
      tax_exemption_reason: requireTaxExemption
        ? resolveExemptionCode(inv?.tax_exemption, ctx.config.ix_exemption_reason) ?? undefined
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

  /**
   * Does InvoiceXpress already hold a document under this reference?
   *
   * `null` means NO — and it must only ever mean that. This used to ignore the
   * error entirely, so a 5xx from the proxy (which sits on shared hosting and
   * falls over under load) answered "no such document" to the question every
   * create asks before issuing one. The three callers are all idempotency
   * guards: the create path, the refund credit-note dedup, and the Lodgify
   * instalment dedup. A wrong "no" from any of them mints a duplicate fiscal
   * document.
   *
   * So an unreadable answer throws. The queue retries, the poll comes back in
   * thirty minutes, and nothing is lost by waiting — which is not true of a
   * duplicate. Moloni's own findByReference already works this way
   * (`if (isMoloniTransient(e)) throw e`); this was the outlier.
   */
  async findByReference(reference: string, ctx: AdapterCtx) {
    // Fast path: InvoiceXpress answers this in ~1s either way, while the proxy
    // takes ~152s to say "no such document" — and "no" is the normal answer
    // before a create. Only a confirmed answer short-circuits; anything it
    // cannot determine throws and falls through to the proxy below, which keeps
    // this method's contract of never turning "I don't know" into "no".
    try {
      const direct = await findViaInvoiceXpress(ixHeadersFromCtx(ctx) as any, reference);
      return direct ? { id: direct } : null;
    } catch { /* fall through to the proxy */ }

    const res = await IxApi.v2.documents.reference.post({
      headers: ixHeadersFromCtx(ctx),
      body: { reference },
    });

    // A failure can also arrive as HTTP 200 carrying `success: false`.
    const problem = res.error ?? ixEnvelopeError(res.data);
    if (problem) {
      // A genuine "there is no such document" is the answer we were asked for.
      if (isNotFoundIxError(problem, res.response)) return null;
      throw new Error(
        `InvoiceXpress reference lookup failed for "${reference}": ${JSON.stringify(problem).slice(0, 300)}`,
      );
    }

    const id = res.data?.data?.id;
    return id ? { id: String(id) } : null;
  }

  async createDraft(normalized: Normalized, ctx: AdapterCtx): Promise<DestinationInvoiceCreateResult> {
    const viesChecker = ctx.config.b2b_reverse_charge === 1 && ctx.viesChecker ? ctx.viesChecker : undefined;
    const builder = new IxBuilder(ctx.config, viesChecker, ctx.productOverrides);

    // Per-sale fiscal classification. Off by default: with the flag at 0 this
    // whole block is skipped and the build is what it always was, stamping the
    // shop-wide exemption code. On, the document names the regime the sale was
    // actually made under — an export, an intra-Community supply, or the shop's
    // own reason — which is the difference between a globally-selling merchant
    // being compliant and merely being invoiced. Note this reads the VIES
    // checker directly rather than through `viesChecker` above: reverse charge
    // was never evaluated on this path at all, so the checker was built and
    // then never used.
    let fiscal: FiscalClassification | null = null;
    if (ctx.config.ix_derive_exemption === 1) {
      fiscal = await classifyExemption({
        buyerCountryCode: normalized.order.billing_address?.country_code
          ?? normalized.order.shipping_address?.country_code,
        euVatCandidates: builder.extractEuVatCandidates(normalized),
        config: ctx.config,
        viesChecker: ctx.viesChecker,
      });
    }

    const { invoice, nifHold, requestTaxExemptionReason } =
      builder.createInvoiceFromNormalizedOrder(normalized, fiscal ? { fiscal } : undefined);

    // The hold only means anything on a document that ended up exempt. A sale
    // where the buyer paid VAT needs no exemption confirmed, so an unverifiable
    // VAT number on it is not a reason to withhold a correct invoice.
    const fiscalHold = fiscal && requestTaxExemptionReason ? fiscal.hold : null;

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
      const sequenceId = await resolveSequenceId(ctx, ctx.config.ix_sequence_name, ixDocType(ctx));
      if (sequenceId) {
        (invoice as any).sequence_id = sequenceId;
      } else if (ctx.config.ix_require_series === 1) {
        // A merchant filing each destination country into its own series has
        // one series per country, and a name that does not resolve silently
        // files the sale under whichever series IX defaults to. That is a sale
        // in the wrong country's numbering, discovered — if ever — by an
        // accountant months later. Failing here leaves the order visibly
        // unbilled instead, which is a problem someone can see and fix.
        throw platformError(
          `A série "${ctx.config.ix_sequence_name}" não existe na conta InvoiceXpress `
          + `(ou a lista de séries não respondeu). A encomenda não foi facturada para não ir para a série errada.`,
        );
      }
    }

    // The second currency. InvoiceXpress issues in the account's own currency —
    // for a Portuguese account the euro, by law — but it will print a second
    // figure beside it, which is what a buyer who paid 100 AUD needs to see on
    // a document totalling 58,20 €. Measured against the sandbox on 2026-09-04:
    // `currency_code` + `rate` (a decimal AS A STRING) on the create body come
    // back as `multicurrency: { rate, currency, total }`, with
    // `total = document total × rate`.
    //
    // The rate is the payment's own settlement rate, not an FX feed's, so the
    // foreign figure lands on the amount the buyer actually paid.
    //
    // NOTE: ix-proxy.kapta.app currently drops both fields — its request schema
    // does not list them (`sequence_id` is listed, which is why that one gets
    // through). Sending them is harmless until the proxy passes them on, and
    // the document is fiscally complete either way: the euro value is the value.
    const fx = normalized.order.paid_in_foreign_currency;
    if (ctx.config.ix_multicurrency === 1 && fx?.code && fx.rate > 0) {
      (invoice as any).currency_code = fx.code;
      (invoice as any).rate = String(fx.rate);
    }

    // Two ways to post the same document. The plain one is what this path has
    // always done; the other is the one the legacy Shopify path uses, and it
    // carries everything that path learned the hard way: transient retry
    // against a proxy measured timing out under load, the DOC010 fallback for
    // an IX client record that cannot be resolved, explicit account taxes so a
    // foreign rate is not resolved to "Isento", and — the reason it matters
    // here — reading the document back to confirm IX stored the money we sent.
    // Without that read-back, a sale stored at 0% VAT looks exactly like a sale
    // that worked.
    const res = ctx.config.ix_adapter_safety_nets === 1
      ? (await createIxInvoiceWithFallback(ixHeadersFromCtx(ctx), invoice, ixDocType(ctx), {
        forceTaxRate: ctx.config.force_tax_rate,
        forceShippingTaxRate: ctx.config.force_shipping_tax_rate,
        allRatesExplicit: true,
      })).res
      : await IxApi.v2.documents.post({
        headers: ixHeadersFromCtx(ctx),
        body: { data: invoice, type: ixDocType(ctx) },
        query: { resolvers: "on_tax_fallback_search_tax_by_value" },
      });

    const id = res.data?.data?.id;
    if (!id) {
      const status = res.response?.status;
      const detail = JSON.stringify({ body: res.data, error: res.error });
      throw platformError(
        `InvoiceXpress create failed${status ? ` (HTTP ${status})` : ""}: ${detail.slice(0, 500)}`,
        status,
      );
    }
    return {
      invoiceId: String(id),
      // Either reason holds the document; both stated when both apply, because
      // an operator fixing one needs to know the other is also there.
      holdReason: [nifHold ? nifHoldReason(nifHold) : null, fiscalHold]
        .filter(Boolean).join(" | ") || null,
      exemptionCode: invoice.tax_exemption_reason ?? null,
    };
  }

  async finalize(invoiceId: string, ctx: AdapterCtx): Promise<void> {
    const { data, error, response } = await IxApi.v2.changeState.post({
      body: { type: ixDocType(ctx), id: Number(invoiceId), state: "finalized" },
      headers: ixHeadersFromCtx(ctx),
    });
    // `error` alone is not enough: the proxy answers some failures with HTTP 200
    // and `success: false`, which the SDK never surfaces as an error. Without the
    // envelope check a refused finalize returned quietly and the caller went on
    // to treat the document as certified.
    const problem = error ?? ixEnvelopeError(data);
    if (problem) {
      throw platformError(`InvoiceXpress finalize failed: ${JSON.stringify(problem)}`, response?.status);
    }
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

    // A credit note undoes a specific document, so it must be issued under the
    // regime THAT document was issued under — not under whatever the shop is
    // configured with today. Crediting a March export (M05) with today's M10
    // declares a different exemption than the sale it reverses. Its siblings
    // (creditFullDocument, refunds-create) already read the code off the
    // document; this path read the config directly.
    //
    // Behind the same flag as the rest of the classification work, and
    // best-effort: an unreadable document falls back to the configured code,
    // which is exactly what this line did before.
    let creditExemption: string | null | undefined = ctx.config.ix_exemption_reason;
    if (requireTaxExemption && ctx.config.ix_derive_exemption === 1) {
      try {
        const original = await this.getDocument(invoiceId, ctx);
        creditExemption = resolveExemptionCode(original?.exemption_code, ctx.config.ix_exemption_reason);
      } catch (e: any) {
        console.warn(`[IX] credit note ${invoiceId}: could not read the original's exemption code (${e?.message ?? e}) — using the configured one`);
      }
    }

    const creditNote: IxCreditNote = {
      ...invoice,
      items,
      reference: refundReference(refund.refundId),
      tax_exemption_reason: requireTaxExemption ? creditExemption ?? undefined : undefined,
      owner_invoice_id: Number(invoiceId),
    };
    // The builder does not set a sequence_id today — createDraft adds it after
    // the build — but this spreads a whole invoice payload, so the delete is
    // there to keep a future build path from leaking the INVOICE id onto a
    // credit note, which IX refuses outright ("A série não corresponde ao tipo
    // de documento", measured against the sandbox 2026-09-04). Then put back
    // the credit-note id of the same series, only for a
    // connection that runs on named series deliberately — otherwise a merchant
    // whose credit notes have always been numbered in the account default would
    // silently start a different sequence.
    delete (creditNote as any).sequence_id;
    if (ctx.config.ix_sequence_name && ctx.config.ix_require_series === 1) {
      const creditSequenceId = await resolveSequenceId(ctx, ctx.config.ix_sequence_name, "credit_note");
      if (creditSequenceId) {
        (creditNote as any).sequence_id = creditSequenceId;
      } else {
        throw platformError(
          `A série "${ctx.config.ix_sequence_name}" não tem sequência de nota de crédito na conta InvoiceXpress. `
          + `A nota de crédito não foi emitida para não sair numa série diferente da fatura que anula.`,
        );
      }
    }

    const { data, error, response } = await IxApi.v2.creditNotes.post({
      headers: ixHeadersFromCtx(ctx),
      body: { credit_note: creditNote },
      query: { resolvers: "on_tax_fallback_search_tax_by_value" },
    });
    // Envelope included so the REASON survives into the message. Without it a
    // 200-with-`success:false` fell through to "credit returned no id", and
    // classifyPipelineError keys on the message text — so a bad NIF stopped
    // being recognisable as one.
    const creditProblem = error ?? ixEnvelopeError(data);
    if (creditProblem) {
      throw platformError(
        `InvoiceXpress credit create failed: ${JSON.stringify(creditProblem)}`,
        response?.status,
      );
    }

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
