import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { stashInvite, readInvite, clearInvite } from "./invite-storage";

/**
 * The referral token has to outlive the tab that saw the link, and nothing
 * else about the onboarding invite may change. The failure this guards was
 * silent: sign-up finished in a second tab, the token was not there, and the
 * friend paid full price.
 */

const KEY = "rioko_referral_code";
const TOKEN = "RIO-1A2B3C-9F2B41";

function storage() {
    const m = new Map<string, string>();
    return {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => void m.set(k, String(v)),
        removeItem: (k: string) => void m.delete(k),
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T10:00:00.000Z"));
    vi.stubGlobal("window", { localStorage: storage(), sessionStorage: storage() });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("the stashed invite", () => {
    it("reaches another tab, and expires with the window", () => {
        stashInvite(KEY, TOKEN, 7);
        (window as any).sessionStorage = storage(); // a new tab: same localStorage, empty session
        expect(readInvite(KEY)).toBe(TOKEN);

        vi.setSystemTime(new Date("2026-09-22T10:00:01.000Z"));
        expect(readInvite(KEY)).toBeUndefined();
        expect(window.localStorage.getItem(KEY)).toBeNull();
    });

    it("still reads a token stashed in the tab before the move, and clears both", () => {
        window.sessionStorage.setItem(KEY, TOKEN);
        expect(readInvite(KEY)).toBe(TOKEN);
        clearInvite(KEY);
        expect(readInvite(KEY)).toBeUndefined();
    });

    it("leaves the onboarding invite in the tab when no expiry is asked for", () => {
        stashInvite("rioko_onboarding_invite", "inv_abc");
        expect(window.localStorage.getItem("rioko_onboarding_invite")).toBeNull();
        expect(window.sessionStorage.getItem("rioko_onboarding_invite")).toBe("inv_abc");
    });
});
