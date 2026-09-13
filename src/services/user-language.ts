import type { Env } from "../env";

/**
 * Which language a merchant is written to in.
 *
 * The choice lives on the account (`users.language`, migration 0061), is set by
 * the operator on the customer record or by the client on the Conta page, and is
 * read here so every email we render is in the language the rest of their Rioko
 * already speaks.
 *
 * Fails open to Portuguese: a missing column, a dropped connection or an account
 * we cannot resolve all send what every account received before this existed.
 * An email in the wrong language is worth more than no email at all.
 */
export type Lang = "pt" | "en";

export const DEFAULT_LANG: Lang = "pt";

/** Anything that is not the English marker is Portuguese — the same shape
 *  `getUserTheme` uses, and the reason a typo in the column cannot silence a
 *  send. */
export function asLang(value: unknown): Lang {
  return value === "en" ? "en" : DEFAULT_LANG;
}

export async function getUserLanguage(env: Env, userId?: string | null): Promise<Lang> {
  if (!userId) return DEFAULT_LANG;
  try {
    const row: any = await env.DB.prepare("SELECT language FROM users WHERE id = ?").bind(userId).first();
    return asLang(row?.language);
  } catch (e: any) {
    console.warn(`[lang] Could not read the language for ${userId}: ${e?.message}`);
    return DEFAULT_LANG;
  }
}
