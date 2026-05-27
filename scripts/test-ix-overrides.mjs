// IxBuilder per-SKU overrides — unit-level harness.
// Replicates the patched buildInvoiceItemsFromRaw logic against synthetic
// Shopify raw_order payloads, verifying:
//   1. tax_rate override replaces the line's VAT rate
//   2. vat_inclusion="inc" flips an exc shop into included math for that SKU
//   3. vat_inclusion="exc" flips an inc shop into excluded math for that SKU
//   4. name_override replaces the displayed product name
//   5. unmapped lines fall back to default behavior

function buildLine(grossUnit, qty, grossLineDiscount, rate, tax, name, description, shopifyIncluded, lineIncluded) {
    if (qty <= 0 || grossUnit <= 0) return null;
    const effectiveIncluded = lineIncluded ?? shopifyIncluded;
    const factor = rate > 0 ? 1 + rate / 100 : 1;
    const unitNetExact = effectiveIncluded && rate > 0 ? grossUnit / factor : grossUnit;
    const targetLineGross = grossUnit * qty - grossLineDiscount;
    const targetLineNet = effectiveIncluded && rate > 0 ? targetLineGross / factor : targetLineGross;
    const unitNetSend = Math.ceil(unitNetExact * 100) / 100;
    const lineSubtotalSend = unitNetSend * qty;
    const rawPercent = lineSubtotalSend > 0 ? (1 - targetLineNet / lineSubtotalSend) * 100 : 0;
    const discountPercent = Math.round(Math.max(0, rawPercent) * 10000) / 10000;
    const item = { quantity: qty, tax, unit_price: unitNetSend, name };
    if (description) item.description = description;
    if (discountPercent > 0) item.discount = discountPercent;
    return item;
}

function overrideKeyFor(li) {
    const sku = (li?.sku ?? "").toString().trim();
    if (sku) return sku.slice(0, 30);
    if (li?.variant_id) return `RIOKO-VARIANT-${li.variant_id}`.slice(0, 30);
    if (li?.product_id) return `RIOKO-PRODUCT-${li.product_id}`.slice(0, 30);
    return "RIOKO-SHIPPING";
}

function buildItemsFromRaw(rawOrder, overrides) {
    const shopifyIncluded = rawOrder?.taxes_included === true;
    const items = [];
    for (const li of (rawOrder.line_items ?? [])) {
        const quantity = Number(li?.quantity ?? 0);
        const shopifyRate = Number(li?.tax_lines?.[0]?.rate ?? 0) * 100;
        const grossUnit = Number(li?.price ?? 0);
        const allocations = Array.isArray(li?.discount_allocations) ? li.discount_allocations : [];
        const grossLineDiscount = allocations.reduce((acc, a) => acc + Number(a?.amount ?? 0), 0);

        const override = overrides?.get(overrideKeyFor(li));
        const rate = override?.tax_rate != null ? Number(override.tax_rate) : shopifyRate;
        const lineIncluded = override?.vat_inclusion === "inc" ? true
            : override?.vat_inclusion === "exc" ? false
                : undefined;
        const tax = override?.tax_rate != null ? Number(override.tax_rate) : rate;
        const variantTitle = li?.variant_title ? ` / ${li.variant_title}` : "";
        const defaultName = `${li?.title ?? li?.name ?? "Item"}${variantTitle}`;
        const name = (override?.name_override ?? defaultName);
        const description = li?.sku ? `SKU: ${li.sku}` : undefined;
        const item = buildLine(grossUnit, quantity, grossLineDiscount, rate, tax, name, description, shopifyIncluded, lineIncluded);
        if (item) items.push(item);
    }
    return items;
}

// computeExpectedGross from src/adapters/reconcile.ts
function computeExpectedGross(lines) {
    let total = 0;
    for (const l of lines) {
        const qty = Number(l.quantity) || 0;
        const unit = Number(l.unit_price) || 0;
        const discPct = Number(l.discount ?? 0);
        const taxRate = typeof l.tax === "number" ? l.tax : Number(l.tax?.value ?? 0);
        const lineNet = unit * qty * (1 - discPct / 100);
        const lineGross = lineNet * (1 + taxRate / 100);
        total += Math.round(lineGross * 100) / 100;
    }
    return Math.round(total * 100) / 100;
}

const results = [];
function assert(label, expected, items) {
    const actual = computeExpectedGross(items);
    const drift = Math.abs(actual - expected);
    const pass = drift <= 0.01;
    results.push({ label, expected, actual, drift, pass });
    console.log(`${pass ? "✓" : "✗"} ${label}`);
    console.log(`    expected ${expected.toFixed(2)} EUR / built ${actual.toFixed(2)} EUR / drift ${drift.toFixed(4)}`);
    items.forEach((it, i) => {
        const taxN = typeof it.tax === "number" ? it.tax : it.tax?.value;
        console.log(`    line ${i + 1}: name="${it.name}" qty=${it.quantity} unit_price=${it.unit_price} tax=${taxN}% discount=${it.discount ?? 0}`);
    });
}

