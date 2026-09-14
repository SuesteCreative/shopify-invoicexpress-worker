/**
 * One Stripe payment, several fiscal lines.
 *
 * A PaymentIntent is a single number. Nothing in it says that 60,00 € of it was
 * an exempt enrolment and 1,15 € was a card-processing fee that carries VAT at
 * the standard rate — Stripe has no line items for a payment created through
 * the API, and the forms app that created it wrote only a description. So a
 * connection whose money arrives that way gets ONE line at one rate, and any
 * part of the sale taxed differently is silently declared at the wrong one.
 *
 * Measured on Escola Lá Fora, 14/09/2026: 1.320 payments, 194.912,28 €, every
 * one of them a single amount, and the connector that preceded Rioko issued 506
 * documents with a single line each — 289 exempt and 217 at 13 %, on sales that
 * were the same thing, because the rate came from whichever Moloni article it
 * happened to resolve rather than from the sale.
 *
 * What IS recoverable from the payment is arithmetic. A processing fee is a
 * stated percentage plus a stated fixed amount, applied to the rest, so the
 * split is the unique base that reproduces the charged total to the cent. This
 * module solves that, and — when the connection also declares the price of the
 * things being sold — splits the base into its named items too.
 *
 * It refuses rather than guesses. Every path returns null unless the emitted
 * lines add back up to exactly what was charged, because a document whose lines
 * do not sum to the money received is worse than a coarse one.
 */

/** A line the split produced, priced GROSS (what the buyer paid for it). */
export interface SplitLine {
  title: string;
  /** The destination's product reference — `deriveProductReference` reads it. */
  sku: string;
  /** VAT rate as a percentage. 0 means exempt, and the connection's exemption
   *  code applies. */
  rate: number;
  /** Gross cents for the WHOLE line (unit × qty), so the caller never re-derives. */
  grossCents: number;
  qty: number;
}

interface FeeRule {
  /** Percentage of the base, e.g. 1.5. */
  pct: number;
  fixedCents: number;
}

export interface LineSplitConfig {
  fee: FeeRule & {
    sku: string;
    rate: number;
    title: string;
    /** Per-form overrides, first match wins. The same merchant runs forms with
     *  different fee settings — measured here: "Verão Lá Fora" charges 1,5 % and
     *  no fixed part, everything else 1,5 % + 0,25 €, and one form charges no
     *  fee at all. */
    byForm: Array<{ match: RegExp; pct: number; fixedCents: number }>;
  } | null;
  /** What an item with no declared price is. */
  base: { sku: string; rate: number };
  /** Declared price and tax treatment per item label, exact match. */
  prices: Map<string, { cents: number; sku: string; rate: number }>;
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Read the connection's recipe. Returns null when it declared none, which is
 * every connection but the ones that need this.
 */
export function parseLineSplit(raw: unknown): LineSplitConfig | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let doc: any;
  try {
    doc = JSON.parse(raw);
  } catch {
    console.warn("[Stripe] stripe_line_split is not valid JSON — ignoring it");
    return null;
  }
  if (!doc || typeof doc !== "object") return null;

  const base = {
    sku: String(doc.base?.sku ?? "").trim(),
    rate: num(doc.base?.rate, 0),
  };
  if (!base.sku) {
    console.warn("[Stripe] stripe_line_split has no base.sku — ignoring it");
    return null;
  }

  let fee: LineSplitConfig["fee"] = null;
  if (doc.fee && typeof doc.fee === "object" && String(doc.fee.sku ?? "").trim()) {
    const byForm: Array<{ match: RegExp; pct: number; fixedCents: number }> = [];
    for (const r of Array.isArray(doc.fee.by_form) ? doc.fee.by_form : []) {
      const pattern = String(r?.match ?? "").trim();
      if (!pattern) continue;
      try {
        byForm.push({ match: new RegExp(pattern, "i"), pct: num(r.pct, 0), fixedCents: num(r.fixed_cents, 0) });
      } catch {
        console.warn(`[Stripe] stripe_line_split: bad regex ${pattern} — skipping that rule`);
      }
    }
    fee = {
      sku: String(doc.fee.sku).trim(),
      rate: num(doc.fee.rate, 0),
      title: String(doc.fee.title ?? "Taxa de processamento").trim(),
      pct: num(doc.fee.pct, 0),
      fixedCents: num(doc.fee.fixed_cents, 0),
      byForm,
    };
  }

  const prices = new Map<string, { cents: number; sku: string; rate: number }>();
  for (const [label, spec] of Object.entries(doc.prices ?? {})) {
    const s = spec as any;
    const cents = Math.round(num(s?.cents, NaN));
    if (!Number.isFinite(cents) || cents < 0) continue;
    prices.set(label.trim(), { cents, sku: String(s?.sku ?? base.sku).trim() || base.sku, rate: num(s?.rate, base.rate) });
  }

