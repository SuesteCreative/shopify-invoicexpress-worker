import { describe, it, expect } from "vitest";
import { decideVat, ossRateFor, ossCountry, ptRegionalRate, EU_STANDARD_VAT_RATES } from "./tax-rates";
import { computeExpectedGross } from "./reconcile";
import type { AdapterCtx } from "./types";

/**
 * The engine rewrites the VAT on a line. The one thing it must never do is
 * change what the customer paid — `reconcileTotalOrThrow` compares the document
 * against the payment and refuses the sale on a one-cent drift, and it is not
 * modified by any of this. So the headline test is arithmetic, not behaviour.
 */

function line(over: Partial<any> = {}) {
  return {
    id: 1, product_id: 0, variant_id: 0, quantity: 1,
    unit_price: 100, unit_price_calculated: 100, subtotal_calculated: 100,
    tax: { name: "VAT", value: 0, unit_amount: 0 },
    discount: { name: "", percent: 0 },
    title: "Fundamentals", variant_title: null, sku: "",
    fulfilled: true, fulfilled_quantity: 1, fulfillment_status: "fulfilled",
    ...over,
  };
}

function normalized(country: string, items: any[] = [line()]) {
  return {
    order: {
      shipping_address: { country_code: country },
      billing_address: { country_code: country },
      customer: {},
      items,
    },
    refunds: [], exchanges: [], credits: [], debits: [],
  } as any;
}

function ctx(over: {
  engine?: boolean; gross?: boolean; dest?: any; overrides?: any; mappings?: any;
  derive?: boolean; vies?: boolean | null;
} = {}): AdapterCtx {
  return {
    apiKey: "k",
    config: {
      vat_included: over.gross === false ? 0 : 1,
      ix_derive_exemption: over.derive ? 1 : 0,
    } as any,
    destinationConfig: { oss_engine: over.engine === false ? 0 : 1, ...(over.dest ?? {}) },
    productOverrides: over.overrides,
    productMappings: over.mappings,
    // Absent unless the case says otherwise: a connection that never declared a
    // reverse-charge registration gets no VIES checker built for it either.
    viesChecker: over.vies === undefined ? undefined : async () => over.vies ?? null,
  } as any;
}

/** An order carrying a VAT number where the extractor actually looks. */
function b2bOrder(country: string, vat: string, items: any[] = [line()]) {
  const n = normalized(country, items);
  n.order.billing_address.company = vat;
  return n;
}

/** A Portuguese order, with the customer's postal code where the rule reads it. */
function ptOrder(zip: string, items: any[] = [line()]) {
  const n = normalized("PT", items);
  n.order.billing_address.zip = zip;
  return n;
}

/** The regional regime alone, as MeetFrank must have it: OSS off. */
const regionalOnly = (extra: any = {}) => ctx({ engine: false, dest: { pt_regional_rates: true, ...extra } });

/** What the reconciliation guard will compute from these lines. */
const grossOf = (items: any[]) => computeExpectedGross(items.map((i) => ({
  quantity: i.quantity,
  unit_price: i.unit_price,
  tax_rate: i.tax.value,
  discount_percent: i.discount?.percent ?? 0,
  discount_amount: i.discount_allocation_amount ?? 0,
  name: i.title,
})));

