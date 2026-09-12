import { describe, it, expect } from "vitest";
import { missingDestinationCredentials, ixCredentialsPresent } from "./destination-credentials";

/**
 * The check that would have caught Bestisafil: an active Stripe Connect →
 * InvoiceXpress connection, a paid subscription, and no IX credentials
 * anywhere — so every payment died at the proxy with UNAUTHENTICATED and not
 * one document was ever issued.
 */
function harness() {
    const nodeSqlite = "node:sqlite";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require(nodeSqlite);
    const sqlite = new DatabaseSync(":memory:");

    sqlite.exec(`
        CREATE TABLE integrations (user_id TEXT PRIMARY KEY, ix_account_name TEXT, ix_api_key TEXT);
        CREATE TABLE connections (
            user_id TEXT, source_kind TEXT, destination_kind TEXT, destination_config_json TEXT
        );

        -- IX, fully credentialed.
        INSERT INTO integrations VALUES ('user_ok', 'bestisafil', 'k_live_x');
        -- IX row exists but was cleared: the MeetFrank shape.
        INSERT INTO integrations VALUES ('user_cleared', '', '');
        -- 'user_none' has no integrations row at all: the Bestisafil shape.

        INSERT INTO connections VALUES ('user_moloni', 'stripe_connect', 'moloni', '{"moloni_refresh_token":"r_x"}');
        INSERT INTO connections VALUES ('user_moloni_empty', 'stripe_connect', 'moloni', '{}');
        INSERT INTO connections VALUES ('user_vendus', 'lodgify', 'vendus', '{"vendus_api_key":"v_x"}');
        INSERT INTO connections VALUES ('user_vendus_empty', 'lodgify', 'vendus', '{}');
    `);

    return {
        prepare(sql: string) {
            const stmt = sqlite.prepare(sql);
            let bound: unknown[] = [];
            const api = {
                bind(...args: unknown[]) { bound = args; return api; },
                async first() { return stmt.get(...bound) ?? null; },
            };
            return api;
        },
    } as any;
}

describe("missingDestinationCredentials", () => {
    const db = harness();

    it("passes an InvoiceXpress connection that has both halves", async () => {
        expect(await missingDestinationCredentials(db, "user_ok", "stripe_connect", "invoicexpress")).toBeNull();
    });

    it("refuses when the account has no integrations row at all", async () => {
        const msg = await missingDestinationCredentials(db, "user_none", "stripe_connect", "invoicexpress");
        expect(msg).toMatch(/InvoiceXpress/);
    });

    it("refuses when the row exists but the credentials were cleared", async () => {
        const msg = await missingDestinationCredentials(db, "user_cleared", "lodgify", "invoicexpress");
        expect(msg).toMatch(/InvoiceXpress/);
    });

    it("reads Moloni and Vendus off the connection's own destination config", async () => {
        expect(await missingDestinationCredentials(db, "user_moloni", "stripe_connect", "moloni")).toBeNull();
        expect(await missingDestinationCredentials(db, "user_moloni_empty", "stripe_connect", "moloni")).toMatch(/Moloni/);
        expect(await missingDestinationCredentials(db, "user_vendus", "lodgify", "vendus")).toBeNull();
        expect(await missingDestinationCredentials(db, "user_vendus_empty", "lodgify", "vendus")).toMatch(/Vendus/);
    });

    it("does not block a destination it cannot judge", async () => {
        expect(await missingDestinationCredentials(db, "user_none", "stripe", "something_new")).toBeNull();
    });
});

describe("ixCredentialsPresent", () => {
    it("needs both halves, non-blank", () => {
        expect(ixCredentialsPresent({ ix_account_name: "bestisafil", ix_api_key: "k" })).toBe(true);
        expect(ixCredentialsPresent({ ix_account_name: "bestisafil", ix_api_key: "" })).toBe(false);
        expect(ixCredentialsPresent({ ix_account_name: "   ", ix_api_key: "k" })).toBe(false);
        expect(ixCredentialsPresent({ ix_api_key: "k" })).toBe(false);
        // No integrations row at all — the Bestisafil and MeetFrank shape.
        expect(ixCredentialsPresent(null)).toBe(false);
    });
});
