import { getStripeEnv, getStripeEnvOptional } from "./stripe";
import { documentFromGetResponse, remainingPages, summarizeIxDoc, type KaptaDocSummary } from "./kapta-doc-number";

export { findInIndex, normalizeDocNumber, docNumberSpellings, type KaptaDocSummary } from "./kapta-doc-number";

interface KaptaIXConfig {
    account: string;
    apiKey: string;
    env: string;
}

interface IXDocument {
    id: string;
    type: "invoice_receipts" | "invoices" | "credit_notes";
    state: string;
    /** IX's own spelling of the number: NUMBER/SERIES, e.g. "673/Kapta2026". Not
     * what is printed on the document — see `inverted_sequence_number`. */
    sequence_number?: string;
    /** The number as printed, SERIES/NUMBER, e.g. "Kapta2026/673". This is the one
     * an admin reads off the document and types. */
    inverted_sequence_number?: string;
    reference?: string;
    date?: string;
    total?: string;
    client?: {
        name?: string;
        email?: string;
        fiscal_id?: string;
        address?: string;
        postal_code?: string;
        city?: string;
        country?: string;
    };
    permalink?: string;
}

interface MatchCandidate {
    email?: string | null;
    name?: string | null;
    nif?: string | null;
    address?: string | null;
    zip?: string | null;
    amount_cents: number;
    paid_at: Date;
}

interface MatchResult {
    ix_invoice_id: string | null;
    ix_invoice_permalink: string | null;
    ix_match_method: "reference" | "heuristic" | null;
    ix_match_score: number | null;
}

function getConfig(): KaptaIXConfig | null {
    const account = getStripeEnvOptional("KAPTA_IX_ACCOUNT_NAME");
    const apiKey = getStripeEnvOptional("KAPTA_IX_API_KEY");
    const env = getStripeEnvOptional("KAPTA_IX_ENV") || "production";
    if (!account || !apiKey) return null;
    return { account, apiKey, env };
}

/**
 * Every call to InvoiceXpress gives up after this long.
 *
 * None had a limit. A page that never answered held the request open until
 * Cloudflare cut it, and the admin's Faturas Kapta tab sat on "A ler os
 * pagamentos…" with nothing to say why — on every client, because every visit
 * walked the whole account. A timeout turns that into an error the panel shows.
 */
const IX_FETCH_TIMEOUT_MS = 10_000;

function ixFetch(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, { ...init, signal: AbortSignal.timeout(IX_FETCH_TIMEOUT_MS) });
}

/** `limit` at a time, in order of the input. A rejection stops nothing else. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
    const out: PromiseSettledResult<R>[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            try { out[i] = { status: "fulfilled", value: await fn(items[i]) }; }
            catch (reason) { out[i] = { status: "rejected", reason }; }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

/** The host answers the same for the life of an isolate; no need to ask per call. */
const _baseUrlCache = new Map<string, string>();

async function getBaseUrl(cfg: KaptaIXConfig): Promise<string> {
    const cached = _baseUrlCache.get(cfg.account);
    if (cached) return cached;

    const isTest = cfg.env === "sandbox" || cfg.env === "test" || cfg.env === "macewindu";
    const suffix = isTest ? ".macewindu.invoicexpress.com" : ".invoicexpress.com";
    const domain = cfg.account.toLowerCase().endsWith(".invoicexpress.com")
        ? cfg.account
        : `${cfg.account}${suffix}`;

    let url = `https://${domain}`;
    if (!isTest && !cfg.account.includes(".app") && !cfg.account.endsWith(".invoicexpress.com")) {
        try {
            const check = await ixFetch(`https://${domain}/clients.json?per_page=1&api_key=${cfg.apiKey}`, { method: "HEAD" });
            if (check.status === 530 || check.status === 404) url = `https://${cfg.account}.app.invoicexpress.com`;
        } catch { url = `https://${cfg.account}.app.invoicexpress.com`; }
    }
    _baseUrlCache.set(cfg.account, url);
    return url;
}

function buildPermalink(cfg: KaptaIXConfig, baseUrl: string, doc: IXDocument): string {
    return `${baseUrl}/${doc.type}/${doc.id}`;
}

