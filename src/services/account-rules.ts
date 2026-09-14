import type { Env } from "../env";
import type { SourceKind, DestinationKind } from "../storage";
import { RULES, NO_RULES, parseRuleValue } from "./rules-catalogue";

export type AccountRules = Readonly<Record<string, string>>;

/**
 * What this account declared about how its documents are produced, with the
 * catalogue's defaults filled in for everything it did not.
 *
 * One query, three bound parameters, no `OR`, no wildcard, no fallback to
 * anything. That is the isolation: a rule is reachable only by a run that has
 * already declared itself to be this connection, and absence resolves to
 * `NO_RULES` — a frozen module constant that IS today's behaviour — never to
 * another account's answer or another connection's.
 *
 * Same contract as `loadProductOverrides`: best effort. A missing table or a D1
 * blip must never be the reason a sale goes uninvoiced, and falling back to the
 * defaults is falling back to exactly what the pipeline did before rules existed.
 */
export async function loadAccountRules(
  env: Env,
  userId: string,
  sourceKind: SourceKind,
  destinationKind: DestinationKind,
): Promise<AccountRules> {
  const db = (env as any).DB;
  if (!db) return NO_RULES;

  try {
    const result = await db.prepare(
      `SELECT rule_id, value_json
         FROM account_rules
        WHERE user_id = ? AND source_kind = ? AND destination_kind = ?`,
    ).bind(userId, sourceKind, destinationKind).all();

    const rows = (result.results ?? []) as Array<{ rule_id: string; value_json: string }>;
    if (rows.length === 0) return NO_RULES;

    const out: Record<string, string> = { ...NO_RULES };
    for (const row of rows) {
      let raw: unknown;
      try { raw = JSON.parse(row.value_json); } catch { raw = row.value_json; }
      const value = parseRuleValue(row.rule_id, raw);
      if (value !== null) {
        out[row.rule_id] = value;
      } else {
        // Loud, because the operator set something and it is not being applied —
        // but not fatal, because the rest of the account's rules are fine and a
        // document is better issued under the defaults than not issued.
        console.warn(
          `[account-rules] ${userId} ${sourceKind}->${destinationKind}: `
          + `ignoring ${RULES[row.rule_id] ? "unusable value for" : "unknown rule"} '${row.rule_id}'`,
        );
      }
    }
    return Object.freeze(out);
  } catch (err) {
    console.warn("[account-rules] load failed, using defaults:", err);
    return NO_RULES;
  }
}
