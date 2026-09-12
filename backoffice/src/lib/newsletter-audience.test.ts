import { describe, it, expect } from "vitest";
import { audienceQuery, fragmentFor, firstNameOf } from "./newsletter-audience";

/**
 * A newsletter goes to people. Getting the audience wrong is not an error that
 * shows up in a log — it is an email that reached someone it should not have, or
 * did not reach someone it was written for, and by the time anyone notices it
 * has already happened.
 *
 * So the SQL runs for real here, against SQLite, on a fleet that reproduces the
 * two shapes this schema actually has: accounts wired through `connections`, and
 * the older ones wired through `integrations` with no `connections` row at all.
 */

function db() {
    // Named indirectly, exactly as admin-stats-sql.test.ts does it, so the
    // bundler does not try to resolve a node: builtin for the edge runtime.
    const nodeSqlite = "node:sqlite";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require(nodeSqlite);
    const sqlite = new DatabaseSync(":memory:");

    sqlite.exec(`
        CREATE TABLE users (
            id TEXT PRIMARY KEY, email TEXT, name TEXT, company_name TEXT,
            admin_label TEXT, role TEXT DEFAULT 'user', created_at TEXT,
            registration_completed INTEGER DEFAULT 0, is_inactive INTEGER DEFAULT 0
        );
        CREATE TABLE account_members (
            id TEXT PRIMARY KEY, account_id TEXT, member_user_id TEXT, status TEXT
        );
        CREATE TABLE connections (
            id TEXT PRIMARY KEY, user_id TEXT, source_kind TEXT,
            destination_kind TEXT, status TEXT
        );
        CREATE TABLE integrations (id TEXT PRIMARY KEY, user_id TEXT, shopify_domain TEXT);
        CREATE TABLE subscriptions (
            user_id TEXT, connection_key TEXT, status TEXT, plan TEXT,
            stripe_subscription_id TEXT, early_bird INTEGER, trial_end TEXT,
            legacy_price INTEGER
        );
        CREATE TABLE billing_events (
            id TEXT PRIMARY KEY, user_id TEXT, type TEXT NOT NULL, created_at TEXT
        );
        CREATE TABLE processed_orders (id TEXT PRIMARY KEY, invoice_id TEXT, user_id TEXT);
    `);

    return {
        exec: (sql: string) => sqlite.exec(sql),
        /** Run a composed audience and return the ids it selected, in order. */
        ids: (keys: string[]) => {
            const { sql, binds } = audienceQuery(keys);
            return (sqlite.prepare(sql).all(...binds) as any[]).map((r) => r.user_id);
        },
    };
}

/** One of each shape that exists in production. */
function fleet(d: ReturnType<typeof db>) {
    d.exec(`
        INSERT INTO users (id, email, name, company_name, role, registration_completed, is_inactive) VALUES
          ('user_shop',    'shop@x.pt',    'Ana Silva',   'Loja Nova',   'user', 1, 0),
          ('user_legacy',  'legacy@x.pt',  'Rui Costa',   'Loja Velha',  'user', 1, 0),
          ('user_stripe',  'stripe@x.pt',  'Eva Matos',   'Studio Eva',  'user', 1, 0),
          ('user_parked',  'parked@x.pt',  'Zé Parado',   'Parada Lda',  'user', 1, 1),
          ('user_noemail',  NULL,          'Sem Email',   'Anónima',     'user', 1, 0),
          ('user_admin',   'admin@x.pt',   'Pedro',       'Kapta',       'superadmin', 1, 0),
          ('user_seat',    'seat@x.pt',    'Colega',      NULL,          'user', 1, 0);

        -- An invited extra user bills through the account that invited them.
        INSERT INTO account_members (id, account_id, member_user_id, status)
        VALUES ('m1', 'user_shop', 'user_seat', 'active');

        -- Modern pipes.
        INSERT INTO connections (id, user_id, source_kind, destination_kind, status) VALUES
          ('c1', 'user_shop',   'shopify', 'invoicexpress', 'active'),
          ('c2', 'user_stripe', 'stripe',  'moloni',        'active'),
          ('c3', 'user_parked', 'lodgify', 'moloni',        'active');

        -- The legacy pipe: no connections row anywhere, only this.
        INSERT INTO integrations (id, user_id, shopify_domain)
        VALUES ('i1', 'user_legacy', 'velha.myshopify.com');

        INSERT INTO billing_events (id, user_id, type, created_at)
        VALUES ('evt1', 'user_shop', 'invoice.paid', '2026-08-01T10:00:00.000Z');
    `);
}

