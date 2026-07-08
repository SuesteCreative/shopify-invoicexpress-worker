import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getDB, getStripe, isSubscriptionBlocked, subscriptionUIState, SubscriptionRow } from "@/lib/stripe";
import { isAdmin, getImpersonationId, getRole } from "@/lib/admin";

export const runtime = "edge";

export async function GET(req: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        let targetUserId = userId;
        const viewerIsAdmin = await isAdmin(userId);
        if (viewerIsAdmin) {
            const imp = await getImpersonationId(req);
            if (imp) targetUserId = imp;
        }

        const targetRole = await getRole(targetUserId);
        const targetIsAdmin = targetRole === "superadmin" || targetRole === "hiperadmin";

        // Admins/superadmins: exempt from subscription
        if (targetIsAdmin) {
            return NextResponse.json({
                subscription: null,
                ui_state: "exempt",
                blocked: false,
                role: targetRole,
                viewer_is_admin: viewerIsAdmin,
                user_id: targetUserId,
            });
        }

        const db = getDB();
        const sub: SubscriptionRow | null = await db.prepare(
            "SELECT * FROM subscriptions WHERE user_id = ?"
        ).bind(targetUserId).first();

        // The plan price is read DIRECTLY from the subscription's Stripe price
        // (source of truth), so the billing card shows the real amount per
        // integration (€7.50 Lodgify/Shopify, €5 Stripe-Moloni, …) instead of
        // guessing from the connection. Best-effort: a Stripe hiccup or a legacy
        // lookup-key price_id just leaves plan_price null (UI falls back).
        let plan_price: { amount_cents: number; currency: string; interval: string | null } | null = null;
        if (sub?.price_id) {
            try {
                const price = await getStripe().prices.retrieve(sub.price_id);
                plan_price = {
                    amount_cents: price.unit_amount ?? 0,
                    currency: price.currency ?? "eur",
                    interval: price.recurring?.interval ?? null,
                };
            } catch { /* fall back to static label in the UI */ }
        }

        return NextResponse.json({
            subscription: sub,
            ui_state: subscriptionUIState(sub),
            blocked: isSubscriptionBlocked(sub),
            role: targetRole,
            plan_price,
            viewer_is_admin: viewerIsAdmin,
            user_id: targetUserId,
        });
    } catch (e: any) {
        console.error("[billing/subscription] error", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
