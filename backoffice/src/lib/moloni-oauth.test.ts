import { describe, it, expect, vi, afterEach } from "vitest";
import { exchangeMoloniCode } from "./moloni-oauth";

/**
 * What a connection moving off a username and password must end up with.
 *
 * The merchant presses "Mudar para OAuth" on a connection that is invoicing
 * today. Two things decide whether that is safe: the new credential has to land
 * where the worker reads it, and the old one has to be gone — but only once the
 * account that authorised is proven to be the right one. Moloni answers a
 * consent screen with a perfectly valid token pair for whichever account the
 * merchant happened to be logged into.
 */

/** Just enough D1 to capture what would be written. */
function fakeDb() {
    const writes: Array<{ sql: string; binds: any[] }> = [];
    return {
        writes,
        /** The merge patch of the last write, parsed. */
        patch(): Record<string, any> {
            const last = writes[writes.length - 1];
            return JSON.parse(last.binds[0]);
        },
        prepare(sql: string) {
            return {
                bind(...binds: any[]) {
                    return { run: async () => { writes.push({ sql, binds }); return { success: true }; } };
                },
            };
        },
    };
}

const LEGACY_ROW = {
    id: "conn-1",
    destination_config_json: JSON.stringify({
        moloni_client_id: "111",
        moloni_client_secret: "old-secret",
        moloni_username: "conta@exemplo.pt",
        moloni_password: "hunter2",
        moloni_company_name: "Empresa Exemplo",
        moloni_environment: "production",
        // The app the merchant typed on the way to the consent screen, parked by
        // the start route so the live credential was left alone.
        moloni_pending_client_id: "222",
        moloni_pending_client_secret: "new-secret",
    }),
};

function stubMoloni(companies: Array<{ company_id: number; name: string }> | Error) {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (String(url).includes("/grant/")) {
            return new Response(JSON.stringify({
                access_token: "at", refresh_token: "rt", expires_in: 3600,
            }), { status: 200 });
        }
        if (companies instanceof Error) return new Response("nope", { status: 500 });
        return new Response(JSON.stringify(companies), { status: 200 });
    }));
}

afterEach(() => vi.unstubAllGlobals());

describe("a connection migrating from a password to OAuth", () => {
    it("writes the token pair and deletes the password it replaces", async () => {
        stubMoloni([{ company_id: 7, name: "Empresa Exemplo" }]);
        const db = fakeDb();

        expect(await exchangeMoloniCode(db as any, LEGACY_ROW, "code", "https://app/callback")).toEqual({ ok: true });

        const patch = db.patch();
        // Where the worker reads it: `moloni_auth_mode` is what decides the mode.
        expect(patch.moloni_auth_mode).toBe("oauth");
        expect(patch.moloni_access_token).toBe("at");
        expect(patch.moloni_refresh_token).toBe("rt");
        // The app that was parked is promoted, and stops being pending.
        expect(patch.moloni_client_id).toBe("222");
        expect(patch.moloni_client_secret).toBe("new-secret");
        expect(patch.moloni_pending_client_id).toBeNull();
        expect(patch.moloni_pending_client_secret).toBeNull();
        // A null in a merge patch DELETES the key — verified against D1's
        // json_patch, which is what applies this.
        expect(patch.moloni_password).toBeNull();
        expect(patch.moloni_username).toBeNull();
        // The round trip is over.
        expect(patch.moloni_oauth_pending_at).toBeNull();
        expect(db.writes[db.writes.length - 1].sql).toMatch(/WHERE id = \?/);
        expect(db.writes[db.writes.length - 1].binds.at(-1)).toBe("conn-1");
    });

    it("keeps the password when the authorised account cannot see the company", async () => {
        // The merchant authorised a different Moloni login — their own, or a
        // client's. The token is valid and useless.
        stubMoloni([{ company_id: 9, name: "Outra Empresa" }]);
        const db = fakeDb();

        const result = await exchangeMoloniCode(db as any, LEGACY_ROW, "code", "https://app/callback");

        expect(result.ok).toBe(false);
        const patch = db.patch();
        expect(patch.moloni_oauth_error).toMatch(/Empresa Exemplo/);
        // Nothing else moved: the connection is still invoicing exactly as it was.
        expect(patch).not.toHaveProperty("moloni_auth_mode");
        expect(patch).not.toHaveProperty("moloni_refresh_token");
        expect(patch).not.toHaveProperty("moloni_password");
        expect(patch).not.toHaveProperty("moloni_client_id");
    });

    it("keeps the password when the company check itself fails", async () => {
        // Fails closed. An outage at Moloni must not be the thing that deletes a
        // working credential.
        stubMoloni(new Error("down"));
        const db = fakeDb();

        const result = await exchangeMoloniCode(db as any, LEGACY_ROW, "code", "https://app/callback");

        expect(result.ok).toBe(false);
        expect(db.patch()).not.toHaveProperty("moloni_auth_mode");
        expect(db.patch()).not.toHaveProperty("moloni_password");
    });
});

describe("a connection that never had a password", () => {
    it("is authorised without any company check", async () => {
        // Nothing to protect and nothing to compare against: a new connection has
        // no company until its settings step. An extra Moloni round trip here
        // would only be one more thing to fail.
        stubMoloni([]);
        const db = fakeDb();
        const row = {
            id: "conn-2",
            destination_config_json: JSON.stringify({
                moloni_client_id: "333", moloni_client_secret: "s", moloni_environment: "production",
            }),
        };

        expect(await exchangeMoloniCode(db as any, row, "code", "https://app/callback")).toEqual({ ok: true });
        expect(db.patch().moloni_auth_mode).toBe("oauth");
    });
});
