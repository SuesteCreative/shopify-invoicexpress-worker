// Reverse-charge detection harness — exercises IxBuilder against a real
// Shopify orders/created payload (Stella, order 13157264884098) to confirm
// the post-fix path: zero-tax lines, M16 exemption reason, foreign VAT
// stamped as fiscal_id, gross total matches paid amount.

import { IxBuilder } from "../src/ix/builder";

// Minimal Normalized shape matching what shopify.normalizeOrder() produces.
const rawOrder = {
    id: 13157264884098,
    order_number: 4218,
    created_at: "2026-05-27T12:00:00Z",
    taxes_included: false,
    // 2*1.20 + 2*1.20 + 12.00 = 16.80, zero tax.
    total_price: "16.80",
    subtotal_price: "4.80",
    total_tax: "0.00",
    currency: "EUR",
    customer: {
        id: 999,
        email: "carol@example.com",
        tax_exemptions: ["EU_REVERSE_CHARGE_EXEMPTION_RULE"],
        tax_exempt: false,
    },
    billing_address: {
        first_name: "Carol",
        last_name: "Lozano",
        name: "Carol Lozano",
        company: "Samaruc Tattoo Studio 35604681Z",
        address1: "Calle Pare Cosme de Torres",
        city: "Valencia",
        zip: "46019",
        country: "Spain",
        country_code: "ES",
    },
    shipping_address: {
        country_code: "ES",
        city: "Catarroja",
    },
    line_items: [
        {
            id: 1, title: "PVD09 Segmento Articulado", variant_title: "14mm",
            price: "1.20", quantity: 2, sku: "PVD09-14",
            taxable: true,
            tax_lines: [{ rate: 0.21, price: "0.00", title: "ES IVA" }],
            discount_allocations: [],
        },
        {
            id: 2, title: "PVD09 Segmento Articulado", variant_title: "12mm",
            price: "1.20", quantity: 2, sku: "PVD09-12",
            taxable: true,
            tax_lines: [{ rate: 0.21, price: "0.00", title: "ES IVA" }],
            discount_allocations: [],
        },
    ],
    shipping_lines: [
        {
            id: 10, title: "CTT", price: "12.00",
            tax_lines: [{ rate: 0.21, price: "0.00", title: "ES IVA" }],
            discount_allocations: [],
        },
    ],
};

const normalized: any = {
    raw_order: rawOrder,
    order: {
        order_number: rawOrder.order_number,
        created_at: rawOrder.created_at,
        note: null,
        customer: { name: "Carol Lozano", email: "carol@example.com" },
        billing_address: rawOrder.billing_address,
        shipping_address: rawOrder.shipping_address,
        items: [],
    },
};

const config: any = {
    user_id: "test",
    shopify_domain: "2d0604-3.myshopify.com",
    ix_account_name: "test",
    ix_api_key: "test",
    ix_environment: "dev",
    ix_exemption_reason: "M99",
    ix_b2b_exemption_reason: "M16",
    b2b_reverse_charge: 0,
    oss_enabled: 1,
    vat_included: 0,
    pos_mode: 0,
};

const builder = new IxBuilder(config);
const { invoice, requestTaxExemptionReason } = builder.createInvoiceFromNormalizedOrder(normalized);

let ok = true;
function check(label: string, actual: any, expected: any) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${pass ? "✓" : "✗"} ${label}: ${JSON.stringify(actual)} ${pass ? "" : `(expected ${JSON.stringify(expected)})`}`);
    if (!pass) ok = false;
}

console.log("\n=== Invoice ===");
console.log(JSON.stringify(invoice, null, 2));
console.log("\n=== Assertions ===");

check("requestTaxExemptionReason", requestTaxExemptionReason, true);
check("tax_exemption_reason = M16", invoice.tax_exemption_reason, "M16");
check("client.fiscal_id = ES35604681Z", invoice.client?.fiscal_id, "ES35604681Z");
check("client.country = ES", invoice.client?.country, "ES");
check("observations contains IVA - autoliquidação", /IVA - autoliquida/.test(invoice.observations ?? ""), true);
check("all line tax=0", invoice.items?.every((i: any) => (typeof i.tax === "number" ? i.tax : i.tax?.value) === 0), true);

// Expected gross total = paid (79.70). Sum of (unit_price * qty * (1 + tax/100))
const grossTotal = invoice.items?.reduce((acc: number, i: any) => {
    const taxRate = typeof i.tax === "number" ? i.tax : Number(i.tax?.value ?? 0);
    const disc = Number(i.discount ?? 0);
    const lineNet = Number(i.unit_price) * Number(i.quantity) * (1 - disc / 100);
    return acc + Math.round(lineNet * (1 + taxRate / 100) * 100) / 100;
}, 0);
check("gross total = 16.80 (paid)", Math.round((grossTotal ?? 0) * 100) / 100, 16.80);

// ── Regression: standard PT B2C order, taxes_included=true, IVA 23% ──────
const ptRaw: any = {
    id: 99, order_number: 5000, created_at: "2026-05-27T12:00:00Z",
    taxes_included: true,
    total_price: "12.30", subtotal_price: "12.30", total_tax: "2.30",
    currency: "EUR",
    customer: { id: 1, email: "joao@example.com", tax_exemptions: [], tax_exempt: false },
    billing_address: { name: "João", company: "", city: "Lisboa", country_code: "PT" },
    shipping_address: { country_code: "PT" },
    line_items: [{
        title: "Item", price: "12.30", quantity: 1, sku: "ITM1", taxable: true,
        tax_lines: [{ rate: 0.23, price: "2.30", title: "IVA 23%" }],
        discount_allocations: [],
    }],
    shipping_lines: [],
};
const ptNormalized: any = {
    raw_order: ptRaw,
    order: {
        order_number: 5000, created_at: "2026-05-27T12:00:00Z", note: null,
        customer: { name: "João", email: "joao@example.com" },
        billing_address: ptRaw.billing_address,
        shipping_address: ptRaw.shipping_address,
        items: [],
    },
};
const ptBuilder = new IxBuilder({ ...config, ix_exemption_reason: undefined } as any);
const { invoice: ptInvoice, requestTaxExemptionReason: ptRC } = ptBuilder.createInvoiceFromNormalizedOrder(ptNormalized);
console.log("\n=== PT B2C regression ===");
check("PT: no exemption flag", ptRC, false);
check("PT: tax_exemption_reason undefined", ptInvoice.tax_exemption_reason, undefined);
check("PT: no IVA-autoliquidação observation", /autoliquida/.test(ptInvoice.observations ?? ""), false);
check("PT: line tax = 23", (ptInvoice.items?.[0] as any)?.tax, 23);

console.log(`\n${ok ? "✅ ALL PASS" : "❌ FAILURES"}`);
process.exit(ok ? 0 : 1);
