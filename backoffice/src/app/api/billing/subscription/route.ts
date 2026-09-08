import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import {
    getDB, getStripe, isSubscriptionBlocked, subscriptionUIState, SubscriptionRow,
    listSubscriptions, pickSubscription, primaryConnectionKey, listAccountConnections,
    subscriptionPerConnectionEnforced,
} from "@/lib/stripe";
import { keyFromRequest, CONNECTION_KEY_TO_SOURCE } from "@/lib/subscription-key";
import { isAdmin, getRole } from "@/lib/admin";
import { resolveAccountUser } from "@/lib/account";

export const runtime = "edge";

export async function GET(req: NextRequest) {
    try {
        const { userId } = await auth();
        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const viewerIsAdmin = await isAdmin(userId);
        // Admin impersonation first, then an extra user's own account (0039):
        // a member sees the billing of the account that invited them.
        const targetUserId = await resolveAccountUser(req, userId);

        const targetRole = await getRole(targetUserId);
        const targetIsAdmin = targetRole === "superadmin" || targetRole === "hiperadmin";

        // Admins/superadmins: exempt from subscription
        if (targetIsAdmin) {
            return NextResponse.json({
                subscription: null,
                ui_state: "exempt",
                blocked: false,
                connections: [],
                role: targetRole,
                viewer_is_admin: viewerIsAdmin,
                user_id: targetUserId,
            });
        }

        const db = getDB();

        // Which connection the caller is asking about. The card on an
        // integration page names its own; the dashboard names none and gets the
        // account's oldest, which is what its single subscription paid for.
        const requested = req.nextUrl.searchParams.get("connection_key");
        const connectionKey = requested
            ? keyFromRequest(requested, null)
            : await primaryConnectionKey(db, targetUserId);

        const rows = await listSubscriptions(db, targetUserId);
        const sub: SubscriptionRow | null = pickSubscription(rows, connectionKey);

        // Every connection on the account with what covers it. This is the view
        // that was impossible before: one row per account meant a second
        // integration could not be seen as unpaid, because there was nowhere for
        // it to be unpaid IN.
        const enforced = subscriptionPerConnectionEnforced();
        const connections = (await listAccountConnections(db, targetUserId)).map((c) => {
            const row = pickSubscription(rows, c.key);
            return {
                ...c,
                source: CONNECTION_KEY_TO_SOURCE[c.key] ?? null,
                ui_state: subscriptionUIState(row),
                blocked: isSubscriptionBlocked(row),
                subscription_id: row?.stripe_subscription_id ?? null,
                current_period_end: row?.current_period_end ?? null,
            };
        });

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

        // Until enforcement is switched on, the account is judged as a whole —
        // exactly as before — so nobody is told they are suspended for a
        // connection they were never asked to pay for. With
        // SUBSCRIPTION_PER_CONNECTION=1 the answer is about THIS connection.
        const accountRow = rows.find((r) => !isSubscriptionBlocked(r)) ?? rows[0] ?? null;
        const accountBlocked = !accountRow || isSubscriptionBlocked(accountRow);
        const blocked = enforced ? isSubscriptionBlocked(sub) : accountBlocked;

        return NextResponse.json({
            subscription: sub,
            connection_key: connectionKey,
            connections,
            enforced,
            // Off-enforcement, a connection with no row of its own still shows
            // the account's live subscription — otherwise every second
            // integration would read "not subscribed" before anyone was asked
            // to pay for it.
            ui_state: enforced || sub ? subscriptionUIState(sub) : subscriptionUIState(accountRow),
            blocked,
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