// ── Scenario 1: tax_rate override (Shopify says 23%, merchant wants 6%) ────
// taxes_included = true, line price = 24.60 gross. Default would be 20.00 net @ 23%.
// Override to 6% → net = 24.60/1.06 = 23.207547... → ceil to 23.21, target gross 24.60
{
    const raw = {
        taxes_included: true,
        line_items: [{ id: 1, sku: "BOOK-001", title: "Book", quantity: 1, price: "24.60", tax_lines: [{ rate: 0.23 }] }],
    };
    const overrides = new Map([["BOOK-001", { tax_rate: 6 }]]);
    const items = buildItemsFromRaw(raw, overrides);
    // After override: rate=6, included=true (from shop), net=24.60/1.06≈23.2076 → ceil 23.21
    // line_subtotal_send=23.21*1.06=24.6026 → minus a discount % to land on 24.60
    // Net the adapter sends * (1+0.06) should = 24.60
    assert("Override tax 23% → 6% (taxes_included shop)", 24.60, items);
}

// ── Scenario 2: vat_inclusion override (shop=inc but this SKU should be exc) ─
// Shop is inc, line price=20.00. Default would treat 20.00 as gross → net 20/1.23≈16.26.
// Override to "exc" → treat 20.00 as net → gross 20*1.23=24.60.
{
    const raw = {
        taxes_included: true,
        line_items: [{ id: 1, sku: "STELLA-EXC", title: "Stella exc-not-inc", quantity: 1, price: "20.00", tax_lines: [{ rate: 0.23 }] }],
    };
    const overrides = new Map([["STELLA-EXC", { vat_inclusion: "exc" }]]);
    const items = buildItemsFromRaw(raw, overrides);
    // With override exc: net=20.00 → gross 20 * 1.23 = 24.60
    assert("Override vat_inclusion exc on inc shop (Stella case)", 24.60, items);
}

// ── Scenario 3: vat_inclusion override (shop=exc but this SKU is actually inc) ─
{
    const raw = {
        taxes_included: false,
        line_items: [{ id: 1, sku: "INC-PROD", title: "Inc Product", quantity: 1, price: "24.60", tax_lines: [{ rate: 0.23 }] }],
    };
    const overrides = new Map([["INC-PROD", { vat_inclusion: "inc" }]]);
    const items = buildItemsFromRaw(raw, overrides);
    // With override inc: net = 24.60/1.23 = 20.00 → gross stays 24.60
    assert("Override vat_inclusion inc on exc shop", 24.60, items);
}

// ── Scenario 4: name_override ────────────────────────────────────────────────
{
    const raw = {
        taxes_included: false,
        line_items: [{ id: 1, sku: "RENAME-ME", title: "Ugly Shopify Title v2", quantity: 1, price: "10.00", tax_lines: [{ rate: 0.23 }] }],
    };
    const overrides = new Map([["RENAME-ME", { name_override: "Premium Service" }]]);
    const items = buildItemsFromRaw(raw, overrides);
    const pass = items[0]?.name === "Premium Service";
    results.push({ label: "name_override replaces displayed name", expected: "Premium Service", actual: items[0]?.name, drift: 0, pass });
    console.log(`${pass ? "✓" : "✗"} name_override replaces displayed name`);
    console.log(`    expected name "Premium Service" / got "${items[0]?.name}"`);
}

// ── Scenario 5: mixed mapped + unmapped (override applies only to matching SKU) ─
{
    const raw = {
        taxes_included: false,
        line_items: [
            { id: 1, sku: "BOOK-001", title: "Book", quantity: 1, price: "10.00", tax_lines: [{ rate: 0.23 }] },
            { id: 2, sku: "TSHIRT-001", title: "T-shirt", quantity: 1, price: "20.00", tax_lines: [{ rate: 0.23 }] },
        ],
    };
    const overrides = new Map([["BOOK-001", { tax_rate: 6 }]]); // only book gets 6%
    const items = buildItemsFromRaw(raw, overrides);
    // Book: 10.00 * 1.06 = 10.60 gross
    // T-shirt: 20.00 * 1.23 = 24.60 gross
    // Total expected gross 35.20
    assert("Override applies per-SKU; other lines unaffected", 35.20, items);
    const bookTax = items[0]?.tax;
    const tshirtTax = items[1]?.tax;
    console.log(`    book tax=${bookTax}% (expected 6) — t-shirt tax=${tshirtTax}% (expected 23)`);
    if (bookTax !== 6 || tshirtTax !== 23) {
        results[results.length - 1].pass = false;
    }
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log("\n========================================");
console.log("IX OVERRIDES SUMMARY");
console.log("========================================");
for (const r of results) console.log(`  ${r.pass ? "✓" : "✗"}  ${r.label}`);
if (results.some(r => !r.pass)) process.exit(1);
console.log(`\n${results.length} scenarios all passed.`);
