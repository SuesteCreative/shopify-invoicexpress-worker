/**
 * Who is still on the old price, and when that ends.
 *
 * Two price points are in circulation: 5 €/month and 50 €/year from the early
 * days, and 7,50 €/month and 75 €/year since. The old ones were never taken
 * away from the clients who signed up on them, and they are not being taken
 * away now — they end when the subscription they belong to ends:
 *
 *   annual  → at the end of the period already paid for
 *   monthly → on 01/01/2027, four months of notice from the day this was written
 *
 * At that point the subscription is cancelled and the client is asked to
 * subscribe at the current price. Nothing is charged at the old price after the
 * client stopped paying it, and nothing is charged at the new price without
 * them agreeing to it.
 *
 * The amount is read from the Stripe price rather than stored here: three price
 * points are in circulation and a table written into the code would be wrong
 * for one of them the day someone changes it.
 */

export type PriceTier = "legacy" | "current" | "unknown";

/** Where the monthly ladder splits. A price at or below this is the old one. */
const LEGACY_MONTHLY_MAX_CENTS = 500;
/** Same, per year. 50 € against the 75 € that replaced it. */
const LEGACY_YEARLY_MAX_CENTS = 5000;

/** The day the monthly legacy price stops. Annual ones end on their own date. */
export const LEGACY_MONTHLY_SUNSET = "2027-01-01T00:00:00.000Z";

interface PriceLike {
    unit_amount?: number | null;
    recurring?: { interval?: string; interval_count?: number | null } | null;
}

export function tierOf(price: PriceLike | null | undefined): PriceTier {
    const amount = price?.unit_amount;
    const interval = price?.recurring?.interval;
    if (typeof amount !== "number" || !interval) return "unknown";
    if (interval === "year") return amount <= LEGACY_YEARLY_MAX_CENTS ? "legacy" : "current";
    if (interval === "month") return amount <= LEGACY_MONTHLY_MAX_CENTS ? "legacy" : "current";
    // Weekly or daily: nothing sells on those, and guessing which side of the
    // ladder they fall on would be inventing a fact.
    return "unknown";
}

/**
 * When this legacy line stops being billed at the old price.
 *
 * Annual: the end of the period the client already paid for. Monthly: the fixed
 * cut-off, unless the period already runs past it, in which case the period
 * wins — nobody is cut mid-period for a month they paid.
 */
export function sunsetAt(opts: {
    tier: PriceTier;
    interval: string | null | undefined;
    currentPeriodEnd: string | null | undefined;
}): string | null {
    if (opts.tier !== "legacy") return null;
    const periodEnd = opts.currentPeriodEnd ? Date.parse(opts.currentPeriodEnd) : NaN;
    if (opts.interval === "year") return Number.isNaN(periodEnd) ? null : new Date(periodEnd).toISOString();
    if (opts.interval !== "month") return null;
    const cut = Date.parse(LEGACY_MONTHLY_SUNSET);
    if (Number.isNaN(periodEnd)) return new Date(cut).toISOString();
    return new Date(Math.max(cut, periodEnd)).toISOString();
}

/** What the same plan costs today, for the email and for the admin list. */
export function currentPriceCents(interval: string | null | undefined): number | null {
    if (interval === "year") return 7500;
    if (interval === "month") return 750;
    return null;
}

/* ───────────────────────── the operator's answer ─────────────────────────
 *
 * `tierOf` reads the Stripe price, which is the right answer whenever Stripe
 * answers. It does not always: a price id that is really a lookup key does not
 * resolve, Stripe can be unreachable, and a subscription added by hand may
 * carry no price at all. So `subscriptions.legacy_price` (migration 0054) lets
 * an operator say which plan a client is on, and that beats every derivation.
 *
 * Below the override, in order: the price itself, then what was actually
 * charged. The amounts differ because a Stripe price is net of VAT while an
 * invoice is gross, and because the legacy prices predate the tax rate — which
 * is why the gross set is written out rather than computed.
 */

/** Gross invoice amounts that identify the legacy plan.
 *
 *  5 € and 50 € are the plan before the tax rate was applied; 6,15 € and
 *  61,50 € are the same plan with 23 % on top. Both shapes are in the fleet. */
export const LEGACY_GROSS_CENTS = new Set([500, 615, 5000, 6150]);
/** And the current plan: 7,50 € and 75 € with 23 %. (1,85 € is an extra seat,
 *  which says nothing about the plan.) */
export const CURRENT_GROSS_CENTS = new Set([923, 9225]);

/** Where the answer came from, so a derivation is not read as a decision. */
export type TierSource = "override" | "price" | "paid" | "unknown";

export interface TierVerdict {
    tier: PriceTier;
    source: TierSource;
    legacy: boolean;
}

export function resolveTier(input: {
    /** `subscriptions.legacy_price`: 1 or 0 from an operator, null to derive. */
    override?: number | null;
    price?: PriceLike | null;
    /** Gross amount of the most recent paid invoice. */
    paidGrossCents?: number | null;
}): TierVerdict {
    if (input.override === 1) return { tier: "legacy", source: "override", legacy: true };
    if (input.override === 0) return { tier: "current", source: "override", legacy: false };

    const fromPrice = tierOf(input.price);
    if (fromPrice !== "unknown") {
        return { tier: fromPrice, source: "price", legacy: fromPrice === "legacy" };
    }

    const gross = input.paidGrossCents;
    if (typeof gross === "number" && gross > 0) {
        if (LEGACY_GROSS_CENTS.has(gross)) return { tier: "legacy", source: "paid", legacy: true };
        if (CURRENT_GROSS_CENTS.has(gross)) return { tier: "current", source: "paid", legacy: false };
    }

    // Nothing to go on. Not legacy, and honest about not knowing: the current
    // plan is by far the likelier default and the toggle exists for the rest.
    return { tier: "unknown", source: "unknown", legacy: false };
}
