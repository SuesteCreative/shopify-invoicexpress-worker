/**
 * Splitting one Stripe amount into the lines it was actually made of.
 *
 * Every figure here was measured against Escola Lá Fora's live Stripe account and
 * their Paperform price list on 14-15/09/2026, rather than invented: the whole
 * method rests on the arithmetic reproducing the charged total exactly, and an
 * invented example proves nothing about that.
 */
import { describe, it, expect } from "vitest";
import {
  parseLineSplit, parseDescriptionItems, solveBases, splitStripePayment, undecomposedLine,
} from "./stripe-line-split";
import { StripeSource } from "./stripe-source";

const RECIPE = JSON.stringify({
  base: { sku: "ELF-UNI", rate: 0 },
  fee: {
    sku: "ELF-TAXA", rate: 23, title: "Taxa de processamento de pagamento online",
    rules: [
      { pct: 1.5, fixed_cents: 25 },
      { pct: 1.5, fixed_cents: 0 },
      { pct: 1.5, fixed_cents: 25, trunc: true },
      { pct: 1.5, fixed_cents: 0, trunc: true },
      { pct: 0, fixed_cents: 0 },
    ],
  },
  classify: [{ match: "refei|almo[cç]|lanche|alimenta|brunch", sku: "ELF-REF", rate: 13 }],
  prices: {
    "Sessão Sábados Lá Fora": 2000,
    "Verão Lá Fora - 7 a 11 de setembro": 16500,
    "Refeições Férias Lá Fora Lisboa/Almada 2025/2026 - 5 dias": 3000,
    "Refeições Férias Lá Fora Lisboa/Almada 2025/2026 - 3 dias": 1800,
    "Visita de estudo com transporte": 500,
  },
});
const cfg = parseLineSplit(RECIPE)!;
const soma = (ls: { grossCents: number }[]) => ls.reduce((s, l) => s + l.grossCents, 0);

