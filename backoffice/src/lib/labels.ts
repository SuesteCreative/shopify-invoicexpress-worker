/**
 * Human label for an account.
 *
 * A Clerk id (`user_3IrUYEOi0uxDFI3IXxHX8gFxAdM`) identifies nothing to a human
 * reading a page. Anywhere the platform shows an account it shows this instead:
 *
 *   1. `admin_label` — the trading name an admin pinned in superadmin;
 *   2. the name the client typed on the registration form (company_name for a
 *      company NIF, name for an individual one);
 *   3. the Clerk-derived personal name, then the email;
 *   4. the raw id, only when nothing else exists.
 *
 * `admin_label` leads because it is the only field anyone curates, and what it
 * holds is the name the company trades under: "Mr. VanCamper" where the
 * registration says "Vandersol Lda", "WHM" where it says "WHM Services
 * Unipessoal LDA", "MeetFrank" where it says "EMBARKNOWLEDGE LDA". The legal
 * name is right on a document and wrong on a screen. Same order as the worker's
 * src/services/account-label.ts, so a panel and an alert email about the same
 * account agree.
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

/**
 * Values that occupy the name column without naming anybody. The Clerk webhook
 * writes the literal "User" for a signup with no first name, no last name and
 * no username, so `name` can hold a placeholder that every reader downstream
 * treats as an answer — which is how alert emails ended up announcing accounts
 * as "User". Refused here, once, for every surface that reads a label.
 * Mirrored worker-side in src/services/account-label.ts.
 */
const PLACEHOLDER_NAMES = ["user", "utilizador", "unknown", "n/a", "-"];

const clean = (v: unknown): string | null => {
    const s = typeof v === "string" ? v.trim() : "";
    return s.length > 0 ? s : null;
};

/** A name, or nothing — the placeholder never counts as one. */
export const realName = (v: unknown): string | null => {
    const s = clean(v);
    return s && !PLACEHOLDER_NAMES.includes(s.toLowerCase()) ? s : null;
};

export function accountLabel(u: AccountLabelFields | null | undefined, fallback?: string): string {
    if (!u) return fallback ?? "";
    return (
        clean(u.admin_label) ??
        clean(u.company_name) ??
        realName(u.name) ??
        clean(u.email) ??
        fallback ??
        clean(u.id) ??
        ""
    );
}

/** The same precedence as one SQL expression, for list queries.
 *  Callers alias it themselves, e.g. `${ACCOUNT_LABEL_SQL("u")} AS label`. */
export const ACCOUNT_LABEL_SQL = (alias = "u") =>
    `COALESCE(NULLIF(${alias}.admin_label, ''), NULLIF(${alias}.company_name, ''), ${REAL_NAME_SQL(alias)}, ${alias}.email, ${alias}.id)`;

/** `<alias>.name` unless it is a placeholder, for queries that want the person. */
export function REAL_NAME_SQL(alias = "u"): string {
    const list = PLACEHOLDER_NAMES.map((p) => `'${p}'`).join(",");
    return `CASE WHEN LOWER(TRIM(COALESCE(${alias}.name, ''))) IN (${list}) THEN NULL ELSE NULLIF(TRIM(${alias}.name), '') END`;
}
