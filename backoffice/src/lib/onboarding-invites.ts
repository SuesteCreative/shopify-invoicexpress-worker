// Relative, not aliased: this module is unit-tested, and the test runner at the
// repo root does not resolve the `@/` alias.
import { isDestinationKind, isSourceKind } from "./connection-kinds";
import { onboardingPath } from "./platforms";

/**
 * An onboarding link addressed to one client, with their subscription settled.
 *
 * The token reads `cakeartmagazine-4f7a1c9b2e05`: the company so support can say
 * it out loud, twelve hex characters so nobody can guess it. The name alone is
 * never the token — a link that grants a free connection to whoever spells the
 * company name is a hole, not a link.
 */

export interface OnboardingInvite {
    token: string;
    label: string;
    source_kind: string;
    destination_kind: string;
    stripe_subscription_id: string;
    from_connection_key: string | null;
    note: string | null;
    created_by: string;
    created_at: string;
    expires_at: string;
    claimed_by_user_id: string | null;
    claimed_at: string | null;
}

/** Company name → the readable half of a token. Never the whole token. */
export function slugify(label: string): string {
    const base = label
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32)
        .replace(/-+$/g, "");
    return base || "cliente";
}

export function newInviteToken(label: string): string {
    const secret = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    return `${slugify(label)}-${secret}`;
}

/** The shape the public route accepts, and nothing else. */
export const TOKEN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidToken(token: unknown): token is string {
    return typeof token === "string" && token.length >= 8 && token.length <= 64 && TOKEN_PATTERN.test(token);
}

/** Where an invite for this pair sends the client. Null when the pair has no guided page. */
export function invitePath(invite: { source_kind: string; destination_kind: string; token: string }): string | null {
    const base = onboardingPath(invite.source_kind, invite.destination_kind);
    return base ? `${base}/${invite.token}` : null;
}

export function isPairInvitable(source: unknown, destination: unknown): boolean {
    return isSourceKind(source) && isDestinationKind(destination) && onboardingPath(source, destination) !== null;
}

export type InviteRefusal = "not_found" | "expired" | "already_claimed";

/** Why this invite cannot be claimed, or null when it can. */
export function inviteRefusal(invite: OnboardingInvite | null, now: Date): InviteRefusal | null {
    if (!invite) return "not_found";
    if (invite.claimed_at) return "already_claimed";
    if (Date.parse(invite.expires_at) <= now.getTime()) return "expired";
    return null;
}
