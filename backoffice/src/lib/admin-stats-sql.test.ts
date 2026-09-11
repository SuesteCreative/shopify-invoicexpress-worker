import { describe, it, expect } from "vitest";
import {
    REVENUE_BY_MONTH, OTHER_CURRENCIES, CUSTOMERS, CUSTOMERS_LEGACY,
    FUNNEL, SIGNUPS_BY_MONTH, ATTRIBUTION_COVERAGE, DOCUMENTS_BY_MONTH,
} from "./admin-stats-sql";

/**
 * These queries decide what the admin overview says the business earned, and
 * the data they run against is genuinely adversarial: the same paid invoice can
 * be written twice under different primary keys, refunds are stored as positive
 * numbers, and `created_at` comes in two formats that sort differently.
 *
 * So the SQL is executed for real here, against SQLite, on fixtures that
 * reproduce each of those. Asserting on hand-computed totals is the only way to
 * catch the failure mode that matters, which is not an error — it is a page
 * that loads fine and reports the wrong money.
 */

function db() {
    // Named indirectly, exactly as storage.connection-tax.test.ts does it, so
    // the bundler does not try to resolve a node: builtin for the edge runtime.
    const nodeSqlite = "node:sqlite";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require(nodeSqlite);
    const sqlite = new DatabaseSync(":memory:");

    sqlite.exec(`
        CREATE TABLE billing_events (
            id TEXT PRIMARY KEY, user_id TEXT, type TEXT NOT NULL,
            stripe_object_id TEXT, payment_intent_id TEXT,
            amount_cents INTEGER, currency TEXT, status TEXT,
            created_at TEXT
        );
        CREATE TABLE users (
            id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT DEFAULT 'user',
            created_at TEXT, registration_completed INTEGER DEFAULT 0,
            acq_utm_source TEXT, acq_referrer TEXT, acq_captured_at TEXT
        );
        CREATE TABLE account_members (
            id TEXT PRIMARY KEY, account_id TEXT, member_user_id TEXT, status TEXT
        );
        CREATE TABLE connections (id TEXT PRIMARY KEY, user_id TEXT, status TEXT);
        CREATE TABLE integrations (id TEXT PRIMARY KEY, user_id TEXT, shopify_domain TEXT);
        CREATE TABLE subscriptions (user_id TEXT, connection_key TEXT, status TEXT);
        CREATE TABLE processed_orders (id TEXT PRIMARY KEY, invoice_id TEXT, created_at TEXT);
        CREATE TABLE account_seats (id TEXT PRIMARY KEY, account_id TEXT, amount_cents INTEGER, created_at TEXT);
    `);

    return {
        exec: (sql: string) => sqlite.exec(sql),
        all: (sql: string) => sqlite.prepare(sql).all() as any[],
        one: (sql: string) => sqlite.prepare(sql).get() as any,
    };
}

describe("revenue", () => {
    it("counts a paid invoice once even when it was written twice", () => {
        const d = db();
        // The exact collision that exists in production: the Stripe webhook
        // keys the row on the EVENT id, /api/admin/link-subscription keys the
        // same invoice on the INVOICE id. Both carry stripe_object_id = in_A.
        // INSERT OR IGNORE never sees it, because the primary keys differ.
        d.exec(`
            INSERT INTO billing_events (id, user_id, type, stripe_object_id, amount_cents, currency, created_at) VALUES
              ('evt_1', 'user_a', 'invoice.paid', 'in_A', 750, 'eur', '2026-03-04T10:00:00.000Z'),
              ('in_A',  'user_a', 'invoice.paid', 'in_A', 750, 'eur', '2026-03-04 10:00:00');
        `);

        const r = d.all(REVENUE_BY_MONTH);
        expect(r).toHaveLength(1);
        expect(r[0].ym).toBe("2026-03");
        expect(r[0].gross_cents).toBe(750);
    });

    it("subtracts refunds, which are stored positive", () => {
        const d = db();
        d.exec(`
            INSERT INTO billing_events (id, user_id, type, stripe_object_id, amount_cents, currency, created_at) VALUES
              ('evt_paid', 'user_a', 'invoice.paid',    'in_A', 7500, 'eur', '2026-04-01T10:00:00.000Z'),
              ('evt_ref',  'user_a', 'charge.refunded', 're_A', 2500, 'eur', '2026-04-09T10:00:00.000Z');
        `);

        const [m] = d.all(REVENUE_BY_MONTH);
        expect(m.gross_cents).toBe(7500);
        expect(m.refunded_cents).toBe(2500);
        // Net is computed in the route; assert the arithmetic it will do.
        expect(m.gross_cents - m.refunded_cents).toBe(5000);
    });

    it("groups both timestamp formats into the same month", () => {
        const d = db();
        d.exec(`
            INSERT INTO billing_events (id, user_id, type, stripe_object_id, amount_cents, currency, created_at) VALUES
              ('evt_1', 'user_a', 'invoice.paid', 'in_A', 500, 'eur', '2026-05-02 08:00:00'),
              ('evt_2', 'user_b', 'invoice.paid', 'in_B', 500, 'eur', '2026-05-28T23:59:59.999Z');
        `);

        const r = d.all(REVENUE_BY_MONTH);
        expect(r).toHaveLength(1);
        expect(r[0].ym).toBe("2026-05");
        expect(r[0].gross_cents).toBe(1000);
    });

    it("keeps non-euro payments out of the euro series, and reports them separately", () => {
        const d = db();
        d.exec(`
            INSERT INTO billing_events (id, user_id, type, stripe_object_id, amount_cents, currency, created_at) VALUES
              ('evt_eur', 'user_a', 'invoice.paid', 'in_A', 750,  'eur', '2026-06-01T10:00:00.000Z'),
              ('evt_gbp', 'user_b', 'invoice.paid', 'in_B', 900,  'gbp', '2026-06-02T10:00:00.000Z'),
              ('evt_nul', 'user_c', 'invoice.paid', 'in_C', 750,  NULL,  '2026-06-03T10:00:00.000Z');
        `);

        const [m] = d.all(REVENUE_BY_MONTH);
        // A null currency is treated as euro — that is what the fleet actually is.
        expect(m.gross_cents).toBe(1500);

        const other = d.all(OTHER_CURRENCIES);
        expect(other).toHaveLength(1);
        expect(other[0].currency).toBe("gbp");
        expect(other[0].n).toBe(1);
    });

    it("ignores rows with no amount instead of counting them as zero-value sales", () => {
        const d = db();
        d.exec(`
            INSERT INTO billing_events (id, user_id, type, stripe_object_id, amount_cents, currency, created_at) VALUES
              ('evt_seat', 'user_a', 'checkout.session.completed', 'cs_A', NULL, NULL, '2026-07-01T10:00:00.000Z'),
              ('evt_paid', 'user_a', 'invoice.paid',               'in_A', 750,  'eur','2026-07-02T10:00:00.000Z');
        `);

        const r = d.all(REVENUE_BY_MONTH);
        expect(r).toHaveLength(1);
        expect(r[0].gross_cents).toBe(750);
    });
});