type IxEndpoint = { endpoint: string; list: string; type: "invoice_receipts" | "invoices" | "credit_notes" };

function endpointsFor(docType: "invoice" | "credit_note"): IxEndpoint[] {
    return docType === "credit_note"
        ? [{ endpoint: "credit_notes", list: "credit_notes", type: "credit_notes" }]
        : [
            { endpoint: "invoice_receipts", list: "invoice_receipts", type: "invoice_receipts" },
            { endpoint: "invoices", list: "invoices", type: "invoices" },
        ];
}

// Per-account doc-list cache. matchStripeChargeToIX runs once per pending event in
// the ix-match cron loop, ALL against the same Kapta IX account. Paginating
// listRecent per call (needed so a charge whose doc sits past page 1 still
// matches — the "Tentativas esgotadas" bug) would otherwise multiply the fetch
// count by the batch size and blow the Workers subrequest budget. We fetch the
// full list once and reuse it across the run. Short TTL so a doc created between
// runs is still picked up on the next sweep.
const IX_LIST_PAGE_SIZE = 100;
const IX_LIST_MAX_PAGES = 20; // ≤2000 docs per type — covers the whole Kapta account
const IX_LIST_CACHE_TTL_MS = 60_000;
/** Pages fetched at once once IX has said how many there are. */
const IX_LIST_CONCURRENCY = 4;
const _listCache = new Map<string, { at: number; docs: IXDocument[] }>();

async function listRecent(cfg: KaptaIXConfig, baseUrl: string, docType: "invoice" | "credit_note" = "invoice"): Promise<IXDocument[]> {
    const cacheKey = `${cfg.account}:${docType}`;
    const hit = _listCache.get(cacheKey);
    if (hit && Date.now() - hit.at < IX_LIST_CACHE_TTL_MS) return hit.docs;

    const authHeaders = { "X-InvoiceXpress-API-Key": cfg.apiKey, "Accept": "application/json" };
    const docs: IXDocument[] = [];
    for (const t of endpointsFor(docType)) {
        const pageUrl = (page: number) => `${baseUrl}/${t.endpoint}.json?per_page=${IX_LIST_PAGE_SIZE}&page=${page}&api_key=${cfg.apiKey}`;
        try {
            const res = await ixFetch(pageUrl(1), { headers: authHeaders });
            if (!res.ok) continue;
            const first: any = await res.json();
            const list = first[t.list] || [];
            for (const d of list) docs.push({ ...d, type: t.type });
            if (list.length < IX_LIST_PAGE_SIZE) continue; // one page was all of it

            // When IX says how many pages there are, the rest are fetched a few at
            // a time instead of one after another: the account is hundreds of
            // documents, and a page at a time made every read take as long as all
            // of them together.
            const rest = remainingPages(first, IX_LIST_MAX_PAGES);
            if (rest) {
                const pages = await mapLimit(rest, IX_LIST_CONCURRENCY, async (page) => {
                    const r = await ixFetch(pageUrl(page), { headers: authHeaders });
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    const data: any = await r.json();
                    return (data[t.list] || []) as any[];
                });
                for (const p of pages) {
                    if (p.status === "fulfilled") for (const d of p.value) docs.push({ ...d, type: t.type });
                    else console.error(`[Kapta IX] listRecent ${t.endpoint} page error`, p.reason);
                }
                continue;
            }

            for (let page = 2; page <= IX_LIST_MAX_PAGES; page++) {
                const r = await ixFetch(pageUrl(page), { headers: authHeaders });
                if (!r.ok) break;
                const data: any = await r.json();
                const more = data[t.list] || [];
                for (const d of more) docs.push({ ...d, type: t.type });
                if (more.length < IX_LIST_PAGE_SIZE) break; // last page reached
            }
        } catch (err) {
            console.error(`[Kapta IX] listRecent ${t.endpoint} error`, err);
        }
    }
    _listCache.set(cacheKey, { at: Date.now(), docs });
    return docs;
}

