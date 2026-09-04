/**
 * Invoice fields carried in Stripe metadata.
 *
 * A merchant whose checkout is their own software knows things Stripe never
 * asks for: the buyer's fiscal name, their VAT number, the country the sale is
 * taxed in, the rate their own engine applied. They put it in the payment's
 * metadata. Until now we read that metadata for exactly two purposes — hunting
 * a NIF inside free text, and matching tag-routing rules — and everything else
 * in it was discarded, so an invoice went out as "Consumidor Final" while the
 * answer sat on the payment.
 *
 * The map is per connection (`stripe_metadata_map`, a JSON object) because the
 * keys are the merchant's own: `{"name": "billing_name", "vat": "nif"}` reads
 * their `billing_name` into the buyer's name. Absent = this whole module does
 * nothing, which is every connection invoicing today.
 *
 * Two rules that are not negotiable:
 *
 *  - It only ever FILLS BLANKS. Anything Stripe itself stated — a name on the
 *    charge, an address on the Customer — outranks metadata, because metadata
 *    is whatever the merchant's own code happened to send and the payment
 *    object is what the payment network recorded.
 *  - It never moves money. A VAT rate from metadata re-splits a total into net
 *    and tax; it cannot change what the buyer paid.
 */

import type { Normalized } from "../../api/normalize-shopify";

/** Our field name → the merchant's metadata key. */
export type StripeMetadataMap = Record<string, string>;

/** The fields a map may target. Anything else in the JSON is ignored. */
const SUPPORTED_FIELDS = [
  "name", "email", "phone", "company",
  "address1", "address2", "city", "postal_code", "province",
  "country", "vat", "vat_rate",
] as const;

export function parseMetadataMap(raw: unknown): StripeMetadataMap | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: StripeMetadataMap = {};
    for (const field of SUPPORTED_FIELDS) {
      const key = (parsed as any)[field];
      if (typeof key === "string" && key.trim()) out[field] = key.trim();
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    // A malformed map is a configuration mistake, not a reason to lose a sale.
    console.warn("[Stripe] stripe_metadata_map is not valid JSON — ignoring it");
    return null;
  }
}

/**
 * Apply the map to an order already built from the Stripe event.
 *
 * Returns the fields it actually filled, for the log — silence about what a
 * mapping did is how a wrong invoice becomes hard to explain later.
 */
export function applyMetadataMap(normalized: Normalized, map: StripeMetadataMap): string[] {
  const order = normalized.order;
  const attrs: Array<{ name?: string; value?: unknown }> = Array.isArray(order.note_attributes)
    ? order.note_attributes as any
    : [];
  if (attrs.length === 0) return [];

  // Metadata keys are matched case-insensitively: a merchant who writes
  // `Billing_Name` in one place and `billing_name` in another means the same
  // field, and the alternative is an invoice silently missing a name.
  const byKey = new Map<string, string>();
  for (const attr of attrs) {
    const key = String(attr?.name ?? "").trim().toLowerCase();
    const value = String(attr?.value ?? "").trim();
    if (key && value && !byKey.has(key)) byKey.set(key, value);
  }

  const read = (field: string): string | null => {
    const key = map[field];
    if (!key) return null;
    return byKey.get(key.trim().toLowerCase()) ?? null;
  };

  const filled: string[] = [];
  const billing: any = order.billing_address ?? (order.billing_address = {} as any);

  const fillAddress = (field: string, target: string) => {
    const value = read(field);
    if (value && !String(billing[target] ?? "").trim()) {
      billing[target] = value;
      filled.push(field);
    }
  };

  const name = read("name");
  if (name && !String(order.customer?.name ?? "").trim() && !String(billing.name ?? "").trim()) {
    if (order.customer) order.customer.name = name;
    billing.name = name;
    filled.push("name");
  }

  const email = read("email");
  if (email && order.customer && !String(order.customer.email ?? "").trim()) {
    order.customer.email = email;
    filled.push("email");
  }

  fillAddress("phone", "phone");
  fillAddress("company", "company");
  fillAddress("address1", "address1");
  fillAddress("address2", "address2");
  fillAddress("city", "city");
  fillAddress("postal_code", "zip");
  fillAddress("province", "province");

  const country = read("country");
  if (country && !String(billing.country_code ?? "").trim()) {
    // Two shapes are common in the wild: an ISO-2 code and a country name. The
    // country code is what gates the fiscal classification, so a two-letter
    // value is taken as the code and anything longer as the name.
    if (country.length === 2) {
      billing.country_code = country.toUpperCase();
      if (!String(billing.country ?? "").trim()) billing.country = country.toUpperCase();
    } else if (!String(billing.country ?? "").trim()) {
      billing.country = country;
    }
    filled.push("country");
  }

  // The tax id is handed to the existing extractor as a note attribute rather
  // than written onto the client: that path validates a PT NIF, checks an EU
  // VAT against VIES, and refuses what does not hold up. Writing `fiscal_id`
  // straight from metadata would put an unvalidated number on a fiscal
  // document, which is how address words ended up as NIFs on 200 of them.
  const vat = read("vat");
  if (vat) {
    (order.note_attributes as any[]).push({ name: "vat (metadata)", value: vat });
    filled.push("vat");
  }

  return filled;
}

/**
 * Split a total that arrived untaxed using a VAT rate the merchant sent.
 *
 * The last resort, after the Checkout Session and the Stripe Invoice: for a
 * merchant whose own engine computed the VAT and who tells us the rate, this is
 * the difference between an invoice that declares 23% and one that declares
 * nothing. Only touches lines that carry no tax, and keeps every gross exactly
 * where it was — the buyer paid what they paid.
 */
export function applyMetadataVatRate(normalized: Normalized, map: StripeMetadataMap): number | null {
  const order = normalized.order;
  const attrs: any[] = Array.isArray(order.note_attributes) ? order.note_attributes : [];
  const key = map.vat_rate?.trim().toLowerCase();
  if (!key) return null;

  const raw = attrs.find(a => String(a?.name ?? "").trim().toLowerCase() === key)?.value;
  // Accept "23", "23.0" and "23%"; a comma decimal is common in PT metadata.
  const rate = Number(String(raw ?? "").replace("%", "").replace(",", ".").trim());
  if (!Number.isFinite(rate) || rate <= 0 || rate > 100) return null;

  const items: any[] = Array.isArray(order.items) ? order.items : [];
  if (items.length === 0) return null;
  if (items.some(it => Number(it?.tax?.value ?? 0) > 0)) return null; // already taxed — leave it

  for (const item of items) {
    const gross = Number(item.unit_price ?? 0);
    if (!(gross > 0)) continue;
    const net = Math.round((gross / (1 + rate / 100)) * 100) / 100;
    item.unit_price = net;
    item.unit_price_calculated = net;
    item.subtotal_calculated = net;
    item.tax = { name: "VAT", value: rate, unit_amount: Math.round((gross - net) * 100) / 100 };
  }
  return rate;
}
