import type { Env } from "../env";

/**
 * Accounts parked by decision.
 *
 * A dormant client (Fabrica Coffee Roasters, OPH Van de Ven, Casa de Celebrar a
 * Vida) still owns a shop, a domain and a pile of open incidents, so every
 * warning sender keeps writing to them about work nobody intends to do. An
 * alarm that is known-wrong is worse than no alarm: it teaches you to skim the
 * ones that are right. `users.is_inactive` (migration 0046) is the switch a
 * superadmin flips in Dev Mode, and it silences WARNINGS only — a newsletter is
 * not routed through here.
 *
 * Both readers fail open (nobody silenced) when the column is missing, so a
 * database that has not taken 0046 yet keeps its old behaviour instead of
 * losing every alert.
 */

/** Every account currently parked. Empty set when the column does not exist. */
export async function loadInactiveUserIds(env: Env): Promise<Set<string>> {
  try {
    const rows = await env.DB.prepare(
      "SELECT id FROM users WHERE COALESCE(is_inactive, 0) = 1"
    ).all();
    return new Set(((rows?.results ?? []) as any[]).map(r => String(r.id)));
  } catch {
    return new Set();
  }
}

/** Is this one account parked? */
export async function isInactiveAccount(env: Env, userId?: string | null): Promise<boolean> {
  if (!userId) return false;
  try {
    const row: any = await env.DB.prepare(
      "SELECT COALESCE(is_inactive, 0) AS is_inactive FROM users WHERE id = ?"
    ).bind(userId).first();
    return Number(row?.is_inactive) === 1;
  } catch {
    return false;
  }
}
