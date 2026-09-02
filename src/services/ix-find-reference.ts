import { IxApi } from "../api/ix";

/**
 * "Is there already a document with this reference?" — the idempotency question
 * every create asks before it writes.
 *
 * WHY THIS EXISTS: `ix-proxy`'s `POST /v2/documents/reference` answers a HIT in
 * ~1.6s and a MISS in ~152s. Measured repeatedly on 2026-09-02:
 *
 *     proxy, reference that exists          1 617 ms   200
 *     proxy, reference that does NOT exist 151 774 ms   404
 *     InvoiceXpress direct, exists          1 394 ms   200
 *     InvoiceXpress direct, does not exist    902 ms   200
 *
 * A miss is not the rare case — it is the normal case, because a document is
 * only ever created when it does not exist yet. So every legitimate create paid
 * ~150s (twice: the caller retried), and the callers died before answering:
 * `curl` returned HTTP 000, the 04:00 cron never reached its later passes, and
 * Zoo de Lagos sat on 81 unbilled orders that no automated path could recover.
 * That is the whole reason its backlog had to be drained by hand.
 *
 * So: ask InvoiceXpress directly, and keep the proxy as the fallback. The proxy
 * stays the only writer — this is a read, and one the destination can answer in
 * a second.
 *
 * The direct endpoint is a TEXT search, not an exact lookup: "Order #999999"
 * comes back with ten unrelated documents, and "Order #536" matches nothing of
 * "Order #5366". Filtering to an exact `reference` match is therefore not an
 * optimisation, it is what makes the answer correct — without it this would
 * report a document that does not exist and silently skip a real sale.
 */

export interface IxRefHeaders extends Record<string, string> {
  "x-account-name": string;
  "x-api-key": string;
  "x-env": "prod" | "dev";
}

/** The exact-match filter, separated so it can be tested without the network. */
export function pickExactReference(documents: any[], reference: string): string | null {
  const want = reference.trim();
  for (const doc of documents ?? []) {
    if (String(doc?.reference ?? "").trim() === want) {
      const id = doc?.id;
      if (id != null) return String(id);
    }
  }
  return null;
}

/**
 * Direct InvoiceXpress lookup. Returns the document id, `null` for a confirmed
 * miss, and throws for anything it could not determine — the caller must be
 * able to tell "there is no document" apart from "I could not find out", since
 * the first means create and the second must not.
 */
export async function findViaInvoiceXpress(headers: IxRefHeaders, reference: string, timeoutMs = 15_000): Promise<string | null> {
  const account = headers["x-account-name"];
  const key = headers["x-api-key"];
  if (!account || !key) throw new Error("missing IX account credentials");
  // Sandbox lives on a different host and is not worth guessing at: dev falls
  // through to the proxy, which is slow but correct everywhere.
  if (headers["x-env"] !== "prod") throw new Error("non-production environment");

  const url = `https://${account}.app.invoicexpress.com/invoices.json`
    + `?text=${encodeURIComponent(reference)}&api_key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`InvoiceXpress search HTTP ${res.status}`);
  const body: any = await res.json();
  // The endpoint returns whichever collection matches the account's document
  // types; both shapes carry the same fields.
  const list: any[] = body?.invoices ?? body?.invoice_receipts ?? [];
  return pickExactReference(list, reference);
}

/** The original path, kept as the fallback. Slow on a miss, but it works. */
async function findViaProxy(headers: IxRefHeaders, reference: string, attempts: number): Promise<string | null> {
  let lastErr: unknown = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await IxApi.v2.documents.reference.post({ headers, body: { reference } });
      const id = res.data?.data?.id;
      if (id) return String(id);
      return null;
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, 300));
  }
  if (lastErr) {
    console.warn(`[Rioko] IX reference lookup errored ${attempts}x for "${reference}": ${String((lastErr as any)?.message ?? lastErr).slice(0, 120)}`);
  }
  return null;
}

/**
 * The document id for `reference`, or null if the destination has none.
 *
 * Tries InvoiceXpress directly first (~1s either way) and falls back to the
 * proxy when that cannot answer. Returning null on a failed fallback preserves
 * the behaviour every caller was written against: the create then proceeds and
 * the destination's own idempotency is the last guard.
 */
export async function findIxDocumentIdByReference(
  headers: IxRefHeaders,
  reference: string,
  opts: { timeoutMs?: number; proxyAttempts?: number } = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  try {
    return await findViaInvoiceXpress(headers, reference, timeoutMs);
  } catch (e: any) {
    console.warn(`[Rioko] direct IX reference lookup unavailable for "${reference}" (${String(e?.message ?? e).slice(0, 80)}); falling back to proxy`);
    return await findViaProxy(headers, reference, opts.proxyAttempts ?? 2);
  }
}