  return { fee, base, prices };
}

/**
 * The items a forms app names in the payment's description.
 *
 * The shape it writes is `"<form> - <option> (xN), <form> - <option> (xN)"`. The
 * split on commas deliberately ignores commas inside brackets, because option
 * labels contain them ("Verão Lá Fora - 3 a 7 de agosto, manhãs").
 */
export function parseDescriptionItems(description: string): Array<{ label: string; qty: number }> {
  const out: Array<{ label: string; qty: number }> = [];
  for (const part of String(description ?? "").split(/,(?![^(]*\))/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(.*?)\s*\(x(\d+)\)\s*$/);
    if (m) out.push({ label: m[1].trim(), qty: Math.max(1, Number(m[2])) });
    else out.push({ label: trimmed, qty: 1 });
  }
  return out;
}

/**
 * The base a processing fee was charged ON, given the total that was charged.
 *
 * `total = base + trunc(base × pct) + fixed`. Inverted directly the answer can
 * land a cent either side of the truncation, so the neighbourhood of the
 * estimate is tested and only an EXACT reproduction is accepted — the whole
 * point is that the two lines add back to the money received.
 *
 * Truncation, not rounding: verified against 916 payments on this account, where
 * 165,00 € at 1,5 % is charged as 167,47 (165 × 1,015 = 167,475) and not 167,48.
 */
export function solveBaseCents(totalCents: number, rule: FeeRule): number | null {
  if (!Number.isFinite(totalCents) || totalCents <= 0) return null;
  if (rule.pct === 0 && rule.fixedCents === 0) return totalCents;
  const feeOf = (base: number) => Math.trunc((base * rule.pct) / 100) + rule.fixedCents;
  const estimate = Math.round((totalCents - rule.fixedCents) / (1 + rule.pct / 100));
  for (let base = estimate - 3; base <= estimate + 3; base++) {
    if (base > 0 && base + feeOf(base) === totalCents) return base;
  }
  return null;
}

/** The fee rule that applies to a sale, by what the payment calls itself. */
function feeRuleFor(description: string, cfg: LineSplitConfig): FeeRule | null {
  if (!cfg.fee) return null;
  for (const rule of cfg.fee.byForm) {
    if (rule.match.test(description)) return { pct: rule.pct, fixedCents: rule.fixedCents };
  }
  return { pct: cfg.fee.pct, fixedCents: cfg.fee.fixedCents };
}

/**
 * Split one payment into lines, or answer null and leave it alone.
 *
 * Three outcomes, in descending order of how much is known:
 *  - every named item has a declared price and they sum to the base: one line
 *    each, at each one's own rate, plus the fee;
 *  - they do not (no price list yet, or a discounted sale): ONE line for the
 *    whole base at the connection's default treatment, plus the fee. This is
 *    already better than today by exactly the VAT on the fee;
 *  - the fee arithmetic does not reproduce the total: null. A sale that does not
 *    add up is one a human should look at, not one to invent lines for.
 */
export function splitStripePayment(
  totalCents: number,
  description: string,
  cfg: LineSplitConfig,
): SplitLine[] | null {
  const rule = feeRuleFor(description, cfg);
  const baseCents = rule ? solveBaseCents(totalCents, rule) : totalCents;
  if (baseCents == null || baseCents <= 0) return null;
  const feeCents = totalCents - baseCents;

  const lines: SplitLine[] = [];

  const items = parseDescriptionItems(description);
  const priced = items.map((it) => {
    const spec = cfg.prices.get(it.label);
    return spec ? { it, spec } : null;
  });
  const allPriced = priced.length > 0 && priced.every((p) => p !== null);
  const pricedSum = allPriced
    ? priced.reduce((s, p) => s + p!.spec.cents * p!.it.qty, 0)
    : -1;

  if (allPriced && pricedSum === baseCents) {
    for (const p of priced) {
      lines.push({
        title: p!.it.label,
        sku: p!.spec.sku,
        rate: p!.spec.rate,
        grossCents: p!.spec.cents * p!.it.qty,
        qty: p!.it.qty,
      });
    }
  } else {
    lines.push({
      title: description.trim() || "Serviço",
      sku: cfg.base.sku,
      rate: cfg.base.rate,
      grossCents: baseCents,
      qty: 1,
    });
  }

  if (feeCents > 0 && cfg.fee) {
    lines.push({ title: cfg.fee.title, sku: cfg.fee.sku, rate: cfg.fee.rate, grossCents: feeCents, qty: 1 });
  } else if (feeCents !== 0) {
    // A negative fee means the arithmetic went somewhere it should not have.
    return null;
  }

  // The invariant this module exists to keep. Cheap, and it is the difference
  // between a wrong document and no document.
  const sum = lines.reduce((s, l) => s + l.grossCents, 0);
  if (sum !== totalCents) return null;

  return lines;
}