export async function findByReference(reference: string, docType: "invoice" | "credit_note" = "invoice"): Promise<IXDocument | null> {
    const cfg = getConfig();
    if (!cfg) return null;
    const baseUrl = await getBaseUrl(cfg);
    const authHeaders = { "X-InvoiceXpress-API-Key": cfg.apiKey, "Accept": "application/json" };
    for (const t of endpointsFor(docType)) {
        for (let page = 1; page <= IX_LIST_MAX_PAGES; page++) {
            try {
                const res = await ixFetch(`${baseUrl}/${t.endpoint}.json?per_page=${IX_LIST_PAGE_SIZE}&page=${page}&api_key=${cfg.apiKey}&text=${encodeURIComponent(reference)}`, { headers: authHeaders });
                if (!res.ok) break;
                const data: any = await res.json();
                const list = data[t.list] || [];
                const matches = list.filter((d: any) => d.reference === reference || (typeof d.reference === "string" && d.reference.includes(reference)));
                // A cancelled document and the one that replaced it carry the SAME
                // reference — Kapta cancels and re-issues against the same Stripe
                // invoice. An exact reference hit is still a guess between the two,
                // and only one of them is the document that stands.
                const found = matches.find((d: any) => normalize(d.state) !== "canceled") ?? matches[0];
                if (found) {
                    const doc: IXDocument = { ...found, type: t.type };
                    // Prefer IX's own public permalink (no login wall). buildPermalink builds the
                    // back-office URL which requires a Kapta login — only use it as a fallback.
                    doc.permalink = (typeof found.permalink === "string" && found.permalink)
                        ? found.permalink
                        : buildPermalink(cfg, baseUrl, doc);
                    return doc;
                }
                if (list.length < IX_LIST_PAGE_SIZE) break; // last page reached
            } catch (err) {
                console.error(`[Kapta IX] findByReference p${page} error`, err);
                break;
            }
        }
    }
    return null;
}

/**
 * The whole Kapta account, indexed by document id.
 *
 * Only for the one question that needs all of it: turning a number an admin
 * typed into a document (IX has no lookup by `sequence_number`). Reading what an
 * account's payments point at does NOT go through here any more — see
 * getDocumentSummaries — because walking hundreds of documents to show one
 * client's three is what kept the Faturas Kapta tab loading forever.
 */
export async function listDocumentIndex(
    docType: "invoice" | "credit_note" = "invoice",
): Promise<Map<string, KaptaDocSummary>> {
    const index = new Map<string, KaptaDocSummary>();
    const cfg = getConfig();
    if (!cfg) return index;
    const baseUrl = await getBaseUrl(cfg);
    for (const d of await listRecent(cfg, baseUrl, docType)) {
        const summary = summarizeIxDoc(d, buildPermalink(cfg, baseUrl, { ...d, id: String(d.id) }));
        index.set(summary.id, summary);
    }
    return index;
}

/**
 * The documents behind these ids, one GET each.
 *
 * An id does not say which endpoint it lives under, so an invoice id is tried as
 * a fatura-recibo first and then as a fatura. Ids IX does not know are simply
 * absent from the answer. Throws only when not a single request got an answer,
 * so the caller can tell "no such document" from "InvoiceXpress is down".
 */
export async function getDocumentSummaries(
    ids: string[],
    docType: "invoice" | "credit_note" = "invoice",
): Promise<Map<string, KaptaDocSummary>> {
    const found = new Map<string, KaptaDocSummary>();
    const cfg = getConfig();
    if (!cfg) return found;
    const baseUrl = await getBaseUrl(cfg);
    const authHeaders = { "X-InvoiceXpress-API-Key": cfg.apiKey, "Accept": "application/json" };
    const unique = [...new Set(ids.map((id) => String(id).replace(/\.0$/, "")).filter(Boolean))];

    let answered = 0;
    let failed: unknown = null;
    await mapLimit(unique, IX_LIST_CONCURRENCY, async (id) => {
        for (const t of endpointsFor(docType)) {
            try {
                const res = await ixFetch(`${baseUrl}/${t.endpoint}/${encodeURIComponent(id)}.json?api_key=${cfg.apiKey}`, { headers: authHeaders });
                answered++;
                if (!res.ok) continue; // not under this endpoint
                const doc = documentFromGetResponse(await res.json());
                if (!doc) continue;
                found.set(id, summarizeIxDoc(doc, buildPermalink(cfg, baseUrl, { ...(doc as any), id, type: t.type })));
                return;
            } catch (e) {
                failed = e;
            }
        }
    });
    if (unique.length > 0 && answered === 0 && failed) throw failed;
    return found;
}

