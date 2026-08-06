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
// Two hard gates, in this order, before anything is sent:
//   1. `holdReason` — the document is parked for a human (invalid NIF in the
//      address line). The customer must not receive it.
//   2. `status === "draft"` — a draft is not a legal document. Emailing one
//      would hand the buyer a "rascunho" with no ATCUD.

export type IxEmailSkipReason =
  | "disabled"        // merchant has not opted in (ix_send_email != 1)
  | "held"            // parked for a human — see processed_orders.hold_reason
  | "draft"           // not finalized, so not a document we may send
  | "no_recipient"    // IX has no email on the client
  | "lookup_failed"   // could not read the document back from IX
  | "send_failed";    // IX refused the send

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

  const recipient = String(doc.client?.email ?? "").trim();
  // No fiscal_id check here on purpose. A Portuguese B2C sale without a NIF is
  // legally "Consumidor Final" and the buyer is just as entitled to their copy;
  // requiring one is why the admin path silently emailed nobody.
  if (!recipient) return { sent: false, reason: "no_recipient" };

  const { error: sendError } = await ixCall(
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
