import { describe, it, expect } from "vitest";
import { AppStorage } from "./storage";

/**
 * "Already resolved" has to survive a big backfill.
 *
 * `getResolvedOrderIds` asks three tables at once, and the statement repeats the
 * id list in each — so the number of bound variables is THREE times the chunk,
 * plus two scopes. D1 refuses a statement with more than 100, the whole chunk
 * throws, and the catch that keeps a backfill running also swallows every
 * hand-made resolution in it.
 *
 * Measured on Escola Lá Fora (15/09/2026): four payments marked "não
 * necessária", of which a 52-candidate backfill honoured exactly the two that
 * landed in the short trailing chunk. Nothing in the run said the other two had
 * been ignored — they simply came back as billable.
 *
 * The test is on the BINDING, not on a database: node:sqlite has no such limit,
 * so an in-memory run would pass at any chunk size and prove nothing.
 */
const D1_MAX_BOUND_VARIABLES = 100;

function countingEnv(seen: Array<{ sql: string; n: number }>) {
  return {
    DB: {
      prepare(sql: string) {
        const api = {
          bind(...args: any[]) { seen.push({ sql, n: args.length }); return api; },
          async all() { return { results: [] }; },
          async first() { return null; },
          async run() { return { meta: {} }; },
        };
        return api;
      },
    },
  } as any;
}

describe("getResolvedOrderIds stays inside D1's variable limit", () => {
  it("never binds more than 100 variables, whatever the candidate count", async () => {
    for (const total of [1, 30, 31, 52, 100, 499]) {
      const seen: Array<{ sql: string; n: number }> = [];
      const storage = new AppStorage(countingEnv(seen), undefined, "user_X");
      await storage.getResolvedOrderIds(
        Array.from({ length: total }, (_, i) => `pi_${i}`),
        "u:user_X",
      );
      expect(seen.length).toBeGreaterThan(0);
      const worst = Math.max(...seen.map((s) => s.n));
      expect(worst, `${total} candidatos ligaram ${worst} variáveis`).toBeLessThanOrEqual(D1_MAX_BOUND_VARIABLES);
    }
  });

  it("asks about every candidate, not only the ones in a surviving chunk", async () => {
    // The failure mode was silent partial coverage, so count the ids the aux
    // lookup actually asked about across all its chunks.
    const asked: Array<{ sql: string; n: number }> = [];
    const storage = new AppStorage(countingEnv(asked), undefined, "user_X");
    const ids = Array.from({ length: 52 }, (_, i) => `pi_${i}`);
    await storage.getResolvedOrderIds(ids, "u:user_X");

    // Each aux statement binds 3 ids per candidate plus the 2 scopes.
    const aux = asked.filter((s) => s.sql.includes("reconciliation_decision"));
    expect(aux.length).toBeGreaterThan(1);
    expect(aux.reduce((s, x) => s + (x.n - 2) / 3, 0)).toBe(ids.length);
  });
});