describe("the money does not move when the rate does", () => {
  it("re-rates a French sale from 0% to 20% and still totals what was paid", async () => {
    const n = normalized("FR");
    const paid = grossOf(n.order.items);
    expect(paid).toBe(100);

    const out = await decideVat(n, ctx(), "invoicexpress");

    expect(out.changed).toBe(1);
    expect(out.country).toBe("FR");
    expect(n.order.items[0].tax.value).toBe(20);
    // The exact net is 83,3333, which two decimals cannot hold. The line is
    // therefore expressed as IX accepts one: the net CEILED to 2dp, plus the
    // discount percentage that brings the subtotal back to the exact target.
    expect(n.order.items[0].unit_price).toBe(83.34);
    expect(n.order.items[0].discount.percent).toBeGreaterThan(0);
    expect(n.order.items[0].tax.unit_amount).toBeCloseTo(16.67, 2);
    // The whole point.
    expect(grossOf(n.order.items)).toBe(paid);
  });

  it("holds the total through a monetary allocation and a percentage discount at once", async () => {
    // Two discounts of different kinds on one line, both already inside the
    // gross being preserved. Getting either of them wrong shows up here and
    // nowhere else.
    const n = normalized("DE", [line({
      quantity: 3, unit_price: 40, unit_price_calculated: 40,
      discount_allocation_amount: 12, discount: { name: "promo", percent: 5 },
      tax: { name: "VAT", value: 6, unit_amount: 5.98 },
    })]);
    const paid = grossOf(n.order.items);

    await decideVat(n, ctx(), "invoicexpress");

    expect(n.order.items[0].tax.value).toBe(19);
    // Both discounts are folded into the one percentage IX honours: it ignores
    // `discount_amount` on POST, so scaling that field would have billed the
    // line at full price.
    expect(n.order.items[0].discount_allocation_amount).toBe(0);
    expect(n.order.items[0].discount.percent).toBeGreaterThan(0);
    expect(grossOf(n.order.items)).toBeCloseTo(paid, 2);
  });

  it("survives a quantity greater than one, where 2dp rounding bites hardest", async () => {
    // 3 x 60,00 at 0% re-rated to Ireland's 23%: the exact net per unit is
    // 48,7805, and three of those have to still add up to 180,00.
    const n = normalized("IE", [line({ quantity: 3, unit_price: 60, unit_price_calculated: 60 })]);
    const paid = grossOf(n.order.items);
    expect(paid).toBe(180);

    await decideVat(n, ctx(), "invoicexpress");

    expect(n.order.items[0].tax.value).toBe(23);
    expect(Number.isInteger(n.order.items[0].unit_price * 100)).toBe(true);
    expect(grossOf(n.order.items)).toBe(paid);
  });

  it("zero-rates a sale outside the EU and names the exemption", async () => {
    const n = normalized("US", [line({ tax: { name: "VAT", value: 23, unit_amount: 18.7 } })]);
    const paid = grossOf(n.order.items);
    const c = ctx();

    const out = await decideVat(n, c, "invoicexpress");

    expect(n.order.items[0].tax.value).toBe(0);
    expect(n.order.items[0].tax.unit_amount).toBe(0);
    expect(out.exemptionCode).toBe("M40");
    expect((c.config as any).ix_exemption_reason).toBe("M40");
    expect(grossOf(n.order.items)).toBeCloseTo(paid, 2);
  });

  it("uses the connection's own export exemption code when it states one", async () => {
    const n = normalized("CH");
    const c = ctx({ dest: { oss_export_exemption_code: "M05" } });
    expect((await decideVat(n, c, "invoicexpress")).exemptionCode).toBe("M05");
  });
});

