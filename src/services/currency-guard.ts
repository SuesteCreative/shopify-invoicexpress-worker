import type { DestinationKind } from "../storage";

/**
 * Can this destination take a sale that was not paid in euros?
 *
 * Three different answers, which is why this is a function and not a constant:
 *
 *  - **Moloni** issues the document in the currency the buyer paid, natively
 *    (`exchange_currency_id` + `exchange_rate`, handled in its adapter).
 *  - **InvoiceXpress** cannot: a Portuguese account issues in euros, by law, and
 *    `currency_code`/`rate` only print a second figure beside the euro value. So
 *    its adapter restates the sale in euros before building the document, at the
 *    ECB reference rate for that date (art. 49.º CIVA), and refuses loudly when
 *    it cannot get a rate. See src/ix/foreign-currency.ts.
 *  - **Vendus** has no FX path at all. A foreign sale there is still stopped
 *    before it becomes a misvalued document.
 *
 * The pipeline used to stop everything except Moloni, which was right while IX
 * had no way to convert — and expensive once it did: it left 33 of Wim Hof
 * Method's last 89 payments unbillable, each raising a critical incident,
 * because their Stripe account holds a balance per currency and settles USD in
 * USD and AUD in AUD.
 */
export function destinationHandlesForeignCurrency(destination: DestinationKind | string): boolean {
  return destination === "moloni" || destination === "invoicexpress";
}