/** The standing document each of these Stripe invoice numbers is stamped on. */
export async function getReferenceSummaries(references: string[]): Promise<Map<string, KaptaDocSummary>> {
    const found = new Map<string, KaptaDocSummary>();
    const cfg = getConfig();
    if (!cfg) return found;
    const baseUrl = await getBaseUrl(cfg);
    const unique = [...new Set(references.map((r) => r.trim()).filter(Boolean))];
    await mapLimit(unique, IX_LIST_CONCURRENCY, async (reference) => {
        const doc = await findByReference(reference, "invoice");
        if (doc) found.set(reference, summarizeIxDoc(doc, buildPermalink(cfg, baseUrl, doc)));
    });
    return found;
}

function normalize(s: string | null | undefined): string {
    return (s || "").toLowerCase().trim();
}

// NIFs must compare by digits only. Kapta/InvoiceXpress stores the fiscal id with
// a country prefix on some clients (e.g. "PT513292918") while our subscriptions
// table holds the bare 9-digit NIF ("513292918"); a raw string compare would miss
// the strongest match signal. Strip everything non-numeric before comparing.
function normalizeNif(s: string | null | undefined): string {
    return (s || "").replace(/\D/g, "");
}

// Postal codes compared without spaces/dashes/case (NL "5481 VB" ⇒ "5481VB",
// PT "1600-019" ⇒ "1600019").
function normalizeZip(s: string | null | undefined): string {
    return (s || "").replace(/[\s-]/g, "").toUpperCase();
}

// InvoiceXpress dates are "DD/MM/YYYY". `new Date("09/07/2026")` would parse that
// as US M/D/Y (September 7), throwing off proximity scoring — parse explicitly.
function parseIxDate(s: string | null | undefined): Date | null {
    if (!s) return null;
    const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
}

function levenshtein(a: string, b: string): number {
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const dp: number[][] = [];
    for (let i = 0; i <= a.length; i++) dp[i] = [i];
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]) + 1;
        }
    }
    return dp[a.length][b.length];
}

// Scores an IX document against a payment. Two designed paths clear the 60
// threshold on their own, matching how our checkout feeds Stripe → Kapta → IX:
//   • NIF present (the deterministic case): NIF(45) + amount(20) = 65. Kapta reads
//     the fiscal id from Stripe metadata, so it is exactly the NIF we collected.
//   • NIF absent (the field is optional at checkout): the user-specified fallback
//     name(15) + billing address(25) + amount(20) = 60. The IX client is built
//     from the same Stripe customer, so the address line + postal code match.
function scoreCandidate(doc: IXDocument, c: MatchCandidate): number {
    let score = 0;
    const dNif = normalizeNif(doc.client?.fiscal_id);
    const dEmail = normalize(doc.client?.email);
    const dName = normalize(doc.client?.name);
    const cNif = normalizeNif(c.nif);
    const cEmail = normalize(c.email);
    const cName = normalize(c.name);

    if (cNif && dNif && cNif === dNif) score += 45;
    if (cEmail && dEmail && cEmail === dEmail) score += 25;

    const docTotalCents = doc.total ? Math.round(parseFloat(doc.total) * 100) : null;
    if (docTotalCents !== null && Math.abs(docTotalCents - c.amount_cents) <= 1) score += 20;

    if (cName && dName && cName.length > 2 && dName.length > 2) {
        const dist = levenshtein(cName, dName);
        if (dist === 0) score += 15;
        else if (dist <= 3 && dist < Math.max(cName.length, dName.length) / 3) score += 8;
    }

    // Billing address — the primary no-NIF fallback signal. Strong (line + postal
    // code both match) is nearly per-customer unique; partial corroborates.
    const dLine = normalize(doc.client?.address);
    const cLine = normalize(c.address);
    const dZip = normalizeZip(doc.client?.postal_code);
    const cZip = normalizeZip(c.zip);
    const lineMatch = !!cLine && !!dLine && (cLine === dLine || levenshtein(cLine, dLine) <= 2);
    const zipMatch = !!cZip && !!dZip && cZip === dZip;
    if (lineMatch && zipMatch) score += 25;
    else if (lineMatch || zipMatch) score += 12;

    // Date proximity: discriminator for repeat customers paying same amount monthly
    const docDate = parseIxDate(doc.date);
    if (docDate) {
        const hoursDiff = Math.abs(c.paid_at.getTime() - docDate.getTime()) / 3600000;
        if (hoursDiff <= 24) score += 15;
        else if (hoursDiff <= 72) score += 8;
        else if (hoursDiff > 168) score -= 10; // older than a week → penalize
    }

    return score;
}

