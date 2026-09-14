import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { RULES, NO_RULES, parseRuleValue, ruleAppliesTo } from "./rules-catalogue";

describe("the rules catalogue", () => {
  it("declares a default that is one of the options", () => {
    for (const def of Object.values(RULES)) {
      expect(def.options, def.id).toContain(def.default);
    }
  });

  it("explains every option it offers", () => {
    for (const def of Object.values(RULES)) {
      expect(Object.keys(def.help).sort(), def.id).toEqual([...def.options].sort());
    }
  });

  // The id is written into `account_rules.rule_id` and stays there. A renamed id
  // is a row nothing reads any more, on an account that thinks it declared one.
  it("keys each rule by its own id, in snake_case", () => {
    for (const [key, def] of Object.entries(RULES)) {
      expect(def.id).toBe(key);
      expect(def.id).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("resolves an account with no rows to today's behaviour", () => {
    for (const def of Object.values(RULES)) {
      expect(NO_RULES[def.id]).toBe(def.default);
    }
  });

  it("refuses anything the worker could not act on", () => {
    expect(parseRuleValue("buyer_address", "payment_then_customer")).toBe("payment_then_customer");
    expect(parseRuleValue("buyer_address", "whatever")).toBeNull();
    expect(parseRuleValue("buyer_address", 42)).toBeNull();
    expect(parseRuleValue("buyer_address", null)).toBeNull();
    expect(parseRuleValue("no_such_rule", "payment_then_customer")).toBeNull();
  });

  it("keeps a rule off the pairs it was not written for", () => {
    expect(ruleAppliesTo("buyer_address", "stripe", "invoicexpress")).toBe(true);
    expect(ruleAppliesTo("buyer_address", "stripe_connect", "moloni")).toBe(true);
    expect(ruleAppliesTo("buyer_address", "lodgify", "moloni")).toBe(false);
    expect(ruleAppliesTo("no_such_rule", "stripe", "invoicexpress")).toBe(false);
  });

  // This module is meant to be readable by the Next backoffice as well as the
  // Worker. One import of `../storage` or `../env` drags the Worker's world into
  // an edge bundle, and the failure would show up as a broken Pages build rather
  // than as anything pointing here. Checked by machine, because a comment asking
  // for it is exactly what gets missed.
  it("imports nothing", () => {
    // Relative to the repo root, which is where vitest runs. `import.meta.url`
    // would be the obvious spelling and does not typecheck under the Worker's
    // tsconfig, which has no ESM lib.
    const src = readFileSync("src/services/rules-catalogue.ts", "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });
});
