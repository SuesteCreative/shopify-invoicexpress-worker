/**
 * Strip credentials out of free text before it is stored or emailed.
 *
 * WHY: destination errors arrive as whole request descriptions. InvoiceXpress
 * takes its credential in the QUERY STRING, so a timeout comes back as
 *
 *     Request timed out: GET https://<account>.app.invoicexpress.com/invoices/268954123.json?api_key=<the real key>
 *
 * and that string is what we put in `dev_jobs.results`, in `incidents.summary`
 * and `incidents.detail_json`, and then into the ops digest email. Found on
 * 2026-09-02 in a live sweep response: a merchant's API key, in plain text, on
 * its way to D1 and to an inbox.
 *
 * Deliberately a blunt instrument. It runs on strings nobody controls, so it
 * matches the SHAPE of a credential rather than any particular vendor's field,
 * and it is applied at the boundary where text becomes a stored record — not at
 * every call site, which is how one gets missed.
 */

// Order matters. `Bearer` runs first because the header pattern below would
// otherwise treat the word "Bearer" as the value and leave the token standing —
// which is exactly what the test caught.
const PATTERNS: Array<[RegExp, string]> = [
  // Bearer tokens wherever they appear.
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, "$1«redacted»"],
  // Credentials in a query string: ?api_key=…, &token=…, &access_token=…
  [/([?&](?:api_key|apikey|key|token|access_token|auth|password|secret)=)[^&\s"'\\]+/gi, "$1«redacted»"],
  // Credentials in a header dump or JSON body: "x-api-key": "…", api_key: '…'.
  // `&` is excluded from the value so this cannot run past the end of a query
  // parameter and swallow the rest of the URL with it — an operator needs the
  // page and the document id that follow.
  [/(["']?(?:x-api-key|api[-_]?key|authorization|access[-_]?token|client[-_]?secret|password)["']?\s*[:=]\s*["']?)[^\s,&"'}\]]+/gi, "$1«redacted»"],
];

/** Redact credentials from a string. Returns the input unchanged when clean. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/**
 * Redact credentials anywhere inside a JSON-serialisable value, keys included.
 *
 * Walks the structure rather than stringifying and re-parsing, so a value that
 * was not a string (an id, a total) keeps its type and stays usable by whatever
 * reads the record later.
 */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === "string") return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // A key whose NAME says credential is redacted whatever its value looks
      // like — `{ ix_api_key: "d795a…" }` carries no ?api_key= to match on.
      out[k] = /^(x-)?(api[-_]?key|ix_api_key|shopify_token|token|access_token|client_secret|secret|password|hmac_secret)$/i.test(k)
        ? "«redacted»"
        : redactDeep(v, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}
