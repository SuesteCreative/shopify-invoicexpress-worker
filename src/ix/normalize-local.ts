import type { NormalizedOrderResponse } from "../api/normalize-shopify";

// In-worker replacement for the external Hostinger normalize service, for the
// Shopify→IX CREATE path only. The IX builder's raw path recomputes items from
// `raw_order` and reconciles against the paid total; the only thing it reads
// from `normalized.order` are passthrough fields that all exist verbatim on the
// raw Shopify order (customer, billing/shipping address, note, note_attributes,
// order_number, created_at). So this maps those fields 1:1 and leaves the
// COMPUTED collections (items, refunds, credits) empty — they are unused on the
// raw create path (verified by tracing builder.ts + validated by the shadow
// harness that diffs invoices built this way vs via Hostinger).
//
// It is deliberately a pure function of the raw order so `scripts/shadow-normalize.mjs`
// can import the exact same mapping the worker runs — no drift between what we
// validate and what ships.
export function buildNormalizedFromRaw(raw: any, shop: string): NormalizedOrderResponse {
  const total = Number(raw?.total_price ?? raw?.current_total_price ?? 0);
  const tags = typeof raw?.tags === "string"
    ? raw.tags.split(",").map((t: string) => t.trim()).filter(Boolean)
    : (Array.isArray(raw?.tags) ? raw.tags : []);

  // Shopify's raw `customer` carries first_name/last_name but NO top-level
  // `name`; the Hostinger service synthesizes `customer.name = first + last`,
  // and buildInvoiceClient reads `customer.name` before falling back to the
  // billing name. Reproduce that synthesis exactly, or the invoiced client name
  // silently changes (caught by the shadow diff). default_address (used by the
  // surname-graft) flows through via the spread.
  const rawCustomer = raw?.customer ?? null;
  const customer = rawCustomer
    ? {
        ...rawCustomer,
        name: (rawCustomer.name && String(rawCustomer.name).trim())
          || `${rawCustomer.first_name ?? ""} ${rawCustomer.last_name ?? ""}`.trim(),
      }
    : {};

  const order: any = {
    id: raw?.id,
    reference: raw?.name ?? `#${raw?.order_number}`,
    order_number: raw?.order_number,
    created_at: raw?.created_at,
    note: raw?.note ?? null,
    note_attributes: raw?.note_attributes ?? [],
    metafields: null,
    tags,
    meta: {
      device_id: raw?.device_id ?? null,
      token: raw?.token ?? "",
      source_name: raw?.source_name ?? "",
      browser_ip: raw?.browser_ip ?? "",
      payment_gateway_names: raw?.payment_gateway_names ?? [],
      source_identifier: raw?.source_identifier ?? null,
      confirmation_number: raw?.confirmation_number ?? "",
      processed_at: raw?.processed_at ?? raw?.created_at ?? "",
    },
    total,
    total_calculated: total,
    currency: raw?.currency ?? "EUR",
    shop_currency: raw?.currency ?? "EUR",
    exchange_rate: 1,
    financial_status: raw?.financial_status ?? "",
    fulfillment_status: raw?.fulfillment_status ?? null,
    // Passthrough objects — the builder reads name/first_name/last_name/company/
    // address1/address2/city/zip/country/country_code/default_address off these,
    // all present on the raw Shopify order. Guest/POS orders have customer=null →
    // {} (mirrors the audit harness + the normalize service's object default).
    customer,
    billing_address: raw?.billing_address ?? {},
    shipping_address: raw?.shipping_address ?? {},
    // Unused on the raw create path (items recomputed from raw_order). Left empty
    // on purpose: a Phase-2 attempt to reconstruct order.items + credits here for
    // the refund path was PROVEN WRONG by scripts/shadow-refund.mjs (Hostinger's
    // item.unit_price is net-of-discount and non-line-item refunds carry no
    // refund_line_items, so a raw reconstruction mis-totals credit notes). The
    // refund path stays on the Hostinger normalize service until it is redesigned
    // to build credit lines directly from raw refund_line_items and re-validated.
    items: [],
    global_discount: { name: "", percent: 0, amount: 0 },
  };

  const normalized: any = {
    order,
    refunds: [],
    exchanges: [],
    credits: [],
    debits: [],
    raw_order: raw,
  };

  return { shop, order_id: String(raw?.id ?? ""), normalized, raw_order: raw } as unknown as NormalizedOrderResponse;
}
