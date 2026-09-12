import { describe, it, expect } from "vitest";
import { ixCredentialPatchFrom, ixCredentialsOnConnection, ixAccountNameOnConnection } from "./connection-fiscal";

/**
 * The wizards post their InvoiceXpress credentials here now, instead of to the
 * account's legacy `integrations` row. Two properties carry the whole point:
 * a blank must never clear a live credential, and no read path may hand the
 * key back out.
 */
describe("ixCredentialPatchFrom", () => {
    it("takes what was stated", () => {
        expect(ixCredentialPatchFrom({
            ix_account_name: " bestisafil ", ix_api_key: " k_live ", ix_environment: "production",
        })).toEqual({ ix_account_name: "bestisafil", ix_api_key: "k_live", ix_environment: "production" });
    });

    it("treats a blank as unchanged, not as a clear", () => {
        // A form that rendered before its GET returned posts an empty key. On
        // the legacy route that stored NULL and locked the account out of
        // InvoiceXpress eleven minutes after the key had been validated.
        expect(ixCredentialPatchFrom({ ix_account_name: "conta", ix_api_key: "" }))
            .toEqual({ ix_account_name: "conta" });
        expect(ixCredentialPatchFrom({ ix_api_key: "   " })).toBeNull();
        expect(ixCredentialPatchFrom(undefined)).toBeNull();
    });

    it("ignores anything that is not a credential", () => {
        expect(ixCredentialPatchFrom({ ix_sequence_name: "FT2026", auto_finalize: true } as any)).toBeNull();
    });
});

describe("what a connection reports about its credentials", () => {
    const withBoth = JSON.stringify({ ix_account_name: "bestisafil", ix_api_key: "k_live", ix_sequence_name: "FT2026" });

    it("says whether both halves are there, never what they are", () => {
        expect(ixCredentialsOnConnection(withBoth)).toBe(true);
        expect(ixCredentialsOnConnection(JSON.stringify({ ix_account_name: "conta" }))).toBe(false);
        expect(ixCredentialsOnConnection(JSON.stringify({ ix_api_key: "k" }))).toBe(false);
        expect(ixCredentialsOnConnection(null)).toBe(false);
        expect(ixCredentialsOnConnection("nao é json")).toBe(false);
    });

    it("hands back the account name, which is not a secret", () => {
        expect(ixAccountNameOnConnection(withBoth)).toBe("bestisafil");
        expect(ixAccountNameOnConnection(JSON.stringify({ ix_account_name: "  " }))).toBeNull();
        expect(ixAccountNameOnConnection(null)).toBeNull();
    });
});
