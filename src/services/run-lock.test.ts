import { describe, it, expect } from "vitest";
import { claimRunLock, releaseRunLock } from "./run-lock";

/**
 * The lock that keeps two Lodgify passes off the same account at once.
 *
 * Run against real SQL (node:sqlite, the same table migration 0026 creates),
 * because the whole guarantee is one conditional upsert: if the WHERE on the
 * conflict branch were wrong, both callers would win and both would bill.
 */

async function withDb(fn: (db: any) => Promise<void>) {
    let DatabaseSync: any;
    try {
        // Specifier in a variable: the worker typechecks against workers-types,
        // which has no node:sqlite declarations.
        const nodeSqlite = "node:sqlite";
        ({ DatabaseSync } = await import(nodeSqlite));
    } catch {
        console.warn("node:sqlite unavailable; skipping run-lock check");
        return;
    }
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`CREATE TABLE sweep_state (
        shopify_domain TEXT PRIMARY KEY, last_started_at TEXT, last_completed_at TEXT,
        last_status TEXT, last_detail_json TEXT
    );`);
    const db = {
        prepare(sql: string) {
            const stmt = sqlite.prepare(sql);
            let bound: unknown[] = [];
            const api = {
                bind(...args: unknown[]) { bound = args; return api; },
                async run() { return { meta: { changes: Number(stmt.run(...bound).changes ?? 0) } }; },
            };
            return api;
        },
    };
    await fn(db);
}

const KEY = "lodgify-run:user_a";
const MIN = 60_000;

describe("claimRunLock / releaseRunLock", () => {
    it("lets exactly one of two callers in", async () => {
        await withDb(async (db) => {
            const first = await claimRunLock(db, KEY, 10 * MIN);
            const second = await claimRunLock(db, KEY, 10 * MIN);
            expect(first).toBeTruthy();
            expect(second).toBeNull();
        });
    });

    it("is free again once the holder releases it", async () => {
        await withDb(async (db) => {
            const token = await claimRunLock(db, KEY, 10 * MIN);
            await releaseRunLock(db, KEY, token!);
            expect(await claimRunLock(db, KEY, 10 * MIN)).toBeTruthy();
        });
    });

    it("keeps accounts apart", async () => {
        await withDb(async (db) => {
            expect(await claimRunLock(db, KEY, 10 * MIN)).toBeTruthy();
            expect(await claimRunLock(db, "lodgify-run:user_b", 10 * MIN)).toBeTruthy();
        });
    });

    it("stops counting a holder that died without releasing", async () => {
        await withDb(async (db) => {
            const t0 = new Date("2026-09-13T10:00:00Z");
            expect(await claimRunLock(db, KEY, 10 * MIN, t0)).toBeTruthy();
            expect(await claimRunLock(db, KEY, 10 * MIN, new Date(t0.getTime() + 5 * MIN))).toBeNull();
            expect(await claimRunLock(db, KEY, 10 * MIN, new Date(t0.getTime() + 11 * MIN))).toBeTruthy();
        });
    });

    it("never lets a holder that lost its lock release the one that took over", async () => {
        await withDb(async (db) => {
            const t0 = new Date("2026-09-13T10:00:00Z");
            const stale = await claimRunLock(db, KEY, 10 * MIN, t0);
            const fresh = await claimRunLock(db, KEY, 10 * MIN, new Date(t0.getTime() + 11 * MIN));
            expect(fresh).toBeTruthy();
            await releaseRunLock(db, KEY, stale!);
            // Still held by the second caller.
            expect(await claimRunLock(db, KEY, 10 * MIN, new Date(t0.getTime() + 12 * MIN))).toBeNull();
        });
    });
});
