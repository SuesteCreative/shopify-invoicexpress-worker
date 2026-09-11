import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getStripe, getDB } from "@/lib/stripe";
import { resolveAccountUser } from "@/lib/account";
import { priceLookupFor, resolvePrice, resolveBillingSource, isLegacyClient } from "@/lib/billing-prices";
import { keyFromRequest } from "@/lib/subscription-key";

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

    // "dashboard" names no product: the account's own set-up decides which one,
    // exactly as the checkout resolves it.
    const rawSource = new URL(request.url).searchParams.get("source") ?? "";
    const targetUserId = await resolveAccountUser(request, userId);
    const source = await resolveBillingSource(getDB(), targetUserId, rawSource);
    if (!priceLookupFor(source, "monthly")) {
        return NextResponse.json({ error: `Unknown subscription source: "${source}"` }, { status: 400 });
    }

    // The connection being subscribed, so a client marked legacy on one pipe is
    // not quoted the old price on another. `keyFromRequest` maps a source name
    // to its pair, which is the same map the checkout stamps on the session.
    const legacy = await isLegacyClient(getDB(), targetUserId, keyFromRequest(null, source));

    const stripe = getStripe();
    const read = async (plan: "monthly" | "annual") => {
        const lookup = priceLookupFor(source, plan, { legacy });
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
    return NextResponse.json({ monthly, annual, legacy });
}
