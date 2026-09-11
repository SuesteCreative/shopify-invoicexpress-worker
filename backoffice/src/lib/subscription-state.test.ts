import { describe, it, expect } from "vitest";
import { earlyBirdState, isSubscriptionBlocked, subscriptionUIState } from "./subscription-state";

/**
 * `early_bird` records that the deal was GRANTED and is never turned off again.
 * It therefore survives the free window closing and survives the client
 * converting to a paying subscription, which is why twenty-two rows carry it
 * while six are an early bird in the sense anyone means when they say it.
 *
 * Each of the five shapes below exists in production right now.
 */

const future = new Date(Date.now() + 30 * 86400_000).toISOString();
const past = new Date(Date.now() - 30 * 86400_000).toISOString();

const row = (over: Record<string, unknown>) => ({
    user_id: "user_a",
    connection_key: "shopify:invoicexpress",
    stripe_customer_id: null,
    stripe_subscription_id: null,
    status: "trialing",
    plan: null,
    price_id: null,
    current_period_end: null,
    trial_end: null,
    cancel_at_period_end: 0,
    early_bird: 1,
    ...over,
} as any);

describe("what the early-bird flag means today", () => {
    it("is nothing at all when the deal was never granted", () => {
        expect(earlyBirdState(row({ early_bird: 0 }))).toBe("none");
        expect(earlyBirdState(null)).toBe("none");
    });

    it("is running while the window is open and no one is being charged", () => {
        // Six rows. The only ones the word should be used for.
        expect(earlyBirdState(row({ status: "trialing", trial_end: future }))).toBe("running");
    });

    it("is converted once they pay, flag or no flag", () => {
        // Nine rows: active with a Stripe subscription behind them. The window
        // may have closed long ago, or never had a date at all.
        expect(earlyBirdState(row({ status: "active", stripe_subscription_id: "sub_1", trial_end: past }))).toBe("converted");
        expect(earlyBirdState(row({ status: "active", stripe_subscription_id: "sub_1", trial_end: null }))).toBe("converted");
        // Converting before the window ran out counts too.
        expect(earlyBirdState(row({ status: "active", stripe_subscription_id: "sub_1", trial_end: future }))).toBe("converted");
    });

    it("is expired when the window closed and nobody subscribed", () => {
        // Seven rows, and the gate is already refusing them — this only names
        // the state the gate reached.
        expect(earlyBirdState(row({ status: "trialing", trial_end: past }))).toBe("expired");
    });

    it("is expired with no date either, which grants nothing", () => {
        expect(earlyBirdState(row({ status: "trialing", trial_end: null }))).toBe("expired");
    });

    it("counts a Stripe trial as converted — Stripe is billing them", () => {
        expect(earlyBirdState(row({ status: "trialing", stripe_subscription_id: "sub_1" }))).toBe("converted");
    });

    it("never says running for a cancelled subscription", () => {
        expect(earlyBirdState(row({ status: "canceled", trial_end: future }))).toBe("expired");
    });
});

/**
 * The gate itself, which decides whether a merchant's documents get issued at
 * all. It had no test until this file, because it lived in a module that
 * cannot be imported outside a request.
 */
describe("the subscription gate", () => {
    it("blocks a connection nobody pays for", () => {
        // Not a technicality: migration 0044 exists to make this state visible,
        // and "any subscription on the account" was the bug it replaced.
        expect(isSubscriptionBlocked(null)).toBe(true);
        expect(isSubscriptionBlocked(undefined)).toBe(true);
    });

    it("blocks every dead status", () => {
        for (const status of ["canceled", "unpaid", "incomplete_expired", "past_due", "incomplete"]) {
            expect(isSubscriptionBlocked(row({ status }))).toBe(true);
        }
    });

    it("lets an active subscription through", () => {
        expect(isSubscriptionBlocked(row({ status: "active" }))).toBe(false);
    });

    it("lets a trial Stripe is billing through", () => {
        expect(isSubscriptionBlocked(row({ status: "trialing", stripe_subscription_id: "sub_1" }))).toBe(false);
    });

    it("lets an early bird through only while the window is open", () => {
        expect(isSubscriptionBlocked(row({ status: "trialing", early_bird: 1, trial_end: future }))).toBe(false);
        expect(isSubscriptionBlocked(row({ status: "trialing", early_bird: 1, trial_end: past }))).toBe(true);
    });

    it("blocks a trial that is not an early bird, however fresh", () => {
        // Free access is granted by the flag, not by the status: a trialing row
        // with no deal behind it must pay.
        expect(isSubscriptionBlocked(row({ status: "trialing", early_bird: 0, trial_end: future }))).toBe(true);
    });

    it("exempts an admin account", () => {
        expect(isSubscriptionBlocked(row({ status: "exempt" }))).toBe(false);
        expect(subscriptionUIState(row({ status: "exempt" }))).toBe("exempt");
    });

    it("agrees with the badge in every case", () => {
        // The card an operator reads must never say a shop is fine while the
        // pipeline is refusing its documents.
        const cases = [
            row({ status: "active" }),
            row({ status: "canceled" }),
            row({ status: "trialing", early_bird: 1, trial_end: future }),
            row({ status: "trialing", early_bird: 1, trial_end: past }),
            row({ status: "trialing", stripe_subscription_id: "sub_1" }),
            row({ status: "exempt" }),
        ];
        for (const c of cases) {
            const blocked = isSubscriptionBlocked(c);
            const badge = subscriptionUIState(c);
            expect(badge === "blocked").toBe(blocked);
        }
    });
});
