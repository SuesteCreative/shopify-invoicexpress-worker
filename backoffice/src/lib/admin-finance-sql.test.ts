import { describe, it, expect } from "vitest";
import {
    monthlyCents, PAYMENTS_BY_ACCOUNT, REFUNDS_BY_ACCOUNT,
    SUBSCRIPTION_LINES, TRIALS_ENDING, OUTSTANDING_PAYMENTS,
    SETTLED_AFTER_FAILURE, SEATS_BY_ACCOUNT,
} from "./admin-finance-sql";

/**
 * MRR is the one number on the admin console that is a forecast rather than a
 * record, and it is built by adding up prices of different periods. Normalising
 * them is where it goes wrong silently — an annual price counted as a monthly
 * one overstates the business twelvefold — so that arithmetic is pinned here,
 * and the queries are executed against real SQLite so a column that does not
 * exist cannot reach production.
 */

function db() {
    const nodeSqlite = "node:sqlite";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require(nodeSqlite);
    const sqlite = new DatabaseSync(":memory:");

    sqlite.exec(`
        CREATE TABLE billing_events (
            id TEXT PRIMARY KEY, user_id TEXT, type TEXT NOT NULL,
            stripe_object_id TEXT, payment_intent_id TEXT,
            amount_cents INTEGER, currency TEXT, status TEXT, created_at TEXT, raw_json TEXT
        );
        CREATE TABLE users (
            id TEXT PRIMARY KEY, email TEXT, name TEXT, company_name TEXT,
            admin_label TEXT, role TEXT DEFAULT 'user', is_inactive INTEGER DEFAULT 0
        );
        CREATE TABLE subscriptions (
            user_id TEXT, connection_key TEXT, status TEXT, plan TEXT, price_id TEXT,
            current_period_end TEXT, trial_end TEXT, early_bird INTEGER,
            stripe_subscription_id TEXT, cancel_at_period_end INTEGER,
            -- Migration 0052: the fixed end date a legacy monthly is given, and
            -- which notice about it has already gone out.
            cancel_at TEXT, legacy_notice_sent_for TEXT
        );
        CREATE TABLE account_seats (id TEXT PRIMARY KEY, account_id TEXT, amount_cents INTEGER, created_at TEXT);
    `);

    return {
        exec: (sql: string) => sqlite.exec(sql),
        all: (sql: string) => sqlite.prepare(sql).all() as any[],
    };
}

describe("normalising a price to a month", () => {
    it("leaves a monthly price alone", () => {
        expect(monthlyCents({ unit_amount: 750, recurring: { interval: "month", interval_count: 1 } })).toBe(750);
    });

    it("spreads an annual price over twelve months", () => {
        // 75 € a year is 6,25 € a month. Counting it as 75 would overstate this
        // one client by a factor of twelve.
        expect(monthlyCents({ unit_amount: 7500, recurring: { interval: "year", interval_count: 1 } })).toBe(625);
    });

    it("honours an interval count", () => {
        expect(monthlyCents({ unit_amount: 1500, recurring: { interval: "month", interval_count: 2 } })).toBe(750);
        expect(monthlyCents({ unit_amount: 15000, recurring: { interval: "year", interval_count: 2 } })).toBe(625);
    });

    it("counts a one-off as nothing recurring", () => {
        // A seat is `mode: payment` and has no recurrence. It is revenue, but it
        // is not MRR, and adding it would make the forecast a running total.
        expect(monthlyCents({ unit_amount: 150, recurring: null })).toBe(0);
    });

    it("survives a price Stripe did not return", () => {
        expect(monthlyCents(null)).toBe(0);
        expect(monthlyCents(undefined)).toBe(0);
        expect(monthlyCents({ unit_amount: null, recurring: { interval: "month" } })).toBe(0);
    });
});

