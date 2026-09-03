import type { Normalized } from "../api/normalize-shopify";
import type { IRequestConfig } from "../storage";
import type { LodgifyGateway } from "../services/lodgify-api";

export type SourceKind = "shopify" | "stripe" | "eupago" | "lodgify";
export type DestinationKind = "invoicexpress" | "moloni" | "vendus";

export interface AdapterCtx {
  apiKey: string;
  config: IRequestConfig;
  // Parsed `connections.source_config_json` for the active connection. Lets the
  // source adapter pull source-specific credentials (e.g. Stripe restricted_key
  // to expand Customer.tax_ids) without re-querying the DB.
  sourceConfig?: Record<string, any>;
  // Parsed `connections.destination_config_json`. Holds destination-specific
  // credentials and settings (Moloni OAuth, Vendus API key, etc.). Behavior
  // toggles (auto_finalize, ix_send_email, ix_exemption_reason fallback) still
  // live in `config` (legacy `integrations` row) until Phase 5 projects them.
  destinationConfig?: Record<string, any>;
  // Pre-fetched explicit product mappings, keyed by source_reference
  // (output of MoloniDestination.deriveProductReference). Adapters consult
  // this Map before falling back to the find-or-create-by-reference path.
  productMappings?: Map<string, number>;
  // Pre-fetched per-SKU overrides (tax_rate, vat_inclusion, exemption,
  // name). Used by IxBuilder.buildInvoiceItemsFromRaw to adjust per-line
  // behavior without touching the integration-level config.
  productOverrides?: Map<string, {
    tax_rate?: number;
    vat_inclusion?: "inc" | "exc";
    exemption_reason?: string;
    name_override?: string;
  }>;
  // VIES checker for B2B EU reverse-charge classification. Built once per
  // pipeline run when `config.b2b_reverse_charge === 1` so IxBuilder can
  // decide whether to apply M16/M40 exemptions on EU cross-border orders.
  viesChecker?: (countryCode: string, vatNumber: string) => Promise<boolean | null>;
  // Where Lodgify calls leave from. Resolved once per run by buildAdapterCtx
  // (Lodgify connections only) because Lodgify allowlists us by IP address and
  // the Worker has no fixed egress: a call that does not go through the relay
  // leaves from an unallowlisted Cloudflare address and re-earns the block.
  // Absent on every other source; the Lodgify adapter refuses to fetch without it.
  lodgifyGateway?: LodgifyGateway;
}

export interface WebhookVerification {
  ok: boolean;
  rawBody: string;
}

/**
 * What a source can answer for the admin recovery tools, declared rather than
 * inferred. The dev-mode panel has to decide which cards to render — and which
 * filters those cards offer — BEFORE it issues any request, so "does this source
 * have order numbers?" cannot be a `typeof adapter.x === "function"` guess made
 * at the call site.
 */
export interface SourceCapabilities {
  /** An operator can name a single record (an order number, a `pi_…`, a booking id). */
  resolveById: boolean;
  /** The source can enumerate billable records over a date window (backfill). */
  listCandidates: boolean;
  /** Records carry a human order number, so range filters by number make sense.
   *  False for Stripe (there is no such thing) and Lodgify. */
  orderNumberFilter: boolean;
  /** The source can report what the buyer actually paid, so finalize can refuse
   *  to certify a document whose total drifted from the payment. */
  paidTotals: boolean;
  /** The source delivers payment as a SEPARATE later event (Shopify orders/paid),
   *  so the create flow must not finalize inline. False for Stripe/EuPago/Lodgify,
   *  where the event that creates the document IS the payment. */
  emitsSeparatePaidEvent: boolean;
}

export interface SourceAdapter {
  readonly kind: SourceKind;
  readonly capabilities: SourceCapabilities;
  verifyWebhook(rawBody: string, signature: string, secret: string): Promise<boolean>;
  externalId(parsedBody: any): string;
  toNormalized(parsedBody: any, ctx: AdapterCtx): Promise<Normalized | null>;
}

