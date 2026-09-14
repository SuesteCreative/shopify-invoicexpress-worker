import { describe, it, expect, vi } from "vitest";
import { loadAccountRules } from "./account-rules";
import { NO_RULES } from "./rules-catalogue";

/**
 * The property that matters here is the one about what a rule must NOT reach.
 *
 * The leak `projectConnectionBehaviour` exists to stop had a single cause: one
 * shared row a second integration fell back to. These tests are the proof that
 * there is no such row and no such fallback — another account sees nothing,
 * another connection of the SAME account sees nothing, and absence resolves to
 * the catalogue's defaults rather than to somebody else's answer.
 */
type Row = { user_id: string; source_kind: string; destination_kind: string; rule_id: string; value_json: string };

function envWith(rows: Row[], opts: { throws?: boolean } = {}) {
  return {
    DB: {
      prepare() {
        let bound: unknown[] = [];
        const api = {
          bind(...args: unknown[]) { bound = args; return api; },
          async all() {
            if (opts.throws) throw new Error("D1_ERROR: no such table: account_rules");
            const [userId, source, destination] = bound as string[];
            return {
              results: rows.filter((r) =>
                r.user_id === userId && r.source_kind === source && r.destination_kind === destination),
            };
          },
        };
        return api;
      },
    },
  } as any;
}

const row = (over: Partial<Row> = {}): Row => ({
  user_id: "user_a",
  source_kind: "stripe",
  destination_kind: "invoicexpress",
  rule_id: "buyer_address",
  value_json: JSON.stringify("payment_then_customer"),
  ...over,
});

describe("loadAccountRules", () => {
  it("applies the rule the account declared", async () => {
    const rules = await loadAccountRules(envWith([row()]), "user_a", "stripe", "invoicexpress");
    expect(rules.buyer_address).toBe("payment_then_customer");
  });

  it("never reaches another account's rule", async () => {
    const rules = await loadAccountRules(envWith([row()]), "user_b", "stripe", "invoicexpress");
    expect(rules).toEqual(NO_RULES);
  });

  // One merchant may run Stripe→IX alongside Shopify→IX, and each is its own
  // business decision. This is the same account, asking as its other connection.
  it("never reaches the same account's other connection", async () => {
    const rules = await loadAccountRules(envWith([row()]), "user_a", "shopify", "invoicexpress");
    expect(rules).toEqual(NO_RULES);

    const other = await loadAccountRules(envWith([row()]), "user_a", "stripe", "moloni");
    expect(other).toEqual(NO_RULES);
  });

  it("ignores a rule the catalogue does not know, and keeps the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rules = await loadAccountRules(
      envWith([row(), row({ rule_id: "invented_by_hand" })]),
      "user_a", "stripe", "invoicexpress",
    );
    expect(rules.buyer_address).toBe("payment_then_customer");
    expect((rules as any).invented_by_hand).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("ignores a value the catalogue does not offer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rules = await loadAccountRules(
      envWith([row({ value_json: JSON.stringify("from_the_moon") })]),
      "user_a", "stripe", "invoicexpress",
    );
    expect(rules.buyer_address).toBe(NO_RULES.buyer_address);
    warn.mockRestore();
  });

  // A missing table or a D1 blip must never be the reason a sale goes
  // uninvoiced. Falling back to the defaults is falling back to what the
  // pipeline did before rules existed.
  it("falls back to today's behaviour when the read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rules = await loadAccountRules(envWith([], { throws: true }), "user_a", "stripe", "invoicexpress");
    expect(rules).toEqual(NO_RULES);
    warn.mockRestore();
  });

  it("returns nothing a later run could mutate", async () => {
    const rules = await loadAccountRules(envWith([row()]), "user_a", "stripe", "invoicexpress");
    expect(Object.isFrozen(rules)).toBe(true);
  });

  it("survives an env with no database at all", async () => {
    const rules = await loadAccountRules({} as any, "user_a", "stripe", "invoicexpress");
    expect(rules).toEqual(NO_RULES);
  });
});