describe("per-account money", () => {
    it("counts a payment once even when it was written twice, and nets the refund", () => {
        const d = db();
        d.exec(`
            INSERT INTO billing_events (id, user_id, type, stripe_object_id, payment_intent_id, amount_cents, currency, created_at) VALUES
              ('evt_1', 'user_a', 'invoice.paid',    'in_A', 'pi_A', 7500, 'eur', '2026-03-04T10:00:00.000Z'),
              ('in_A',  'user_a', 'invoice.paid',    'in_A', 'pi_A', 7500, 'eur', '2026-03-04 10:00:00'),
              ('evt_r1','user_a', 'charge.refunded', 're_1', 'pi_A', 1000, 'eur', '2026-03-06T10:00:00.000Z'),
              ('evt_r2','user_a', 'charge.refunded', 're_2', 'pi_A', 2500, 'eur', '2026-03-09T10:00:00.000Z');
        `);

        const [paid] = d.all(PAYMENTS_BY_ACCOUNT);
        expect(paid).toMatchObject({ user_id: "user_a", gross_cents: 7500, payments: 1 });

        // Cumulative refund amounts, deduped on the payment intent: 2500, not 3500.
        const [back] = d.all(REFUNDS_BY_ACCOUNT);
        expect(back).toMatchObject({ user_id: "user_a", refunded_cents: 2500 });
    });

    it("keeps accounts apart", () => {
        const d = db();
        d.exec(`
            INSERT INTO billing_events (id, user_id, type, stripe_object_id, payment_intent_id, amount_cents, currency, created_at) VALUES
              ('e1', 'user_a', 'invoice.paid', 'in_A', 'pi_A', 750, 'eur', '2026-03-04T10:00:00.000Z'),
              ('e2', 'user_b', 'invoice.paid', 'in_B', 'pi_B', 500, 'eur', '2026-03-05T10:00:00.000Z');
        `);
        const rows = d.all(PAYMENTS_BY_ACCOUNT).sort((a, b) => a.user_id.localeCompare(b.user_id));
        expect(rows.map((r) => [r.user_id, r.gross_cents])).toEqual([["user_a", 750], ["user_b", 500]]);
    });
});

describe("the remaining queries run against the real shape", () => {
    it("subscription lines, seats and failed payments return what the route reads", () => {
        const d = db();
        d.exec(`
            INSERT INTO users (id, email, name, role) VALUES ('user_a', 'a@x.pt', 'A Lda', 'user');
            INSERT INTO subscriptions (user_id, connection_key, status, plan, price_id, stripe_subscription_id, early_bird, cancel_at_period_end)
            VALUES ('user_a', 'shopify:invoicexpress', 'active', 'monthly', 'price_1', 'sub_1', 0, 0);
            INSERT INTO account_seats (id, account_id, amount_cents, created_at) VALUES ('s1', 'user_a', 150, '2026-03-01');
            INSERT INTO billing_events (id, user_id, type, stripe_object_id, amount_cents, currency, created_at)
            VALUES ('evt_f', 'user_a', 'invoice.payment_failed', 'in_open', 750, 'eur', '2026-03-10T10:00:00.000Z');
        `);

        expect(d.all(SUBSCRIPTION_LINES)[0]).toMatchObject({
            user_id: "user_a", status: "active", price_id: "price_1", email: "a@x.pt", role: "user",
        });
        expect(d.all(SEATS_BY_ACCOUNT)[0]).toMatchObject({ user_id: "user_a", n: 1, cents: 150 });
        expect(d.all(OUTSTANDING_PAYMENTS)[0]).toMatchObject({ user_id: "user_a", amount_cents: 750 });
    });

    it("finds an early-bird trial ending inside the window and ignores one outside it", () => {
        const d = db();
        const soon = new Date(Date.now() + 5 * 86400_000).toISOString();
        const later = new Date(Date.now() + 90 * 86400_000).toISOString();
        d.exec(`
            INSERT INTO users (id, email, role) VALUES ('user_a', 'a@x.pt', 'user'), ('user_b', 'b@x.pt', 'user');
            INSERT INTO subscriptions (user_id, connection_key, status, stripe_subscription_id, early_bird, trial_end) VALUES
              ('user_a', 'k', 'trialing', NULL, 1, '${soon}'),
              ('user_b', 'k', 'trialing', NULL, 1, '${later}');
        `);
        const rows = d.all(TRIALS_ENDING);
        expect(rows).toHaveLength(1);
        expect(rows[0].user_id).toBe("user_a");
    });

    it("ignores a trial that Stripe is already billing", () => {
        const d = db();
        const soon = new Date(Date.now() + 5 * 86400_000).toISOString();
        d.exec(`
            INSERT INTO users (id, email, role) VALUES ('user_a', 'a@x.pt', 'user');
            INSERT INTO subscriptions (user_id, connection_key, status, stripe_subscription_id, early_bird, trial_end)
            VALUES ('user_a', 'k', 'trialing', 'sub_live', 1, '${soon}');
        `);
        expect(d.all(TRIALS_ENDING)).toHaveLength(0);
    });
});

