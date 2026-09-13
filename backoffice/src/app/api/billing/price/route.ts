import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getStripe, getDB, primaryConnectionKey } from "@/lib/stripe";
import { resolveAccountUser } from "@/lib/account";
import { priceLookupFor, resolvePrice, resolveBilling } from "@/lib/billing-prices";

export const runtime = "edge";

/**
 * What an integration actually costs, for the page that prints it.
 *
 * The onboarding card used to state 7,50 € and 75 € in the markup, which was
 * true of exactly one product. Every pair has its own price now, so the amount
 * comes from the same Stripe price the checkout will charge. A price that
 * cannot be resolved answers null rather than an error: the card falls back to
 * showing no figure, which is better than showing a wrong one.
 */
export async function GET(request: NextRequest) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // A generic page names no product: the connection the checkout would bill
    // decides, through the very function the checkout calls, so the figure
    // printed is the one charged. Pass `connection_key` when the checkout does.
    const params = new URL(request.url).searchParams;
    const rawSource = params.get("source") ?? "";
    const targetUserId = await resolveAccountUser(request, userId);
    const { connectionKey, source } = await resolveBilling(
        rawSource, params.get("connection_key"), () => primaryConnectionKey(getDB(), targetUserId),
    );
    if (source === null || !priceLookupFor(source, "monthly")) {
        return NextResponse.json({ error: `Unknown subscription source: "${source ?? connectionKey}"` }, { status: 400 });
    }

    // Nothing else to ask: the pair decides the price and nothing about the
    // caller does. The card used to also ask whether the account was on the old
    // plan, and quoted 5 €/50 € when it was — which is no longer a price we
    // sell, only one that existing subscriptions carry.
    const stripe = getStripe();
    const read = async (plan: "monthly" | "annual") => {
        const lookup = priceLookupFor(source, plan);
        if (!lookup) return null;
        try {
            const price: any = await resolvePrice(stripe, lookup);
            if (!price || price.active === false || typeof price.unit_amount !== "number") return null;
            return { amount_cents: price.unit_amount, currency: String(price.currency || "eur") };
        } catch {
            return null;
        }
    };

    const [monthly, annual] = await Promise.all([read("monthly"), read("annual")]);
    return NextResponse.json({ monthly, annual });
}
