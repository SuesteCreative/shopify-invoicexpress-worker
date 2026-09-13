import { describe, it, expect } from "vitest";
import { rewardRunning, subscriptionUIState, isSubscriptionBlocked } from "./subscription-state";

/**
 * rewardRunning() answers the only question a referral reward changes: which
 * WORDS to put on a paying trial. It must never change the state every other
 * caller switches on — that is what broke, for one release, when "reward" was a
 * member of the state union.
 */

const DAY = 86_400_000;
const future = new Date(Date.now() + 30 * DAY).toISOString();
const past = new Date(Date.now() - 30 * DAY).toISOString();

const row = (over: Record<string, unknown>) => ({
    status: "trialing",
    stripe_subscription_id: "sub_1",
    trial_end: null,
    early_bird: 0,
    reward_until: null,
    ...over,
}) as any;

describe("rewardRunning", () => {
    it("is true for a paying trial whose reward has not run out", () => {
        expect(rewardRunning(row({ reward_until: future }))).toBe(true);
    });

    it("goes false once the reward date passes, so the label returns to trial", () => {
        expect(rewardRunning(row({ reward_until: past }))).toBe(false);
    });

    it("is false for a trial that carries no reward at all", () => {
        expect(rewardRunning(row({}))).toBe(false);
    });

    it("never labels a dead or unpaid row as a reward", () => {
        // The column says why a trial is happening; it grants nothing.
        expect(rewardRunning(row({ status: "canceled", reward_until: future }))).toBe(false);
        expect(rewardRunning(row({ status: "past_due", reward_until: future }))).toBe(false);
        expect(rewardRunning(row({ stripe_subscription_id: null, reward_until: future }))).toBe(false);
        expect(rewardRunning(null)).toBe(false);
    });

    it("leaves the state alone: a reward is still trialing and still not blocked", () => {
        const r = row({ reward_until: future });
        expect(rewardRunning(r)).toBe(true);
        expect(subscriptionUIState(r)).toBe("trialing");
        expect(isSubscriptionBlocked(r)).toBe(false);
    });
});
