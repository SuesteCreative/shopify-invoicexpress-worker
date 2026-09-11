// Relative, not "@/lib/config": the whole module chain then resolves without a
// bundler alias, which is what lets the test next door run under plain vitest.
import { RIOKO_CONFIG } from "./config";

/**
 * The Shopify OAuth round trip, in one place.
 *
 * The manual onboarding registers `https://example.com/` as the app's redirect
 * URL, so the authorisation code lands in the merchant's address bar and is
 * copied out by hand, traded for a token with a `curl` they paste, and the four
 * webhooks are then created by hand in Settings -> Notifications. Point the
 * redirect at a route of ours instead and all four of those steps disappear:
 * the code reaches the server, the exchange happens here, and the webhooks are
 * created through the Admin API in the same request.
 *
 * The reason that last part is safe NOW and was not before: a webhook created
 * through the Admin API belongs to the APP, and Shopify signs it with the app's
 * client secret rather than with the store's signing secret. When the code was
 * copied by hand we never saw that secret, so every delivery from an
 * API-created subscription failed verification — roughly 6,500 incidents across
 * two stores in 2026-05, documented in api/integrations/activate/route.ts.
 * Here the merchant hands us the client secret because the exchange cannot
 * happen without it, so we can store it as the store's webhook secret and the
 * worker verifies those deliveries with no change whatsoever.
 */

export const SHOPIFY_CALLBACK_PATH = "/api/shopify/oauth/callback";

/** The one URL a merchant registers in their Shopify app. Never derived from
 *  the request host: a preview deployment's URL would not match what Shopify
 *  has registered, and the consent screen would refuse before it appeared. */
export function shopifyCallbackUri(): string {
    return `${RIOKO_CONFIG.appUrl}${SHOPIFY_CALLBACK_PATH}`;
}

/**
 * What we ask for at install.
 *
 * `read_all_orders` is NOT here, and its absence is deliberate. Shopify gates it
 * behind an approval — the Dev Dashboard refuses to accept it in a version and
 * answers "Contains invalid scopes" until the app has been granted it through
 * Request access — so an authorize URL asking for it on an unapproved app fails
 * before the consent screen. Everything the live pipeline needs works without
 * it: webhooks deliver their own payload, and `read_orders` reads back the last
 * 60 days.
 *
 * What it costs until it is granted: the Admin API hides orders OLDER than 60
 * days, so the reconciliation sweep and any backlog re-issue see nothing beyond
 * that window. The worker already names this exact cause when an order cannot
 * be found (src/services/shopify-orders.ts).
 */
export const SHOPIFY_SCOPES = "read_customers,read_discounts,read_order_edits,read_orders,read_products";

/** Granted per app by Shopify, never typed in blind. Appended to the scopes of
 *  an app that has the approval — see the builder in the onboarding helper. */
export const SHOPIFY_SCOPE_OLD_ORDERS = "read_all_orders";

/** REST version used by this flow. Keep on a SUPPORTED version (review yearly):
 *  a retired one answers 404 {"errors":"Not Found"} even with a valid token. */
export const SHOPIFY_API_VERSION = "2026-04";

export const SHOPIFY_WEBHOOK_BASE = `${RIOKO_CONFIG.workerUrl}/webhooks/shopify`;

/** The four subscriptions, each against the worker route that handles it. */
export const SHOPIFY_WEBHOOKS = [
    { topic: "orders/create", key: "orders-created", pt: "Criação de encomenda" },
    { topic: "orders/updated", key: "orders-updated", pt: "Atualização de encomenda" },
    { topic: "orders/paid", key: "orders-paid", pt: "Pagamento de encomenda" },
    { topic: "refunds/create", key: "refunds-create", pt: "Criação de reembolso" },
] as const;

export function webhookAddress(key: string): string {
    return `${SHOPIFY_WEBHOOK_BASE}/${key}`;
}

