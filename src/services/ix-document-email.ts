import type { IRequestConfig } from "../storage";
import { IxApi } from "../api/ix";
import { ixCall } from "../ix/ix-call";

// Sending the issued document to the buyer, in one place.
//
// InvoiceXpress sends the mail itself (`PUT /{type}/{id}/email-document.json`,
// exposed by our proxy as `POST /v2/documents/{id}/email`): it goes out from
// the merchant's own IX account, carries their logo and series, and the body
// contains the document's quicklink — the public `permalink` — from which the
// customer views it and downloads the PDF. That is the right sender for a
// fiscal document, and it costs us no deliverability reputation of our own.
//
// This used to be copy-pasted at four call sites (legacy orders/paid, the
// adapter pipeline, the admin finalize, the sweep) which had drifted apart:
// one required the client to have a fiscal_id before it would send, another
// threw on a failed send and so failed the whole webhook *after* the invoice
// had already been created and finalized — turning a missed email into a
// retry storm and a duplicate-finalize attempt. Both are fixed here.
//
// Three hard gates, in this order, before anything is sent:
//   1. `holdReason` — the document is parked for a human (invalid NIF in the
//      address line). The customer must not receive it.
//   2. `status === "draft"` — a draft is not a legal document. Emailing one
//      would hand the buyer a "rascunho" with no ATCUD.
//   3. the document's age — a buyer hears from us about a purchase they just
//      made, never about one from months ago. See DEFAULT_MAX_AGE_DAYS.

export type IxEmailSkipReason =
  | "disabled"        // merchant has not opted in (ix_send_email != 1)
  | "held"            // parked for a human — see processed_orders.hold_reason
  | "draft"           // not finalized, so not a document we may send
  | "backlog"         // the sale is old — see the age gate below
  | "no_recipient"    // IX has no email on the client
  | "lookup_failed"   // could not read the document back from IX
  | "send_failed";    // IX refused the send

/**
 * How old a sale may be and still have its invoice mailed to the buyer.
 *
 * This exists because turning the feature on is retroactive by accident. The
 * flag `ix_send_email` had been set on a shop for days before the code that
 * reads it was deployed; the moment it went live, a backlog re-finalization
 * mailed four customers an invoice for a book they had bought in June. Nobody
 * asked for that mail and nobody was expecting it.
 *
 * So the gate is on the DOCUMENT'S OWN DATE, not on which code path we came
 * through: a buyer hears from us about a purchase they just made, and never
 * about one they made months ago. Two days rather than one so a Multibanco
 * order that confirms the next morning still counts as current.
 */
const DEFAULT_MAX_AGE_DAYS = 2;

/** IX serves dates as DD/MM/YYYY. Returns null for anything else. */
function ixDateToUtcMs(value: unknown): number | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return Number.isFinite(ms) ? ms : null;
}

export type IxEmailOutcome =
  | { sent: true; recipient: string; permalink?: string }
  | { sent: false; reason: IxEmailSkipReason; detail?: string };

function ixHeaders(config: IRequestConfig) {
  return {
    "x-account-name": config.ix_account_name!,
    "x-api-key": config.ix_api_key!,
    "x-env": config.ix_environment === "production" ? "prod" as const : "dev" as const,
  };
}

function ixCollection(config: IRequestConfig): "invoices" | "invoice_receipts" {
  return config.ix_document_type === "invoice_receipt" ? "invoice_receipts" : "invoices";
}

/**
 * Email an issued InvoiceXpress document to the client on it.
 *
 * Never throws: a failed send is reported in the return value so the caller can
 * log it without failing an otherwise-successful invoice+finalize cycle.
 */
