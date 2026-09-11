import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getDB, getStripe } from "@/lib/stripe";
import { resolveAccountUser } from "@/lib/account";
import { linkSubscriptionToConnection } from "@/lib/link-subscription";
import { inviteRefusal, isValidToken, type OnboardingInvite } from "@/lib/onboarding-invites";

export const runtime = "edge";

/**
 * The client end of an onboarding invite.
 *
 * Called by the onboarding page as soon as there is a session — which is the
 * only moment this can run at all, because until then there is no account to
 * attach a subscription to. It moves the subscription named in the invite onto
 * the pair the invite is for, so the last step of the onboarding reads "already
 * covered" instead of asking for a card.
 *
 * Not an admin route: the token IS the authorisation, and it was handed to this
 * client by someone who is an admin. Single use, and it dies on its date.
 */
export async function POST(req: NextRequest) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as { token?: string };
    if (!isValidToken(body.token)) {
        return NextResponse.json({ error: "invalid_token" }, { status: 400 });
    }
    const token = body.token;

    const db = getDB();
    // An admin filling this in while impersonating must land it on the client's
    // account, exactly like the profile write does.
    const targetUserId = await resolveAccountUser(req, userId);

    const invite = (await db
        .prepare("SELECT * FROM onboarding_invites WHERE token = ?")
        .bind(token)
        .first()
        .catch(() => null)) as OnboardingInvite | null;

    // Already claimed by THIS account is a success, not a refusal: the page
    // calls this on every load until the subscription reads active, and a
    // reload must not read as an error.
    if (invite?.claimed_by_user_id === targetUserId) {
        return NextResponse.json({ ok: true, already: true, connection_key: `${invite.source_kind}:${invite.destination_kind}` });
    }

    const refusal = inviteRefusal(invite, new Date());
    if (refusal || !invite) return NextResponse.json({ error: refusal ?? "not_found" }, { status: 404 });

    const connectionKey = `${invite.source_kind}:${invite.destination_kind}`;

    const stripe = getStripe();
    let sub: any;
    try {
        sub = await stripe.subscriptions.retrieve(invite.stripe_subscription_id, {
            expand: ["customer", "latest_invoice.payment_intent"],
        });
    } catch (e: any) {
        console.error("[invite/claim] stripe retrieve failed", e?.message ?? e);
        return NextResponse.json({ error: "subscription_unavailable" }, { status: 502 });
    }

    await linkSubscriptionToConnection({ db, stripe, userId: targetUserId, sub, connectionKey });

    // Every other row this subscription used to pay for is now unreachable by
    // webhook: the metadata points here. Left alone it would stay `active` for
    // ever and keep its gate open through a cancellation — and it can belong to
    // another account, when the client signs up afresh instead of reusing the
    // one they had.
    const retired = await db
        .prepare(
            `UPDATE subscriptions
                SET status = 'canceled', updated_at = CURRENT_TIMESTAMP
              WHERE stripe_subscription_id = ?
                AND NOT (user_id = ? AND connection_key = ?)`
        )
        .bind(invite.stripe_subscription_id, targetUserId, connectionKey)
        .run()
        .catch(() => null);

    await db
        .prepare(
            `UPDATE onboarding_invites
                SET claimed_by_user_id = ?, claimed_at = CURRENT_TIMESTAMP
              WHERE token = ? AND claimed_at IS NULL`
        )
        .bind(targetUserId, token)
        .run();

    return NextResponse.json({
        ok: true,
        connection_key: connectionKey,
        retired_rows: (retired as any)?.meta?.changes ?? 0,
    });
}
