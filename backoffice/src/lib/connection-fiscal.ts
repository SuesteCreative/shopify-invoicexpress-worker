/**
 * The fiscal identity a connection states for itself.
 *
 * The account's legacy `integrations` row belongs to ONE integration — the
 * account's Shopify shop, or the single setup of a client who never had one.
 * `projectConnectionBehaviour` therefore refuses to read it for any non-Shopify
 * source: what a Lodgify booking or a Stripe sale is filed as must come from
 * that connection or be left neutral.
 *
 * Which means a wizard that writes these to the legacy row is writing them where
 * the worker no longer looks. Measured 10/09/2026 on Farracemota Unipessoal, a
 * live Lodgify→InvoiceXpress client: series `FARRACEMOTAUNIPES`, document type
 * `invoice`, exemption `M99` and `vat_included = 1` were all configured, all on
 * the legacy row, and none of them reached a document. `vat_included` is the
 * expensive one — Lodgify prices are gross, and read as net they take another
 * 23% on top.
 *
 * So every source route that owns an IX connection writes them here instead.
 * An absent key still means "not stated": the worker falls back to the legacy
 * row for a Shopify source, and to the destination's own default otherwise.
 */
export const CONNECTION_FISCAL_TEXT_KEYS = [
    "ix_sequence_name",
    "ix_exemption_reason",
    "ix_document_type",
] as const;

/**
 * Booleans that mean the same thing on a connection as on the legacy row.
 * `vat_included` decides whether a line price already contains tax;
 * `auto_finalize` decides whether the document is certified or left a draft.
 */
export const CONNECTION_FISCAL_BOOL_KEYS = [
    "vat_included",
    "auto_finalize",
] as const;

export interface ConnectionFiscal {
    ix_sequence_name?: string;
    ix_exemption_reason?: string;
    ix_document_type?: string;
    vat_included?: boolean;
    auto_finalize?: boolean;
}

/** What this connection states, for the wizard to show. Silent about the rest. */
export function readConnectionFiscal(destinationConfigJson: string | null | undefined): ConnectionFiscal {
    let cfg: Record<string, any> = {};
    try { cfg = destinationConfigJson ? JSON.parse(destinationConfigJson) : {}; } catch { cfg = {}; }
    const out: ConnectionFiscal = {};
    for (const key of CONNECTION_FISCAL_TEXT_KEYS) {
        if (typeof cfg[key] === "string") out[key] = cfg[key];
    }
    for (const key of CONNECTION_FISCAL_BOOL_KEYS) {
        if (typeof cfg[key] === "boolean") out[key] = cfg[key];
        else if (cfg[key] === 0 || cfg[key] === 1) out[key] = cfg[key] === 1;
    }
    return out;
}

/**
 * Only the keys this request carries, so a partial post never erases a sibling.
 * An empty string is meaningful and kept: it clears the override and hands the
 * field back to the account's legacy row.
 *
 * Returns null when the request states nothing, which callers use to leave
 * `destination_config_json` untouched rather than patching an empty object over
 * it.
 */
export function fiscalPatchFrom(fiscal: Record<string, unknown> | undefined): Record<string, string | boolean> | null {
    if (!fiscal) return null;
    const patch: Record<string, string | boolean> = {};
    for (const key of CONNECTION_FISCAL_TEXT_KEYS) {
        const value = fiscal[key];
        if (typeof value === "string") patch[key] = value.trim();
    }
    for (const key of CONNECTION_FISCAL_BOOL_KEYS) {
        const value = fiscal[key];
        if (typeof value === "boolean") patch[key] = value;
    }
    return Object.keys(patch).length ? patch : null;
}
