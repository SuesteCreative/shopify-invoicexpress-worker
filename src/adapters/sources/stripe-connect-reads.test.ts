import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StripeSource } from "./stripe-source";
import type { AdapterCtx } from "../types";

/**
 * A Connect connection reads the merchant's objects with RIOKO's key. Stripe
 * only knows whose objects to return from the `Stripe-Account` header, and
 * answers "no such customer" without it — for a customer that plainly exists.
 *
 * That failure is silent by design here: every enrichment in `toNormalized`
 * swallows its errors so a lookup that fails still produces an invoice. The
 * invoice just comes out with no buyer name, no NIF, dated by the intent rather
 * than the payment, and — with `stripe_tax_from_source` on — at 0% VAT.
 *
 * So the header is the test. The restricted-key half asserts the opposite: those
 * connections never sent one and still must not.
 */

const source = new StripeSource();

const PAYMENT_INTENT_EVENT = {
    id: "evt_1",
    type: "payment_intent.succeeded",
    data: {
        object: {
            id: "pi_3TqCuoJNp2FcbLOX0A8rFYcV",
            object: "payment_intent",
            amount: 1500,
            currency: "eur",
            customer: "cus_123",
            created: 1_760_000_000,
            status: "succeeded",
        },
    },
};

function baseCtx(over: Partial<AdapterCtx>): AdapterCtx {
    return {
        apiKey: "unused",
        config: { user_id: "user_1" } as any,
        ...over,
    } as AdapterCtx;
}

/** Records every request so the assertions can read the headers back. */
function recordingFetch() {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const mock = vi.fn(async (url: any, init: any) => {
        calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
        // Enough of a Customer to satisfy the enrichment, and no tax_ids so the
        // rest of the method takes its shortest path.
        return new Response(JSON.stringify({ id: "cus_123", name: "Ana Silva", tax_ids: { data: [] } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    });
    return { calls, mock };
}

let calls: Array<{ url: string; headers: Record<string, string> }>;

beforeEach(() => {
    const r = recordingFetch();
    calls = r.calls;
    vi.stubGlobal("fetch", r.mock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("Stripe reads on a Connect connection", () => {
    it("scopes the Customer lookup to the merchant's account", async () => {
        await source.toNormalized(PAYMENT_INTENT_EVENT, baseCtx({
            stripeAuth: { apiKey: "sk_platform", connectAccount: "acct_merchant" },
            sourceConfig: { auth_mode: "connect", stripe_account_id: "acct_merchant" },
        }));

        const customerCall = calls.find((c) => c.url.includes("/v1/customers/"));
        expect(customerCall).toBeTruthy();
        expect(customerCall!.headers["Authorization"]).toBe("Bearer sk_platform");
        expect(customerCall!.headers["Stripe-Account"]).toBe("acct_merchant");
    });

    it("scopes the charge lookup too, which is where the payment date comes from", async () => {
        await source.toNormalized(PAYMENT_INTENT_EVENT, baseCtx({
            stripeAuth: { apiKey: "sk_platform", connectAccount: "acct_merchant" },
            sourceConfig: { auth_mode: "connect", stripe_account_id: "acct_merchant" },
        }));

        const piCall = calls.find((c) => c.url.includes("/v1/payment_intents/"));
        expect(piCall).toBeTruthy();
        expect(piCall!.headers["Stripe-Account"]).toBe("acct_merchant");
    });

    it("makes no Stripe call at all when the connection has no usable credential", async () => {
        // Half a Connect credential is not a credential: better a plainer invoice
        // than a burst of 401s per payment.
        const result = await source.toNormalized(PAYMENT_INTENT_EVENT, baseCtx({
            sourceConfig: { auth_mode: "connect", stripe_account_id: "acct_merchant" },
        }));

        expect(calls).toHaveLength(0);
        expect(result).toBeTruthy();
    });
});

describe("Stripe reads on a restricted-key connection", () => {
    it("uses the merchant's own key and sends NO account header", async () => {
        // These connections have never sent one. Adding it now would be a live
        // behaviour change for merchants nobody asked us to touch.
        await source.toNormalized(PAYMENT_INTENT_EVENT, baseCtx({
            sourceConfig: { restricted_key: "rk_merchant", stripe_account_id: "acct_merchant" },
        }));

        const customerCall = calls.find((c) => c.url.includes("/v1/customers/"));
        expect(customerCall).toBeTruthy();
        expect(customerCall!.headers["Authorization"]).toBe("Bearer rk_merchant");
        expect(customerCall!.headers["Stripe-Account"]).toBeUndefined();
    });

    it("still works when the ctx was hand-rolled without stripeAuth", async () => {
        // Several callers build a bare { apiKey, config } ctx and pass the config
        // blob straight through. They must keep working untouched.
        await source.toNormalized(PAYMENT_INTENT_EVENT, baseCtx({
            sourceConfig: { restricted_key: "rk_merchant" },
        }));

        expect(calls.some((c) => c.headers["Authorization"] === "Bearer rk_merchant")).toBe(true);
        expect(calls.every((c) => c.headers["Stripe-Account"] === undefined)).toBe(true);
    });
});