describe("audience", () => {
    it("keeps a parked account: is_inactive silences warnings, not newsletters", () => {
        const d = db();
        fleet(d);
        // The contract written in migration 0046, inactive-accounts.ts,
        // incidents.ts and both messages files. If this ever fails, the product
        // has started lying to the admin who read "only receives newsletters".
        expect(d.ids([])).toContain("user_parked");
        expect(d.ids(["inactive"])).toEqual(["user_parked"]);
        expect(d.ids(["not_inactive"])).not.toContain("user_parked");
    });

    it("leaves out our own accounts and invited seats", () => {
        const d = db();
        fleet(d);
        const all = d.ids([]);
        expect(all).not.toContain("user_admin");
        expect(all).not.toContain("user_seat");
    });

    it("leaves out an account with no address to send to", () => {
        const d = db();
        fleet(d);
        expect(d.ids([])).not.toContain("user_noemail");
    });

    it("finds the legacy Shopify pipe, which has no connections row", () => {
        const d = db();
        fleet(d);
        // The mistake this guards: `connections`-only tests call the oldest
        // clients on the platform empty.
        expect(d.ids(["source:shopify"]).sort()).toEqual(["user_legacy", "user_shop"]);
        expect(d.ids(["dest:invoicexpress"]).sort()).toEqual(["user_legacy", "user_shop"]);
        expect(d.ids(["no_integration"])).not.toContain("user_legacy");
    });

    it("ORs inside a group and ANDs across groups", () => {
        const d = db();
        fleet(d);
        // shopify OR stripe  ->  shop, legacy, stripe
        expect(d.ids(["source:shopify", "source:stripe"]).sort())
            .toEqual(["user_legacy", "user_shop", "user_stripe"]);
        // (shopify OR stripe) AND never paid  ->  shop is dropped, it paid
        expect(d.ids(["source:shopify", "source:stripe", "never_paid"]).sort())
            .toEqual(["user_legacy", "user_stripe"]);
    });

    it("drops an unknown key instead of putting it in the SQL", () => {
        const d = db();
        fleet(d);
        const injection = "source:shopify'; DROP TABLE users;--";
        expect(fragmentFor(injection)).toBeNull();
        expect(d.ids([injection])).toEqual(d.ids([]));
        // The table is still there, which is the point.
        expect(d.ids([]).length).toBeGreaterThan(0);
    });

    it("binds one parameter per placeholder", () => {
        const q = audienceQuery(["source:shopify", "dest:moloni", "sub:active", "early_bird_ending:30"]);
        expect((q.sql.match(/\?/g) ?? []).length).toBe(q.binds.length);
    });
});

describe("gate and trial filters", () => {
    it("separates who the worker is refusing to invoice for", () => {
        const d = db();
        fleet(d);
        d.exec(`
            INSERT INTO subscriptions (user_id, connection_key, status, plan, stripe_subscription_id) VALUES
              ('user_shop', 'shopify:invoicexpress', 'active', 'monthly', 'sub_1');
            INSERT INTO subscriptions (user_id, connection_key, status, plan, stripe_subscription_id) VALUES
              ('user_stripe', 'stripe:moloni', 'canceled', 'monthly', 'sub_2');
        `);
        expect(d.ids(["allowed"])).toEqual(["user_shop"]);
        expect(d.ids(["blocked"])).toContain("user_stripe");
        expect(d.ids(["blocked"])).not.toContain("user_shop");
    });

    it("picks early birds whose grace runs out inside the window", () => {
        const d = db();
        fleet(d);
        d.exec(`
            INSERT INTO subscriptions (user_id, connection_key, status, early_bird, trial_end, stripe_subscription_id) VALUES
              ('user_stripe', 'stripe:moloni',  'trialing', 1, date('now','+10 day') || 'T00:00:00.000Z', NULL),
              ('user_parked', 'lodgify:moloni', 'trialing', 1, date('now','+90 day') || 'T00:00:00.000Z', NULL),
              ('user_legacy', 'shopify:invoicexpress', 'trialing', 1, date('now','-1 day') || 'T00:00:00.000Z', NULL);
        `);
        // Inside the window only. The one already expired is not "ending", and
        // the one three months out is not either.
        expect(d.ids(["early_bird_ending:30"])).toEqual(["user_stripe"]);
        expect(d.ids(["early_bird_ending:120"]).sort()).toEqual(["user_parked", "user_stripe"]);
    });

    it("refuses a nonsense window rather than guessing one", () => {
        expect(fragmentFor("early_bird_ending:0")).toBeNull();
        expect(fragmentFor("early_bird_ending:-5")).toBeNull();
        expect(fragmentFor("early_bird_ending:abc")).toBeNull();
        expect(fragmentFor("early_bird_ending:9999")).toBeNull();
    });
});

describe("firstNameOf", () => {
    it("takes the first word, and falls back to the label", () => {
        expect(firstNameOf("Ana Silva", "Loja Nova")).toBe("Ana");
        expect(firstNameOf(null, "Loja Nova")).toBe("Loja");
        expect(firstNameOf("  ", "x@y.pt")).toBe("x@y.pt");
        expect(firstNameOf(null, "")).toBe("");
    });
});