describe("customers", () => {
    /** One admin, one invited colleague, two real customers. */
    function seedPeople(d: ReturnType<typeof db>) {
        d.exec(`
            INSERT INTO users (id, role, created_at, registration_completed, acq_utm_source, acq_captured_at) VALUES
              ('user_admin',  'hiperadmin', '2026-01-05T10:00:00.000Z', 1, 'google', '2026-01-05T10:00:00.000Z'),
              ('user_cust1',  'user',       '2026-02-10T10:00:00.000Z', 1, 'google', '2026-02-10T10:00:00.000Z'),
              ('user_cust2',  'user',       '2026-02-20 10:00:00',      0, NULL,     NULL),
              ('user_seat',   'user',       '2026-03-01T10:00:00.000Z', 0, NULL,     NULL);
            INSERT INTO account_members (id, account_id, member_user_id, status) VALUES
              ('m1', 'user_cust1', 'user_seat', 'active');
        `);
    }

    it("counts neither admins nor invited extra users as customers", () => {
        const d = db();
        seedPeople(d);
        const f = d.one(FUNNEL(CUSTOMERS));
        expect(f.accounts).toBe(2);
        expect(f.registered).toBe(1);
    });

    it("still answers on a database without migration 0039", () => {
        const d = db();
        seedPeople(d);
        // The legacy shape cannot know about seats, so the colleague counts.
        // What matters is that it runs and still excludes the admin.
        const f = d.one(FUNNEL(CUSTOMERS_LEGACY));
        expect(f.accounts).toBe(3);
    });

    it("walks the funnel down: registered, then connected, then paying", () => {
        const d = db();
        seedPeople(d);
        d.exec(`
            INSERT INTO connections (id, user_id, status) VALUES ('c1', 'user_cust1', 'active');
            INSERT INTO subscriptions (user_id, connection_key, status) VALUES ('user_cust1', 'shopify:invoicexpress', 'active');
        `);
        const f = d.one(FUNNEL(CUSTOMERS));
        expect(f).toMatchObject({ accounts: 2, registered: 1, connected: 1, paying: 1, mid_setup: 0 });
    });

    it("counts a draft connection as a wizard someone walked out of", () => {
        const d = db();
        seedPeople(d);
        d.exec(`INSERT INTO connections (id, user_id, status) VALUES ('c1', 'user_cust2', 'draft');`);
        const f = d.one(FUNNEL(CUSTOMERS));
        expect(f.mid_setup).toBe(1);
        // A draft still counts as connected — the row exists. The two numbers
        // together are what says "wired, but never finished".
        expect(f.connected).toBe(1);
    });

    it("counts the legacy Shopify pipe, which has no connections row at all", () => {
        const d = db();
        seedPeople(d);
        d.exec(`INSERT INTO integrations (id, user_id, shopify_domain) VALUES ('i1', 'user_cust2', 'shop.myshopify.com');`);
        expect(d.one(FUNNEL(CUSTOMERS)).connected).toBe(1);
    });

    it("reports how much of the funnel has no attribution", () => {
        const d = db();
        seedPeople(d);
        const a = d.one(ATTRIBUTION_COVERAGE(CUSTOMERS));
        expect(a).toMatchObject({ total: 2, captured: 1 });
    });

    it("groups sign-ups by month across both timestamp formats", () => {
        const d = db();
        seedPeople(d);
        const s = d.all(SIGNUPS_BY_MONTH(CUSTOMERS));
        expect(s).toEqual([{ ym: "2026-02", n: 2 }]);
    });
});

describe("documents", () => {
    it("counts only sales that produced a document", () => {
        const d = db();
        d.exec(`
            INSERT INTO processed_orders (id, invoice_id, created_at) VALUES
              ('o1', 'inv_1', '2026-08-01T10:00:00.000Z'),
              ('o2', 'inv_2', '2026-08-15 10:00:00'),
              ('o3', NULL,    '2026-08-20T10:00:00.000Z');
        `);
        expect(d.all(DOCUMENTS_BY_MONTH)).toEqual([{ ym: "2026-08", n: 2 }]);
    });
});
