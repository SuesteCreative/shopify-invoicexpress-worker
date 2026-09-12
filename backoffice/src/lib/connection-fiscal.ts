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
    // Which article a sale outside the EU is zero-rated under, when the merchant
    // wants one other than the default. Only consulted when a registration below
    // is on.
    "oss_export_exemption_code",
] as const;

/**
 * Booleans that mean the same thing on a connection as on the legacy row.
 * `vat_included` decides whether a line price already contains tax;
 * `auto_finalize` decides whether the document is certified or left a draft.
 */
export const CONNECTION_FISCAL_BOOL_KEYS = [
    "vat_included",
    "auto_finalize",
    // The tax REGISTRATIONS. Not preferences and not rules: a declaration of
    // what this business is registered for, which is the only thing a merchant
    // can answer that we cannot. Each one authorises exactly one rung of the VAT
    // decision to move money; absent means off, and absent is the default.
    //
    // `src/adapters/tax-rates.ts` reads all three straight off
    // `destination_config_json`, so a key written here is the key it reads.
    "oss_engine",
    "pt_regional_rates",
    "b2b_reverse_charge_pipeline",
] as const;

export interface ConnectionFiscal {
    ix_sequence_name?: string;
    ix_exemption_reason?: string;
    ix_document_type?: string;
    oss_export_exemption_code?: string;
    vat_included?: boolean;
    auto_finalize?: boolean;
    oss_engine?: boolean;
    pt_regional_rates?: boolean;
    b2b_reverse_charge_pipeline?: boolean;
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

/**
 * The InvoiceXpress credentials a connection holds for itself.
 *
 * Kept apart from the fiscal patch above, deliberately: these are secrets, and
 * `readConnectionFiscal` is sent to the browser. There is no read counterpart
 * here and there must not be one — a wizard shows whether credentials exist,
 * never what they are.
 *
 * Why on the connection at all: they used to live only on the account's legacy
 * `integrations` row, so a Stripe→IX or Lodgify→IX account grew a row that the
 * admin console then drew as a broken "Shopify → InvoiceXpress" integration.
 * Deleting that phantom destroyed the credential the real connection used.
 * Moloni and Vendus never had the problem because theirs live here.
 *
 * BLANK MEANS UNCHANGED, as on the legacy route: a form that rendered before
 * its GET returned must not be able to clear a live credential.
 */
export function ixCredentialPatchFrom(
    credentials: Record<string, unknown> | undefined,
): Record<string, string> | null {
    if (!credentials) return null;
    const patch: Record<string, string> = {};
    for (const key of ["ix_account_name", "ix_api_key", "ix_environment"] as const) {
        const value = credentials[key];
        if (typeof value === "string" && value.trim()) patch[key] = value.trim();
    }
    return Object.keys(patch).length ? patch : null;
}

/** Whether this connection holds both halves of its own IX credential. */
export function ixCredentialsOnConnection(destinationConfigJson: string | null | undefined): boolean {
    let cfg: Record<string, any> = {};
    try { cfg = destinationConfigJson ? JSON.parse(destinationConfigJson) : {}; } catch { cfg = {}; }
    return !!String(cfg.ix_account_name ?? "").trim() && !!String(cfg.ix_api_key ?? "").trim();
}

/** The connection's IX account name — not a secret, and the wizard shows it. */
export function ixAccountNameOnConnection(destinationConfigJson: string | null | undefined): string | null {
    let cfg: Record<string, any> = {};
    try { cfg = destinationConfigJson ? JSON.parse(destinationConfigJson) : {}; } catch { cfg = {}; }
    const name = String(cfg.ix_account_name ?? "").trim();
    return name || null;
}
