/**
 * Human label for an account.
 *
 * A Clerk id (`user_3IrUYEOi0uxDFI3IXxHX8gFxAdM`) identifies nothing to a human
 * reading a page. Anywhere the platform shows an account it shows this instead:
 *
 *   1. the name the client typed on the registration form (company_name for a
 *      company NIF, name for an individual one) — what they call themselves;
 *   2. `admin_label` — the store name an admin pinned in superadmin;
 *   3. the Clerk-derived personal name, then the email;
 *   4. the raw id, only when nothing else exists.
 *
 * Never feeds fiscal documents — identification only (see migration 0015).
 */
export interface AccountLabelFields {
    id?: string | null;
    name?: string | null;
    company_name?: string | null;
    admin_label?: string | null;
    email?: string | null;
}

const clean = (v: unknown): string | null => {
    const s = typeof v === "string" ? v.trim() : "";
    return s.length > 0 ? s : null;
};

export function accountLabel(u: AccountLabelFields | null | undefined, fallback?: string): string {
    if (!u) return fallback ?? "";
    return (
        clean(u.company_name) ??
        clean(u.admin_label) ??
        clean(u.name) ??
        clean(u.email) ??
        fallback ??
        clean(u.id) ??
        ""
    );
}

/** The same precedence as one SQL expression, for list queries.
 *  Callers alias it themselves, e.g. `${ACCOUNT_LABEL_SQL("u")} AS label`. */
export const ACCOUNT_LABEL_SQL = (alias = "u") =>
    `COALESCE(NULLIF(${alias}.company_name, ''), NULLIF(${alias}.admin_label, ''), NULLIF(${alias}.name, ''), ${alias}.email, ${alias}.id)`;