export interface NormalizedRefund {
  refundId: string | number;
  itemsIds: Array<string | number>;
  amountToRefund: number;
  /** Total gross amount actually refunded (tax-inclusive). When present, the
   *  destination reconciles the credit-note total against it and aborts on a
   *  mismatch rather than shipping a mis-totalled fiscal document. */
  grossAmount?: number;
}

export interface DestinationInvoiceCreateResult {
  invoiceId: string;
  /** Set when the document must stay a draft for a human to review — today
   *  only "the buyer typed something into the address line that was meant to
   *  be a NIF and doesn't validate". Persisted on processed_orders.hold_reason;
   *  blocks finalize and the customer email until a re-emit clears it. */
  holdReason?: string | null;
}

export interface DestinationCreditResult {
  creditId: string;
}

/**
 * Which fiscal operations this destination can perform. Declared, not inferred:
 * the admin panel renders its cards off this, and an absent method is otherwise
 * indistinguishable from "not written yet" — which is exactly how the Lodgify
 * take-back path came to be a silent no-op on InvoiceXpress.
 */
export interface DestinationCapabilities {
  /** The destination has a draft state at all. Vendus issues on POST: false. */
  drafts: boolean;
  deleteDraft: boolean;
  creditFullDocument: boolean;
  /** finalize can move the document's date to satisfy a series chronology rule.
   *  InvoiceXpress and Moloni both enforce one, and both reject the close (not
   *  just the insert) when the document falls behind the series. */
  finalizeWithDate: boolean;
  emailDocument: boolean;
  /** The document's state/total/date can be read back. */
  readDocument: boolean;
  /** Money received against an already-closed document can be recorded on it
   *  (Moloni: a Recibo associated to a Fatura). Destinations whose only sale
   *  document already asserts payment have nothing to record: false. */
  settleDocument?: boolean;
}

/**
 * `canceled` is deliberately its own state and not a flavour of `finalized`.
 *
 * InvoiceXpress documents move through draft → final/settled → canceled, and a
 * canceled document is neither deletable (it is not a draft) nor creditable (it
 * has already been undone). Folding it into `finalized` makes "apagar rascunho"
 * answer "issue a credit note instead" and lets a credit note be issued against
 * a document that was already voided.
 */
export type DocumentState = "draft" | "finalized" | "canceled" | "deleted";

/** A document as the destination currently holds it. */
export interface DestinationDocument {
  id: string;
  state: DocumentState;
  /** YYYY-MM-DD as stored at the destination, or null if unparseable. */
  date: string | null;
  /** Gross total the destination holds. Null when unreadable. */
  total: number | null;
  reference: string | null;
  /** Human document number once finalized ("FT 2026/12"); null while draft. */
  number: string | null;
  permalink: string | null;
  /**
   * The VAT-exemption code (SAF-T "M" code) the destination actually STORED.
   *
   * Read back rather than assumed, because it has already diverged from what we
   * sent: lliberta 11/LL went out with M10 in the payload and InvoiceXpress
   * holds M99, while the document's own observations still render the M10 text.
   * Each adapter fills this from its native field so the verifier stays
   * destination-agnostic. Null when the destination has no such concept or the
   * document carries no exemption.
   */
  exemption_code?: string | null;
  /** Native payload, for destination-internal code that needs the full record. */
  raw: unknown;
}

export interface CreditFullResult {
  creditId: string;
  number: string | null;
  /** Idempotency hit: the reference already existed, nothing new was issued. */
  alreadyExisted: boolean;
  /** dryRun only: the payload that WOULD have been posted. No document created. */
  preview?: unknown;
}

