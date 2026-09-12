/**
 * Identifying a Kapta document by the number printed on it.
 *
 * Its own module, importing nothing from the server runtime, for the same reason
 * lib/subscription-state is: the module that talks to InvoiceXpress reaches the
 * Cloudflare request context, which cannot be imported under a test.
 */

/** What the admin surface needs to know about one Kapta document. */
export interface KaptaDocSummary {
    id: string;
    /** The number InvoiceXpress prints, e.g. "KAPTA2026/673". */
    number: string | null;
    /** Document state — "finalized", "canceled", "settled", "draft"… */
    state: string | null;
    /** What the document carries as its reference. For a Kapta service invoice
     * this is Stripe's own invoice number, e.g. "C2715CFE-1396". */
    reference: string | null;
    total: string | null;
    date: string | null;
    permalink: string | null;
}

/** Strip what differs between how IX prints a number and how a human types it:
 * spaces, and the case of the series. " kapta2026 / 673 " → "KAPTA2026/673". */
export function normalizeDocNumber(s: string | null | undefined): string {
    return (s || "").toUpperCase().replace(/\s+/g, "");
}

/**
 * A document number reduced to what it identifies, whichever way round it is
 * written.
 *
 * InvoiceXpress keeps the same number in two spellings: `sequence_number` is
 * NUMBER/SERIES ("673/Kapta2026") and `inverted_sequence_number` is what is
 * printed on the document, SERIES/NUMBER ("Kapta2026/673"). An admin types what
 * they read; comparing that against the other spelling finds nothing and calls a
 * real document missing. So a number stands for both ways of writing it.
 */
export function docNumberSpellings(s: string | null | undefined): string[] {
    const n = normalizeDocNumber(s);
    if (!n) return [];
    const parts = n.split("/");
    return parts.length === 2 ? [n, `${parts[1]}/${parts[0]}`] : [n];
}

/** The document an admin means by a typed number, or null when no such number exists. */
export function findInIndex(index: Map<string, KaptaDocSummary>, number: string): KaptaDocSummary | null {
    const wanted = new Set(docNumberSpellings(number));
    if (wanted.size === 0) return null;
    for (const doc of index.values()) {
        if (docNumberSpellings(doc.number).some(s => wanted.has(s))) return doc;
    }
    return null;
}
