import { describe, it, expect } from "vitest";
import { loadAccountReferrals } from "./client-record-referrals";

/**
 * The record answers "who invited this account, and did it cost us anything".
 * What would make that answer wrong without anything looking broken: a reward
 * count that is not the one the ceiling uses, an invitee marked as paying off a
 * zero-euro or failed invoice, and an inviter whose account is gone simply
 * vanishing from the page.
 */

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
        CREATE TABLE users (
          id TEXT PRIMARY KEY, client_code TEXT, email TEXT, name TEXT,
          company_name TEXT, admin_label TEXT
        );
        CREATE TABLE billing_events (user_id TEXT, type TEXT, amount_cents INTEGER);

        INSERT INTO users (id, client_code, email, name, company_name) VALUES
          ('user_a', 'RIO-AAAAAA', 'a@x.pt', 'Ana', 'Loja da Ana, Lda'),
          ('user_b', 'RIO-BBBBBB', 'b@x.pt', 'Bruno', NULL),
          ('user_c', 'RIO-CCCCCC', 'c@x.pt', NULL, NULL),
          ('user_d', 'RIO-DDDDDD', 'd@x.pt', NULL, NULL),
          ('user_e', 'RIO-EEEEEE', 'e@x.pt', NULL, NULL);

        INSERT INTO referrals (invitee_user_id, inviter_user_id, inviter_client_code, state, claimed_at, invitee_subscribed_at, reward_until, void_reason) VALUES
          ('user_b', 'user_a', 'RIO-AAAAAA', 'rewarded', '2026-09-01 10:00:00', '2026-09-02T00:00:00.000Z', '2026-12-01T00:00:00.000Z', NULL),
          ('user_c', 'user_a', 'RIO-AAAAAA', 'rewarded', '2026-09-03 10:00:00', '2026-09-04T00:00:00.000Z', '2027-02-01T00:00:00.000Z', NULL),
          ('user_d', 'user_a', 'RIO-AAAAAA', 'void',     '2026-09-05 10:00:00', '2026-09-06T00:00:00.000Z', NULL, 'same_fiscal_id'),
          ('user_e', 'user_a', 'RIO-AAAAAA', 'pending',  '2026-09-07 10:00:00', NULL, NULL, NULL);

        INSERT INTO billing_events (user_id, type, amount_cents) VALUES
          ('user_b', 'invoice.paid', 1500),
          ('user_c', 'invoice.paid', 0),
          ('user_c', 'invoice.payment_failed', 1500),
          ('user_a', 'invoice.paid', 5000);
    `);
    const db: any = {
        prepare: (sql: string) => ({
            bind: (...b: any[]) => ({
                all: async () => ({ results: sqlite.prepare(sql).all(...b) }),
                first: async () => sqlite.prepare(sql).get(...b) ?? null,
            }),
        }),
    };
    return { sqlite, db };
}

describe("loadAccountReferrals", () => {
    it("lists whom the account invited, newest first, with the reward ceiling counted", async () => {
        const { db } = fixture();
        const r = await loadAccountReferrals(db, "user_a");

        expect(r.invited_by).toBeNull();
        expect(r.invited.map((x) => x.invitee_user_id)).toEqual(["user_e", "user_d", "user_c", "user_b"]);
        // Two rewarded rows; the void one is recorded, not paid, and does not count.
        expect(r.rewards_used).toBe(2);
        expect(r.max_rewards).toBe(3);

        const b = r.invited.find((x) => x.invitee_user_id === "user_b")!;
        expect(b).toMatchObject({ invitee_label: "Bruno", invitee_client_code: "RIO-BBBBBB", invitee_paid: true });
        expect(r.invited.find((x) => x.invitee_user_id === "user_d")!.void_reason).toBe("same_fiscal_id");
    });

    it("does not call a zero-euro or failed invoice a payment", async () => {
        const { db } = fixture();
        const r = await loadAccountReferrals(db, "user_a");
        // Rewarded and never paid: the shape abuse takes, and it must read as such.
        expect(r.invited.find((x) => x.invitee_user_id === "user_c")!.invitee_paid).toBe(false);
        expect(r.invited.find((x) => x.invitee_user_id === "user_e")!.invitee_paid).toBe(false);
    });

    it("names who invited the account, by the inviter's own number", async () => {
        const { db } = fixture();
        const r = await loadAccountReferrals(db, "user_b");

        expect(r.invited).toEqual([]);
        expect(r.rewards_used).toBe(0);
        expect(r.invited_by).toMatchObject({
            inviter_user_id: "user_a",
            inviter_label: "Loja da Ana, Lda",
            inviter_client_code: "RIO-AAAAAA",
            state: "rewarded",
            reward_until: "2026-12-01T00:00:00.000Z",
        });
    });

    it("prefers the inviter's current number to the seat code the link carried", async () => {
        const { db, sqlite } = fixture();
        sqlite.exec("UPDATE referrals SET inviter_client_code = 'RIO-5EA75E' WHERE invitee_user_id = 'user_b'");
        const r = await loadAccountReferrals(db, "user_b");
        expect(r.invited_by!.inviter_client_code).toBe("RIO-AAAAAA");
    });

    it("keeps the stored number when the inviting account is gone", async () => {
        const { db, sqlite } = fixture();
        sqlite.exec("DELETE FROM users WHERE id = 'user_a'");
        const r = await loadAccountReferrals(db, "user_b");
        expect(r.invited_by).toMatchObject({
            inviter_user_id: "user_a", inviter_label: null, inviter_client_code: "RIO-AAAAAA",
        });
    });

    it("answers empty for an account with no referrals", async () => {
        const { db } = fixture();
        const r = await loadAccountReferrals(db, "user_nobody");
        expect(r).toEqual({ invited_by: null, invited: [], rewards_used: 0, max_rewards: 3 });
    });
});
