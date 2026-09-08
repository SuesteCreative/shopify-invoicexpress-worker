import { describe, it, expect } from "vitest";
import { checkSubscriptionGate } from "./subscription-gate";

/**
 * Truth table for the gate that decides whether a merchant may invoice at all.
 *
 * Worth pinning: a `canceled` subscription on a still-`active` connection
 * silently stopped Casa de Celebrar a Vida's invoicing, and the gate's
 * fail-open-on-error behaviour is a deliberate availability choice that must not
 * be "tidied up" into a fail-closed default.
 */

type Row = Record<string, unknown> | null;

/**
 * Minimal D1 stand-in: `first()` answers the users lookup, `all()` the
 * subscriptions one — which reads every row on the account since 0044, because
 * an account can now hold one subscription per connection.
 */
function fakeEnv(opts: { user?: Row; sub?: Row; subs?: Row[]; throws?: boolean; perConnection?: boolean }): any {
  const rows = opts.subs ?? (opts.sub ? [opts.sub] : []);
  return {
    SUBSCRIPTION_PER_CONNECTION: opts.perConnection ? "1" : undefined,
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (opts.throws) throw new Error("D1 unavailable");
                return sql.includes("FROM users") ? (opts.user ?? null) : (rows[0] ?? null);
              },
              async all() {
                if (opts.throws) throw new Error("D1 unavailable");
                return { results: rows };
              },
            };
          },
        };
      },
    },
  };
}

const cfg = { user_id: "user_test" } as any;
const future = new Date(Date.now() + 7 * 864e5).toISOString();
const past = new Date(Date.now() - 7 * 864e5).toISOString();

describe("checkSubscriptionGate", () => {
  it("allows when the config carries no user_id", async () => {
    const r = await checkSubscriptionGate(fakeEnv({}), {} as any);
    expect(r.allowed).toBe(true);
  });

  it("exempts superadmin and hiperadmin regardless of subscription", async () => {
    for (const role of ["superadmin", "hiperadmin"]) {
      const env = fakeEnv({ user: { role }, sub: { status: "canceled" } });
      expect((await checkSubscriptionGate(env, cfg)).allowed).toBe(true);
    }
  });

  it("allows an active subscription", async () => {
    const env = fakeEnv({ user: { role: "member" }, sub: { status: "active" } });
    expect((await checkSubscriptionGate(env, cfg)).allowed).toBe(true);
  });

  it.each(["canceled", "unpaid", "incomplete_expired", "incomplete", "past_due"])(
    "blocks status=%s",
    async (status) => {
      const env = fakeEnv({ user: { role: "member" }, sub: { status } });
      const r = await checkSubscriptionGate(env, cfg);
      expect(r.allowed).toBe(false);
      if (!r.allowed) expect(r.reason).toContain(status);
    },
  );

  it("blocks when there is no subscription row at all", async () => {
    const env = fakeEnv({ user: { role: "member" }, sub: null });
    const r = await checkSubscriptionGate(env, cfg);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toContain("none");
  });

  it("allows a paying Stripe trial (has stripe_subscription_id)", async () => {
    const env = fakeEnv({
      user: { role: "member" },
      sub: { status: "trialing", stripe_subscription_id: "sub_123", early_bird: 0 },
    });
    expect((await checkSubscriptionGate(env, cfg)).allowed).toBe(true);
  });

  it("allows an early-bird still inside its trial window", async () => {
    const env = fakeEnv({
      user: { role: "member" },
      sub: { status: "trialing", stripe_subscription_id: null, early_bird: 1, trial_end: future },
    });
    expect((await checkSubscriptionGate(env, cfg)).allowed).toBe(true);
  });

  it("blocks an early-bird whose trial window has expired", async () => {
    const env = fakeEnv({
      user: { role: "member" },
      sub: { status: "trialing", stripe_subscription_id: null, early_bird: 1, trial_end: past },
    });
    expect((await checkSubscriptionGate(env, cfg)).allowed).toBe(false);
  });

  it("blocks a non-early-bird trialing without a Stripe subscription", async () => {
    const env = fakeEnv({
      user: { role: "member" },
      sub: { status: "trialing", stripe_subscription_id: null, early_bird: 0, trial_end: future },
    });
    expect((await checkSubscriptionGate(env, cfg)).allowed).toBe(false);
  });

  it("fails OPEN when the lookup errors — a D1 hiccup must not stop invoicing", async () => {
    const env = fakeEnv({ throws: true });
    expect((await checkSubscriptionGate(env, cfg)).allowed).toBe(true);
  });
});


/**
 * One account, two connections — the shape that made this necessary. Wim Hof
 * Method ran a Shopify shop on a subscription bought for a Stripe account:
 * `subscriptions.user_id` was the primary key, so the shop could not have one
 * of its own, and the gate never asked which connection was invoicing.
 */
describe("one subscription per connection", () => {
  const shopify = { source: "shopify", destination: "invoicexpress" };
  const stripe = { source: "stripe", destination: "invoicexpress" };
  const paidStripe = { connection_key: "stripe:invoicexpress", status: "active" };

  it("lets the shop through on the Stripe subscription while enforcement is off", async () => {
    // Deliberate: every merchant signed up under account-wide billing, and
    // flipping that without warning would stop invoicing mid-day.
    const env = fakeEnv({ user: { role: "member" }, subs: [paidStripe] });
    expect((await checkSubscriptionGate(env, cfg, shopify)).allowed).toBe(true);
  });

  it("blocks the connection that nothing pays for once enforcement is on", async () => {
    const env = fakeEnv({ user: { role: "member" }, subs: [paidStripe], perConnection: true });
    const r = await checkSubscriptionGate(env, cfg, shopify);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toContain("no_subscription for shopify:invoicexpress");
  });

  it("still lets the connection that IS paid for through", async () => {
    const env = fakeEnv({ user: { role: "member" }, subs: [paidStripe], perConnection: true });
    expect((await checkSubscriptionGate(env, cfg, stripe)).allowed).toBe(true);
  });

  it("names the connection in the reason when its own subscription lapsed", async () => {
    const env = fakeEnv({
      user: { role: "member" }, perConnection: true,
      subs: [paidStripe, { connection_key: "shopify:invoicexpress", status: "past_due" }],
    });
    const r = await checkSubscriptionGate(env, cfg, shopify);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("subscription_inactive (past_due) for shopify:invoicexpress");
  });

  it("falls back to the account when the caller names no connection", async () => {
    // Admin paths and anything pre-dating the discriminator: judging them as
    // blocked because they did not say would stop invoicing for a paying
    // merchant over a missing argument.
    const env = fakeEnv({ user: { role: "member" }, subs: [paidStripe], perConnection: true });
    expect((await checkSubscriptionGate(env, cfg)).allowed).toBe(true);
  });

  it("allows an account whose OTHER connection is the live one, enforcement off", async () => {
    const env = fakeEnv({
      user: { role: "member" },
      subs: [{ connection_key: "shopify:invoicexpress", status: "canceled" }, paidStripe],
    });
    expect((await checkSubscriptionGate(env, cfg, shopify)).allowed).toBe(true);
  });
});
