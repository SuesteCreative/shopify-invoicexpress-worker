import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { STATUS_UPSERT_SQL } from "./connection-lifecycle";

/**
 * Saving settings must not take a live connection off the air.
 *
 * The worker reads `status = 'active'` and nothing else, so a connection nudged
 * to 'draft' stops invoicing with no error anywhere: not in the merchant's
 * dashboard, which still shows the integration, and not in a log, because
 * nothing failed. A merchant rotated their InvoiceXpress key, saved, and their
 * invoicing ended on that click.
 *
 * The rule is one SQL fragment shared by every route that upserts a connection.
 * Tested here rather than through the routes: those are edge handlers that reach
 * `getRequestContext`, and the fragment is the whole of the behaviour.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Shaped like the real upserts: `status` in VALUES, the fragment in DO UPDATE. */
const UPSERT = `
    INSERT INTO connections (id, user_id, source_kind, destination_kind, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, COALESCE(?, 'draft'), ?, ?)
    ON CONFLICT(user_id, source_kind, destination_kind) DO UPDATE SET
      ${STATUS_UPSERT_SQL},
      updated_at = excluded.updated_at`;

/** What lodgify-source writes: same rule, no `excluded` to read from. */
const UPDATE = `
    UPDATE connections
       SET status = CASE WHEN ? = 'draft' AND status <> 'draft' THEN status ELSE ? END,
           updated_at = ?
     WHERE user_id = ? AND source_kind = ? AND destination_kind = ?`;

function harness() {
    const nodeSqlite = "node:sqlite";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require(nodeSqlite);
    const sqlite = new DatabaseSync(":memory:");

    // The UNIQUE is what makes ON CONFLICT fire, and is the real schema's.
    sqlite.exec(`
        CREATE TABLE connections (
            id TEXT PRIMARY KEY, user_id TEXT, source_kind TEXT, destination_kind TEXT,
            status TEXT, created_at TEXT, updated_at TEXT,
            UNIQUE(user_id, source_kind, destination_kind)
        );
    `);

    const seed = (status: string | null) => {
        sqlite.prepare(
            `INSERT INTO connections (id, user_id, source_kind, destination_kind, status, created_at, updated_at)
             VALUES ('c1', 'user_a', 'stripe_connect', 'invoicexpress', ?, '2026-01-01', '2026-01-01')`,
        ).run(status);
    };

    /** A settings save: the wizard's body, whatever status it carries. */
    const save = (status: string | null) => {
        sqlite.prepare(UPSERT).run(
            "new-id", "user_a", "stripe_connect", "invoicexpress", status, "2026-09-14", "2026-09-14",
        );
    };

    const saveViaUpdate = (status: string) => {
        sqlite.prepare(UPDATE).run(status, status, "2026-09-14", "user_a", "stripe_connect", "invoicexpress");
    };

    const status = () =>
        (sqlite.prepare(`SELECT status FROM connections WHERE user_id = 'user_a'`).get() as any)?.status ?? null;

    const rows = () =>
        (sqlite.prepare(`SELECT COUNT(*) AS n FROM connections`).get() as any).n as number;

    return { seed, save, saveViaUpdate, status, rows };
}

describe("a settings save never deactivates a connection", () => {
    it("keeps an active connection active", () => {
        const h = harness();
        h.seed("active");
        h.save("draft");
        expect(h.status()).toBe("active");
    });

    it("keeps it active when the body states no status at all", () => {
        const h = harness();
        h.seed("active");
        h.save(null); // COALESCE makes this 'draft' in VALUES, as the real routes do
        expect(h.status()).toBe("active");
    });

    it("leaves a paused connection paused", () => {
        const h = harness();
        h.seed("paused");
        h.save("draft");
        expect(h.status()).toBe("paused");
    });

    it("leaves a connection in error alone", () => {
        const h = harness();
        h.seed("error");
        h.save("draft");
        expect(h.status()).toBe("error");
    });

    it("does the same through the lodgify UPDATE", () => {
        const h = harness();
        h.seed("active");
        h.saveViaUpdate("draft");
        expect(h.status()).toBe("active");
    });
});

describe("everything else still moves", () => {
    it("activating activates", () => {
        const h = harness();
        h.seed("draft");
        h.save("active");
        expect(h.status()).toBe("active");
    });

    it("the admin console can still pause a live connection", () => {
        const h = harness();
        h.seed("active");
        h.save("paused");
        expect(h.status()).toBe("paused");
    });

    it("a draft stays a draft, and does not become a second row", () => {
        const h = harness();
        h.seed("draft");
        h.save("draft");
        expect(h.status()).toBe("draft");
        expect(h.rows()).toBe(1);
    });

    it("a connection that does not exist yet is born a draft", () => {
        const h = harness();
        h.save(null);
        expect(h.status()).toBe("draft");
    });

    it("a row with no status at all takes the one it is given", () => {
        const h = harness();
        h.seed(null);
        h.save("active");
        expect(h.status()).toBe("active");
    });
});

/**
 * The fragment only protects the routes that use it, and a new source route is
 * exactly the kind of thing that gets written by copying an old one.
 */
describe("every route that upserts a connection uses the rule", () => {
    const ROUTES = [
        "../app/api/integrations/stripe-source/route.ts",
        "../app/api/integrations/eupago-source/route.ts",
        "../app/api/integrations/moloni-destination/route.ts",
        "../app/api/integrations/vendus-destination/route.ts",
    ];

    for (const rel of ROUTES) {
        it(`is imported by ${rel.split("/").slice(-2).join("/")}`, () => {
            const src = readFileSync(resolve(HERE, rel), "utf8");
            expect(src).toContain("STATUS_UPSERT_SQL");
            // The unguarded spelling is what this replaced; it must not come back
            // in the same statement by a later copy-paste.
            expect(src).not.toContain("status = excluded.status,\n           updated_at");
        });
    }

    it("lodgify-source writes the rule into its UPDATE", () => {
        const src = readFileSync(resolve(HERE, "../app/api/integrations/lodgify-source/route.ts"), "utf8");
        expect(src).toContain("CASE WHEN ? = 'draft' AND status <> 'draft'");
    });
});
