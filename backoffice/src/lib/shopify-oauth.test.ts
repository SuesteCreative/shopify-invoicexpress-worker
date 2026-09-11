import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { buildAuthorizeUrl, cleanShopDomain, shopifyCallbackUri, verifyCallbackHmac, SHOPIFY_SCOPES } from "./shopify-oauth";

/**
 * The callback is a public route: the HMAC is the only thing standing between
 * Shopify's redirect and anyone who can guess a URL, so the property worth
 * pinning is the exact string that gets signed. The expected digest is computed
 * with node's crypto over a message written out by hand — an independent
 * implementation against a canonical form we state rather than derive, so a
 * change to the sorting or the encoding fails here instead of in production,
 * where it would read as "assinatura inválida" on every install.
 */

const SECRET = "shpss_pretend_client_secret";
const CANONICAL = "code=abc123&shop=demo-store.myshopify.com&state=bf1c0f6a&timestamp=1757600000";

function sign(message: string, secret = SECRET) {
    return createHmac("sha256", secret).update(message).digest("hex");
}

/** The same four parameters, deliberately NOT in alphabetical order. */
function callbackParams(overrides: Record<string, string> = {}) {
    const params = new URLSearchParams({
        state: "bf1c0f6a",
        code: "abc123",
        timestamp: "1757600000",
        shop: "demo-store.myshopify.com",
        ...overrides,
    });
    return params;
}

describe("verifyCallbackHmac", () => {
    it("accepts the digest Shopify would send, whatever order the params arrive in", async () => {
        const params = callbackParams();
        params.set("hmac", sign(CANONICAL));
        expect(await verifyCallbackHmac(params, SECRET)).toBe(true);
    });

    it("rejects a parameter edited on the way back", async () => {
        const params = callbackParams();
        params.set("hmac", sign(CANONICAL));
        params.set("shop", "attacker-store.myshopify.com");
        expect(await verifyCallbackHmac(params, SECRET)).toBe(false);
    });

    it("rejects the right digest under the wrong secret", async () => {
        const params = callbackParams();
        params.set("hmac", sign(CANONICAL));
        expect(await verifyCallbackHmac(params, "shpss_some_other_app")).toBe(false);
    });

    it("rejects a missing hmac rather than treating absence as a pass", async () => {
        expect(await verifyCallbackHmac(callbackParams(), SECRET)).toBe(false);
    });
});

describe("buildAuthorizeUrl", () => {
    it("asks for the scopes we use and sends the code to our own callback", () => {
        const url = new URL(buildAuthorizeUrl("demo-store.myshopify.com", "client-id-123", "state-abc"));
        expect(url.origin + url.pathname).toBe("https://demo-store.myshopify.com/admin/oauth/authorize");
        expect(url.searchParams.get("scope")).toBe(SHOPIFY_SCOPES);
        expect(url.searchParams.get("client_id")).toBe("client-id-123");
        expect(url.searchParams.get("state")).toBe("state-abc");
        // The whole point of Método 2: not example.com.
        expect(url.searchParams.get("redirect_uri")).toBe(shopifyCallbackUri());
        expect(shopifyCallbackUri()).toBe("https://rioko.online/api/shopify/oauth/callback");
    });

    it("leaves read_all_orders out, because asking for it unapproved fails the install", () => {
        // Shopify gates it behind Request access and the Dev Dashboard refuses a
        // version containing it, so an authorize URL asking for it never reaches
        // a consent screen. Re-adding it here would break every new onboarding.
        expect(SHOPIFY_SCOPES).not.toContain("read_all_orders");
        expect(SHOPIFY_SCOPES).toContain("read_orders");
    });

    it("takes whatever the operator pasted", () => {
        expect(cleanShopDomain("https://demo-store.myshopify.com/admin/settings/general"))
            .toBe("demo-store.myshopify.com");
        expect(cleanShopDomain("  demo-store.myshopify.com/  ")).toBe("demo-store.myshopify.com");
        const url = new URL(buildAuthorizeUrl("https://demo-store.myshopify.com/admin", "id", "st"));
        expect(url.hostname).toBe("demo-store.myshopify.com");
    });
});
