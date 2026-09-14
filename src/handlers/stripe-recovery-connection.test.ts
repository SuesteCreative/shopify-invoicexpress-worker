import { describe, it, expect } from "vitest";
import { loadStripeConnectionFull } from "./admin-stripe";

/**
 * Which Stripe connection a recovery route acts on.
 *
 * Backfill, re-emit, credit note, delete-draft, finalize-drafts and the nightly
 * heal all resolve through this one function, so a wrong answer here is not a
 * wrong screen — it is a fiscal document issued into another integration's
 * destination, under another integration's series, and (because the run-in hold
 * only holds `stripe_connect`) certified instead of left in draft.
 *
 * The fake below applies the SQL's own filters and ordering rather than
 * returning a fixed list, so dropping `status = 'active'` or the ORDER BY turns
 * these red instead of leaving them green. A missing filter is invisible in a
 * result set: the query keeps returning a plausible row, and only starts
 * returning the wrong one in production, months later, under a row order nobody
 * chose.
 *
 * Deliberately not `node:sqlite` — it landed in Node 22.5 and CI runs 20, where
 * the sibling suites skip themselves and protect nothing. This one runs
 * everywhere.
 */

interface Row {
  source_kind: string;
  destination_kind: string;
  status: string;
  source_config_json: string | null;
  destination_config_json: string | null;
  invoice_cutoff: string | null;
  created_at: string;
}

function row(over: Partial<Row> & { source_kind: string }): Row {
  return {
    destination_kind: "invoicexpress",
    status: "active",
    source_config_json: null,
    destination_config_json: null,
    invoice_cutoff: null,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const restrictedKey = (key: string) => JSON.stringify({ restricted_key: key });
const connectAccount = (acct: string) =>
  JSON.stringify({ auth_mode: "connect", stripe_account_id: acct });

function fakeEnv(rows: Row[]) {
  return {
    STRIPE_PLATFORM_SECRET_KEY: "sk_live_platform",
    STRIPE_PLATFORM_SECRET_KEY_TEST: "sk_test_platform",
    DB: {
      prepare(sql: string) {
        const api = {
          bind(..._binds: any[]) { return api; },
          async all() {
            let out = [...rows];
            // Every filter the query states, applied. Nothing it does not state.
            if (/status = 'active'/.test(sql)) {
              out = out.filter((r) => r.status === "active");
            }
            if (/source_kind IN \('stripe', 'stripe_connect'\)/.test(sql)) {
              out = out.filter((r) => r.source_kind === "stripe" || r.source_kind === "stripe_connect");
            }
            if (/ORDER BY CASE WHEN source_kind = 'stripe'/.test(sql)) {
              out = [...out].sort((a, b) =>
                (a.source_kind === "stripe" ? 0 : 1) - (b.source_kind === "stripe" ? 0 : 1));
            } else {
              // No ordering asked for, so the store answers in the worst order
              // on purpose: dropping the ORDER BY has to fail, not pass.
              out = [...out].reverse();
            }
            return { results: out };
          },
        };
        return api;
      },
    },
  } as any;
}

describe("the Stripe connection a recovery route acts on", () => {
  it("ignores a connection that is not active, whatever key it still holds", async () => {
    // The shape that cost a day: a restricted-key wizard someone started and
    // abandoned, left in `draft` with a usable key still in it, sitting beside a
    // healthy Stripe Connect connection. It used to win on the `stripe`-first
    // ordering, and every recovery route then ran as `stripe` — wrong
    // destination, wrong series, and no run-in hold.
    const conn = await loadStripeConnectionFull(
      fakeEnv([
        row({ source_kind: "stripe", status: "draft", source_config_json: restrictedKey("rk_abandoned") }),
        row({ source_kind: "stripe_connect", destination_kind: "moloni", source_config_json: connectAccount("acct_live") }),
      ]),
      "user_1",
    );

    expect(conn?.sourceKind).toBe("stripe_connect");
    expect(conn?.destinationKind).toBe("moloni");
    expect(conn?.auth?.connectAccount).toBe("acct_live");
  });

  it("does not resurrect a paused connection either", async () => {
    const conn = await loadStripeConnectionFull(
      fakeEnv([
        row({ source_kind: "stripe", status: "paused", source_config_json: restrictedKey("rk_paused") }),
        row({ source_kind: "stripe_connect", source_config_json: connectAccount("acct_live") }),
      ]),
      "user_1",
    );

    expect(conn?.sourceKind).toBe("stripe_connect");
  });

  it("answers nothing when every Stripe connection is inactive", async () => {
    // Better than picking a dead one: the route says "no Stripe connection" and
    // an operator goes and looks, instead of a document going out from a
    // connection the merchant believes is switched off.
    const conn = await loadStripeConnectionFull(
      fakeEnv([row({ source_kind: "stripe", status: "draft", source_config_json: restrictedKey("rk_x") })]),
      "user_1",
    );

    expect(conn).toBeNull();
  });

  it("keeps the historic `stripe`-first preference when both are live", async () => {
    // Not a judgement that legacy is better — it is the row these routes have
    // always resolved, and changing it silently would move live merchants.
    const conn = await loadStripeConnectionFull(
      fakeEnv([
        row({ source_kind: "stripe_connect", source_config_json: connectAccount("acct_live") }),
        row({ source_kind: "stripe", source_config_json: restrictedKey("rk_live") }),
      ]),
      "user_1",
    );

    expect(conn?.sourceKind).toBe("stripe");
  });

  it("prefers a connection that can authenticate over one that cannot", async () => {
    const conn = await loadStripeConnectionFull(
      fakeEnv([
        row({ source_kind: "stripe", source_config_json: JSON.stringify({}) }),
        row({ source_kind: "stripe_connect", source_config_json: connectAccount("acct_live") }),
      ]),
      "user_1",
    );

    expect(conn?.sourceKind).toBe("stripe_connect");
  });

  it("carries the destination, so a re-emit files where the webhook would have", async () => {
    const conn = await loadStripeConnectionFull(
      fakeEnv([row({ source_kind: "stripe", destination_kind: "vendus", source_config_json: restrictedKey("rk_live") })]),
      "user_1",
    );

    expect(conn?.destinationKind).toBe("vendus");
  });
});