/**
 * Which date a draft should carry when it is certified.
 *
 * - `closest_available` keep the draft's own date — the day the sale happened —
 *                       and move it forward ONLY as far as the series rule
 *                       forces (InvoiceXpress refuses a document dated behind
 *                       the last finalized one in its series). Never silently
 *                       clamps to today: an operator who wants today asks for
 *                       `today`.
 * - `series_or_today`   the same, then today as a last resort if IX still
 *                       refuses. For per-document recovery, where leaving the
 *                       draft un-certifiable is worse than a late date.
 * - `today`             stamp today.
 *
 * The difference between the first two is deliberate and load-bearing: a bulk
 * run must not quietly restamp a backlog to today, while a single stuck document
 * an operator is trying to rescue should take the late date over staying stuck.
 */
export type FinalizeDateStrategy = "closest_available" | "series_or_today" | "today";

/**
 * What the destination holds for the document a settlement looked at. Returned
 * on every arm so an automatic caller can write its gate row without a second
 * round trip.
 */
export interface SettleDocSnapshot {
  status: number | null;
  total: number | null;
  reconciled: number | null;
  /** The document id resolved nowhere. */
  missing?: boolean;
}

/**
 * The result of recording money against a closed document.
 *
 * `skipped` carries a `reason` and `error` a `code` because an unattended caller
 * has to tell "still a draft, ask again later" from "fully settled, stop asking"
 * from "a guard refused this, a human must look" — three outcomes that read
 * identically as a bare status.
 */
export type SettleOutcome =
  | { status: "settled"; receiptId: string; value: number; settledTotal: number; message: string; doc?: SettleDocSnapshot }
  | { status: "skipped"; reason?: "not_closed" | "nothing_due"; message: string; doc?: SettleDocSnapshot }
  | { status: "blocked"; reason: string; message: string; doc?: SettleDocSnapshot }
  | { status: "error"; code?: "config" | "not_found" | "not_reconciled" | "insert_unknown" | "platform"; message: string; doc?: SettleDocSnapshot }
  | { status: "dry_run"; value: number; message: string; doc?: SettleDocSnapshot };

export type FinalizeOutcome =
  | { status: "finalized"; date: string; originalDate: string; message: string }
  | { status: "skipped"; message: string }
  | { status: "error"; message: string }
  | { status: "dry_run"; date: string; originalDate: string; message: string };

/**
 * Per-run state a destination needs across rows of one finalize batch — the IX
 * account tax table and the running last-finalized-date baseline. Opaque to
 * callers on purpose: keeping it inside the destination is what stops an
 * InvoiceXpress-shaped object from leaking into the generic engine's signature.
 */
export interface FinalizeBatch {
  readonly kind: DestinationKind;
}

export interface DestinationAdapter {
  readonly kind: DestinationKind;
  readonly capabilities: DestinationCapabilities;
  createDraft(normalized: Normalized, ctx: AdapterCtx): Promise<DestinationInvoiceCreateResult>;
  finalize(invoiceId: string, ctx: AdapterCtx): Promise<void>;
  issueCredit(invoiceId: string, refund: NormalizedRefund, normalized: Normalized, ctx: AdapterCtx): Promise<DestinationCreditResult>;
  /** Send the issued document to the buyer. Must not throw on a failed send —
   *  the invoice already exists, so a bounced email is a log line, not a reason
   *  to fail (and retry) the whole webhook. */
  emailDocument?(invoiceId: string, ctx: AdapterCtx, opts?: { holdReason?: string | null }): Promise<void>;
  findByReference?(reference: string, ctx: AdapterCtx): Promise<{ id: string } | null>;
  /** Take back a document that is still a draft, when the sale behind it went
   *  away (e.g. a cancelled booking). Must refuse a finalized document — that
   *  one is fiscally locked and can only be undone with a credit note. */
  deleteDraft?(invoiceId: string, ctx: AdapterCtx): Promise<"deleted" | "already_gone" | "finalized">;

