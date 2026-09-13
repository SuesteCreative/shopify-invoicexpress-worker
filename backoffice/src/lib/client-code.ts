/**
 * The customer number, and the one place a `users` row is created.
 *
 * `RIO-1A2B3C` — six uppercase hex characters. The alphabet 0-9A-F has no
 * visually confusable pair in it (no O against 0, no I or l against 1), which
 * matters because this code exists to be read aloud on a support call and typed
 * back by someone else. Minted the same way here and in
 * `migrations/0058_client_code.sql` (`hex(randomblob(3))`), so the backfill and
 * the runtime cannot drift into two different formats.
 *
 * It names the ACCOUNT. It is never a credential — nothing may gate access on it
 * — and never fiscal: it does not reach a document, a series or a reference.
 *
 * NO CODE IS EVER REPEATED, and none is ever reused. Two things enforce that and
 * they are not the same thing: the unique index on `users.client_code` keeps two
 * LIVE accounts apart, and the `client_codes` ledger keeps a DELETED account's
 * number out of circulation for good. Without the second, a deleted company's
 * `document_events` and `processed_orders` — which survive the deletion on
 * purpose — could end up filed under a number somebody else now answers to.
 * Every mint claims the ledger first and only then writes the row.
 *
 * `upsertUserRow` is here rather than inline because the same
 * INSERT … ON CONFLICT was written out twice, byte for byte, in the Clerk
 * webhook and in /api/auth/sync. Two copies of the statement that creates every
 * customer is two places to forget the code — and now, two places to forget the
 * retry.
 *
 * Nothing here imports Clerk or the request context: every function takes its
 * D1 handle. That is what lets the real SQL run against node:sqlite in the test
 * beside this file, which is the only way a column that does not exist gets
 * caught before production. Same reason `kapta-doc-number.ts` is runtime-free.
 */

export const CLIENT_CODE_PREFIX = "RIO-";
export const CLIENT_CODE_RE = /^RIO-[0-9A-F]{6}$/;

/** A fresh code. Three random bytes, printed the way SQLite's hex() prints them. */
export function newClientCode(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(3));
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return CLIENT_CODE_PREFIX + hex.toUpperCase();
}

/**
 * The canonical form of whatever someone typed, or null.
 *
 * A code that gets dictated gets typed back as `rio-1a2b3c`, `RIO 1A2B3C` or
 * just `1a2b3c`, and an operator who has to guess the punctuation will stop
 * using it. Separators and case are noise; the six hex characters are the code.
 * `R`, `I` and `O` are not hex, so stripping a leading RIO can never eat part of
 * a body.
 */
export function normalizeClientCode(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const compact = String(raw).toUpperCase().replace(/[\s\-_]/g, "");
    const body = compact.startsWith("RIO") ? compact.slice(3) : compact;
    return /^[0-9A-F]{6}$/.test(body) ? CLIENT_CODE_PREFIX + body : null;
}

const UPSERT_SQL = `
    INSERT INTO users (id, email, name, last_login, client_code)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        name = excluded.name,
        last_login = CURRENT_TIMESTAMP,
        -- A login never rewrites a code that exists, but it heals a row that
        -- somehow has none.
        client_code = COALESCE(users.client_code, excluded.client_code)`;

/**
 * The upsert that does not touch the code at all.
 *
 * Two callers: an account that already has its number (a login must not mint,
 * or every sign-in would burn a code), and a database where 0058 has not been
 * applied yet.
 */
const UPSERT_SQL_NO_CODE = `
    INSERT INTO users (id, email, name, last_login)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        name = excluded.name,
        last_login = CURRENT_TIMESTAMP`;

/** 0058 not applied yet: the column, or the ledger table, is not there. */
const MISSING_COLUMN = /no such column|has no column named|no such table/i;
const UNIQUE_VIOLATION = /unique/i;

/**
 * Claim a code in the ledger. Throws on a code that was ever issued before.
 *
 * This, not the unique index on `users`, is what makes a number unrepeatable:
 * the index only knows about accounts that still exist, and a deleted account's
 * documents do not disappear with it.
 */
async function claimClientCode(db: any, code: string, userId: string): Promise<void> {
    await db.prepare("INSERT INTO client_codes (code, user_id) VALUES (?, ?)").bind(code, userId).run();
}

/**
 * Create or refresh the `users` row for a Clerk identity.
 *
 * A code is minted only for an account that has none — a login must never mint,
 * or every sign-in would burn a number. Three attempts, because a code already
 * in the ledger (live or retired) is a `UNIQUE` failure and the only sane answer
 * is another code. At 16.7M codes this effectively never runs, which is exactly
 * why it has to be written down once instead of remembered twice.
 */
