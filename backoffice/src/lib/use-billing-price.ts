"use client";

import { useEffect, useState } from "react";
import type { Money } from "./billing-display";

export type BillingPrices = { monthly: Money | null; annual: Money | null };

/**
 * What this pair costs, from the same price the checkout will charge.
 *
 * `connectionKey` is the pair's own key, never the account's primary: a guided
 * page sells the integration it guides, and the price it prints has to be the
 * one its own Subscrever button rings up.
 *
 * A failure answers null and the card prints no figure. That is the whole point
 * of asking: the pages this replaced stated 5 €/mês in the translation file and
 * charged 7,50 €, so no figure is the only safe fallback — the real amount is
 * one click away on Stripe's own page either way.
 */
export function useBillingPrice(connectionKey: string): BillingPrices | null {
    const [prices, setPrices] = useState<BillingPrices | null>(null);

    useEffect(() => {
        let alive = true;
        fetch(`/api/billing/price?connection_key=${encodeURIComponent(connectionKey)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d: any) => { if (alive) setPrices(d && !d.error ? d : null); })
            .catch(() => { if (alive) setPrices(null); });
        return () => { alive = false; };
    }, [connectionKey]);

    return prices;
}
