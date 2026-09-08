import { NextRequest, NextResponse } from "next/server";
import { getDB, isSubscriptionBlocked, SubscriptionRow } from "@/lib/stripe";
import { getRole } from "@/lib/admin";
import { listSubscriptions, pickSubscription, subscriptionPerConnectionEnforced } from "@/lib/stripe";
import { DEFAULT_CONNECTION_KEY } from "@/lib/subscription-key";

export const runtime = "edge";

/**
 * Internal endpoint: rioko-next webhook calls this to check if it should emit IX invoice.
 * Auth: X-Internal-API-Key header matched against env INTERNAL_GATE_API_KEY.
 */
export async function GET(req: NextRequest) {
    try {
        const apiKey = req.headers.get("x-internal-api-key");
        const expected = process.env.INTERNAL_GATE_API_KEY || process.env.ADMIN_API_KEY;
        if (!expected || apiKey !== expected) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const shopifyDomain = req.nextUrl.searchParams.get("shopify_domain");
        if (!shopifyDomain) return NextResponse.json({ error: "shopify_domain required" }, { status: 400 });

        const db = getDB();
        const integration: any = await db.prepare(
            "SELECT user_id FROM integrations WHERE shopify_domain = ? LIMIT 1"
        ).bind(shopifyDomain).first();

        if (!integration?.user_id) {
            return NextResponse.json({ blocked: true, reason: "no_integration" });
        }

        // Admins/superadmins: exempt from subscription gate
        const role = await getRole(integration.user_id);
        if (role === "superadmin" || role === "hiperadmin") {
            return NextResponse.json({ blocked: false, reason: null, status: "exempt", user_id: integration.user_id });
        }

        // This endpoint answers for a SHOPIFY shop, so with per-connection
        // billing on it asks about that connection specifically. Off, any live
        // subscription on the account answers for it, as before.
        const rows = await listSubscriptions(db, integration.user_id);
        const sub: SubscriptionRow | null = subscriptionPerConnectionEnforced()
            ? pickSubscription(rows, DEFAULT_CONNECTION_KEY)
            : (rows.find((r) => !isSubscriptionBlocked(r)) ?? rows[0] ?? null);

        const blocked = isSubscriptionBlocked(sub);
        return NextResponse.json({
            blocked,
            reason: blocked ? (sub ? `status_${sub.status}` : "no_subscription") : null,
            status: sub?.status,
            trial_end: sub?.trial_end,
            user_id: integration.user_id,
        });
    } catch (e: any) {
        console.error("[internal/subscription-check] error", e);
        return NextResponse.json({ blocked: false, error: e.message }, { status: 500 });
        // Fail-open on internal errors so we don't break integrations on backoffice outage
    }
}
