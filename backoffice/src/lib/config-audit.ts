/**
 * Who changed what, on a merchant's configuration.
 *
 * `config_audit` existed before this file and held two rows: only the admin
 * console's single-field editor ever wrote to it. Everything else that changes
 * a merchant's configuration — the integration wizards, the destructive
 * lifecycle actions — wrote nothing at all.
 *
 * That gap has a cost, measured. On 2026-09-10 Farracemota's InvoiceXpress
 * credentials were saved, validated, and eleven minutes later blanked. On
 * 2026-09-11 MeetFrank's whole legacy row was deleted, taking the credentials
 * every one of their connections authenticates with. In both cases invoicing
 * stopped silently, and in both cases there was no way to say who did it,
 * from where, or why — the systems that had done it kept no record.
 *
 * So every path that can break a merchant's invoicing writes here now.
 *
 * SECRETS NEVER GO IN. A credential's value is replaced by a presence marker:
 * the question this table answers is "was it there before and is it there
 * now", which needs no secret, and a truncated key is a leaked key.
 */

/** Columns whose VALUE must never be written to the trail. */
const SECRET_FIELDS = new Set([
    "ix_api_key",
    "shopify_token",
    "shopify_webhook_secret",
    "shopify_client_secret",
    "restricted_key",
    "webhook_secret",
    "moloni_client_secret",
    "moloni_password",
    "moloni_access_token",
    "moloni_refresh_token",
    "vendus_api_key",
    "api_key",
]);

/** What a secret looked like, without saying what it was. */
function presence(value: unknown): string {
    const s = String(value ?? "").trim();
    return s ? `«definido, ${s.length} caracteres»` : "«vazio»";
}

export function auditValue(field: string, value: unknown): string | null {
    if (SECRET_FIELDS.has(field)) return presence(value);
    if (value == null) return null;
    return String(value).slice(0, 500);
}

export interface AuditEntry {
    userId: string;
    /** The signed-in account that made the change — NOT the account changed. */
    actor: string | null;
    /** 'integrations' | 'connection:<source>-><dest>' | 'company_rules' | … */
    scope: string;
    field: string;
    oldValue: unknown;
    newValue: unknown;
}

export async function auditConfigChange(db: any, entry: AuditEntry): Promise<void> {
    try {
        await db.prepare(
            `INSERT INTO config_audit (id, user_id, actor, scope, field, old_value, new_value)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
            crypto.randomUUID(), entry.userId, entry.actor, entry.scope, entry.field,
            auditValue(entry.field, entry.oldValue), auditValue(entry.field, entry.newValue),
        ).run();
    } catch (e) {
        // The trail must never be the reason a legitimate change fails to save.
        console.warn("[config-audit] write failed:", e);
    }
}

/**
 * One row per column that actually changed, for a write that touches many.
 *
 * The integration wizards post partial bodies into an UPDATE of twenty-one
 * columns, so logging the request would be noise and logging every column
 * would bury the one line that matters. Only differences are written.
 */
export async function auditFieldDiff(
    db: any,
    ctx: { userId: string; actor: string | null; scope: string },
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
): Promise<string[]> {
    // Compared on the RAW values, stored through auditValue. Comparing the
    // stored form instead would hide a rotated key behind two identical
    // presence markers — the one credential change most worth having a record
    // of.  `null` and `""` are the same absence and are not a change.
    const same = (a: unknown, b: unknown) => (a == null ? "" : String(a)) === (b == null ? "" : String(b));

    const changed: string[] = [];
    for (const [field, next] of Object.entries(after)) {
        const prev = before?.[field] ?? null;
        if (same(prev, next)) continue;
        changed.push(field);
        await auditConfigChange(db, { ...ctx, field, oldValue: prev, newValue: next });
    }
    return changed;
}