describe("parseLineSplit", () => {
  it("is off unless the connection wrote one", () => {
    expect(parseLineSplit(null)).toBeNull();
    expect(parseLineSplit("")).toBeNull();
    expect(parseLineSplit("{not json")).toBeNull();
  });

  it("refuses a recipe with no base treatment rather than half-applying it", () => {
    expect(parseLineSplit(JSON.stringify({ fee: { sku: "X" } }))).toBeNull();
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

describe("solveBases", () => {
  const R = (pct: number, fixedCents: number, trunc = false) => [{ pct, fixedCents, trunc }];

  it("recovers the price behind a 1,5% + 0,25 € charge", () => {
    // Sábados Lá Fora, 142 payments: 20,00 € charged as 20,55 €.
    expect(solveBases(2055, R(1.5, 25))[0].base).toBe(2000);
    // Bebés: 60,00 € charged as 61,15 €.
    expect(solveBases(6115, R(1.5, 25))[0].base).toBe(6000);
  });

  it("separates the two shapes the same 165,00 € week was charged under", () => {
    // 165 × 1,015 = 167,475. ROUND gives 167,48 (and +0,25 gives 167,73);
    // truncation gives 167,47. Both totals exist on this account, because the
    // fixed part was added to the form's formula partway through.
    expect(solveBases(16773, R(1.5, 25))[0].base).toBe(16500);
    expect(solveBases(16747, R(1.5, 0, true))[0].base).toBe(16500);
  });

  it("passes a no-fee form through untouched", () => {
    expect(solveBases(500, R(0, 0))[0].base).toBe(500);
  });

  it("answers nothing when no base reproduces the total", () => {
    expect(solveBases(500, R(1.5, 900))).toEqual([]);
    expect(solveBases(0, R(1.5, 25))).toEqual([]);
  });
});

describe("splitStripePayment", () => {
  it("splits the fee off a single-item sale", () => {
    expect(splitStripePayment(2055, "Inscrição Sábados Lá Fora - Sessão Sábados Lá Fora (x1)", cfg)).toEqual([
      { title: "Sessão Sábados Lá Fora", sku: "ELF-UNI", rate: 0, grossCents: 2000, qty: 1 },
      { title: "Taxa de processamento de pagamento online", sku: "ELF-TAXA", rate: 23, grossCents: 55, qty: 1 },
    ]);
  });

  it("gives the meals their own rate and the fee its own", () => {
    // 165,00 isento + 30,00 refeições = 195,00 → 197,92 cobrado (1,5 % truncado).
    const lines = splitStripePayment(19792,
      "Inscrição Verão Lá Fora 2026 - Verão Lá Fora - 7 a 11 de setembro (x1), Refeições Férias Lá Fora Lisboa/Almada 2025/2026 - 5 dias (x1)",
      cfg)!;
    expect(lines.map((l) => [l.sku, l.rate, l.grossCents])).toEqual([
      ["ELF-UNI", 0, 16500],
      ["ELF-REF", 13, 3000],
      ["ELF-TAXA", 23, 292],
    ]);
    expect(soma(lines)).toBe(19792);
  });

  it("multiplies a line by its quantity", () => {
    // 165,00 + 18,00 × 2 = 201,00 → 204,27 com 1,5 % + 0,25.
    const lines = splitStripePayment(20427,
      "Inscrição Verão Lá Fora 2026 - Verão Lá Fora - 7 a 11 de setembro (x1), Refeições Férias Lá Fora Lisboa/Almada 2025/2026 - 3 dias (x2)",
      cfg)!;
    const refeicoes = lines.find((l) => l.sku === "ELF-REF")!;
    expect(refeicoes).toMatchObject({ grossCents: 3600, qty: 2, rate: 13 });
    expect(soma(lines)).toBe(20427);
  });

  it("emits no fee line for a form that charges none", () => {
    const lines = splitStripePayment(500, "Autorização Visita Ericeira Domus - Visita de estudo com transporte (x1)", cfg)!;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ sku: "ELF-UNI", rate: 0, grossCents: 500 });
  });

  it("derives the price of an option the merchant has since repriced", () => {
    // 48 payments of 52,02 € name an inscription the form now sells at another
    // price. 51,00 + ROUND(0,765) + 0,25 = 52,02, so the total says what it was.
    const lines = splitStripePayment(5202, "Inscrição Bebés Lá Fora Lisboa 2025/2026 - Inscrição Bebés Lá Fora Lisboa 2025/2026 (x1)", cfg)!;
    expect(lines[0]).toMatchObject({ grossCents: 5100, derived: true, sku: "ELF-UNI" });
    expect(soma(lines)).toBe(5202);
  });

  it("refuses when two items are both unknown", () => {
    // Underdetermined: any split between them reproduces the total, so there is
    // no honest answer. These go to the manual list instead.
    expect(splitStripePayment(48339, "Inverno Lá Fora - Semana A (x1), Semana B (x1)", cfg)).toBeNull();
  });

  it("refuses when the arithmetic does not close", () => {
    expect(splitStripePayment(67, "Sessão Sábados Lá Fora (x1)", cfg)).toBeNull();
  });

  it("always adds back up to the money received", () => {
    for (const [total, desc] of [
      [2055, "Inscrição Sábados Lá Fora - Sessão Sábados Lá Fora (x1)"],
      [19792, "Inscrição Verão Lá Fora 2026 - Verão Lá Fora - 7 a 11 de setembro (x1), Refeições Férias Lá Fora Lisboa/Almada 2025/2026 - 5 dias (x1)"],
      [500, "Autorização Visita Ericeira Domus - Visita de estudo com transporte (x1)"],
    ] as Array<[number, string]>) {
      const lines = splitStripePayment(total, desc, cfg);
      expect(lines && soma(lines)).toBe(total);
    }
  });
});

describe("StripeSource emits the split as NET price + tax amount", () => {
  it("gives every line a rate the destination will actually honour", async () => {
    // The bug this pins: the first document Rioko issued came out with the
    // processing fee at "isento M07" instead of 23 %, because the lines were
    // emitted GROSS with tax.unit_amount left at 0 — and every destination reads
    // that zero as "the source stated no rate". Price and tax are one contract.
    const event = {
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_test", status: "succeeded", amount_received: 19792, currency: "eur", created: 1_789_000_000,
          description: "Inscrição Verão Lá Fora 2026 - Verão Lá Fora - 7 a 11 de setembro (x1), Refeições Férias Lá Fora Lisboa/Almada 2025/2026 - 5 dias (x1)",
        },
      },
    };
    const normalized = await new StripeSource().toNormalized(event, { config: { stripe_line_split: RECIPE } } as any);
    const items = normalized!.order.items as any[];

    expect(items.map((i) => [i.sku, i.tax.value])).toEqual([["ELF-UNI", 0], ["ELF-REF", 13], ["ELF-TAXA", 23]]);
    expect(items[0].unit_price).toBeCloseTo(165, 4);
    expect(items[1].unit_price).toBeCloseTo(3000 / 1.13 / 100, 4);
    expect(items[2].unit_price).toBeCloseTo(292 / 1.23 / 100, 4);

    // Net + VAT, summed, is the money received.
    const gross = items.reduce((s, it) => s + it.unit_price * (1 + it.tax.value / 100) * it.quantity, 0);
    expect(gross).toBeCloseTo(197.92, 2);
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

describe("an option's own commas are not item separators", () => {
  it("keeps a date range that contains commas as one option", () => {
    // 19 payments — every Inverno sale this merchant made — refused because
    // "29, 30 de dezembro e 2 de janeiro" was split into three items that
    // priced to nothing. The submission says it is one option at 140,00 €.
    expect(parseDescriptionItems(
      "Inscrição Inverno Lá Fora Lisboa 2025 - Inverno Lá Fora Lisboa - 29, 30 de dezembro e 2 de janeiro (x1), Refeições Férias Lá Fora Lisboa 2025/2026 - 3 dias (x1)",
    )).toEqual([
      { label: "Inscrição Inverno Lá Fora Lisboa 2025 - Inverno Lá Fora Lisboa - 29, 30 de dezembro e 2 de janeiro", qty: 1 },
      { label: "Refeições Férias Lá Fora Lisboa 2025/2026 - 3 dias", qty: 1 },
    ]);
  });

  it("treats a description with no quantities as one unnamed item", () => {
    expect(parseDescriptionItems("Subscription creation")).toEqual([{ label: "Subscription creation", qty: 1 }]);
  });
});

describe("the line keeps the option's whole name", () => {
  it("does not cut an option at its own dash", () => {
    // The first document with meals came out billing "5 dias" — the option's own
    // " - " was read as the form-title separator, so the family would have been
    // shown a line saying nothing about what they bought.
    const lines = splitStripePayment(19792,
      "Inscrição Verão Lá Fora 2026 - Verão Lá Fora - 7 a 11 de setembro (x1), Refeições Férias Lá Fora Lisboa/Almada 2025/2026 - 5 dias (x1)",
      parseLineSplit(JSON.stringify({
        base: { sku: "ELF-UNI", rate: 0 },
        fee: { sku: "ELF-TAXA", rate: 23, title: "Taxa", rules: [{ pct: 1.5, fixed_cents: 0, trunc: true }] },
        classify: [{ match: "refei", sku: "ELF-REF", rate: 13 }],
        forms: ["Inscrição Verão Lá Fora 2026"],
        prices: { "Verão Lá Fora - 7 a 11 de setembro": 16500, "Refeições Férias Lá Fora Lisboa/Almada 2025/2026 - 5 dias": 3000 },
      }))!)!;
    expect(lines.map((l) => l.title)).toEqual([
      "Verão Lá Fora - 7 a 11 de setembro",
      "Refeições Férias Lá Fora Lisboa/Almada 2025/2026 - 5 dias",
      "Taxa",
    ]);
  });
});

describe("a payment that cannot be solved still lands on the right article", () => {
  it("uses the connection's own article, never the Stripe id", async () => {
    // Two of eighty documents in the first real batch fell back to the source's
    // synthetic line, whose SKU is the payment id — so Moloni minted an article
    // called `pi_3S6Hih…`. The previous connector left dozens of those.
    // Two options the recipe does not price: underdetermined, so the solver
    // refuses and the fallback has to carry the line.
    const desc = "Inverno Lá Fora - Semana A (x1), Semana B (x1)";
    const event = {
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_naoResolve", status: "succeeded", amount_received: 5295, currency: "eur", created: 1, description: desc } },
    };
    const normalized = await new StripeSource().toNormalized(event, { config: { stripe_line_split: RECIPE } } as any);
    const items = normalized!.order.items as any[];
    expect(items).toHaveLength(1);
    expect(items[0].sku).toBe("ELF-UNI");
    expect(items[0].unit_price).toBeCloseTo(52.95, 2);
  });

  it("keeps the intermediate rate when the whole payment is food", () => {
    const line = undecomposedLine(4085, "Refeições Estoril - alguma coisa nova (x1)", cfg);
    expect(line).toMatchObject({ sku: "ELF-REF", rate: 13, grossCents: 4085 });
  });
});

describe("a fee rule can belong to one form", () => {
  // "Explorar Lá Fora" charges 2,95 € on a 50,00 € inscription: its formula
  // reads a 180,00 € reference price, not the amount charged. Declared as a
  // global rule, a fixed 2,95 would fit other forms' payments by accident.
  const scoped = parseLineSplit(JSON.stringify({
    base: { sku: "ELF-UNI", rate: 0 },
    fee: {
      sku: "ELF-TAXA", rate: 23, title: "Taxa",
      rules: [
        { match: "^Inscrição Explorar Lá Fora", pct: 0, fixed_cents: 295 },
        { pct: 1.5, fixed_cents: 25 },
      ],
    },
    forms: ["Inscrição Explorar Lá Fora Lisboa 2025/2026", "Inscrição Sábados Lá Fora"],
    prices: { "Inscrição Explorar Lá Fora Lisboa 2025/2026": 5000, "Sessão Sábados Lá Fora": 2000 },
  }))!;

  it("uses the form's own rule for its payments", () => {
    const lines = splitStripePayment(5295,
      "Inscrição Explorar Lá Fora Lisboa 2025/2026 - Inscrição Explorar Lá Fora Lisboa 2025/2026 (x1)", scoped)!;
    expect(lines.map((l) => [l.sku, l.grossCents])).toEqual([["ELF-UNI", 5000], ["ELF-TAXA", 295]]);
  });

  it("never tries it on another form's payment", () => {
    const lines = splitStripePayment(2055, "Inscrição Sábados Lá Fora - Sessão Sábados Lá Fora (x1)", scoped)!;
    expect(lines.map((l) => [l.sku, l.grossCents])).toEqual([["ELF-UNI", 2000], ["ELF-TAXA", 55]]);
  });
});
