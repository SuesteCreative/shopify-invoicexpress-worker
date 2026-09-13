/**
 * Printing a price, once.
 *
 * The three guided pages each stated their price in the translation file:
 * Stripe→Moloni advertised "5 €/mês + IVA" and Connect→Moloni reused the same
 * string, while the checkout charged the current price from the catalogue. The
 * old 5 €/50 € is not something we sell — it is what a migrated client's
 * EXISTING subscription bills on, marked `subscriptions.legacy_price` — so the
 * only honest figure on a subscribe card is the one the till will ring up, read
 * from `/api/billing/price`, and the only honest figure on a running
 * subscription is its own `plan_price`.
 *
 * No react and no next here on purpose: the runner at the repo root collects
 * `backoffice/src/lib/*.test.ts` without installing the backoffice's
 * dependencies, so anything a test touches has to stay dependency-free.
 */

/** What `/api/billing/price` answers per plan, and what the subscription route
 *  reports for a running subscription. Null when Stripe could not be read. */
export type Money = { amount_cents: number; currency: string };

/** next-intl hands us "pt" or "en"; money needs a region to place the symbol.
 *  A full tag ("pt-PT", the `dateLocale` message the cards already read) passes
 *  through untouched, so adopting this changes no card's current formatting. */
const LOCALES: Record<string, string> = { pt: "pt-PT", en: "en-IE" };

function tagFor(locale: string | null | undefined): string {
    const raw = String(locale || "");
    if (raw.includes("-")) return raw;
    return LOCALES[raw] ?? LOCALES.pt;
}

/**
 * A price as a person reads it: "7,50 €" in Portuguese, "€75" in English.
 *
 * Whole amounts drop the decimals — "75 €", not "75,00 €" — because that is how
 * the price was written by hand before, and a card that suddenly grew two zeros
 * would read as a change of price rather than a change of code.
 */
export function formatMoney(money: Money | null | undefined, locale: string): string | null {
    if (!money || typeof money.amount_cents !== "number" || !Number.isFinite(money.amount_cents)) return null;
    const currency = String(money.currency || "eur").toUpperCase();
    const whole = money.amount_cents % 100 === 0;
    try {
        return new Intl.NumberFormat(tagFor(locale), {
            style: "currency",
            currency,
            minimumFractionDigits: whole ? 0 : 2,
            maximumFractionDigits: 2,
        }).format(money.amount_cents / 100);
    } catch {
        // An unknown currency code throws rather than falling back to a symbol,
        // and a card with no figure beats a card with a wrong one.
        return null;
    }
}

/**
 * How much the annual plan saves, as a percentage of twelve monthly payments.
 *
 * It was the string "Poupa 17%", which was true of the one pair priced
 * 7,50 €/75 € and stated on every pair regardless. Null when either price is
 * missing or the annual plan saves nothing, so the badge simply does not render.
 */
/** The yearly price spread over twelve months, for the "equivale a X/mês" note.
 *  Derived from the yearly price rather than from a sentence written when the
 *  yearly price was 75 €. */
export function monthlyEquivalent(annual: Money | null | undefined): Money | null {
    if (!annual || !(annual.amount_cents > 0)) return null;
    return { amount_cents: Math.round(annual.amount_cents / 12), currency: annual.currency };
}

export function annualSavingPct(monthly: Money | null | undefined, annual: Money | null | undefined): number | null {
    if (!monthly || !annual) return null;
    const year = monthly.amount_cents * 12;
    if (!(year > 0) || !(annual.amount_cents > 0)) return null;
    const pct = Math.round((1 - annual.amount_cents / year) * 100);
    return pct > 0 ? pct : null;
}
