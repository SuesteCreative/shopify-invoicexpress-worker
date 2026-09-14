/**
 * Splitting one Stripe amount into the lines it was actually made of.
 *
 * Every figure here was measured against Escola Lá Fora's live Stripe account on
 * 14/09/2026 — 916 single-item payments across 25 forms — rather than invented,
 * because the whole method rests on the fee arithmetic reproducing the charged
 * total exactly, and an invented example proves nothing about that.
 */
import { describe, it, expect } from "vitest";
import {
  parseLineSplit, parseDescriptionItems, solveBaseCents, splitStripePayment,
} from "./stripe-line-split";
import { StripeSource } from "./stripe-source";

const RECIPE = JSON.stringify({
  base: { sku: "ELF-UNI", rate: 0 },
  fee: {
    sku: "ELF-TAXA", rate: 23, title: "Taxa de processamento de pagamento online",
    pct: 1.5, fixed_cents: 25,
    by_form: [
      { match: "^Inscrição Verão Lá Fora 2026", pct: 1.5, fixed_cents: 0 },
      { match: "^Autorização Visita", pct: 0, fixed_cents: 0 },
    ],
  },
  prices: {
    "Refeições Estoril - Refeições Férias Lá Fora Estoril 2025/2026 - 5 dias": { cents: 4000, sku: "ELF-REF", rate: 13 },
    "Inscrição Dias Lá Fora - 1 Semana (5 Dias)": { cents: 16500, sku: "ELF-UNI", rate: 0 },
  },
});

const cfg = parseLineSplit(RECIPE)!;

describe("parseLineSplit", () => {
  it("is off unless the connection wrote one", () => {
    expect(parseLineSplit(null)).toBeNull();
    expect(parseLineSplit("")).toBeNull();
  });

  it("refuses a recipe with no base treatment rather than half-applying it", () => {
    expect(parseLineSplit(JSON.stringify({ fee: { sku: "X" } }))).toBeNull();
  });

  it("survives a malformed blob", () => {
    expect(parseLineSplit("{not json")).toBeNull();
  });
});

describe("parseDescriptionItems", () => {
  it("reads the items and their quantities", () => {
    expect(parseDescriptionItems(
      "Inscrição Verão Lá Fora 2026 - Verão Lá Fora - 7 a 11 de setembro (x1), Refeições Férias Lá Fora Lisboa/Almada 2025/2026 - 5 dias (x2)",
    )).toEqual([
      { label: "Inscrição Verão Lá Fora 2026 - Verão Lá Fora - 7 a 11 de setembro", qty: 1 },
      { label: "Refeições Férias Lá Fora Lisboa/Almada 2025/2026 - 5 dias", qty: 2 },
    ]);
  });

  it("does not split on a comma inside a label's own brackets", () => {
    expect(parseDescriptionItems("Carnaval Lá Fora - Carnaval (16, 17 e 18) (x1)"))
      .toEqual([{ label: "Carnaval Lá Fora - Carnaval (16, 17 e 18)", qty: 1 }]);
  });
});

describe("solveBaseCents", () => {
  it("recovers the price behind a 1,5% + 0,25 € charge", () => {
    // Sábados Lá Fora, 142 payments: 20,00 € charged as 20,55 €.
    expect(solveBaseCents(2055, { pct: 1.5, fixedCents: 25 })).toBe(2000);
    // Sessões Avulsas: 30,00 € charged as 30,70 €.
    expect(solveBaseCents(3070, { pct: 1.5, fixedCents: 25 })).toBe(3000);
    // Bebés: 60,00 € charged as 61,15 €.
    expect(solveBaseCents(6115, { pct: 1.5, fixedCents: 25 })).toBe(6000);
  });

  it("truncates the percentage, as Paperform does", () => {
    // 165,00 × 1,015 = 167,475. Charged 167,47, never 167,48 — this is the case
    // that makes rounding the wrong operation.
    expect(solveBaseCents(16747, { pct: 1.5, fixedCents: 0 })).toBe(16500);
    expect(solveBaseCents(19792, { pct: 1.5, fixedCents: 0 })).toBe(19500);
    expect(solveBaseCents(20807, { pct: 1.5, fixedCents: 0 })).toBe(20500);
  });

  it("passes a no-fee form through untouched", () => {
    expect(solveBaseCents(493, { pct: 0, fixedCents: 0 })).toBe(493);
  });

  it("answers null when no base reproduces the total", () => {
    // A fee bigger than the payment: there is no positive base behind it.
    expect(solveBaseCents(500, { pct: 1.5, fixedCents: 900 })).toBeNull();
    // A total the fee function can never produce: it steps from 66 (base 66) to
    // 68 (base 67), so 67 is not reachable and must not be forced to fit.
    expect(solveBaseCents(67, { pct: 1.5, fixedCents: 0 })).toBeNull();
    expect(solveBaseCents(0, { pct: 1.5, fixedCents: 25 })).toBeNull();
  });
});

