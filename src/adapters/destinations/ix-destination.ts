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
import { resolveIxSequenceId } from "../../ix/sequences";
import { restateOrderInEur } from "../../ix/foreign-currency";
import type { FiscalClassification } from "../../ix/fiscal-classification";
import { createIxInvoiceWithFallback, ixExpectedTotals } from "../../ix/create-invoice";
import { mirrorItemsFromIxDocument, planRefundCredit, refundInDocumentMoney, documentNotCreditable } from "../../ix/credit-mirror";
import { prepareIxFinalizeBatch, finalizeIxDraft, isAlreadyFinalizedIxError, type IxFinalizeBatch } from "./ix-finalize";
import type { Normalized } from "../../api/normalize-shopify";
import { IxApi } from "../../api/ix";
import { findViaInvoiceXpress } from "../../services/ix-find-reference";
import { IxBuilder, nifHoldReason } from "../../ix/builder";
import { reconcileTotalOrThrow } from "../reconcile";
import { sendIxDocumentEmail, describeIxEmailOutcome } from "../../services/ix-document-email";
import { refundReference } from "../../services/document-references";
import { platformError } from "../../services/platform-error";

// The sequences lookup moved to ../../ix/sequences so the legacy Shopify→IX
// handlers can resolve a series too — they route on tags exactly like this
// pipeline does, and duplicating the family-per-doctype rule is how the two
// halves drift apart. Re-exported here because that is where callers (and the
// per-doctype test) have always imported it from.
export { pickSequenceId, type IxSequenceRow } from "../../ix/sequences";

