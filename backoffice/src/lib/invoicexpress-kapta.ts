import { getStripeEnv, getStripeEnvOptional } from "./stripe";

interface KaptaIXConfig {
    account: string;
    apiKey: string;
    env: string;
}

interface IXDocument {
    id: string;
    type: "invoice_receipts" | "invoices";
    state: string;
    reference?: string;
    date?: string;
    total?: string;
    client?: {
        name?: string;
        email?: string;
        fiscal_id?: string;
        address?: string;
    };
    permalink?: string;
}

interface MatchCandidate {
    email?: string | null;
    name?: string | null;
    nif?: string | null;
    address?: string | null;
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

async function getBaseUrl(cfg: KaptaIXConfig): Promise<string> {
    const isTest = cfg.env === "sandbox" || cfg.env === "test" || cfg.env === "macewindu";
    const suffix = isTest ? ".macewindu.invoicexpress.com" : ".invoicexpress.com";
    const domain = cfg.account.toLowerCase().endsWith(".invoicexpress.com")
        ? cfg.account
        : `${cfg.account}${suffix}`;

    if (!isTest && !cfg.account.includes(".app") && !cfg.account.endsWith(".invoicexpress.com")) {
        try {
            const check = await fetch(`https://${domain}/clients.json?per_page=1&api_key=${cfg.apiKey}`, { method: "HEAD" });
            if (check.status === 530 || check.status === 404) return `https://${cfg.account}.app.invoicexpress.com`;
        } catch { return `https://${cfg.account}.app.invoicexpress.com`; }
    }
    return `https://${domain}`;
}

function buildPermalink(cfg: KaptaIXConfig, baseUrl: string, doc: IXDocument): string {
    return `${baseUrl}/${doc.type}/${doc.id}`;
}

async function listRecent(cfg: KaptaIXConfig, baseUrl: string): Promise<IXDocument[]> {
    const authHeaders = { "X-InvoiceXpress-API-Key": cfg.apiKey, "Accept": "application/json" };
    const types: { endpoint: string; list: string; type: "invoice_receipts" | "invoices" }[] = [
        { endpoint: "invoice_receipts", list: "invoice_receipts", type: "invoice_receipts" },
        { endpoint: "invoices", list: "invoices", type: "invoices" },
    ];
    const docs: IXDocument[] = [];
    for (const t of types) {
        try {
            const res = await fetch(`${baseUrl}/${t.endpoint}.json?per_page=50&api_key=${cfg.apiKey}`, { headers: authHeaders });
            if (!res.ok) continue;
            const data: any = await res.json();
            const list = data[t.list] || [];
            for (const d of list) {
                docs.push({ ...d, type: t.type });
            }
        } catch (err) {
            console.error(`[Kapta IX] listRecent ${t.endpoint} error`, err);
        }
    }
    return docs;
}

export async function findByReference(reference: string): Promise<IXDocument | null> {
    const cfg = getConfig();
    if (!cfg) return null;
    const baseUrl = await getBaseUrl(cfg);
    const authHeaders = { "X-InvoiceXpress-API-Key": cfg.apiKey, "Accept": "application/json" };
    const types: { endpoint: string; list: string; type: "invoice_receipts" | "invoices" }[] = [
        { endpoint: "invoice_receipts", list: "invoice_receipts", type: "invoice_receipts" },
        { endpoint: "invoices", list: "invoices", type: "invoices" },
    ];
    for (const t of types) {
        try {
            const res = await fetch(`${baseUrl}/${t.endpoint}.json?per_page=100&api_key=${cfg.apiKey}&text=${encodeURIComponent(reference)}`, { headers: authHeaders });
            if (!res.ok) continue;
            const data: any = await res.json();
            const list = data[t.list] || [];
            const found = list.find((d: any) => d.reference === reference || (typeof d.reference === "string" && d.reference.includes(reference)));
            if (found) {
                const doc: IXDocument = { ...found, type: t.type };
                doc.permalink = buildPermalink(cfg, baseUrl, doc);
                return doc;
            }
        } catch (err) {
            console.error(`[Kapta IX] findByReference error`, err);
        }
    }
    return null;
}

function normalize(s: string | null | undefined): string {
    return (s || "").toLowerCase().trim();
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

function scoreCandidate(doc: IXDocument, c: MatchCandidate): number {
    let score = 0;
    const dNif = normalize(doc.client?.fiscal_id);
    const dEmail = normalize(doc.client?.email);
    const dName = normalize(doc.client?.name);
    const cNif = normalize(c.nif);
    const cEmail = normalize(c.email);
    const cName = normalize(c.name);

    if (cNif && dNif && cNif === dNif) score += 40;
    if (cEmail && dEmail && cEmail === dEmail) score += 25;

    const docTotalCents = doc.total ? Math.round(parseFloat(doc.total) * 100) : null;
    if (docTotalCents !== null && Math.abs(docTotalCents - c.amount_cents) <= 1) score += 20;

    if (cName && dName && cName.length > 2 && dName.length > 2) {
        const dist = levenshtein(cName, dName);
        if (dist === 0) score += 10;
        else if (dist <= 3 && dist < Math.max(cName.length, dName.length) / 3) score += 7;
    }

    return score;
}

export async function findByHeuristic(c: MatchCandidate): Promise<{ doc: IXDocument; score: number } | null> {
    const cfg = getConfig();
    if (!cfg) return null;
    const baseUrl = await getBaseUrl(cfg);
    const docs = await listRecent(cfg, baseUrl);

    let best: { doc: IXDocument; score: number } | null = null;
    for (const d of docs) {
        const score = scoreCandidate(d, c);
        if (score > (best?.score ?? 0)) best = { doc: d, score };
    }

    if (best && best.score >= 60) {
        best.doc.permalink = buildPermalink(cfg, baseUrl, best.doc);
        return best;
    }
    return null;
}

export async function matchStripeChargeToIX(opts: {
    payment_intent_id?: string | null;
    candidate: MatchCandidate;
}): Promise<MatchResult> {
    // Try 1: exact reference match
    if (opts.payment_intent_id) {
        const ref = `pi_${opts.payment_intent_id.replace(/^pi_/, "")}`;
        const doc = await findByReference(ref);
        if (doc) {
            return {
                ix_invoice_id: doc.id,
                ix_invoice_permalink: doc.permalink || null,
                ix_match_method: "reference",
                ix_match_score: 100,
            };
        }
        // Try also without prefix
        const docBare = await findByReference(opts.payment_intent_id);
        if (docBare) {
            return {
                ix_invoice_id: docBare.id,
                ix_invoice_permalink: docBare.permalink || null,
                ix_match_method: "reference",
                ix_match_score: 100,
            };
        }
    }

    // Try 2: heuristic
    const h = await findByHeuristic(opts.candidate);
    if (h) {
        return {
            ix_invoice_id: h.doc.id,
            ix_invoice_permalink: h.doc.permalink || null,
            ix_match_method: "heuristic",
            ix_match_score: h.score,
        };
    }

    return { ix_invoice_id: null, ix_invoice_permalink: null, ix_match_method: null, ix_match_score: null };
}
