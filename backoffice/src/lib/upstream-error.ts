/**
 * What an upstream API said about a rejection, as text.
 *
 * InvoiceXpress and Shopify both answer `errors` with whatever shape suits the
 * moment: a plain string, `{"errors":{"error":"Invalid API key"}}`, or a list.
 * Passed on as it arrived, the object left `/api/integrations/validate` inside
 * `error`, the wizard put it in state, and React was handed an object as a
 * child — minified error #31, which blanks the whole page. The same value is
 * bound to `integrations.ix_error`, which takes text and nothing else.
 *
 * So every message from a destination is reduced here, once, before it is
 * either stored or answered with.
 */
export function errorText(raw: unknown, fallback: string): string {
    if (raw === null || raw === undefined) return fallback;
    if (typeof raw === "string") return raw.trim() || fallback;
    if (Array.isArray(raw)) {
        const parts = raw.map(p => errorText(p, "")).filter(Boolean);
        return parts.length ? parts.join("; ") : fallback;
    }
    if (typeof raw === "object") {
        const held = raw as Record<string, unknown>;
        // The keys these APIs actually nest the sentence under, in the order
        // they mean it.
        for (const key of ["error", "message", "errors"]) {
            if (key in held) {
                const inner = errorText(held[key], "");
                if (inner) return inner;
            }
        }
        // Unrecognised shape: the JSON is still more useful to an operator than
        // "[object Object]", and it is still a string.
        return JSON.stringify(raw);
    }
    return String(raw);
}
