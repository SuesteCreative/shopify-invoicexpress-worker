import { describe, it, expect } from "vitest";
import { creditCentsFrom, drainPendingReferralCredits, claimInviteePayment } from "./referral-credit";

/**
 * This file moves money. The two ways it can be wrong are both silent:
 *
 *   - the sign. In Stripe a NEGATIVE balance is a credit; positive is a debt.
 *     Backwards, this charges someone two extra months for recommending us.
 *   - double payment. The Stripe webhook re-delivers, and a credit applied
 *     without its row being updated would be applied again on the retry.
 */

function fixture() {
    const nodeSqlite = "node:sqlite";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require(nodeSqlite);
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
        CREATE TABLE referrals (
          invitee_user_id TEXT PRIMARY KEY, code TEXT NOT NULL, inviter_user_id TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending', claimed_at TEXT DEFAULT CURRENT_TIMESTAMP,
          invitee_first_invoice_id TEXT, invitee_paid_at TEXT, credit_cents INTEGER,
          credit_txn_id TEXT, credited_at TEXT, note TEXT,
          CHECK (inviter_user_id <> invitee_user_id)
        );
        CREATE TABLE subscriptions (
          user_id TEXT, connection_key TEXT, status TEXT, plan TEXT,
          stripe_customer_id TEXT, created_at TEXT, updated_at TEXT
        );
        CREATE TABLE billing_events (
          id TEXT PRIMARY KEY, user_id TEXT, type TEXT, amount_cents INTEGER, created_at TEXT
        );
    `);

    /** The slice of the D1 interface this module uses. */
    const db: any = {
        prepare: (sql: string) => ({
            bind: (...b: any[]) => ({
                all: async () => ({ results: sqlite.prepare(sql).all(...b) }),
                first: async () => sqlite.prepare(sql).get(...b) ?? null,
                run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...b).changes } }),
            }),
        }),
    };

    const calls: any[] = [];
    const stripe = {
        customers: {
            async createBalanceTransaction(id: string, params: any, options: any) {
                calls.push({ id, params, options });
                return { id: `cbtxn_${calls.length}` };
            },
        },
    };

    return { sqlite, db, stripe, calls };
}

describe("creditCentsFrom", () => {
    it("doubles a monthly invoice", () => {
        // 7,50 € + 23 % = 9,23 € a month; two of those is what they stop paying.
        expect(creditCentsFrom(923, "monthly")).toBe(1846);
    });

    it("takes two twelfths of an annual one", () => {
        expect(creditCentsFrom(9225, "annual")).toBe(1538);
    });

    it("treats an unknown plan as monthly, which is the common case", () => {
        expect(creditCentsFrom(923, null)).toBe(1846);
    });

    it("refuses to invent an amount", () => {
        expect(creditCentsFrom(null, "monthly")).toBeNull();
        expect(creditCentsFrom(0, "monthly")).toBeNull();
    });
});

describe("drainPendingReferralCredits", () => {
    const owed = `
        INSERT INTO referrals (invitee_user_id, code, inviter_user_id, state, invitee_first_invoice_id)
        VALUES ('user_b', 'loja-aaa', 'user_a', 'paid', 'in_b1');
    `;
    const paying = `
        INSERT INTO subscriptions (user_id, connection_key, status, plan, stripe_customer_id, created_at, updated_at)
        VALUES ('user_a', 'shopify:invoicexpress', 'active', 'monthly', 'cus_a', '2026-01-01', '2026-01-01');
        INSERT INTO billing_events (id, user_id, type, amount_cents, created_at)
        VALUES ('evt_1', 'user_a', 'invoice.paid', 923, '2026-09-01T10:00:00.000Z');
    `;

    it("credits the inviter, negative, once, with an idempotency key", async () => {
        const f = fixture();
        f.sqlite.exec(owed + paying);

        const r = await drainPendingReferralCredits(f.db, f.stripe, "user_a");
        expect(r.credited).toBe(1);
        expect(r.cents).toBe(1846);

        expect(f.calls).toHaveLength(1);
        expect(f.calls[0].id).toBe("cus_a");
        // Negative. This is the assertion that stops the sign being flipped.
        expect(f.calls[0].params.amount).toBe(-1846);
        expect(f.calls[0].params.currency).toBe("eur");
        expect(f.calls[0].options.idempotencyKey).toBe("rioko-referral-user_b");

        const row = f.sqlite.prepare("SELECT * FROM referrals WHERE invitee_user_id='user_b'").get() as any;
        expect(row.state).toBe("credited");
        expect(row.credit_cents).toBe(1846);
        expect(row.credit_txn_id).toBe("cbtxn_1");
    });

    it("does not pay the same referral twice when the webhook repeats", async () => {
        const f = fixture();
        f.sqlite.exec(owed + paying);
        await drainPendingReferralCredits(f.db, f.stripe, "user_a");
        const again = await drainPendingReferralCredits(f.db, f.stripe, "user_a");
        expect(again.credited).toBe(0);
        expect(f.calls).toHaveLength(1);
    });

    it("parks a credit for an inviter with no Stripe customer yet", async () => {
        const f = fixture();
        // An early bird who invited people before ever paying us.
        f.sqlite.exec(owed);
        const r = await drainPendingReferralCredits(f.db, f.stripe, "user_a");
        expect(r.credited).toBe(0);
        expect(r.parked[0]).toEqual({ invitee_user_id: "user_b", reason: "no_stripe_customer" });
        expect(f.calls).toHaveLength(0);

        const row = f.sqlite.prepare("SELECT state, note FROM referrals WHERE invitee_user_id='user_b'").get() as any;
        // Still owed. The next checkout drains it.
        expect(row.state).toBe("paid");
        expect(row.note).toBe("no_stripe_customer");
    });

    it("parks rather than guess when there is no invoice to double", async () => {
        const f = fixture();
        f.sqlite.exec(owed + `
            INSERT INTO subscriptions (user_id, connection_key, status, plan, stripe_customer_id, created_at, updated_at)
            VALUES ('user_a', 'shopify:invoicexpress', 'active', 'monthly', 'cus_a', '2026-01-01', '2026-01-01');
        `);
        const r = await drainPendingReferralCredits(f.db, f.stripe, "user_a");
        expect(r.credited).toBe(0);
        expect(r.parked[0].reason).toBe("no_ledger_amount");
        expect(f.calls).toHaveLength(0);
    });

    it("pays several referrals at once, because the copy promises no cap", async () => {
        const f = fixture();
        f.sqlite.exec(paying + `
            INSERT INTO referrals (invitee_user_id, code, inviter_user_id, state) VALUES ('user_b','loja-aaa','user_a','paid');
            INSERT INTO referrals (invitee_user_id, code, inviter_user_id, state) VALUES ('user_c','loja-aaa','user_a','paid');
            INSERT INTO referrals (invitee_user_id, code, inviter_user_id, state) VALUES ('user_d','loja-aaa','user_a','pending');
        `);
        const r = await drainPendingReferralCredits(f.db, f.stripe, "user_a");
        // The pending one has not paid yet and is not owed.
        expect(r.credited).toBe(2);
        expect(r.cents).toBe(3692);
        expect(f.calls.map((c) => c.options.idempotencyKey).sort())
            .toEqual(["rioko-referral-user_b", "rioko-referral-user_c"]);
    });
});

describe("claimInviteePayment", () => {
    it("claims once and names the inviter", async () => {
        const f = fixture();
        f.sqlite.exec(`INSERT INTO referrals (invitee_user_id, code, inviter_user_id) VALUES ('user_b','loja-aaa','user_a')`);

        expect(await claimInviteePayment(f.db, "user_b", "in_1")).toBe("user_a");
        // Stripe re-delivers; the second claim finds nothing pending.
        expect(await claimInviteePayment(f.db, "user_b", "in_1")).toBeNull();

        const row = f.sqlite.prepare("SELECT * FROM referrals WHERE invitee_user_id='user_b'").get() as any;
        expect(row.state).toBe("paid");
        expect(row.invitee_first_invoice_id).toBe("in_1");
    });

    it("says nothing for a payment that was not a referral, which is most of them", async () => {
        const f = fixture();
        expect(await claimInviteePayment(f.db, "user_z", "in_9")).toBeNull();
    });
});
