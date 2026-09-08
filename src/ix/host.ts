/**
 * The hostname an InvoiceXpress account answers on.
 *
 * There are two, and only one of them exists:
 *
 *   andramartinsvieir.app.invoicexpress.com  → 200, resolves
 *   andramartinsvieir.invoicexpress.com      → no A/AAAA record at all
 *
 * Measured 2026-09-08. The bare form had been in `resolveSequenceId` since it
 * was written, which meant the sequence lookup NEVER worked in production: the
 * fetch threw on DNS, the catch returned null, and the document went to the
 * account's default series without a word. A merchant who configured a series —
 * or routed one per country — got the default one on every document and nothing
 * said otherwise.
 *
 * The sandbox lives on a third subdomain, which is why this cannot be a single
 * string: `.macewindu.` is a different host, not a different path.
 */
export function ixAccountHost(account: string, environment?: string | null): string {
  const suffix = environment === "production"
    ? ".app.invoicexpress.com"
    : ".macewindu.invoicexpress.com";
  return `https://${account}${suffix}`;
}
