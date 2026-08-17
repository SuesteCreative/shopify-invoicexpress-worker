/**
 * Which SAF-T exemption code ("M10", "M05", …) a 0%-VAT document must carry.
 *
 * Portugal requires every exempt line to name the legal reason it is exempt, and
 * InvoiceXpress takes that as `tax_exemption_reason` on write. On READ it hands
 * the same value back under a different name, `tax_exemption` — and it does not
 * always hand back a value at all: a draft that was created with a reason has
 * been observed reading back with `tax_exemption: ""`.
 *
 * That empty string is what this function exists for. The obvious spelling,
 *
 *     doc.tax_exemption ?? config.ix_exemption_reason
 *
 * keeps the empty string, because `??` only falls through on null/undefined. The
 * caller then tests the result for truthiness, finds "" falsy, and omits the
 * field entirely — so a document that WAS exempt for a named legal reason is
 * rewritten with no reason at all. InvoiceXpress does not refuse that; it stamps
 * its own default, M99 ("não sujeito"), and the document silently declares a
 * different tax regime than the one it was issued under. That is the lliberta
 * 11/LL drift, and the Bikini Books and DO IT BRAVELY documents with it.
 *
 * So: an all-whitespace code is NO code, and the shop's configured reason takes
 * over. Returns null when neither side knows one — callers decide whether that
 * is survivable, and for a document being rewritten it is not.
 */
export function resolveExemptionCode(
  storedOnDocument: unknown,
  configured: string | null | undefined,
): string | null {
  const stored = typeof storedOnDocument === "string" ? storedOnDocument.trim() : "";
  if (stored) return stored;
  const fromConfig = typeof configured === "string" ? configured.trim() : "";
  return fromConfig || null;
}