/** `resolveIxSequenceId` bound to an adapter context. */
function resolveSequenceId(
  ctx: AdapterCtx,
  seriesName: string,
  docType: string = "invoice",
): Promise<number | null> {
  return resolveIxSequenceId(ctx.config, seriesName, docType);
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

/**
 * The related documents out of a `/v2/documents/{id}/related` response.
 *
 * Two `data` deep, and that is the whole point of this function existing. The
 * generated client hands back `{ data: <body> }`, and the body is the proxy's
 * envelope `{ data: { documents }, success, error }` — so the list lives at
 * `data.data.documents`. Three call sites read `data.documents` instead and got
 * `undefined`, which `?? []` turned into "this document has no credit notes".
 *
 * That is the worst possible failure for the question being asked. Every caller
 * asks it to decide whether a credit note ALREADY EXISTS before issuing another
 * one: the refund path, the legacy cancel, and the connection cancel. All three
 * were answered "no" for a document that plainly had one, so the guard against
 * crediting twice has never once fired.
 *
 * Takes either the client's response or the bare envelope, because one caller
 * (reconciliation) fetches this endpoint by hand and already unwraps a level.
 */
export function ixRelatedDocuments(res: unknown): any[] {
  const envelope = (res as any)?.data ?? res;
  const docs = (envelope as any)?.data?.documents ?? (envelope as any)?.documents;
  return Array.isArray(docs) ? docs : [];
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

/**
 * A credit note for a document, in the document's own terms: its client, the
 * lines given, and the exemption code the document itself carries. Dated the day
 * it is issued, not the day of the sale it undoes.
 */
function ixCreditNoteFor(
  inv: any,
  invoiceId: string,
  items: any[],
  ctx: AdapterCtx,
  opts: { reference: string; reason?: string | null },
): any {
  // IX rejects a 0% line unless a razão de isenção travels with it. Prefer the
  // code the document itself carries over the shop's configured default.
  const requireTaxExemption = items.some((it: any) =>
    Number(typeof it.tax === "number" ? it.tax : it.tax?.value ?? 0) === 0);

  const today = new Date().toISOString().slice(0, 10);
  return {
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
    // The reason for the credit first, the merchant's standing note after it.
    // A credit note rectifies an invoice and is itself a document, so a fixed
    // mention belongs on it; capped, or IX truncates it wherever it likes.
    ...(() => {
      const obs = [opts.reason, (ctx.config.custom_invoice_note ?? "").trim()]
        .filter(Boolean).map(String).join(" | ").slice(0, 200);
      return obs ? { observations: obs } : {};
    })(),
    // Same trap as the date PUT: IX reads an exemption back as `tax_exemption`
    // and sometimes as "", which `??` would keep and the wire would then drop,
    // leaving IX to stamp M99 on the credit note. See resolveExemptionCode.
    tax_exemption_reason: requireTaxExemption
      ? resolveExemptionCode(inv?.tax_exemption, ctx.config.ix_exemption_reason) ?? undefined
      : undefined,
    owner_invoice_id: Number(invoiceId),
  };
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
      // The buyer facts an exemption code can contradict. IX carries them on the
      // document itself, so this costs no extra call.
      //
      // `client` absent is not the same as a client with nothing in it: the
      // first means IX did not hand us the block (null, check skipped), the
      // second that IX holds a client with no country/tax id ("", checkable).
      // Collapsing the two is how a missing field becomes a fabricated finding.
      //
      // NOTE: `country` here is IX's NAME for the country ("France"), not an
      // ISO2 code — see toIxCountryName in ix/builder.ts, which converts on the
      // way in. euCountryFromStored() in document-verify.ts reads both.
      buyer_country: d.client ? String(d.client.country ?? "").trim() : null,
      buyer_tax_id: d.client ? String(d.client.fiscal_id ?? "").trim() : null,
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
    const { data: rel, error: relErr } = await IxApi.v2.documents.byId.related.get({
      headers, path: { id: Number(invoiceId) },
    });
    // A read we could not make is not "no credit note exists". Swallowing this
    // turns a flaky proxy into a second credit note on a document that already
    // has one, and IX will happily issue it.
    const relProblem = relErr ?? ixEnvelopeError(rel);
    if (relProblem) {
      throw new Error(
        `Não consegui ler os documentos relacionados de ${invoiceId} — não emito nota de crédito às cegas: `
        + JSON.stringify(relProblem).slice(0, 300),
      );
    }
    const related = ixRelatedDocuments(rel);
    const liveCreditNotes = related.filter((d: any) => {
      if (String(d?.type ?? "") !== "CreditNote") return false;
      const s = String(d?.status ?? "").toLowerCase();
      return s !== "canceled" && s !== "cancelled" && s !== "deleted";
    });
    const existing = liveCreditNotes.find((d: any) => matchRefs.includes(d.reference));
    if (existing) {
      return { creditId: String(existing.id), number: existing.sequence_number ?? null, alreadyExisted: true };
    }
    // A credit note we did NOT write is still a credit note. This account was
    // regularised by a previous integrator whose references we do not know, and
    // matching only our own spellings would credit those documents a second
    // time. Refuse and let a human decide.
    if (liveCreditNotes.length > 0) {
      const refs = liveCreditNotes.map((d: any) => d.sequence_number ?? d.id).join(", ");
      throw new Error(
        `O documento ${invoiceId} já tem nota de crédito (${refs}) com outra referência — não credito duas vezes`,
      );
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

    // One definition of "mirror" in the repository, shared with the refund path
    // (src/ix/credit-mirror.ts): the document's own lines, its per-line
    // discounts, and the fallback to each line's `subtotal` when the document
    // carries a header-level discount the lines do not. It throws when the
    // rebuild cannot reproduce the stored total, which is the same refusal this
    // code has always made — a credit note must undo the document exactly.
    const { items, gross } = mirrorItemsFromIxDocument(inv);
    const storedTotal = Number(inv.total);
    const rebuilt = { gross };

    const creditNote = ixCreditNoteFor(inv, invoiceId, items, ctx, { reference: opts.reference, reason: opts.reason });

    if (opts.dryRun) {
      // The totals go in the preview so a dry run can be checked against the
      // document without re-deriving them by hand.
      return {
        creditId: "", number: null, alreadyExisted: false,
        preview: { ...creditNote, expected_total: rebuilt.gross, document_total: storedTotal },
      };
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

    // Same trap as finalize(): the proxy answers some refusals with HTTP 200 and
    // `success: false`, which the SDK never raises. Unchecked, a credit note IX
    // declined to certify was reported as issued, and it stays a draft — which no
    // route can delete, because delete-draft resolves through processed_orders
    // and a credit note is not registered there.
    const { data: stateData, error: stateErr, response: stateRes } = await IxApi.v2.changeState.post({
      body: { type: "credit_note", id: Number(cnId), state: "finalized" },
      headers,
    });
    const stateProblem = stateErr ?? ixEnvelopeError(stateData);
    if (stateProblem) {
      throw platformError(
        `Nota de crédito ${cnId} criada mas o InvoiceXpress recusou certificá-la — ficou em rascunho: `
        + JSON.stringify(stateProblem).slice(0, 300),
        stateRes?.status,
      );
    }

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
      requirePaidTotal?: boolean;
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
      requirePaidTotal: opts.requirePaidTotal,
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
    // Euros, before anything is built. InvoiceXpress documents are valued in the
    // account's currency and `currency_code`/`rate` only print a second figure,
    // so a sale that reaches here still in AUD would be issued as that many
    // EUROS. The source restates a payment the processor itself converted; this
    // catches the one it did not (a Stripe account holding a balance per
    // currency never converts), and is a no-op on a euro sale. See
    // ix/foreign-currency.ts — it fails closed rather than guess a rate.
    await restateOrderInEur(normalized.order);

    const viesChecker = ctx.config.b2b_reverse_charge === 1 && ctx.viesChecker ? ctx.viesChecker : undefined;
    const builder = new IxBuilder(ctx.config, viesChecker, ctx.productOverrides, ctx.rules);

    // The per-sale classification, decided once by the pipeline before any
    // destination saw the order, and read here rather than re-derived.
    //
    // It used to be computed in this block — which meant it happened only for
    // InvoiceXpress, from a different country than the rate decision used, and
    // after the lines had already been re-rated. Deciding it in one place is
    // what lets the same regime reach Moloni and Vendus, and it also removes a
    // second VIES round trip per document.
    const fiscal: FiscalClassification | null = ctx.vat?.fiscal ?? null;

    const { invoice, nifHold, requestTaxExemptionReason } =
      builder.createInvoiceFromNormalizedOrder(normalized, fiscal ? { fiscal } : undefined);

    // The hold only means anything on a document that ended up exempt. A sale
    // where the buyer paid VAT needs no exemption confirmed, so an unverifiable
    // VAT number on it is not a reason to withhold a correct invoice.
    const fiscalHold = requestTaxExemptionReason ? (ctx.vat?.hold ?? null) : null;

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

  /**
   * Credit a refund by mirroring the document InvoiceXpress holds — see
   * src/ix/credit-mirror.ts.
   *
   * A Stripe, Lodgify or EuPago refund names no article: it is an amount of
   * money. A full one credits the document exactly as issued; a partial one
   * credits every line of it, each at its own rate, in the refunded share. The
   * lines are never rebuilt from the order — a credit note undoes the document,
   * not the order as it reads today — and no "Refund amount" line is invented at
   * the highest rate on the invoice to make a total come out.
   */
  async issueCredit(
    invoiceId: string,
    refund: NormalizedRefund,
    ctx: AdapterCtx,
    opts: { dryRun?: boolean } = {},
  ): Promise<DestinationCreditResult> {
    const headers = ixHeadersFromCtx(ctx);

    const doc = await this.getDocument(invoiceId, ctx);
    if (!doc) return documentNotCreditable(invoiceId, "deleted");
    if (doc.state !== "finalized") return documentNotCreditable(invoiceId, doc.state);
    const inv = doc.raw as any;

    let docItems;
    try {
      docItems = mirrorItemsFromIxDocument(inv).items;
    } catch (e: any) {
      return { status: "refused", reason: String(e?.message ?? e) };
    }

    const docTotal = Number(inv.total);
    const plan = planRefundCredit({
      docTotal,
      docItems,
      sources: [],
      refund: { refundId: refund.refundId, amount: refundInDocumentMoney(refund, docTotal), lineItems: [] },
      rawRefund: null,
      taxesIncluded: false,
      alreadyCredited: refund.alreadyCredited,
      cashRefund: "proportional",
    });
    if (!plan.ok) {
      return { status: "refused", reason: plan.reason, nothingToCredit: plan.nothingToCredit, detail: plan.detail };
    }

    const creditNote = ixCreditNoteFor(inv, invoiceId, plan.items, ctx, { reference: refundReference(refund.refundId) });

    // A connection that runs on named series deliberately issues the credit note
    // in the credit-note sequence of the same series — IX refuses the invoice
    // sequence id on a credit note ("A série não corresponde ao tipo de
    // documento"). Otherwise the account default, as credit notes always were.
    if (ctx.config.ix_sequence_name && ctx.config.ix_require_series === 1) {
      const creditSequenceId = await resolveSequenceId(ctx, ctx.config.ix_sequence_name, "credit_note");
      if (creditSequenceId) {
        creditNote.sequence_id = creditSequenceId;
      } else {
        throw platformError(
          `A série "${ctx.config.ix_sequence_name}" não tem sequência de nota de crédito na conta InvoiceXpress. `
          + `A nota de crédito não foi emitida para não sair numa série diferente da fatura que anula.`,
        );
      }
    }

    if (opts.dryRun) return { status: "preview", total: plan.total, basis: plan.basis, payload: creditNote };

    const { data, error, response } = await IxApi.v2.creditNotes.post({
      headers,
      body: { credit_note: creditNote },
      query: { resolvers: "on_tax_fallback_search_tax_by_value" },
    });
    // Envelope included so the REASON survives into the message:
    // classifyPipelineError and the ledger both key on the message text.
    const creditProblem = error ?? ixEnvelopeError(data);
    if (creditProblem) {
      throw platformError(`InvoiceXpress credit create failed: ${JSON.stringify(creditProblem)}`, response?.status);
    }

    const creditId = (data?.data as any)?.id
      ?? (data?.data as any)?.credit_note?.id
      ?? (data?.data as any)?.creditNote?.id;
    if (!creditId) throw new Error("InvoiceXpress credit returned no id");

    // This refusal used to be ignored, reporting an uncertified draft as an issued
    // credit note. A draft IX will not certify is taken back, so a retry cannot
    // put a twin beside it; one that cannot be taken back is named on the error,
    // and the ledger holds the refund against it.
    const { data: stateData, error: stateErr, response: stateRes } = await IxApi.v2.changeState.post({
      body: { type: "credit_note", id: Number(creditId), state: "finalized" },
      headers,
    });
    const stateProblem = stateErr ?? ixEnvelopeError(stateData);
    if (stateProblem && !isAlreadyFinalizedIxError(stateProblem)) {
      const withdrawn = await IxApi.v2.changeState.post({
        body: { type: "credit_note", id: Number(creditId), state: "deleted" },
        headers,
      }).then(({ data: d, error: e }) => !(e ?? ixEnvelopeError(d)), () => false);
      const err: any = platformError(
        `InvoiceXpress finalize failed for credit note ${creditId}: ${JSON.stringify(stateProblem).slice(0, 500)}`,
        stateRes?.status,
      );
      if (!withdrawn) err.strandedCreditId = String(creditId);
      throw err;
    }

    return { status: "issued", creditId: String(creditId), total: plan.total };
  }

  async emailDocument(invoiceId: string, ctx: AdapterCtx, opts?: { holdReason?: string | null }): Promise<void> {
    const outcome = await sendIxDocumentEmail(ctx.config, invoiceId, { holdReason: opts?.holdReason });
    console.log(`[IX] ${describeIxEmailOutcome(invoiceId, outcome)}`);
  }
}
