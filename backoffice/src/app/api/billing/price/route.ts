import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { priceLookupFor, resolvePrice } from "@/lib/billing-prices";

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

    const source = new URL(request.url).searchParams.get("source") ?? "";
    if (!priceLookupFor(source, "monthly")) {
        return NextResponse.json({ error: `Unknown subscription source: "${source}"` }, { status: 400 });
    }

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
