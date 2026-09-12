import { describe, it, expect } from "vitest";
import {
    claimRefusal, inviteeTrialEnd, referralLink, newReferralCode,
    isValidReferralCode, CAMPAIGN_END, INVITEE_FREE_DAYS,
} from "./referral";

/**
 * The two things that must never happen — an account referred twice, an account
 * referring itself — are enforced by migration 0057, not by code. So they are
 * tested against the real DDL: a constraint that exists only in a .sql file
 * nobody executes is a comment.
 */

function db() {
    const nodeSqlite = "node:sqlite";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require(nodeSqlite);
    const sqlite = new DatabaseSync(":memory:");
    // Copied from migrations/0057_referrals.sql. If the two drift, these pass
    // while production does not — so keep them the same shape by eye when the
    // migration changes.
    sqlite.exec(`
        CREATE TABLE referral_codes (
          code TEXT PRIMARY KEY,
          user_id TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE referrals (
          invitee_user_id TEXT PRIMARY KEY,
          code TEXT NOT NULL,
          inviter_user_id TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending',
          claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          invitee_first_invoice_id TEXT,
          invitee_paid_at TEXT,
          credit_cents INTEGER,
          credit_txn_id TEXT,
          credited_at TEXT,
          note TEXT,
          CHECK (inviter_user_id <> invitee_user_id)
        );
        CREATE INDEX idx_referrals_inviter ON referrals(inviter_user_id, state);
        CREATE UNIQUE INDEX idx_referrals_invoice ON referrals(invitee_first_invoice_id);
    `);
    return sqlite;
}

describe("the schema enforces the promises", () => {
    it("refuses a self-referral", () => {
        const s = db();
        expect(() =>
            s.exec(`INSERT INTO referrals (invitee_user_id, code, inviter_user_id)
                    VALUES ('user_a', 'c-1', 'user_a')`),
        ).toThrow();
    });

    it("refuses to refer the same account twice", () => {
        const s = db();
        s.exec(`INSERT INTO referrals (invitee_user_id, code, inviter_user_id) VALUES ('user_b','c-1','user_a')`);
        expect(() =>
            s.exec(`INSERT INTO referrals (invitee_user_id, code, inviter_user_id) VALUES ('user_b','c-2','user_z')`),
        ).toThrow();
    });

    it("refuses to credit the same invoice twice", () => {
        const s = db();
        s.exec(`
            INSERT INTO referrals (invitee_user_id, code, inviter_user_id, invitee_first_invoice_id)
            VALUES ('user_b','c-1','user_a','in_1');
        `);
        expect(() =>
            s.exec(`INSERT INTO referrals (invitee_user_id, code, inviter_user_id, invitee_first_invoice_id)
                    VALUES ('user_c','c-1','user_a','in_1')`),
        ).toThrow();
    });

    it("still allows many unpaid referrals at once", () => {
        const s = db();
        // NULLs are distinct in a SQLite unique index, which is what makes the
        // constraint above safe to apply to a column that is empty until payment.
        s.exec(`
            INSERT INTO referrals (invitee_user_id, code, inviter_user_id) VALUES ('user_b','c-1','user_a');
            INSERT INTO referrals (invitee_user_id, code, inviter_user_id) VALUES ('user_c','c-1','user_a');
            INSERT INTO referrals (invitee_user_id, code, inviter_user_id) VALUES ('user_d','c-1','user_a');
        `);
        expect((s.prepare("SELECT COUNT(*) AS n FROM referrals").get() as any).n).toBe(3);
    });

    it("gives an account one code, for ever", () => {
        const s = db();
        s.exec(`INSERT INTO referral_codes (code, user_id) VALUES ('loja-aaa','user_a')`);
        expect(() => s.exec(`INSERT INTO referral_codes (code, user_id) VALUES ('loja-bbb','user_a')`)).toThrow();
    });
});

describe("claimRefusal", () => {
    const open = new Date("2026-09-15T10:00:00.000Z");
    const ok = {
        code: "loja-nova-4f7a1c9b2e05",
        inviterUserId: "user_a",
        inviteeUserId: "user_b",
        inviteeCreatedAt: "2026-09-15T09:00:00.000Z",
        now: open,
    };

    it("lets a fresh account claim inside the campaign", () => {
        expect(claimRefusal(ok)).toBeNull();
    });

    it("refuses a token that is not one", () => {
        expect(claimRefusal({ ...ok, code: "nope!" })).toBe("invalid");
    });

    it("refuses a code nobody owns", () => {
        expect(claimRefusal({ ...ok, inviterUserId: null })).toBe("unknown");
    });

    it("refuses inviting yourself", () => {
        expect(claimRefusal({ ...ok, inviteeUserId: "user_a" })).toBe("self");
    });

    it("closes the day after the campaign ends, and not before", () => {
        // The account has to stay new as the clock moves, or "not_new" answers
        // first and the boundary being tested is never reached.
        const lastDay = new Date(`${CAMPAIGN_END}T23:00:00.000Z`);
        const dayAfter = new Date("2026-11-01T00:01:00.000Z");
        expect(claimRefusal({ ...ok, now: lastDay, inviteeCreatedAt: lastDay.toISOString() })).toBeNull();
        expect(claimRefusal({ ...ok, now: dayAfter, inviteeCreatedAt: dayAfter.toISOString() })).toBe("closed");
    });

    it("refuses an account that has been here too long to be a referral", () => {
        expect(claimRefusal({ ...ok, inviteeCreatedAt: "2026-08-01T10:00:00.000Z" })).toBe("not_new");
        // Both timestamp formats live in users.created_at.
        expect(claimRefusal({ ...ok, inviteeCreatedAt: "2026-09-14 08:00:00" })).toBeNull();
    });
});

describe("the offer itself", () => {
    it("gives the invitee thirty days", () => {
        const end = inviteeTrialEnd(new Date("2026-09-15T10:00:00.000Z"));
        expect(end.slice(0, 10)).toBe("2026-10-15");
        expect(INVITEE_FREE_DAYS).toBe(30);
    });

    it("builds a link whose secret is not the company name", () => {
        const code = newReferralCode("Loja Nova");
        expect(isValidReferralCode(code)).toBe(true);
        expect(code.startsWith("loja-nova-")).toBe(true);
        expect(code.length).toBeGreaterThan("loja-nova-".length + 8);
        expect(referralLink(code)).toBe(`https://rioko.online/pt/convite/${code}`);
    });
});
