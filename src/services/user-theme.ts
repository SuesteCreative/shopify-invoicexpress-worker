import type { Env } from "../env";
import type { EmailTheme } from "./email-templates";

/**
 * Which skin a merchant chose in the dashboard, so the emails we send them are
 * dressed the same way.
 *
 * The dashboard paints itself from `localStorage`, which never reaches a server.
 * That is deliberate and stays that way: this column is a *copy* of the choice,
 * written by the backoffice when the toggle is flipped, and it is read here and
 * nowhere else. Nothing about how an invoice is built, routed or issued reads it.
 *
 * Fails open to the current default skin: a missing column, a dropped
 * connection or an account we cannot resolve all render Day, which is what the
 * dashboard shows someone who never touched the toggle.
 */
const DEFAULT_EMAIL_THEME: EmailTheme = "day";

export async function getUserTheme(env: Env, userId?: string | null): Promise<EmailTheme> {
  if (!userId) return DEFAULT_EMAIL_THEME;
  try {
    const row: any = await env.DB.prepare("SELECT theme FROM users WHERE id = ?").bind(userId).first();
    return row?.theme === "night" ? "night" : DEFAULT_EMAIL_THEME;
  } catch (e: any) {
    console.warn(`[theme] Could not read the skin for ${userId}: ${e?.message}`);
    return DEFAULT_EMAIL_THEME;
  }
}
