import { describe, it, expect } from "vitest";
import {
    isCampaignDismissed, rememberCampaignClose,
    CAMPAIGN_DISMISSED_KEY, CAMPAIGN_CLOSED_KEY,
} from "./campaign-dismissal";

/** A `localStorage` that is a plain object, so `Object.keys` sees the keys. */
function store() {
    const s: Record<string, string> = {};
    return Object.assign(s, {
        getItem: (k: string) => (k in s ? s[k] : null),
        setItem: (k: string, v: string) => { s[k] = v; },
        removeItem: (k: string) => { delete s[k]; },
    });
}

const USER = "user_2abc";
const S1 = "sess_one";
const S2 = "sess_two";

describe("closing without the tick", () => {
    it("silences it for this sign-in", () => {
        const s = store();
        rememberCampaignClose(s, USER, S1, false);
        expect(isCampaignDismissed(s, USER, S1)).toBe(true);
    });

    it("comes back on the next sign-in — the whole point", () => {
        const s = store();
        rememberCampaignClose(s, USER, S1, false);
        expect(isCampaignDismissed(s, USER, S2)).toBe(false);
    });

    it("never writes the permanent flag", () => {
        const s = store();
        rememberCampaignClose(s, USER, S1, false);
        expect(s[CAMPAIGN_DISMISSED_KEY + USER]).toBeUndefined();
    });

    it("leaves one key behind, not one per sign-in", () => {
        const s = store();
        rememberCampaignClose(s, USER, S1, false);
        rememberCampaignClose(s, USER, S2, false);
        expect(Object.keys(s).filter((k) => k.startsWith(CAMPAIGN_CLOSED_KEY))).toEqual([
            CAMPAIGN_CLOSED_KEY + S2,
        ]);
    });
});

describe("the tick", () => {
    it("silences it for good, on any sign-in", () => {
        const s = store();
        rememberCampaignClose(s, USER, S1, true);
        expect(isCampaignDismissed(s, USER, S2)).toBe(true);
    });

    it("is per user: the next account on this browser still sees it", () => {
        const s = store();
        rememberCampaignClose(s, USER, S1, true);
        expect(isCampaignDismissed(s, "user_other", S2)).toBe(false);
    });
});

describe("no session id", () => {
    it("cannot be silenced temporarily, so it shows", () => {
        const s = store();
        rememberCampaignClose(s, USER, null, false);
        expect(isCampaignDismissed(s, USER, null)).toBe(false);
    });

    it("can still be silenced for good", () => {
        const s = store();
        rememberCampaignClose(s, USER, null, true);
        expect(isCampaignDismissed(s, USER, null)).toBe(true);
    });
});