describe("what the engine refuses to touch", () => {
  it("does nothing at all when the connection has not opted in", async () => {
    const n = normalized("FR");
    const out = await decideVat(n, ctx({ engine: false }), "invoicexpress");
    expect(out.enabled).toBe(false);
    expect(n.order.items[0].tax.value).toBe(0);
    expect(n.order.items[0].unit_price).toBe(100);
  });

  it("leaves the source's rate alone when the country is unknown", async () => {
    const n = normalized("");
    await decideVat(n, ctx(), "invoicexpress");
    expect(n.order.items[0].tax.value).toBe(0);
    expect(n.order.items[0].unit_price).toBe(100);
  });

  it("never overwrites a domestic reduced rate", async () => {
    // A Portuguese sale at 6% is a book or a hotel night. Re-rating it to the
    // standard 23% would break a correct invoice.
    const n = normalized("PT", [line({ tax: { name: "VAT", value: 6, unit_amount: 5.66 } })]);
    await decideVat(n, ctx(), "invoicexpress");
    expect(n.order.items[0].tax.value).toBe(6);
  });

  it("does fill in a domestic rate the source never charged", async () => {
    const n = normalized("PT");
    await decideVat(n, ctx(), "invoicexpress");
    expect(n.order.items[0].tax.value).toBe(23);
  });

  it("yields to a per-SKU override, which is a decision and not a gap", async () => {
    const n = normalized("FR", [line({ sku: "BOOK-1" })]);
    const overrides = new Map([["BOOK-1", { tax_rate: 6 }]]);
    await decideVat(n, ctx({ overrides }), "invoicexpress");
    expect(n.order.items[0].tax.value).toBe(0); // untouched — the override decides downstream
    expect(n.order.items[0].unit_price).toBe(100);
  });

  it("yields to the bookseller's ISBN rule without a per-title entry", async () => {
    const n = normalized("FR", [line({ sku: "9781234567897" })]);
    const overrides = new Map([["RIOKO-ISBN-BOOK", { tax_rate: 6 }]]);
    await decideVat(n, ctx({ overrides }), "invoicexpress");
    expect(n.order.items[0].unit_price).toBe(100);
  });

  it("yields to a mapped Moloni product, whose own tax rule the destination applies", async () => {
    // Rewriting the net underneath a mapped product leaves the document
    // totalling something other than what was paid, and Moloni's money guard
    // then refuses the sale outright.
    const n = normalized("FR", [line({ sku: "price_abc" })]);
    const mappings = new Map([["price_abc", 4242]]);
    await decideVat(n, ctx({ mappings }), "moloni");
    expect(n.order.items[0].unit_price).toBe(100);
  });
});

describe("when the rate cannot be applied, it holds instead of guessing", () => {
  it("refuses to add VAT on top of a net price, and says why", async () => {
    // vat_included = 0 means the price does not contain the tax, so a rate
    // change would grow the total past what was paid. The document goes out at
    // the rate actually charged, as a draft, with a notice.
    const n = normalized("FR");
    const out = await decideVat(n, ctx({ gross: false }), "invoicexpress");

    expect(out.changed).toBe(0);
    expect(n.order.items[0].unit_price).toBe(100);
    expect(n.order.items[0].tax.value).toBe(0);
    expect(out.holdReason).toContain("20%");
  });

  it("refuses a foreign rate Vendus would silently mis-declare", async () => {
    // Vendus maps a rate to one of four Portuguese codes and computes the VAT
    // from the code. 20% becomes "OUT": right total, wrong breakdown, no error.
    const n = normalized("FR");
    const out = await decideVat(n, ctx(), "vendus");
    expect(out.changed).toBe(0);
    expect(out.holdReason).toContain("Vendus");
  });

  it("still serves Vendus the rates it can express", async () => {
    const n = normalized("US", [line({ tax: { name: "VAT", value: 23, unit_amount: 18.7 } })]);
    const out = await decideVat(n, ctx(), "vendus");
    expect(out.changed).toBe(1);
    expect(n.order.items[0].tax.value).toBe(0);
  });
});

describe("the rate table and the country rule", () => {
  it("covers all 27 member states", async () => {
    expect(Object.keys(EU_STANDARD_VAT_RATES)).toHaveLength(27);
    for (const [cc, rate] of Object.entries(EU_STANDARD_VAT_RATES)) {
      expect(rate, cc).toBeGreaterThan(14);
      expect(rate, cc).toBeLessThan(30);
    }
  });

  it("follows the shipping address, then billing — the opposite of the client block", async () => {
    expect(ossCountry({ shipping_address: { country_code: "fr" }, billing_address: { country_code: "PT" } } as any)).toBe("FR");
    expect(ossCountry({ shipping_address: {}, billing_address: { country_code: "ES" } } as any)).toBe("ES");
    expect(ossCountry({ shipping_address: {}, billing_address: {}, customer: {} } as any)).toBe("");
  });

  it("answers null for a country it has no rate for, rather than guessing", async () => {
    expect(ossRateFor("", 0)).toBeNull();
    expect(ossRateFor("FR", 0)).toBe(20);
    expect(ossRateFor("US", 23)).toBe(0);
    expect(ossRateFor("PT", 6)).toBeNull();
  });
});