export async function sendIxDocumentEmail(
  config: IRequestConfig,
  invoiceId: string | number,
  opts?: {
    /** Non-null when the document is parked for a human — nothing is sent. */
    holdReason?: string | null;
    /** Force the send even for a draft. Only the admin tools pass this. */
    allowDraft?: boolean;
    /**
     * Override the age gate. `0` disables it — reserved for a human explicitly
     * asking us to re-send one named document, never for a batch.
     */
    maxAgeDays?: number;
    /**
     * When the sale happened (YYYY-MM-DD), when that differs from the date on
     * the document. A retro-finalize moves the document's date forward to
     * satisfy IX's series rule, which would make a two-month-old sale look
     * like today's to the age gate — the very mail this is meant to prevent.
     * Callers that move a date MUST pass the date they moved it from.
     */
    saleDate?: string;
  },
): Promise<IxEmailOutcome> {
  if (Number(config.ix_send_email) !== 1) return { sent: false, reason: "disabled" };
  if (opts?.holdReason) return { sent: false, reason: "held", detail: opts.holdReason };
  if (!config.ix_account_name || !config.ix_api_key) {
    return { sent: false, reason: "lookup_failed", detail: "IX credentials missing on the integration" };
  }

  const id = Number(invoiceId);
  const headers = ixHeaders(config);

  const { data, error } = await ixCall(
    () => IxApi.v2.documents.byId.get({ headers, path: { id } }),
    { isOk: (r) => !r.error, label: `get ${id}` },
  );

  if (error || !data?.data) {
    return { sent: false, reason: "lookup_failed", detail: JSON.stringify(error ?? null).slice(0, 300) };
  }

  const doc: any = data.data;
  const status = String(doc.status ?? "").toLowerCase();
  const permalink: string | undefined = doc.permalink || undefined;

  if (status === "draft" && !opts?.allowDraft) {
    return { sent: false, reason: "draft", detail: `document ${id} is still a draft` };
  }

  // Age gate — see DEFAULT_MAX_AGE_DAYS. Deliberately AFTER the draft check and
  // before we look at the recipient, so a backlog document is reported as
  // "backlog" rather than being mistaken for a missing address.
  const maxAgeDays = opts?.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  if (maxAgeDays > 0) {
    // Whole calendar days on both sides — IX gives a date, not a timestamp, so
    // comparing it against "now" would make a two-day-old document three days
    // old by the afternoon.
    const saleMs = opts?.saleDate ? Date.parse(`${opts.saleDate}T00:00:00Z`) : NaN;
    const docMs = Number.isFinite(saleMs) ? saleMs : ixDateToUtcMs(doc.date);
    const now = new Date();
    const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const ageDays = docMs == null ? null : Math.round((todayMs - docMs) / 864e5);
    if (ageDays != null && ageDays > maxAgeDays) {
      return {
        sent: false,
        reason: "backlog",
        detail: `document ${id} is for a sale on ${opts?.saleDate ?? doc.date} (${ageDays}d old) — past sales are not mailed`,
      };
    }
  }

  const recipient = String(doc.client?.email ?? "").trim();
  // No fiscal_id check here on purpose. A Portuguese B2C sale without a NIF is
  // legally "Consumidor Final" and the buyer is just as entitled to their copy;
  // requiring one is why the admin path silently emailed nobody.
  if (!recipient) return { sent: false, reason: "no_recipient" };

  const { data: sendData, error: sendError } = await ixCall(
    () => IxApi.v2.documents.byId.email.post({
      body: {
        message: {
          client: { email: recipient, save: "0" },
          subject: config.ix_email_subject ?? undefined,
          body: config.ix_email_body ?? undefined,
        },
      },
      path: { id },
      query: { type: ixCollection(config) },
      headers,
    }),
    { isOk: (r) => !r.error, label: `email ${id}` },
  );

  if (sendError) {
    return { sent: false, reason: "send_failed", detail: JSON.stringify(sendError).slice(0, 300) };
  }

  // The proxy wraps IX's reply in its own {data, success, error} envelope, and
  // the SDK only populates `error` for a non-2xx status. So a failure reported
  // INSIDE a 200 envelope would otherwise be read as a successful send.
  //
  // Verified live against a real finalized document: IX answers this endpoint
  // with an EMPTY body, which the proxy cannot JSON-parse, so a good send comes
  // back as `{ success: true, error: { code: "PARSE_FAILED" } }`. That error is
  // therefore NOT a signal — only an explicit `success: false` is.
  const envelope = sendData as any;
  if (envelope && envelope.success === false) {
    return { sent: false, reason: "send_failed", detail: JSON.stringify(envelope.error ?? envelope).slice(0, 300) };
  }

  return { sent: true, recipient, permalink };
}

/** One-line summary for the `logs` table / console. */
export function describeIxEmailOutcome(invoiceId: string | number, outcome: IxEmailOutcome): string {
  if (outcome.sent) return `Email sent to ${outcome.recipient} for document ${invoiceId}`;
  return `Email skipped for document ${invoiceId} (${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ""})`;
}

/**
 * The document's public quicklink — the page where the buyer views the document
 * and downloads its PDF. IX returns it on the document itself; this is the
 * standalone lookup for the paths that only hold an id (merchant emails,
 * dashboard links). Returns null rather than throwing.
 */
export async function getIxDocumentPermalink(config: IRequestConfig, invoiceId: string | number): Promise<string | null> {
  if (!config.ix_account_name || !config.ix_api_key) return null;
  try {
    const { data, error } = await ixCall(
      () => IxApi.v2.documents.byId.link.get({
        headers: ixHeaders(config),
        path: { id: Number(invoiceId) },
        query: { type: "permalink" },
      }),
      { isOk: (r) => !r.error, label: `permalink ${invoiceId}` },
    );
    if (error) return null;
    // The endpoint returns the URL directly as `data` (a bare string).
    const link = (data as any)?.data;
    return typeof link === "string" && link ? link : null;
  } catch {
    return null;
  }
}
