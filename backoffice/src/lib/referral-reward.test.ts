import { describe, it, expect } from "vitest";
import { addMonths, periodEndOf, rewardInviter } from "./referral-reward";

/**
 * This file moves a billing date, which is money in the only form that does not
 * look like money until somebody's invoice is wrong.
 *
 * Two things it exists to catch: month arithmetic that overflows (31 December
 * plus two months is 28 February, not 3 March) and a reward computed from the
 * wrong base when the subscription is already inside one — that is what makes
 * the second and third rewards stack instead of overwrite.
 */

const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

function fixture() {
    const nodeSqlite = "node:sqlite";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require(nodeSqlite);
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
        CREATE TABLE referrals (
          invitee_user_id TEXT PRIMARY KEY, inviter_user_id TEXT NOT NULL,
          inviter_client_code TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
          claimed_at TEXT DEFAULT CURRENT_TIMESTAMP, invitee_subscription_id TEXT,
          invitee_subscribed_at TEXT, reward_months INTEGER, reward_until TEXT,
          rewarded_at TEXT, void_reason TEXT, note TEXT,
          CHECK (inviter_user_id <> invitee_user_id)
        );
        CREATE TABLE subscriptions (
          user_id TEXT, connection_key TEXT, status TEXT, plan TEXT, nif TEXT,
          stripe_subscription_id TEXT, reward_until TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT
        );
        CREATE TABLE users (id TEXT PRIMARY KEY, nif TEXT);
    `);
    const db: any = {
        prepare: (sql: string) => ({
            bind: (...b: any[]) => ({
                all: async () => ({ results: sqlite.prepare(sql).all(...b) }),
                first: async () => sqlite.prepare(sql).get(...b) ?? null,
                run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...b).changes } }),
            }),
        }),
    };

    const updates: any[] = [];
    let current: any = {
        id: "sub_inviter", status: "active", metadata: {},
        current_period_end: unix("2026-10-01T00:00:00.000Z"), trial_end: null,
    };
    const stripe = {
        subscriptions: {
            async retrieve(id: string) { return { ...current, id }; },
            async update(id: string, params: any, options: any) {
                updates.push({ id, params, options });
                current = { ...current, trial_end: params.trial_end, status: "trialing" };
                return current;
            },
        },
    };
    const setSubscription = (patch: any) => { current = { ...current, ...patch }; };
    return { sqlite, db, stripe, updates, setSubscription };
}

const pending = `
    INSERT INTO referrals (invitee_user_id, inviter_user_id, inviter_client_code, state)
    VALUES ('user_b', 'user_a', 'RIO-1A2B3C', 'pending');
    INSERT INTO subscriptions (user_id, connection_key, status, stripe_subscription_id, created_at)
    VALUES ('user_a', 'shopify:invoicexpress', 'active', 'sub_inviter', '2026-01-01');
`;

describe("addMonths", () => {
    it("adds whole months", () => {
        expect(addMonths("2026-10-01T00:00:00.000Z", 2).slice(0, 10)).toBe("2026-12-01");
        expect(addMonths("2026-09-15T10:30:00.000Z", 2).slice(0, 10)).toBe("2026-11-15");
    });

    it("clamps instead of overflowing into the next month", () => {
        // Date.setMonth would answer 3 March here. A month that does not have a
        // 31st has to give the 28th, or the reward is a day longer than promised
        // and lands in the wrong month.
        expect(addMonths("2026-12-31T00:00:00.000Z", 2).slice(0, 10)).toBe("2027-02-28");
        expect(addMonths("2027-12-31T00:00:00.000Z", 2).slice(0, 10)).toBe("2028-02-29"); // leap
        expect(addMonths("2026-08-31T00:00:00.000Z", 2).slice(0, 10)).toBe("2026-10-31");
    });

    it("keeps the time of day", () => {
        expect(addMonths("2026-10-01T09:07:03.000Z", 2)).toBe("2026-12-01T09:07:03.000Z");
    });
});

describe("periodEndOf", () => {
    it("prefers the furthest date it can find", () => {
        expect(periodEndOf({ current_period_end: 100, trial_end: 500 })).toBe(500);
        expect(periodEndOf({ current_period_end: 500, trial_end: null })).toBe(500);
    });

    it("reads current_period_end off the item, where later API versions moved it", () => {
        expect(periodEndOf({ items: { data: [{ current_period_end: 700 }] } })).toBe(700);
    });

    it("admits it does not know rather than guessing", () => {
        expect(periodEndOf({})).toBeNull();
        expect(periodEndOf({ current_period_end: null, trial_end: null })).toBeNull();
    });
});

describe("rewardInviter", () => {
    it("pushes the billing date two months out and records both sides", async () => {
        const f = fixture();
        f.sqlite.exec(pending);

        const r = await rewardInviter(f.db, f.stripe, "user_b", "sub_invitee");
        expect(r.rewarded).toBe(true);
        expect(r.reward_until?.slice(0, 10)).toBe("2026-12-01");

        expect(f.updates).toHaveLength(1);
        const [u] = f.updates;
        expect(u.id).toBe("sub_inviter");
        expect(u.params.trial_end).toBe(unix("2026-12-01T00:00:00.000Z"));
        // Without this Stripe writes adjustment lines into a clean reward.
        expect(u.params.proration_behavior).toBe("none");
        expect(u.options.idempotencyKey).toBe("rioko-reward-user_b");

        const ref = f.sqlite.prepare("SELECT * FROM referrals WHERE invitee_user_id='user_b'").get() as any;
        expect(ref.state).toBe("rewarded");
        expect(ref.reward_months).toBe(2);
        expect(ref.invitee_subscription_id).toBe("sub_invitee");

        // The panel needs to know why the subscription went to trialing.
        const sub = f.sqlite.prepare("SELECT reward_until FROM subscriptions WHERE user_id='user_a'").get() as any;
        expect(sub.reward_until.slice(0, 10)).toBe("2026-12-01");
    });

    it("stacks the second reward onto the first instead of overwriting it", async () => {
        const f = fixture();
        f.sqlite.exec(pending);
        await rewardInviter(f.db, f.stripe, "user_b", "sub_invitee");

        // A second friend subscribes while the first reward is still running.
        f.sqlite.exec(`INSERT INTO referrals (invitee_user_id, inviter_user_id, inviter_client_code, state)
                       VALUES ('user_c', 'user_a', 'RIO-1A2B3C', 'pending')`);
        const r2 = await rewardInviter(f.db, f.stripe, "user_c", "sub_invitee_2");

        // From December, not from October: the base is the trial_end now in force.
        expect(r2.reward_until?.slice(0, 10)).toBe("2027-02-01");
        expect(f.updates[1].params.trial_end).toBe(unix("2027-02-01T00:00:00.000Z"));
    });

    it("stops at three rewards, and records the fourth as refused", async () => {
        const f = fixture();
        f.sqlite.exec(`
            INSERT INTO subscriptions (user_id, connection_key, status, stripe_subscription_id, created_at)
            VALUES ('user_a', 'shopify:invoicexpress', 'active', 'sub_inviter', '2026-01-01');
            INSERT INTO referrals (invitee_user_id, inviter_user_id, inviter_client_code, state) VALUES ('user_1','user_a','RIO-1A2B3C','rewarded');
            INSERT INTO referrals (invitee_user_id, inviter_user_id, inviter_client_code, state) VALUES ('user_2','user_a','RIO-1A2B3C','rewarded');
            INSERT INTO referrals (invitee_user_id, inviter_user_id, inviter_client_code, state) VALUES ('user_3','user_a','RIO-1A2B3C','rewarded');
            INSERT INTO referrals (invitee_user_id, inviter_user_id, inviter_client_code, state) VALUES ('user_4','user_a','RIO-1A2B3C','pending');
        `);
        const r = await rewardInviter(f.db, f.stripe, "user_4", "sub_invitee_4");
        expect(r.rewarded).toBe(false);
        expect(r.reason).toBe("cap_reached");
        expect(f.updates).toHaveLength(0);

        const row = f.sqlite.prepare("SELECT state, void_reason FROM referrals WHERE invitee_user_id='user_4'").get() as any;
        expect(row.state).toBe("void");
        expect(row.void_reason).toBe("cap_reached");
    });

    it("does not pay a referral between two accounts of the same company", async () => {
        const f = fixture();
        f.sqlite.exec(pending + `
            INSERT INTO users (id, nif) VALUES ('user_a','516277421'), ('user_b','PT516277421');
        `);
        const r = await rewardInviter(f.db, f.stripe, "user_b", "sub_invitee");
        expect(r.reason).toBe("same_fiscal_id");
        expect(f.updates).toHaveLength(0);
        const row = f.sqlite.prepare("SELECT state FROM referrals WHERE invitee_user_id='user_b'").get() as any;
        expect(row.state).toBe("void");
    });

    it("parks, rather than voids, when the inviter has no live subscription", async () => {
        const f = fixture();
        // Claimed while they were paying; cancelled before the friend subscribed.
        f.sqlite.exec(`INSERT INTO referrals (invitee_user_id, inviter_user_id, inviter_client_code, state)
                       VALUES ('user_b','user_a','RIO-1A2B3C','pending')`);
        const r = await rewardInviter(f.db, f.stripe, "user_b", "sub_invitee");
        expect(r.reason).toBe("inviter_no_live_subscription");
        const row = f.sqlite.prepare("SELECT state, note, void_reason FROM referrals WHERE invitee_user_id='user_b'").get() as any;
        // Not void: it is a human decision, not an abuse, and it can be paid later.
        expect(row.state).toBe("subscribed");
        expect(row.note).toBe("inviter_no_live_subscription");
        expect(row.void_reason).toBeNull();
    });

    it("claims once, so a re-delivered webhook pays nothing twice", async () => {
        const f = fixture();
        f.sqlite.exec(pending);
        await rewardInviter(f.db, f.stripe, "user_b", "sub_invitee");
        const again = await rewardInviter(f.db, f.stripe, "user_b", "sub_invitee");
        expect(again.rewarded).toBe(false);
        expect(again.reason).toBe("not_pending");
        expect(f.updates).toHaveLength(1);
    });

    it("says nothing for a subscription that was not a referral, which is most of them", async () => {
        const f = fixture();
        const r = await rewardInviter(f.db, f.stripe, "user_z", "sub_z");
        expect(r).toEqual({ rewarded: false, reason: "not_pending" });
    });

    it("pays nothing for a subscription created after the campaign ended", async () => {
        // Clause 2. Claimed inside the campaign, subscribed after it: recorded,
        // not paid.
        const f = fixture();
        f.sqlite.exec(pending);
        const r = await rewardInviter(f.db, f.stripe, "user_b", "sub_invitee", new Date("2026-11-02T10:00:00.000Z"));
        expect(r.rewarded).toBe(false);
        expect(r.reason).toBe("after_campaign");
        expect(f.updates).toHaveLength(0);
        const row = f.sqlite.prepare("SELECT state FROM referrals WHERE invitee_user_id='user_b'").get() as any;
        expect(row.state).toBe("void");
    });

    it("keeps the original subscription date when an admin retries later", async () => {
        // Subscribed in October, parked, retried by an admin in November. The
        // retry must not look like a late subscription.
        const f = fixture();
        f.sqlite.exec(`
            INSERT INTO referrals (invitee_user_id, inviter_user_id, inviter_client_code, state, invitee_subscribed_at)
            VALUES ('user_b', 'user_a', 'RIO-1A2B3C', 'pending', '2026-10-20T10:00:00.000Z');
            INSERT INTO subscriptions (user_id, connection_key, status, stripe_subscription_id, created_at)
            VALUES ('user_a', 'shopify:invoicexpress', 'active', 'sub_inviter', '2026-01-01');
        `);
        const r = await rewardInviter(f.db, f.stripe, "user_b", "sub_invitee", new Date("2026-11-05T10:00:00.000Z"));
        expect(r.rewarded).toBe(true);
    });

    it("parks, rather than promises, on a subscription already scheduled to end", async () => {
        // Stripe cancels at cancel_at regardless of trial_end: the months would be
        // recorded and shown and never happen.
        const f = fixture();
        f.sqlite.exec(pending);
        f.setSubscription({ cancel_at: unix("2026-12-31T00:00:00.000Z") });
        const r = await rewardInviter(f.db, f.stripe, "user_b", "sub_invitee");
        expect(r.reason).toBe("inviter_subscription_ending");
        expect(f.updates).toHaveLength(0);
    });

    it("parks when Stripe cannot say when the period ends", async () => {
        const f = fixture();
        f.sqlite.exec(pending);
        f.setSubscription({ current_period_end: null, trial_end: null, items: undefined });
        const r = await rewardInviter(f.db, f.stripe, "user_b", "sub_invitee");
        expect(r.reason).toBe("no_period_end");
        expect(f.updates).toHaveLength(0);
    });
});