/** `https://x.myshopify.com/admin/settings` and friends down to `x.myshopify.com`. */
export function cleanShopDomain(raw: string): string {
    if (!raw) return "";
    return raw
        .trim()
        .replace(/^https?:\/\//i, "")
        .replace(/\/admin.*$/i, "")
        .replace(/\/+$/, "");
}

export function buildAuthorizeUrl(shop: string, clientId: string, state: string): string {
    const url = new URL(`https://${cleanShopDomain(shop)}/admin/oauth/authorize`);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("scope", SHOPIFY_SCOPES);
    url.searchParams.set("redirect_uri", shopifyCallbackUri());
    url.searchParams.set("state", state);
    return url.toString();
}

/**
 * Shopify signs the redirect's query string with the app's client secret.
 *
 * A second lock on top of `state`: the state proves the round trip is one we
 * started, this proves the parameters carrying it were not edited on the way
 * back. Built with encodeURIComponent over the sorted pairs, which is the
 * algorithm Shopify documents; none of the parameters they send can contain a
 * space, which is the only place the encodings would disagree.
 */
export async function verifyCallbackHmac(params: URLSearchParams, clientSecret: string): Promise<boolean> {
    const received = params.get("hmac");
    if (!received || !clientSecret) return false;

    const message = [...params.entries()]
        .filter(([key]) => key !== "hmac" && key !== "signature")
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&");

    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(clientSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
    const expected = [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, "0")).join("");

    // Constant-time-ish, same shape as isValidOAuthState.
    if (expected.length !== received.length) return false;
    let diff = 0;
    const lower = received.toLowerCase();
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ lower.charCodeAt(i);
    return diff === 0;
}

export type ExchangeResult =
    | { ok: true; accessToken: string; scope: string }
    | { ok: false; detail: string };

export async function exchangeCode(
    shop: string,
    clientId: string,
    clientSecret: string,
    code: string,
): Promise<ExchangeResult> {
    let body: any;
    try {
        const res = await fetch(`https://${cleanShopDomain(shop)}/admin/oauth/access_token`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
            },
            body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code }).toString(),
        });
        const text = await res.text();
        try { body = JSON.parse(text); } catch { body = null; }
        if (!res.ok) {
            return { ok: false, detail: String(body?.error_description ?? body?.error ?? `Shopify ${res.status}`) };
        }
    } catch (e: any) {
        return { ok: false, detail: `Não foi possível falar com a Shopify: ${e?.message ?? e}` };
    }

    const accessToken = body?.access_token;
    if (!accessToken) return { ok: false, detail: "A Shopify não devolveu um access token." };
    return { ok: true, accessToken, scope: String(body?.scope ?? "") };
}

export type InstallResult = {
    created: string[];
    existing: string[];
    failed: { topic: string; detail: string }[];
};

/**
 * The four subscriptions, through REST.
 *
 * REST and not GraphQL because there is not one GraphQL call in this codebase,
 * and REST is the path that demonstrably created subscriptions on real stores.
 *
 * Reads what is already there first and skips those topics, so running this
 * twice cannot produce a second set. An app sees its own subscriptions through
 * this endpoint — what it does NOT see are the store-owned ones created by hand
 * in Settings -> Notifications, which is why an empty list here is not proof
 * that a store has no webhooks, and why the start route refuses outright on any
 * row that looks like it is already on the manual flow.
 */
export async function installWebhooks(
    shop: string,
    accessToken: string,
    apiVersion: string = SHOPIFY_API_VERSION,
): Promise<InstallResult> {
    const domain = cleanShopDomain(shop);
    const base = `https://${domain}/admin/api/${apiVersion}`;
    const headers = { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" };
    const result: InstallResult = { created: [], existing: [], failed: [] };

    let present: { topic: string; address: string }[] = [];
    try {
        const res = await fetch(`${base}/webhooks.json`, { headers });
        if (res.ok) {
            const body: any = await res.json();
            present = (body?.webhooks ?? []).map((w: any) => ({ topic: String(w?.topic ?? ""), address: String(w?.address ?? "") }));
        }
    } catch {
        // Unreadable list is not fatal: creating a duplicate topic is refused by
        // Shopify anyway, and that refusal is reported per topic below.
    }

    for (const hook of SHOPIFY_WEBHOOKS) {
        const address = webhookAddress(hook.key);
        if (present.some(w => w.topic === hook.topic && w.address === address)) {
            result.existing.push(hook.topic);
            continue;
        }
        try {
            const res = await fetch(`${base}/webhooks.json`, {
                method: "POST",
                headers,
                body: JSON.stringify({ webhook: { topic: hook.topic, address, format: "json" } }),
            });
            const body: any = await res.json().catch(() => null);
            if (res.ok && body?.webhook?.id) {
                result.created.push(hook.topic);
            } else {
                const errors = body?.errors;
                result.failed.push({
                    topic: hook.topic,
                    detail: typeof errors === "string" ? errors : JSON.stringify(errors ?? `Shopify ${res.status}`),
                });
            }
        } catch (e: any) {
            result.failed.push({ topic: hook.topic, detail: String(e?.message ?? e) });
        }
    }

    return result;
}