describe("what is actually owed", () => {
    it("drops a failure whose retry collected it", () => {
        const d = db();
        // The ordinary case, and the one that made this list unreadable: an SCA
        // challenge or a bank decline on the first attempt, paid minutes later.
        // Eleven of thirteen rows in production were this.
        d.exec(`
            INSERT INTO users (id, email, role) VALUES ('user_a', 'a@x.pt', 'user');
            INSERT INTO billing_events (id, user_id, type, stripe_object_id, amount_cents, currency, created_at) VALUES
              ('evt_f', 'user_a', 'invoice.payment_failed', 'in_A', 9225, 'eur', '2026-09-10T18:00:00.000Z'),
              ('evt_p', 'user_a', 'invoice.paid',           'in_A', 9225, 'eur', '2026-09-10T20:14:00.000Z');
        `);
        expect(d.all(OUTSTANDING_PAYMENTS)).toHaveLength(0);
        expect(d.all(SETTLED_AFTER_FAILURE)[0].n).toBe(1);
    });

    it("keeps a failure nobody ever collected", () => {
        const d = db();
        d.exec(`
            INSERT INTO users (id, email, role) VALUES ('user_a', 'a@x.pt', 'user');
            INSERT INTO billing_events (id, user_id, type, stripe_object_id, amount_cents, currency, created_at)
            VALUES ('evt_f', 'user_a', 'invoice.payment_failed', 'in_A', 923, 'eur', '2026-09-10T18:00:00.000Z');
        `);
        const rows = d.all(OUTSTANDING_PAYMENTS);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ invoice_id: "in_A", amount_cents: 923, attempts: 1 });
        expect(d.all(SETTLED_AFTER_FAILURE)[0].n).toBe(0);
    });

    it("counts one invoice once however many times Stripe retried it", () => {
        const d = db();
        // Stripe retries on its own schedule and each attempt writes a row. The
        // same invoice appeared twice in the production list for this reason.
        d.exec(`
            INSERT INTO users (id, email, role) VALUES ('user_a', 'a@x.pt', 'user');
            INSERT INTO billing_events (id, user_id, type, stripe_object_id, amount_cents, currency, created_at) VALUES
              ('evt_1', 'user_a', 'invoice.payment_failed', 'in_A', 923, 'eur', '2026-08-08T10:00:00.000Z'),
              ('evt_2', 'user_a', 'invoice.payment_failed', 'in_A', 923, 'eur', '2026-08-11T10:00:00.000Z');
        `);
        const rows = d.all(OUTSTANDING_PAYMENTS);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ attempts: 2, created_at: "2026-08-11T10:00:00.000Z" });
    });

    it("names the client", () => {
        const d = db();
        d.exec(`
            INSERT INTO users (id, email, company_name, role) VALUES ('user_a', 'a@x.pt', 'Pleasant Venture Lda', 'user');
            INSERT INTO billing_events (id, user_id, type, stripe_object_id, amount_cents, currency, created_at)
            VALUES ('evt_f', 'user_a', 'invoice.payment_failed', 'in_A', 923, 'eur', '2026-09-10T18:00:00.000Z');
        `);
        expect(d.all(OUTSTANDING_PAYMENTS)[0].company_name).toBe("Pleasant Venture Lda");
    });
});

describe("what an outstanding invoice was for", () => {
    it("carries the line description, which is what tells a seat from a renewal", () => {
        const d = db();
        // The two real ones: 1,85 EUR is a seat, 9,23 EUR is a month of Shopify
        // into InvoiceXpress. Same card, entirely different problems.
        d.exec(`
            INSERT INTO users (id, email, company_name, role) VALUES
              ('user_a', 'a@x.pt', 'Alliance', 'user'),
              ('user_b', 'b@x.pt', 'Pleasant Venture Lda', 'user');
            INSERT INTO billing_events (id, user_id, type, stripe_object_id, amount_cents, currency, created_at, raw_json) VALUES
              ('evt_a', 'user_a', 'invoice.payment_failed', 'in_A', 185, 'eur', '2026-09-05T10:00:00.000Z',
               '{"billing_reason":"manual","lines":{"data":[{"description":"Rioko 2.0 || Extra User"}]}}'),
              ('evt_b', 'user_b', 'invoice.payment_failed', 'in_B', 923, 'eur', '2026-09-10T10:00:00.000Z',
               '{"billing_reason":"subscription_cycle","lines":{"data":[{"description":"1 × Rioko 2.0 || Shopify - InvoiceXpress (a EUR7.50/month)"}]}}');
        `);

        const byInvoice = Object.fromEntries(d.all(OUTSTANDING_PAYMENTS).map((r) => [r.invoice_id, r]));
        expect(byInvoice.in_A).toMatchObject({ reason: "manual", description: "Rioko 2.0 || Extra User" });
        expect(byInvoice.in_B.reason).toBe("subscription_cycle");
    });

    it("survives a row whose payload was never stored", () => {
        const d = db();
        d.exec(`
            INSERT INTO users (id, email, role) VALUES ('user_a', 'a@x.pt', 'user');
            INSERT INTO billing_events (id, user_id, type, stripe_object_id, amount_cents, currency, created_at, raw_json)
            VALUES ('evt_a', 'user_a', 'invoice.payment_failed', 'in_A', 923, 'eur', '2026-09-10T10:00:00.000Z', NULL);
        `);
        const [row] = d.all(OUTSTANDING_PAYMENTS);
        expect(row.invoice_id).toBe("in_A");
        expect(row.description).toBeNull();
    });
});