  /** Read a document back. Returns null when the id resolves nowhere.
   *  Returns the whole record rather than just the state because every caller
   *  needs the state AND one more field in the same breath, and a second round
   *  trip on a flaky proxy is exactly what the admin handlers were fighting. */
  getDocument?(invoiceId: string, ctx: AdapterCtx): Promise<DestinationDocument | null>;

  /**
   * Mirror a finalized document's OWN lines back as a finalized credit note,
   * linked to it, under `reference`. Refuses (via `alreadyExisted`) when that
   * reference already exists.
   *
   * Deliberately takes no `Normalized`: the whole point is that no source refund
   * exists — an operator is cancelling a document after the fact. Crediting from
   * a re-fetched source order would credit what the order says TODAY rather than
   * what the document says, which is a fiscal mismatch, not a feature.
   */
  creditFullDocument?(
    invoiceId: string,
    ctx: AdapterCtx,
    opts: {
      /** The reference the new credit note is written with. */
      reference: string;
      /** Every reference that counts as "already credited", when the convention
       *  has changed over time. Defaults to `[reference]`. Passing the historical
       *  spellings is what stops a document credited under an older name from
       *  being credited a second time. */
      matchReferences?: string[];
      reason?: string | null;
      dryRun?: boolean;
    },
  ): Promise<CreditFullResult>;

  /**
   * Record money received against a document that is already closed.
   *
   * For a stay invoiced in full and paid in halves, this is the second half of
   * the merchant's actual process: the Fatura states the debt, and each payment
   * is recorded against it as its own receipt. Deliberately separate from
   * `createDraft`: a receipt can only be associated to a CLOSED document, so it
   * can never be part of issuing one.
   *
   * Implementations must be safe to call twice — settle what is missing, and
   * report `skipped` when nothing is.
   */
  settleDocument?(
    invoiceId: string,
    ctx: AdapterCtx,
    opts: {
      /** Amount received in total, as the SOURCE knows it. The destination
       *  settles the difference against what it has already reconciled, so a
       *  caller that recomputes the same figure twice cannot double-receipt. */
      collected: number;
      /** Date of the payment. Defaults to today at the destination. */
      date?: string | null;
      /**
       * How the money reached the merchant, as the SOURCE states it
       * ("Airbnb: HM…", "Booking.com: 5670891596"). A receipt has to say how the
       * money came in, and for an OTA stay the channel is the honest answer —
       * the host never touches the guest's card, and "Airbnb" on the document is
       * what ties it to the payout line in the bank.
       */
      channelReference?: string | null;
      /**
       * The reference(s) this sale's document may carry. When the destination
       * holds a document under a different one, the id it was handed points at
       * someone else's document and it refuses — the fault class behind the
       * August "Order #0" collision, caught for free from a field the lookup
       * already returns.
       */
      expectedReferences?: string[];
      notes?: string | null;
      dryRun?: boolean;
    },
  ): Promise<SettleOutcome>;

  /** Fetch once per finalize run whatever `finalizeWithDate` needs across rows. */
  prepareFinalizeBatch?(ctx: AdapterCtx, opts?: { strategy?: FinalizeDateStrategy }): Promise<FinalizeBatch>;

  /** Certify a draft, moving its date only as far as the series rule forces. */
  finalizeWithDate?(
    invoiceId: string,
    ctx: AdapterCtx,
    opts: {
      strategy: FinalizeDateStrategy;
      /** What the buyer actually paid; the destination refuses to certify a
       *  document whose total drifted from it. */
      paidTotal?: number | null;
      batch?: FinalizeBatch;
      /** Builds the note stamped into the document's observations when the date
       *  has to move, given the date the document originally carried. A callback
       *  because only the caller knows what to call the transaction ("a encomenda
       *  #1137", "o pagamento Stripe pi_…") and only the destination knows the
       *  original date. Return null to stamp nothing. */
      dateMovedNote?: (originalDate: string) => string | null;
      dryRun?: boolean;
    },
  ): Promise<FinalizeOutcome>;
}
