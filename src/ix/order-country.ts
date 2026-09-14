import type { Normalized } from "../api/normalize-shopify";

/**
 * The country whose VAT applies, by the place-of-supply rule for distance
 * selling: where the goods or services go.
 *
 * Deliberately the OPPOSITE priority to the invoice's CLIENT block, which is
 * billing-first. The two answer different questions — who to bill, and whose
 * VAT to charge — and merging them would quietly get one of them wrong.
 *
 * Lives here rather than in `adapters/tax-rates`, where it was written, because
 * `IxBuilder` needs the same answer and tax-rates imports the builder: the two
 * of them importing each other is a cycle. `tax-rates` re-exports it, so every
 * existing caller and its tests are untouched.
 */
export function ossCountry(order: Normalized["order"]): string {
  const candidates = [
    order.shipping_address?.country_code,
    order.billing_address?.country_code,
    (order.customer as any)?.default_address?.country_code,
  ];
  for (const c of candidates) {
    const cc = String(c ?? "").trim().toUpperCase();
    if (cc.length === 2) return cc;
  }
  return "";
}
