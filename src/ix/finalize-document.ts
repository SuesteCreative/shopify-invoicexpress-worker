import { IxApi } from "../api/ix";
import { ixCall } from "./ix-call";
import { ixEnvelopeError } from "../adapters/destinations/ix-destination";
import { isAlreadyFinalizedIxError } from "../adapters/destinations/ix-finalize";

export type IxDocKind = "invoice" | "invoice_receipt";

export type IxHeaders = Record<string, string> & {
  "x-account-name": string;
  "x-api-key": string;
  "x-env": "prod" | "dev";
};

/**
 * Certify one InvoiceXpress draft. Nothing else — no logging, no email, no
 * state of its own.
 *
 * Two answers count as done: no error at all, and IX saying the document was
 * already finalized. A redelivered webhook must not be read as a failure just
 * because the first delivery did the work.
 *
 * Anything else is returned, never swallowed: an IX refusal that reads as
 * success is how a draft stays a draft with nobody told.
 */
export async function finalizeIxDocumentById(
  headers: IxHeaders,
  invoiceId: string,
  docKind: IxDocKind,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const { data, error } = await ixCall(
    () => IxApi.v2.changeState.post({
      body: { type: docKind, id: Number(invoiceId), state: "finalized" },
      headers,
    }),
    { isOk: (r) => !r.error, label: `finalize ${invoiceId}` },
  );

  const failure = error ?? ixEnvelopeError(data);
  if (failure && !isAlreadyFinalizedIxError(failure)) {
    return { ok: false, detail: JSON.stringify(failure).slice(0, 500) };
  }
  return { ok: true };
}
