import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { resolveAccountUser } from "@/lib/account";
import { getImpersonationId } from "@/lib/admin";
import { resolveClientCode } from "@/lib/client-code";
import { claimRefusal, existingClaim, splitReferralToken, REFUSAL_PT } from "@/lib/referral";

export const runtime = "edge";

/**
 * Claim a referral, once.
 *
 * The token is the authorisation, not an admin right — the same shape as the
 * onboarding invite. All it can do is record who invited whom; the money moves
 * later, when the invitee actually subscribes, and every rule is re-checked
 * there because the world moves between the two moments.
 *
 * The same link again answers ok, not an error: the landing and the layout both
 * claim, and a claim lost to the network is replayed on the next load, so a
 * repeat has to be quiet. A DIFFERENT link on an account that already has an
 * inviter is refused with 409: the first invite is the one that counts.
 */
export async function POST(request: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        // An admin looking at a client's dashboard must not be able to spend
        // that client's account on a referral. Reading is impersonation's job;
        // this writes.
        if (await getImpersonationId(request)) {
            return NextResponse.json({ error: "Não é possível resgatar um convite a impersonar." }, { status: 403 });
        }

        const body = await request.json().catch(() => ({})) as { token?: string };
        const token = String(body.token ?? "").trim();
        const parts = splitReferralToken(token);
        if (!parts) return NextResponse.json({ error: REFUSAL_PT.invalid, refusal: "invalid" }, { status: 400 });

        const db = (getRequestContext().env as any).DB as D1Database;
        const invitee = await resolveAccountUser(request, userId);

        const existing: any = await db.prepare(
            "SELECT inviter_user_id FROM referrals WHERE invitee_user_id = ?"
        ).bind(invitee).first();

        // The code half resolves through the customer-number resolver, which
        // already sends an invited seat to the account that owns it — so two
        // colleagues cannot produce two different inviters for one company.
        const resolved = await resolveClientCode(db, parts.code);
        const inviterRow: any = resolved?.accountId
            ? await db.prepare("SELECT id, referral_suffix FROM users WHERE id = ?").bind(resolved.accountId).first()
            : null;
        // The suffix is what makes the link unguessable. A right code with a
        // wrong suffix is indistinguishable from a code that does not exist.
        const inviterUserId = inviterRow?.referral_suffix === parts.suffix ? String(inviterRow.id) : null;

        // Checked before the rules, not through them: a replay of the link that
        // was recorded stays ok even after the account has subscribed or aged
        // past the window, which the rules would otherwise refuse.
        const prior = existingClaim(existing?.inviter_user_id, inviterUserId);
        if (prior === "same") return NextResponse.json({ ok: true, already: true });

        const live: any = inviterUserId
            ? await db.prepare(
                `SELECT 1 AS ok FROM subscriptions
                  WHERE user_id = ? AND stripe_subscription_id IS NOT NULL
                    AND status IN ('active','trialing') LIMIT 1`
            ).bind(inviterUserId).first()
            : null;

        const me: any = await db.prepare("SELECT created_at FROM users WHERE id = ?").bind(invitee).first();

        // Clause 4 of the terms: never had a subscription. Account age alone let
        // an account that registered on Monday and subscribed on Tuesday claim a
        // friend's link on Thursday, and put a trial on its next connection.
        const subscribed: any = await db.prepare(
            "SELECT 1 AS ok FROM subscriptions WHERE user_id = ? AND stripe_subscription_id IS NOT NULL LIMIT 1"
        ).bind(invitee).first();

        const refusal = claimRefusal({
            token,
            inviterUserId,
            inviterHasLiveSubscription: Boolean(live?.ok),
            inviteeUserId: invitee,
            inviteeCreatedAt: me?.created_at ?? null,
            alreadyReferred: prior === "other",
            inviteeHasSubscription: Boolean(subscribed?.ok),
            now: new Date(),
        });
        if (refusal) {
            // 409 for "already": the request is well formed, the account is taken.
            return NextResponse.json({ error: REFUSAL_PT[refusal], refusal }, { status: refusal === "already" ? 409 : 400 });
        }

        // OR IGNORE because two tabs can arrive at once; the read-back decides
        // what actually happened.
        await db.prepare(
            `INSERT OR IGNORE INTO referrals (invitee_user_id, inviter_user_id, inviter_client_code, state)
             VALUES (?, ?, ?, 'pending')`
        ).bind(invitee, inviterUserId, parts.code).run();

        const stored: any = await db.prepare(
            "SELECT inviter_user_id FROM referrals WHERE invitee_user_id = ?"
        ).bind(invitee).first();
        if (!stored) return NextResponse.json({ error: REFUSAL_PT.invalid, refusal: "invalid" }, { status: 400 });
        // Two tabs with two different links: the IGNORE kept the other one.
        if (String(stored.inviter_user_id) !== inviterUserId) {
            return NextResponse.json({ error: REFUSAL_PT.already, refusal: "already" }, { status: 409 });
        }

        console.warn(`[referral] ${invitee} claimed ${parts.code} from ${stored.inviter_user_id}`);
        // Nothing is granted here. The two free months are a Stripe trial on the
        // subscription they are about to create, and the inviter is paid when
        // that subscription exists.
        return NextResponse.json({ ok: true });
    } catch (error: any) {
        console.error("[referral/claim] failed:", error?.message ?? error);
        return NextResponse.json({ error: "claim_failed" }, { status: 500 });
    }
}
