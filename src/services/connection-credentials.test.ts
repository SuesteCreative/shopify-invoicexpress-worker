import { describe, it, expect } from "vitest";
import { projectConnectionBehaviour, synthLegacyConfig } from "./connection-context";
import { missingDestinationCredential } from "./connection-health";

/**
 * InvoiceXpress credentials used to live ONLY on the account's legacy
 * `integrations` row, which is Shopify's row. A Stripe→IX or Lodgify→IX account
 * therefore grew a row purely to hold a credential, the admin console drew that
 * row as a broken "Shopify → InvoiceXpress" pipe, and deleting the pipe that did
 * not exist destroyed the credential that did. MeetFrank lost its invoicing to
 * that twice in two days.
 *
 * A connection can now carry its own. What these hold to is the fallback: every
 * account configured before this keeps working, and Shopify is untouched.
 */
describe("projectConnectionBehaviour — InvoiceXpress credentials", () => {
    const legacy = () => ({
        ...synthLegacyConfig("user_a"),
        ix_account_name: "conta-partilhada",
        ix_api_key: "chave-partilhada",
        ix_environment: "production",
    }) as any;

    it("prefers the connection's own credentials", () => {
        const c = projectConnectionBehaviour(legacy(), {
            ix_account_name: "conta-da-ligacao",
            ix_api_key: "chave-da-ligacao",
            ix_environment: "sandbox",
        }, "stripe") as any;
        expect(c.ix_account_name).toBe("conta-da-ligacao");
        expect(c.ix_api_key).toBe("chave-da-ligacao");
        expect(c.ix_environment).toBe("sandbox");
    });

    it("falls back to the legacy row when the connection states nothing", () => {
        const c = projectConnectionBehaviour(legacy(), { ix_sequence_name: "FT2026" }, "stripe") as any;
        expect(c.ix_account_name).toBe("conta-partilhada");
        expect(c.ix_api_key).toBe("chave-partilhada");
    });

    it("takes neither half on its own", () => {
        // Pairing this connection's account name with another integration's key
        // authenticates against the wrong account, or nothing at all.
        const onlyName = projectConnectionBehaviour(legacy(), { ix_account_name: "conta-da-ligacao" }, "stripe") as any;
        expect(onlyName.ix_account_name).toBe("conta-partilhada");
        const onlyKey = projectConnectionBehaviour(legacy(), { ix_api_key: "chave-da-ligacao" }, "stripe") as any;
        expect(onlyKey.ix_api_key).toBe("chave-partilhada");
    });

    it("leaves Shopify on the row that is its own", () => {
        const c = projectConnectionBehaviour(legacy(), {}, "shopify") as any;
        expect(c.ix_account_name).toBe("conta-partilhada");
    });

    it("blank is not a credential", () => {
        const c = projectConnectionBehaviour(legacy(), { ix_account_name: "  ", ix_api_key: "  " }, "stripe") as any;
        expect(c.ix_account_name).toBe("conta-partilhada");
    });
});

describe("the health check reads the same two places, in the same order", () => {
    it("passes a connection that carries its own credentials and has no legacy row", () => {
        expect(missingDestinationCredential(
            "invoicexpress",
            { ix_account_name: "conta", ix_api_key: "chave" },
            null,
        )).toBeNull();
    });

    it("still faults a connection with neither", () => {
        expect(missingDestinationCredential("invoicexpress", { ix_account_name: "conta" }, null))
            .toMatch(/InvoiceXpress/);
    });
});