export async function upsertUserRow(
    db: any,
    user: { id: string; email: string | null; name: string | null },
): Promise<void> {
    const touch = () => db.prepare(UPSERT_SQL_NO_CODE).bind(user.id, user.email, user.name).run();

    let existing: string | null = null;
    try {
        const row: any = await db.prepare("SELECT client_code FROM users WHERE id = ?").bind(user.id).first();
        existing = row?.client_code ? String(row.client_code) : null;
    } catch (e: any) {
        // The deploy can land before the migration does (0058 is applied by
        // hand, like everything since 0018). Sign-ups must not stop for it.
        if (!MISSING_COLUMN.test(String(e?.message ?? e))) throw e;
        await touch();
        return;
    }

    if (existing) { await touch(); return; }

    for (let attempt = 0; attempt < 3; attempt++) {
        const code = newClientCode();
        try {
            await claimClientCode(db, code, user.id);
            await db.prepare(UPSERT_SQL).bind(user.id, user.email, user.name, code).run();
            return;
        } catch (e: any) {
            const msg = String(e?.message ?? e);
            if (MISSING_COLUMN.test(msg)) { await touch(); return; }
            if (UNIQUE_VIOLATION.test(msg) && attempt < 2) continue;
            throw e;
        }
    }
}

/**
 * The account's code, minting one if the row arrived without it.
 *
 * The safety net for rows created by something other than the two upserts — a
 * hand edit in D1, a restore. Called by the pages that DISPLAY the code, never
 * on a hot path. Returns null when there is no such row, or when 0058 has not
 * been applied: a missing code must not take a page down with it.
 */
export async function ensureClientCode(db: any, userId: string): Promise<string | null> {
    try {
        const row: any = await db.prepare("SELECT client_code FROM users WHERE id = ?").bind(userId).first();
        if (!row) return null;
        if (row.client_code) return String(row.client_code);

        for (let attempt = 0; attempt < 3; attempt++) {
            const code = newClientCode();
            try {
                await claimClientCode(db, code, userId);
                const res: any = await db
                    .prepare("UPDATE users SET client_code = ? WHERE id = ? AND client_code IS NULL")
                    .bind(code, userId)
                    .run();
                if ((res?.meta?.changes ?? 0) > 0) return code;
                // Nothing changed: somebody else filled it in between the read
                // and the write. Theirs is the code.
                const again: any = await db.prepare("SELECT client_code FROM users WHERE id = ?").bind(userId).first();
                return again?.client_code ? String(again.client_code) : null;
            } catch (e: any) {
                if (UNIQUE_VIOLATION.test(String(e?.message ?? e)) && attempt < 2) continue;
                throw e;
            }
        }
        return null;
    } catch {
        return null;
    }
}

export interface ResolvedClient {
    /** The account whose record should be shown. */
    accountId: string;
    /** Set when the code named a MEMBER: the `users` id that was asked for. */
    memberOf: string | null;
}

/**
 * Code (or Clerk id) → the account to show.
 *
 * A Clerk id is accepted so every link already pointing at
 * `/admin/users/<id>/dev-mode` converts without breaking, and so an operator
 * holding a raw id from a log line can still open the record.
 *
 * A member's code resolves to the OWNER's account, with `memberOf` set so the
 * page can redirect and say why. Without that, dictating a member's code opens
 * an empty record and nobody works out what happened.
 */
export async function resolveClientCode(db: any, raw: string | null | undefined): Promise<ResolvedClient | null> {
    let id: string | null = null;

    const code = normalizeClientCode(raw);
    if (code) {
        const row: any = await db.prepare("SELECT id FROM users WHERE client_code = ?").bind(code).first()
            .catch(() => null);
        id = row?.id ? String(row.id) : null;
    } else if (typeof raw === "string" && raw.startsWith("user_")) {
        const row: any = await db.prepare("SELECT id FROM users WHERE id = ?").bind(raw).first()
            .catch(() => null);
        id = row?.id ? String(row.id) : null;
    }

    if (!id) return null;

    // The same question `findMembershipFor` answers, asked of the handle this
    // module was given instead of the one it reads off the request context —
    // which is what keeps this file testable. The predicate must stay identical
    // to lib/account.ts: active membership, oldest first.
    const membership: any = await db
        .prepare("SELECT account_id FROM account_members WHERE member_user_id = ? AND status = 'active' ORDER BY accepted_at ASC LIMIT 1")
        .bind(id)
        .first()
        .catch(() => null);

    return membership?.account_id
        ? { accountId: String(membership.account_id), memberOf: id }
        : { accountId: id, memberOf: null };
}

/**
 * A code that was issued and whose account is gone.
 *
 * Lets the record page answer "this number belonged to an account that has been
 * deleted" instead of the same blank 404 a typo gets. The number itself stays
 * burnt either way — it is never handed to anyone else.
 */
export async function lookupRetiredCode(
    db: any, raw: string | null | undefined,
): Promise<{ code: string; user_id: string | null; created_at: string } | null> {
    const code = normalizeClientCode(raw);
    if (!code) return null;
    const row: any = await db
        .prepare("SELECT code, user_id, created_at FROM client_codes WHERE code = ?")
        .bind(code)
        .first()
        .catch(() => null);
    return row ? { code: String(row.code), user_id: row.user_id ?? null, created_at: String(row.created_at) } : null;
}