describe("Portugal's regional rates, which follow the customer's domicile", () => {
  it("bills a Madeira customer at 22% WITHOUT the OSS engine", async () => {
    // The whole reason this is its own flag. MeetFrank's regime is B2B reverse
    // charge; enabling OSS for them would put foreign VAT on an invoice that
    // must carry none. They still need 22% and 16%.
    const n = ptOrder("9000-063", [line({ tax: { name: "VAT", value: 23, unit_amount: 18.7 } })]);
    const paid = grossOf(n.order.items);

    const out = await decideVat(n, regionalOnly(), "invoicexpress");

    expect(out.enabled).toBe(true);
    expect(n.order.items[0].tax.value).toBe(22);
    expect(grossOf(n.order.items)).toBeCloseTo(paid, 2);
  });

  it("bills an Azores customer at 16%, the case that had to be issued by hand", async () => {
    // Carlos Arruda, 299,00 €, 08/09/2026: no path through the worker could
    // produce 16%, so the document was written straight against the API.
    const n = ptOrder("9500-100", [line({ unit_price: 299, unit_price_calculated: 299 })]);
    const paid = grossOf(n.order.items);
    expect(paid).toBe(299);

    await decideVat(n, regionalOnly(), "invoicexpress");

    expect(n.order.items[0].tax.value).toBe(16);
    expect(grossOf(n.order.items)).toBe(299);
  });

  it("leaves the mainland alone", async () => {
    const n = ptOrder("1000-001", [line({ tax: { name: "VAT", value: 23, unit_amount: 18.7 } })]);
    await decideVat(n, regionalOnly(), "invoicexpress");
    expect(n.order.items[0].tax.value).toBe(23);
  });

  it("does not touch a reduced band it has no regional value for", async () => {
    // Madeira's reduced rates are 5% and 12%, which this does not carry. A line
    // already at 6% is left exactly as it is rather than guessed at 22%.
    const n = ptOrder("9000-063", [line({ tax: { name: "VAT", value: 6, unit_amount: 5.66 } })]);
    await decideVat(n, regionalOnly(), "invoicexpress");
    expect(n.order.items[0].tax.value).toBe(6);
  });

  it("does nothing when the connection has not asked for it", async () => {
    const n = ptOrder("9500-100");
    const out = await decideVat(n, ctx({ engine: false }), "invoicexpress");
    expect(out.enabled).toBe(false);
    expect(n.order.items[0].tax.value).toBe(0);
  });

  it("reads the billing address, where the customer IS — not where goods go", async () => {
    // The opposite of the OSS rule on purpose: a distance sale of goods is
    // taxed where they GO, a supply of services where the customer IS.
    const n = ptOrder("9700-100");
    n.order.shipping_address.zip = "1000-001";
    await decideVat(n, regionalOnly(), "invoicexpress");
    expect(n.order.items[0].tax.value).toBe(16);
  });

  it("maps the postal ranges, including Porto Santo", async () => {
    expect(ptRegionalRate("9000-063")).toBe(22);
    expect(ptRegionalRate("9400-100")).toBe(22); // Porto Santo, part of Madeira
    expect(ptRegionalRate("9500-100")).toBe(16);
    expect(ptRegionalRate("9900-000")).toBe(16); // Horta
    expect(ptRegionalRate("8999-999")).toBeNull();
    expect(ptRegionalRate("")).toBeNull();
    expect(ptRegionalRate("900")).toBeNull();
  });

  it("still lets the OSS engine decide the foreign countries when both are on", async () => {
    const n = normalized("FR");
    await decideVat(n, ctx({ dest: { pt_regional_rates: true } }), "invoicexpress");
    expect(n.order.items[0].tax.value).toBe(20);
  });
});

