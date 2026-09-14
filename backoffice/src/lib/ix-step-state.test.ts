import { describe, it, expect } from "vitest";
import { ixStepState } from "./ix-step-state";

describe("ixStepState", () => {
    it("authorises a key that lives on the connection, whatever the legacy row says", () => {
        // Farracemota, 2026-09-14: connection active with both halves, legacy
        // row empty and ix_authorized 0. The badge read "pendente".
        const s = ixStepState(
            { ix_account_name: null, has_ix_api_key: false, ix_authorized: 0 },
            { has_ix_credentials: true, ix_account_name: "farracemotaunipes" },
        );
        expect(s).toEqual({ accountName: "farracemotaunipes", keyStored: true, authorized: true });
    });

    it("still reads the legacy row when that is where the pair lives", () => {
        const s = ixStepState(
            { ix_account_name: "shopname", has_ix_api_key: true, ix_authorized: 1 },
            null,
        );
        expect(s).toEqual({ accountName: "shopname", keyStored: true, authorized: true });
    });

    it("does not keep a verdict about credentials that are gone", () => {
        const s = ixStepState({ ix_account_name: "", has_ix_api_key: false, ix_authorized: 1 }, null);
        expect(s.authorized).toBe(false);
        expect(s.keyStored).toBe(false);
    });

    it("says nothing is configured when neither place holds anything", () => {
        expect(ixStepState(null, null)).toEqual({ accountName: "", keyStored: false, authorized: false });
        expect(ixStepState(undefined, { has_ix_credentials: false })).toEqual({
            accountName: "", keyStored: false, authorized: false,
        });
    });

    it("prefers the name the worker will call", () => {
        const s = ixStepState(
            { ix_account_name: "old-legacy", has_ix_api_key: true, ix_authorized: 1 },
            { has_ix_credentials: true, ix_account_name: "on-connection" },
        );
        expect(s.accountName).toBe("on-connection");
    });
});
