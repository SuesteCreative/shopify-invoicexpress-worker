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

/** Minimal D1 stand-in: routes `first()` by which table the SQL mentions. */
function fakeEnv(opts: { user?: Row; sub?: Row; throws?: boolean }): any {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (opts.throws) throw new Error("D1 unavailable");
                return sql.includes("FROM users") ? (opts.user ?? null) : (opts.sub ?? null);
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