describe("the regime is one decision, and it reaches every destination", () => {
  it("touches nothing at all when the connection declared no registration", async () => {
    // THE CONSTRAINT TEST. It is the mechanical proof of "nothing changes for a
    // merchant who changed no config", and it fails the moment a rung forgets to
    // check its own flag.
    const n = b2bOrder("DE", "DE123456789");
    const before = JSON.stringify(n);

    const out = await decideVat(n, ctx({ engine: false, vies: true }), "invoicexpress");

    expect(out.enabled).toBe(false);
    expect(out.regime).toBe("off");
    expect(JSON.stringify(n)).toBe(before);
  });

  it("invoices a VIES-confirmed company at 0% with autoliquidação", async () => {
    const n = b2bOrder("DE", "DE123456789");
    const paid = grossOf(n.order.items);
    const c = ctx({ engine: false, vies: true, dest: { b2b_reverse_charge_pipeline: true } });

    const out = await decideVat(n, c, "invoicexpress");

    expect(out.regime).toBe("reverse_charge");
    expect(n.order.items[0].tax.value).toBe(0);
    expect(out.exemptionCode).toBe("M16");
    expect(out.fiscal?.mention).toContain("DE123456789");
    expect(grossOf(n.order.items)).toBeCloseTo(paid, 2);
  });

  it("reaches Moloni and Vendus with the same lines and the same code", async () => {
    // The whole point of deciding this before any destination sees the order:
    // until now reverse charge existed only inside the InvoiceXpress builder.
    for (const dest of ["moloni", "vendus"] as const) {
      const n = b2bOrder("DE", "DE123456789");
      const c = ctx({ engine: false, vies: true, dest: { b2b_reverse_charge_pipeline: true } });

      const out = await decideVat(n, c, dest);

      expect(out.regime, dest).toBe("reverse_charge");
      expect(n.order.items[0].tax.value, dest).toBe(0);
      expect((c.destinationConfig as any).exemption_reason, dest).toBe("M16");
    }
  });

  it("treats a business outside the EU as an export, not a reverse charge", async () => {
    // A Swiss buyer who supplied a German VAT number. The answer is export, and
    // it stays export even with the reverse-charge registration on and VIES
    // saying yes — because leaving the EU outranks who the buyer is.
    //
    // Measured, not assumed: swapping the two rungs in `resolveRegime` does NOT
    // fail this, because `classifyExemption` already tests non-EU before
    // anything B2B and never returns `intra_eu_b2b` for CH. The order here is
    // defence in depth, and this pins the OUTCOME rather than which layer
    // produced it.
    const n = b2bOrder("CH", "DE123456789");
    const c = ctx({ vies: true, derive: true, dest: { b2b_reverse_charge_pipeline: true } });

    const out = await decideVat(n, c, "invoicexpress");

    expect(out.regime).toBe("export");
    expect(out.exemptionCode).toBe("M05");
  });

  it("holds the draft instead of guessing when VIES does not answer", async () => {
    // The two candidate answers here are 0% and Germany's 19%, and choosing
    // wrong declares a regime nobody verified. With OSS also on it would be very
    // easy to fall through to the consumer rung and do exactly that.
    const n = b2bOrder("DE", "DE123456789");
    const c = ctx({ vies: null, dest: { b2b_reverse_charge_pipeline: true } });

    const out = await decideVat(n, c, "invoicexpress");

    expect(out.regime).toBe("reverse_charge_unverified");
    expect(out.changed).toBe(0);
    expect(n.order.items[0].tax.value).toBe(0);
    expect(out.hold).toBeTruthy();
  });

  it("names the regime without moving money when only the naming is asked for", async () => {
    // `ix_derive_exemption` has never touched a rate and must not start: it is
    // what keeps every connection that has it today identical.
    const n = normalized("US", [line({ tax: { name: "VAT", value: 23, unit_amount: 18.7 } })]);
    const c = ctx({ engine: false, derive: true });

    const out = await decideVat(n, c, "invoicexpress");

    expect(out.regime).toBe("export");
    expect(out.changed).toBe(0);
    expect(n.order.items[0].tax.value).toBe(23);
    expect(out.fiscal?.exemptionCode).toBe("M05");
  });

  it("asks VIES nothing when no registration wants the answer", async () => {
    // VIES is a slow external call that fails and times out. It must never sit
    // on the invoicing path of a merchant who did not ask a question it answers.
    let asked = 0;
    const c = ctx({ dest: {} }) as any;
    c.viesChecker = async () => { asked++; return true; };

    await decideVat(b2bOrder("DE", "DE123456789"), c, "invoicexpress");

    expect(asked).toBe(0);
  });
});
