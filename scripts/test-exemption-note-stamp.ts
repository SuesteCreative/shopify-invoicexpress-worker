// Exemption-note stamping harness — confirms that when a shop has
// ix_stamp_exemption_note = 1, an exempt (0%-tax, non reverse-charge) export
// invoice carries the bilingual legal mention derived from its exemption code
// in `observations`, and that the code itself is sent as tax_exemption_reason.
// Models a Bikini Books US export (art.14 CIVA = M05). Also checks the gate:
// flag off → no mention; reverse-charge path keeps its own mention.

import { IxBuilder } from "../src/ix/builder";
import { EXEMPTION_MENTIONS } from "../src/ix/exemption-mentions";

const M05_PT = EXEMPTION_MENTIONS.M05.pt;
const M05_EN = EXEMPTION_MENTIONS.M05.en;

// US export: no VAT collected → zero-tax lines, not reverse charge.
const usRaw: any = {
    id: 700001, order_number: 8100, created_at: "2026-07-06T10:00:00Z",
    taxes_included: false,
    total_price: "24.00", subtotal_price: "20.00", total_tax: "0.00",
    currency: "EUR",
    customer: { id: 5, email: "reader@example.com", tax_exemptions: [], tax_exempt: false },
    billing_address: {
        name: "Jane Reader", company: "", address1: "1 Market St",
        city: "San Francisco", zip: "94105", country: "United States", country_code: "US",
    },
    shipping_address: { country_code: "US", city: "San Francisco" },
    line_items: [{
        id: 1, title: "Critical Thinking (paperback)", price: "20.00", quantity: 1,
        sku: "BB-CT-01", taxable: true,
        tax_lines: [{ rate: 0.0, price: "0.00", title: "US" }],
        discount_allocations: [],
    }],
    shipping_lines: [{
        id: 10, title: "UPS", price: "4.00",
        tax_lines: [{ rate: 0.0, price: "0.00", title: "US" }],
        discount_allocations: [],
    }],
};

const usNormalized: any = {
    raw_order: usRaw,
    order: {
        order_number: usRaw.order_number, created_at: usRaw.created_at, note: null,
        customer: { name: "Jane Reader", email: "reader@example.com" },
        billing_address: usRaw.billing_address,
        shipping_address: usRaw.shipping_address,
        items: [],
    },
};

const bikiniConfig: any = {
    user_id: "test", shopify_domain: "166c6d-82.myshopify.com",
    ix_account_name: "bikinibooks", ix_api_key: "test", ix_environment: "dev",
    ix_exemption_reason: "M05", ix_b2b_exemption_reason: "M40",
    ix_stamp_exemption_note: 1,
    b2b_reverse_charge: 1, oss_enabled: 1, vat_included: 1, pos_mode: 0,
};

let ok = true;
function check(label: string, actual: any, expected: any) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${pass ? "✓" : "✗"} ${label}: ${JSON.stringify(actual)} ${pass ? "" : `(expected ${JSON.stringify(expected)})`}`);
    if (!pass) ok = false;
}

// 1) Flag ON, exempt export → mention stamped + correct code.
{
    const { invoice, requestTaxExemptionReason } = new IxBuilder(bikiniConfig)
        .createInvoiceFromNormalizedOrder(usNormalized);
    console.log("\n=== Bikini Books US export (flag on) ===");
    console.log("observations:", JSON.stringify(invoice.observations));
    check("requestTaxExemptionReason", requestTaxExemptionReason, true);
    check("tax_exemption_reason = M05", invoice.tax_exemption_reason, "M05");
    check("observations has PT mention", (invoice.observations ?? "").includes(M05_PT), true);
    check("observations has EN mention", (invoice.observations ?? "").includes(M05_EN), true);
    check("all line tax = 0", invoice.items?.every((i: any) => (typeof i.tax === "number" ? i.tax : i.tax?.value) === 0), true);
}

// 2) Flag OFF → code still sent, but no mention text.
{
    const { invoice } = new IxBuilder({ ...bikiniConfig, ix_stamp_exemption_note: 0 })
        .createInvoiceFromNormalizedOrder(usNormalized);
    console.log("\n=== Flag off ===");
    check("off: tax_exemption_reason = M05", invoice.tax_exemption_reason, "M05");
    check("off: no PT mention", (invoice.observations ?? "").includes(M05_PT), false);
}

// 3) Order note preserved alongside mention.
{
    const withNote = { ...usNormalized, order: { ...usNormalized.order, note: "Gift wrap" } };
    const { invoice } = new IxBuilder(bikiniConfig).createInvoiceFromNormalizedOrder(withNote);
    console.log("\n=== With order note ===");
    check("note kept", (invoice.observations ?? "").includes("Gift wrap"), true);
    check("mention kept", (invoice.observations ?? "").includes(M05_PT), true);
}

// 4) Unmapped code (M99) → no mention even with flag on.
{
    const { invoice } = new IxBuilder({ ...bikiniConfig, ix_exemption_reason: "M99" })
        .createInvoiceFromNormalizedOrder(usNormalized);
    console.log("\n=== Unmapped code M99 (flag on) ===");
    check("M99: tax_exemption_reason = M99", invoice.tax_exemption_reason, "M99");
    check("M99: no mention", (invoice.observations ?? ""), "");
}

console.log(`\n${ok ? "✅ ALL PASS" : "❌ FAILURES"}`);
process.exit(ok ? 0 : 1);