describe("splitStripePayment", () => {
  it("splits the fee out of a sale with no price list", () => {
    const lines = splitStripePayment(6115, "Inscrição Bebés Lá Fora Lisboa 2025/2026 - Inscrição (x1)", cfg);
    expect(lines).toEqual([
      { title: "Inscrição Bebés Lá Fora Lisboa 2025/2026 - Inscrição (x1)", sku: "ELF-UNI", rate: 0, grossCents: 6000, qty: 1 },
      { title: "Taxa de processamento de pagamento online", sku: "ELF-TAXA", rate: 23, grossCents: 115, qty: 1 },
    ]);
  });

  it("uses the form's own fee rule over the default", () => {
    // Verão charges the percentage and no fixed part: 195,00 → 197,92.
    const lines = splitStripePayment(19792, "Inscrição Verão Lá Fora 2026 - Verão Lá Fora - 7 a 11 de setembro (x1)", cfg)!;
    expect(lines.map((l) => [l.sku, l.grossCents])).toEqual([["ELF-UNI", 19500], ["ELF-TAXA", 292]]);
  });

  it("emits no fee line for a form that charges none", () => {
    const lines = splitStripePayment(493, "Autorização Visita Ericeira Domus - Visita de estudo (x1)", cfg)!;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ sku: "ELF-UNI", rate: 0, grossCents: 493 });
  });

  it("gives each named item its own rate once the prices are known", () => {
    // 165,00 (isento) + 40,00 (refeições, 13%) = 205,00 → 208,07 charged.
    const desc = "Inscrição Dias Lá Fora - 1 Semana (5 Dias) (x1), Refeições Estoril - Refeições Férias Lá Fora Estoril 2025/2026 - 5 dias (x1)";
    const lines = splitStripePayment(20807, desc, { ...cfg, fee: { ...cfg.fee!, byForm: [{ match: /^Inscrição Dias/i, pct: 1.5, fixedCents: 0 }] } })!;
    expect(lines.map((l) => [l.sku, l.rate, l.grossCents])).toEqual([
      ["ELF-UNI", 0, 16500],
      ["ELF-REF", 13, 4000],
      ["ELF-TAXA", 23, 307],
    ]);
  });

  it("falls back to one base line when a priced item is missing", () => {
    // The meals option has no declared price yet: better a coarse base line with
    // the fee correctly split off than an invented 13% figure.
    const desc = "Inscrição Dias Lá Fora - 1 Semana (5 Dias) (x1), Refeições Férias Lá Fora Lisboa 2025/2026 (x1)";
    const lines = splitStripePayment(20807, desc, { ...cfg, fee: { ...cfg.fee!, byForm: [{ match: /^Inscrição Dias/i, pct: 1.5, fixedCents: 0 }] } })!;
    expect(lines.map((l) => l.sku)).toEqual(["ELF-UNI", "ELF-TAXA"]);
    expect(lines.reduce((s, l) => s + l.grossCents, 0)).toBe(20807);
  });

  it("falls back when the declared prices do not add up to the base", () => {
    // A discounted sale: the items are known but the buyer paid less. Inventing
    // lines that sum to more than the payment is the failure mode to avoid.
    const desc = "Inscrição Dias Lá Fora - 1 Semana (5 Dias) (x1)";
    const lines = splitStripePayment(15000, desc, { ...cfg, fee: { ...cfg.fee!, byForm: [{ match: /^Inscrição Dias/i, pct: 0, fixedCents: 0 }] } })!;
    expect(lines).toHaveLength(1);
    expect(lines[0].grossCents).toBe(15000);
  });

  it("refuses rather than guess when the fee arithmetic does not close", () => {
    expect(splitStripePayment(500, "Qualquer coisa (x1)", parseLineSplit(JSON.stringify({
      base: { sku: "ELF-UNI", rate: 0 },
      fee: { sku: "ELF-TAXA", rate: 23, pct: 1.5, fixed_cents: 900 },
    }))!)).toBeNull();
  });

  it("always adds back up to the money received", () => {
    for (const total of [2055, 3070, 6115, 16747, 19792, 20807, 13524, 493]) {
      const lines = splitStripePayment(total, "Inscrição Sábados Lá Fora - Sessão (x1)", cfg);
      if (lines) expect(lines.reduce((s, l) => s + l.grossCents, 0)).toBe(total);
    }
  });
});

describe("StripeSource emits the split as NET price + tax amount", () => {
  it("gives the fee line a rate the destination will actually honour", async () => {
    // The bug this pins: the first document Rioko issued for this merchant came
    // out with the processing fee at "isento M07" instead of 23 %, because the
    // lines were emitted GROSS with tax.unit_amount left at 0 — and every
    // destination reads that zero as "the source stated no rate", falling through
    // to the connection's default of 0. Price and tax amount are one contract.
    const event = {
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_3UFVmyBp3wyQk8MN0AdXDzRK",
          status: "succeeded",
          amount_received: 6115,
          currency: "eur",
          created: 1_789_000_000,
          description: "Inscrição Sessões Experimentais / Avulsas - Sessão Avulsa (x1)",
        },
      },
    };
    const normalized = await new StripeSource().toNormalized(event, { config: { stripe_line_split: RECIPE } } as any);
    const items = normalized!.order.items;

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ sku: "ELF-UNI", quantity: 1, unit_price: 60 });
    expect(items[0].tax).toMatchObject({ value: 0, unit_amount: 0 });

    expect(items[1]).toMatchObject({ sku: "ELF-TAXA", quantity: 1 });
    expect(items[1].tax.value).toBe(23);
    // Net 0,935 + 0,215 of VAT = the 1,15 that was charged.
    expect(items[1].unit_price).toBeCloseTo(0.935, 4);
    expect(items[1].tax.unit_amount).toBeCloseTo(0.215, 4);

    // The whole point: net + VAT, summed, is the money received.
    const gross = items.reduce((s, it: any) => s + (it.unit_price * (1 + it.tax.value / 100)) * it.quantity, 0);
    expect(gross).toBeCloseTo(61.15, 2);
  });

  it("leaves a payment alone when the connection declared no recipe", async () => {
    const event = {
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_x", status: "succeeded", amount_received: 6115, currency: "eur", created: 1, description: "Seja o que for (x1)" } },
    };
    const normalized = await new StripeSource().toNormalized(event, { config: {} } as any);
    expect(normalized!.order.items).toHaveLength(1);
  });
});
