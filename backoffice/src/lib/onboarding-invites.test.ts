import { describe, it, expect } from "vitest";
import { inviteRefusal, isValidToken, newInviteToken, slugify, type OnboardingInvite } from "./onboarding-invites";

const base: OnboardingInvite = {
    token: "cakeartmagazine-4f7a1c9b2e05",
    label: "Cake Art Magazine",
    source_kind: "lodgify",
    destination_kind: "moloni",
    stripe_subscription_id: "sub_123",
    from_connection_key: null,
    note: null,
    created_by: "user_admin",
    created_at: "2026-09-11 10:00:00",
    expires_at: "2026-10-11T10:00:00.000Z",
    claimed_by_user_id: null,
    claimed_at: null,
};

describe("onboarding invite tokens", () => {
    it("keeps the company readable and adds a secret", () => {
        const token = newInviteToken("Cake Art Magazine");
        expect(token.startsWith("cake-art-magazine-")).toBe(true);
        // Twelve hex characters. The name is for people, this is the part that
        // stops someone typing a company name into the address bar and getting
        // a free connection.
        expect(token.slice("cake-art-magazine-".length)).toMatch(/^[0-9a-f]{12}$/);
    });

    it("survives accents, punctuation and nothing at all", () => {
        expect(slugify("Pão de Ló, Lda.")).toBe("pao-de-lo-lda");
        expect(slugify("  ---  ")).toBe("cliente");
        expect(slugify("A".repeat(80)).length).toBeLessThanOrEqual(32);
    });

    it("accepts only the shape the public route serves", () => {
        expect(isValidToken("cakeartmagazine-4f7a1c9b2e05")).toBe(true);
        expect(isValidToken("Cake-4f7a1c9b2e05")).toBe(false);
        expect(isValidToken("../../etc/passwd")).toBe(false);
        expect(isValidToken("curto")).toBe(false);
        expect(isValidToken(undefined)).toBe(false);
    });
});

describe("claiming", () => {
    const now = new Date("2026-09-20T00:00:00.000Z");

    it("lets a live invite through", () => {
        expect(inviteRefusal(base, now)).toBeNull();
    });

    it("refuses one that was already used", () => {
        expect(inviteRefusal({ ...base, claimed_at: "2026-09-12 09:00:00", claimed_by_user_id: "user_x" }, now))
            .toBe("already_claimed");
    });

    it("refuses one past its date", () => {
        expect(inviteRefusal({ ...base, expires_at: "2026-09-19T23:59:59.000Z" }, now)).toBe("expired");
    });

    it("refuses a token nobody issued", () => {
        expect(inviteRefusal(null, now)).toBe("not_found");
    });
});
