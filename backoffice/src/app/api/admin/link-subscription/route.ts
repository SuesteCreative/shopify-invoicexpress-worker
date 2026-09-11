import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getStripe, getDB } from "@/lib/stripe";
import { isAdmin } from "@/lib/admin";
import { primaryConnectionKey, listAccountConnections } from "@/lib/stripe";
import { keyFromRequest } from "@/lib/subscription-key";
import { linkSubscriptionToConnection } from "@/lib/link-subscription";

export const runtime = "edge";

/**
 * Admin: manually associate an existing Stripe subscription (e.g. one created via
 * a Payment Link, which carries no user_id metadata) with a Rioko account. Stamps
 * metadata.user_id so future webhooks resolve, upserts the local subscription row,
 * releases any paused connection, and records the latest paid invoice + matches it
 * to the Kapta IX invoice so the payment shows in the account's billing history.
 */
export async function POST(req: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId || !(await isAdmin(userId))) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        }

        const body = (await req.json().catch(() => ({}))) as { user_id?: string; subscription_id?: string; connection_key?: string };
        const targetUserId = body.user_id?.trim();
        const subscriptionId = body.subscription_id?.trim();
        if (!targetUserId || !subscriptionId) {
            return NextResponse.json({ error: "user_id and subscription_id are required" }, { status: 400 });
        }
        if (!subscriptionId.startsWith("sub_")) {
            return NextResponse.json({ error: "subscription_id must be a Stripe subscription id (sub_…)" }, { status: 400 });
        }

        const stripe = getStripe();
        const db = getDB();

        let sub: any;
        try {
            sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["customer", "latest_invoice.payment_intent"] });
        } catch (e: any) {
            return NextResponse.json({ error: `Stripe subscription not found: ${e.message}` }, { status: 404 });
        }

        // Which connection this Stripe subscription pays for (0044). An admin
        // naming one by hand wins. The subscription's own metadata is trusted
        // only when it names a connection the account actually HAS: a checkout
        // started from a generic page used to stamp `shopify:invoicexpress` on
        // every account, so linking by metadata alone filed the payment against
        // a connection that does not exist and left the real one reading
        // "inactive" (Farracemota, 10/09/2026).
        const accountKeys = (await listAccountConnections(db, targetUserId)).map((c) => c.key);
        const metaKey = sub.metadata?.connection_key ? keyFromRequest(sub.metadata.connection_key as string, null) : null;
        const connectionKey = body.connection_key
            ? keyFromRequest(body.connection_key, null)
            : metaKey && accountKeys.includes(metaKey)
                ? metaKey
                : await primaryConnectionKey(db, targetUserId);

        // The work itself lives in lib/link-subscription, because the onboarding
        // invite does exactly this, decided in advance.
        const result = await linkSubscriptionToConnection({ db, stripe, userId: targetUserId, sub, connectionKey });

        return NextResponse.json({
            ...result,
            connection_key: connectionKey,
            subscription: {
                ...result.subscription,
                customer: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
            },
        });
    } catch (e: any) {
        console.error("[link-subscription] error", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
