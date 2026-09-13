/**
 * The language an account is spoken to in — screens, toasts and emails alike.
 *
 * One column, `users.language` (migration 0061), written from two places (the
 * customer record and the Conta page) and read everywhere the client is
 * addressed. The worker has its own reader for the emails it sends
 * (`src/services/user-language.ts`); this is the browser side of the same
 * setting.
 *
 * Portuguese is what a missing value, an unreadable database or an account we
 * cannot resolve all fall back to: it is what every account was written to
 * before this existed.
 */
export const LANGUAGES = ["pt", "en"] as const;

export type Lang = (typeof LANGUAGES)[number];

export const DEFAULT_LANG: Lang = "pt";

export function asLang(value: unknown): Lang {
    return value === "en" ? "en" : DEFAULT_LANG;
}

export function isLang(value: unknown): value is Lang {
    return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

/**
 * The language of the ACCOUNT this person works in, which for an invited member
 * is the owner's choice and not their own. One statement rather than a
 * membership lookup followed by a second read: this runs in the middleware, on
 * every page a signed-in merchant opens.
 *
 * `status = 'active'` is what `resolveAccountUser` requires of a membership too;
 * a revoked member falls back to their own (empty) account, which is also what
 * every other account-scoped read gives them.
 */
export async function readAccountLanguage(db: D1Database, authUserId: string): Promise<Lang> {
    try {
        const row: any = await db.prepare(`
            SELECT COALESCE(owner.language, self.language) AS language
              FROM users self
              LEFT JOIN account_members m
                     ON m.member_user_id = self.id AND m.status = 'active'
              LEFT JOIN users owner ON owner.id = m.account_id
             WHERE self.id = ?
             LIMIT 1
        `).bind(authUserId).first();
        return asLang(row?.language);
    } catch {
        // Before 0061 lands there is no column to read. The dashboard has to
        // open anyway, in the language it has always opened in.
        return DEFAULT_LANG;
    }
}
