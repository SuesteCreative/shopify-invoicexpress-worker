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
    total: string | null;
    date: string | null;
    permalink: string | null;
}

/** Strip what differs between how IX prints a number and how a human types it:
 * spaces, and the case of the series. " kapta2026 / 673 " → "KAPTA2026/673". */
export function normalizeDocNumber(s: string | null | undefined): string {
    return (s || "").toUpperCase().replace(/\s+/g, "");
}

/** The document an admin means by a typed number, or null when no such number exists. */
export function findInIndex(index: Map<string, KaptaDocSummary>, number: string): KaptaDocSummary | null {
    const wanted = normalizeDocNumber(number);
    if (!wanted) return null;
    for (const doc of index.values()) {
        if (normalizeDocNumber(doc.number) === wanted) return doc;
    }
    return null;
}