export async function findByHeuristic(c: MatchCandidate, docType: "invoice" | "credit_note" = "invoice"): Promise<{ doc: IXDocument; score: number } | null> {
    const cfg = getConfig();
    if (!cfg) return null;
    const baseUrl = await getBaseUrl(cfg);
    const docs = await listRecent(cfg, baseUrl, docType);

    let best: { doc: IXDocument; score: number } | null = null;
    for (const d of docs) {
        // A cancelled document is not the one that invoiced this payment, however
        // well it scores. It was cancelled because it was wrong, and the one that
        // replaced it is in the same list carrying the same client and amount —
        // which is exactly why the guess landed on the dead one: one2rent read a
        // cancelled invoice as their own because the matcher had no idea what
        // "canceled" meant.
        if (normalize(d.state) === "canceled") continue;
        const score = scoreCandidate(d, c);
        if (score > (best?.score ?? 0)) best = { doc: d, score };
    }

    if (best && best.score >= 60) {
        // Keep IX's public permalink (preserved from the list response); fall back to the
        // back-office URL only if the API didn't return one.
        if (!(typeof best.doc.permalink === "string" && best.doc.permalink)) {
            best.doc.permalink = buildPermalink(cfg, baseUrl, best.doc);
        }
        return best;
    }
    return null;
}

export async function matchStripeChargeToIX(opts: {
    payment_intent_id?: string | null;
    /** Stripe's own invoice number, e.g. "C2715CFE-1396". */
    invoice_number?: string | null;
    candidate: MatchCandidate;
    doc_type?: "invoice" | "credit_note";
    extra_refs?: string[];
}): Promise<MatchResult> {
    const docType = opts.doc_type || "invoice";

    // Try 1: exact reference match (try multiple refs: pi_xxx, bare id, re_xxx for refunds, etc.)
    const refsToTry: string[] = [];
    // The Stripe INVOICE NUMBER first, because for a subscription payment it is
    // the exact answer: Kapta's connector stamps it on the document as the
    // reference ("C2715CFE-1396"). The payment_intent spellings below never
    // match one of those, so every renewal fell through to the heuristic while
    // the exact number sat unused in the event we had stored.
    if (opts.invoice_number) refsToTry.push(opts.invoice_number);
    if (opts.payment_intent_id) {
        // Kapta's Stripe→IX connector stamps the document reference as "#stripe_<bareId>"
        // (bare = payment_intent id without the pi_ prefix). Match that first for a
        // deterministic hit; keep the pi_/full variants as fallbacks.
        const bare = opts.payment_intent_id.replace(/^(pi_|ch_)/, "");
        refsToTry.push(`#stripe_${bare}`, bare, `pi_${bare}`, opts.payment_intent_id);
    }
    if (opts.extra_refs) refsToTry.push(...opts.extra_refs);

    for (const ref of refsToTry) {
        const doc = await findByReference(ref, docType);
        if (doc) {
            return {
                ix_invoice_id: String(doc.id),
                ix_invoice_permalink: doc.permalink || null,
                ix_match_method: "reference",
                ix_match_score: 100,
            };
        }
    }

    // Try 2: heuristic
    const h = await findByHeuristic(opts.candidate, docType);
    if (h) {
        return {
            ix_invoice_id: String(h.doc.id),
            ix_invoice_permalink: h.doc.permalink || null,
            ix_match_method: "heuristic",
            ix_match_score: h.score,
        };
    }

    return { ix_invoice_id: null, ix_invoice_permalink: null, ix_match_method: null, ix_match_score: null };
}
