import { describe, it, expect } from "vitest";
import { grantReferralGrace, graceEndFrom } from "./referral-grace";

/**
 * Two failures, both invisible until somebody complains.
 *
 * The first is the one that made this file exist: with
 * SUBSCRIPTION_PER_CONNECTION=1 the gate reads the row for the EXACT pair it is
 * invoicing and does not fall back, and at claim time a referred account has no
 * connection to key a row to. A grace written against a guess is a grace the
 * merchant never receives, while holding an email that promised it.
 *
 * The second is the one the fix could have introduced. Running this on every
 * session sync is what makes the grace catch up with whatever they connect, and
 * that is only safe because the end date is anchored to the CLAIM. Anchored to
 * now, every visit would push the free month another thirty days out, for ever.
 */

function fixture() {
    const nodeSqlite = "node:sqlite";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require(nodeSqlite);
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
        CREATE TABLE referrals (
          invitee_user_id TEXT PRIMARY KEY, code TEXT NOT NULL, inviter_user_id TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending', claimed_at TEXT NOT NULL,
          invitee_first_invoice_id TEXT, credited_at TEXT, note TEXT
        );
        CREATE TABLE subscriptions (
          user_id TEXT, connection_key TEXT, status TEXT, plan TEXT, early_bird INTEGER,
          trial_end TEXT, stripe_subscription_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT, PRIMARY KEY (user_id, connection_key)
        );
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
    return { sqlite, db };
}

const keys = (...k: string[]) => async () => k;
const CLAIMED = "2026-09-01T10:00:00.000Z";
const SOON = new Date("2026-09-05T10:00:00.000Z");
const row = (s: any, key: string) =>
    s.prepare("SELECT * FROM subscriptions WHERE user_id='user_b' AND connection_key=?").get(key) as any;

describe("graceEndFrom", () => {
    it("is thirty days after the claim, in either timestamp format", () => {
        expect(graceEndFrom("2026-09-01T10:00:00.000Z").slice(0, 10)).toBe("2026-10-01");
        // CURRENT_TIMESTAMP's space form is UTC; Date would otherwise read it as
        // local time and move the date by an hour or two of drift.
        expect(graceEndFrom("2026-09-01 10:00:00")).toBe(graceEndFrom("2026-09-01T10:00:00.000Z"));
    });
});

describe("grantReferralGrace", () => {
    const pending = `INSERT INTO referrals (invitee_user_id, code, inviter_user_id, state, claimed_at)
                     VALUES ('user_b','loja-aaa','user_a','pending','${CLAIMED}')`;

    it("lands on the pair the merchant actually connected", async () => {
        const f = fixture();
        f.sqlite.exec(pending);
        // They followed the link with nothing set up, then wired Lodgify to Moloni.
        const n = await grantReferralGrace(f.db, "user_b", SOON, keys("lodgify:moloni"));
        expect(n).toBe(1);
        const r = row(f.sqlite, "lodgify:moloni");
        expect(r.early_bird).toBe(1);
        expect(r.status).toBe("trialing");
        expect(r.trial_end.slice(0, 10)).toBe("2026-10-01");
    });

    it("covers every connection on the account", async () => {
        const f = fixture();
        f.sqlite.exec(pending);
        const n = await grantReferralGrace(f.db, "user_b", SOON, keys("shopify:invoicexpress", "stripe:moloni"));
        expect(n).toBe(2);
        expect(row(f.sqlite, "stripe:moloni").early_bird).toBe(1);
    });

    it("does not extend the free month by running again", async () => {
        const f = fixture();
        f.sqlite.exec(pending);
        await grantReferralGrace(f.db, "user_b", SOON, keys("stripe:moloni"));
        const first = row(f.sqlite, "stripe:moloni").trial_end;
        // A fortnight of page loads later.
        await grantReferralGrace(f.db, "user_b", new Date("2026-09-20T10:00:00.000Z"), keys("stripe:moloni"));
        expect(row(f.sqlite, "stripe:moloni").trial_end).toBe(first);
    });

    it("stops once the free month is over", async () => {
        const f = fixture();
        f.sqlite.exec(pending);
        const n = await grantReferralGrace(f.db, "user_b", new Date("2026-11-01T10:00:00.000Z"), keys("stripe:moloni"));
        expect(n).toBe(0);
        expect(row(f.sqlite, "stripe:moloni")).toBeUndefined();
    });

    it("never touches a paying subscription", async () => {
        const f = fixture();
        f.sqlite.exec(pending + `;
            INSERT INTO subscriptions (user_id, connection_key, status, early_bird, stripe_subscription_id)
            VALUES ('user_b','stripe:moloni','active',0,'sub_live');
        `);
        const n = await grantReferralGrace(f.db, "user_b", SOON, keys("stripe:moloni"));
        expect(n).toBe(0);
        const r = row(f.sqlite, "stripe:moloni");
        expect(r.status).toBe("active");
        expect(r.early_bird).toBe(0);
        expect(r.trial_end).toBeNull();
    });

    it("never shortens a grace somebody already has", async () => {
        const f = fixture();
        f.sqlite.exec(pending + `;
            INSERT INTO subscriptions (user_id, connection_key, status, early_bird, trial_end)
            VALUES ('user_b','stripe:moloni','trialing',1,'2027-01-01T00:00:00.000Z');
        `);
        const n = await grantReferralGrace(f.db, "user_b", SOON, keys("stripe:moloni"));
        expect(n).toBe(0);
        expect(row(f.sqlite, "stripe:moloni").trial_end).toBe("2027-01-01T00:00:00.000Z");
    });

    it("does nothing at all for an account that was never referred", async () => {
        const f = fixture();
        expect(await grantReferralGrace(f.db, "user_z", SOON, keys("stripe:moloni"))).toBe(0);
    });

    it("stops once the invitee has paid, so it cannot re-trial a customer", async () => {
        const f = fixture();
        f.sqlite.exec(`INSERT INTO referrals (invitee_user_id, code, inviter_user_id, state, claimed_at)
                       VALUES ('user_b','loja-aaa','user_a','paid','${CLAIMED}')`);
        expect(await grantReferralGrace(f.db, "user_b", SOON, keys("stripe:moloni"))).toBe(0);
    });
});
