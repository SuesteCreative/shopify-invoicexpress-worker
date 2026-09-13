import { describe, it, expect } from "vitest";
import {
    splitReferralToken, referralToken, referralLink, newReferralSuffix,
    claimRefusal, existingClaim, campaignOpen, CAMPAIGN_END, MAX_REWARDS, REWARD_MONTHS,
} from "./referral";

/**
 * The token is the customer number plus a suffix, and the customer number
 * carries a dash of its own. That is the trap this file guards: a naive split
 * on "-" gives three pieces, not two, and reading the wrong one turns every
 * invite link into "this invite does not exist" with nothing in any log.
 */

describe("the token", () => {
    it("is the customer number plus six hex", () => {
        expect(referralToken("RIO-1A2B3C", "9F2B41")).toBe("RIO-1A2B3C-9F2B41");
        expect(referralLink("RIO-1A2B3C-9F2B41")).toBe("https://rioko.online/pt/convite/RIO-1A2B3C-9F2B41");
    });

    it("opens in the sharer's language, with the same token", () => {
        expect(referralLink("RIO-1A2B3C-9F2B41", "en")).toBe("https://rioko.online/en/convite/RIO-1A2B3C-9F2B41");
    });

    it("splits the three segments back into two halves", () => {
        expect(splitReferralToken("RIO-1A2B3C-9F2B41")).toEqual({ code: "RIO-1A2B3C", suffix: "9F2B41" });
    });

    it("takes a link typed by a human", () => {
        // Lower case off a phone, spaces from a paste.
        expect(splitReferralToken("rio-1a2b3c-9f2b41")).toEqual({ code: "RIO-1A2B3C", suffix: "9F2B41" });
        expect(splitReferralToken("  RIO-1A2B3C-9F2B41  ")).toEqual({ code: "RIO-1A2B3C", suffix: "9F2B41" });
    });

    it("refuses anything that is not one", () => {
        expect(splitReferralToken("RIO-1A2B3C")).toBeNull();          // the number alone
        expect(splitReferralToken("RIO-1A2B3C-9F2B41-EXTRA")).toBeNull();
        expect(splitReferralToken("RIO-ZZZZZZ-9F2B41")).toBeNull();   // not hex
        expect(splitReferralToken("RIO-1A2B3C-9F2B4")).toBeNull();    // suffix too short
        expect(splitReferralToken("RIO-1A2B3C-9F2B4G")).toBeNull();   // suffix not hex
        expect(splitReferralToken(null)).toBeNull();
        expect(splitReferralToken(42)).toBeNull();
    });

    it("mints a suffix of the right shape, and not the same one twice", () => {
        const a = newReferralSuffix();
        expect(a).toMatch(/^[0-9A-F]{6}$/);
        const many = new Set(Array.from({ length: 200 }, () => newReferralSuffix()));
        expect(many.size).toBeGreaterThan(190); // 16.7M space; collisions here would be a broken mint
    });
});

describe("claimRefusal", () => {
    const now = new Date("2026-09-15T10:00:00.000Z");
    const ok = {
        token: "RIO-1A2B3C-9F2B41",
        inviterUserId: "user_a",
        inviterHasLiveSubscription: true,
        inviteeUserId: "user_b",
        inviteeCreatedAt: "2026-09-15T09:00:00.000Z",
        alreadyReferred: false,
        now,
    };

    it("lets a fresh account claim inside the campaign", () => {
        expect(claimRefusal(ok)).toBeNull();
    });

    it("refuses a token that is not one, a code nobody owns, and yourself", () => {
        expect(claimRefusal({ ...ok, token: "nope" })).toBe("invalid");
        expect(claimRefusal({ ...ok, inviterUserId: null })).toBe("unknown");
        expect(claimRefusal({ ...ok, inviteeUserId: "user_a" })).toBe("self");
    });

    it("refuses an account somebody else already invited", () => {
        expect(claimRefusal({ ...ok, alreadyReferred: true })).toBe("already");
    });

    it("tells a replay of the same link from a second person's link", () => {
        // The route used to answer ok to ANY token once a row existed, so the
        // second friend's link said "registado" and alreadyReferred was never true.
        expect(existingClaim(null, "user_a")).toBe("none");
        expect(existingClaim("user_a", "user_a")).toBe("same");
        expect(existingClaim("user_a", "user_c")).toBe("other");
        expect(claimRefusal({
            ...ok,
            inviterUserId: "user_c",
            alreadyReferred: existingClaim("user_a", "user_c") === "other",
        })).toBe("already");
    });

    it("still calls a dead link dead on an account that was already invited", () => {
        // A wrong suffix resolves to no inviter, which is "other" than the row's,
        // but the answer the visitor needs is that the link does not exist.
        expect(existingClaim("user_a", null)).toBe("other");
        expect(claimRefusal({ ...ok, inviterUserId: null, alreadyReferred: true })).toBe("unknown");
    });

    it("refuses when whoever invited has nothing to add two months to", () => {
        // The reward is months on a running subscription. Without one there is
        // no reward, and the invitee should be told before they set anything up.
        expect(claimRefusal({ ...ok, inviterHasLiveSubscription: false })).toBe("inviter_inactive");
    });

    it("closes the day after the campaign ends, and not before", () => {
        const lastDay = new Date(`${CAMPAIGN_END}T23:00:00.000Z`);
        const dayAfter = new Date("2026-11-01T00:01:00.000Z");
        expect(claimRefusal({ ...ok, now: lastDay, inviteeCreatedAt: lastDay.toISOString() })).toBeNull();
        expect(claimRefusal({ ...ok, now: dayAfter, inviteeCreatedAt: dayAfter.toISOString() })).toBe("closed");
        expect(campaignOpen(lastDay)).toBe(true);
        expect(campaignOpen(dayAfter)).toBe(false);
    });

    it("refuses an account that already pays us, however new", () => {
        // Clause 4: new customers only. Age alone let an account that subscribed
        // yesterday claim a link today and put a trial on its next connection.
        expect(claimRefusal({ ...ok, inviteeHasSubscription: true })).toBe("already_subscribed");
    });

    it("refuses an account that has been here too long to be a referral", () => {
        expect(claimRefusal({ ...ok, inviteeCreatedAt: "2026-08-01T10:00:00.000Z" })).toBe("not_new");
        // Both timestamp formats live in users.created_at.
        expect(claimRefusal({ ...ok, inviteeCreatedAt: "2026-09-14 08:00:00" })).toBeNull();
    });

    it("still applies the age rule before the D1 row exists", () => {
        // The Clerk webhook can land after the first claim. A null created_at
        // used to skip the rule, so an old Clerk account passed as new.
        const noRow = { ...ok, inviteeCreatedAt: null };
        expect(claimRefusal({ ...noRow, inviteeSignedUpAt: Date.parse("2026-08-01T10:00:00.000Z") })).toBe("not_new");
        expect(claimRefusal({ ...noRow, inviteeSignedUpAt: Date.parse("2026-09-15T09:00:00.000Z") })).toBeNull();
        // The D1 row wins when both are there.
        expect(claimRefusal({ ...ok, inviteeSignedUpAt: Date.parse("2026-08-01T10:00:00.000Z") })).toBeNull();
        // Nothing to prove the account is new: refused, never waved through.
        expect(claimRefusal(noRow)).toBe("not_new");
    });
});

describe("the promises the copy makes", () => {
    it("is two months, three times, six in total", () => {
        expect(REWARD_MONTHS).toBe(2);
        expect(MAX_REWARDS).toBe(3);
        expect(REWARD_MONTHS * MAX_REWARDS).toBe(6);
    });
});
