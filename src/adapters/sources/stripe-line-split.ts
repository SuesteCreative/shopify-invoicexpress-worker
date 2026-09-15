/**
 * One Stripe payment, several fiscal lines.
 *
 * A PaymentIntent is a single number. Stripe has no line items for a payment
 * created through its API, so a sale that is part exempt service, part food at
 * the intermediate rate and part card-processing fee at the standard one arrives
 * as one amount — and is declared entirely at whichever rate the connection
 * defaults to.
 *
 * Measured on Escola Lá Fora: 1.320 payments, 194.912,28 €, every one a single
 * amount, and the connector that preceded Rioko issued 506 documents with one
 * line each — 289 exempt and 217 at 13 %, on sales that were the same thing.
 *
 * What the payment does carry is a description naming what was bought, with
 * quantities, and a total. Given the merchant's own price list, that is an
 * equation: the items fix the base, and the difference to the total is the
 * processing fee. The connection states the price list and the fee's shape; this
 * module solves the rest, and refuses whenever the answer does not reproduce the
 * charged total to the cent.
 *
 * Two things it deliberately does NOT do. It does not infer a price from a
 * single-item payment and then reuse it elsewhere — each payment is solved on
 * its own, so a wrong guess cannot spread. And it does not round: `ROUND` or
 * truncation is a property of the merchant's own checkout, so both are declared
 * and the one that reproduces the total is the one that was used.
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
  /** True when the price came from the total rather than the declared list —
   *  an option the merchant has since repriced or removed. */
  derived?: boolean;
}

interface FeeRule {
  /** Percentage of the base, e.g. 1.5. */
  pct: number;
  fixedCents: number;
  /** The merchant's checkout truncates instead of rounding. */
  trunc: boolean;
}

interface Treatment {
  sku: string;
  rate: number;
}

export interface LineSplitConfig {
  fee: (Treatment & { title: string; rules: FeeRule[] }) | null;
  /** What an item is when no classifier matches. */
  base: Treatment;
  /** Name pattern → treatment, first match wins. This is what puts food at 13 %
   *  without the merchant listing every meal option twice. */
  classify: Array<{ match: RegExp; sku: string; rate: number }>;
  /** Declared price per product name, in cents. A list when the merchant sells
   *  the same named option at more than one price (a sibling discount, a year's
   *  change) — every candidate is tried and the total picks. */
  prices: Map<string, number[]>;
  /** The form titles the description prefixes onto its FIRST item. Needed
   *  verbatim: a title can itself contain " - " ("Verão Lá Fora 2026 - novas
   *  vagas"), and splitting on the first one strips the wrong half and loses a
   *  price that is right there in the list. Longest first, so the most specific
   *  title wins. */
  formTitles: string[];
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function treatment(raw: any, fallback?: Treatment): Treatment | null {
  const sku = String(raw?.sku ?? "").trim();
  if (!sku) return fallback ?? null;
  return { sku, rate: num(raw?.rate, fallback?.rate ?? 0) };
}

/** Read the connection's recipe. Null when it declared none, which is every
 *  connection whose payments already arrive with line items. */
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

  const base = treatment(doc.base);
  if (!base) {
    console.warn("[Stripe] stripe_line_split has no base.sku — ignoring it");
    return null;
  }

  let fee: LineSplitConfig["fee"] = null;
  const feeT = treatment(doc.fee);
  if (feeT) {
    const rules: FeeRule[] = [];
    for (const r of Array.isArray(doc.fee.rules) ? doc.fee.rules : []) {
      rules.push({ pct: num(r?.pct, 0), fixedCents: Math.round(num(r?.fixed_cents, 0)), trunc: r?.trunc === true });
    }
    // A recipe that names the fee but no rule still has one: charge nothing.
    if (rules.length === 0) rules.push({ pct: 0, fixedCents: 0, trunc: false });
    fee = { ...feeT, title: String(doc.fee.title ?? "Taxa de processamento").trim(), rules };
  }

  const classify: LineSplitConfig["classify"] = [];
  for (const c of Array.isArray(doc.classify) ? doc.classify : []) {
    const pattern = String(c?.match ?? "").trim();
    const t = treatment(c, base);
    if (!pattern || !t) continue;
    try {
      classify.push({ match: new RegExp(pattern, "i"), sku: t.sku, rate: t.rate });
    } catch {
      console.warn(`[Stripe] stripe_line_split: bad regex ${pattern} — skipping that rule`);
    }
  }

  const prices = new Map<string, number[]>();
  for (const [nome, v] of Object.entries(doc.prices ?? {})) {
    const cents = (Array.isArray(v) ? v : [v])
      .map((x) => Math.round(num(x, NaN)))
      .filter((x) => Number.isFinite(x) && x >= 0);
    if (cents.length) prices.set(nome.trim(), [...new Set(cents)].sort((a, b) => b - a));
  }

  const formTitles = (Array.isArray(doc.forms) ? doc.forms : [])
    .map((t: unknown) => String(t ?? "").trim())
    .filter(Boolean)
    .sort((a: string, b: string) => b.length - a.length);

  return { fee, base, classify, prices, formTitles };
}

/**
 * The items a forms app names in the payment's description.
 *
 * `"<form> - <option> (xN), <option> (xN)"` — the form's own title prefixes only
 * the FIRST item.
 *
 * Found by the `(xN)` that ends each one, NOT by splitting on commas: option
 * labels contain commas of their own, and not only inside brackets. "Inverno Lá
 * Fora Lisboa - 29, 30 de dezembro e 2 de janeiro (x1)" is ONE option, and
 * splitting it produced three items that priced to nothing — 19 payments, all of
 * this merchant's Inverno sales, refused for a punctuation mark.
 *
 * A description with no `(xN)` at all is one unnamed item, which is what a
 * manually created payment looks like.
 */
export function parseDescriptionItems(description: string): Array<{ label: string; qty: number }> {
  const text = String(description ?? "").trim();
  if (!text) return [];
  const out: Array<{ label: string; qty: number }> = [];
  for (const m of text.matchAll(/\s*(.+?)\s*\(x(\d+)\)\s*(?:,|$)/g)) {
    const label = m[1].trim();
    if (label) out.push({ label, qty: Math.max(1, Number(m[2])) });
  }
  return out.length ? out : [{ label: text, qty: 1 }];
}

const feeOf = (baseCents: number, rule: FeeRule): number =>
  (rule.trunc ? Math.trunc : Math.round)((baseCents * rule.pct) / 100) + rule.fixedCents;

/**
 * The base a fee was charged ON, for each shape of fee the merchant has used.
 *
 * Inverting `base + fee(base)` directly can land a cent either side of the
 * rounding, so the neighbourhood of the estimate is tested and only an EXACT
 * reproduction is accepted.
 */
export function solveBases(totalCents: number, rules: FeeRule[]): Array<{ base: number; rule: FeeRule }> {
  const out: Array<{ base: number; rule: FeeRule }> = [];
  if (!Number.isFinite(totalCents) || totalCents <= 0) return out;
  for (const rule of rules) {
    const estimate = Math.round((totalCents - rule.fixedCents) / (1 + rule.pct / 100));
    for (let base = Math.max(1, estimate - 4); base <= estimate + 4; base++) {
      if (base + feeOf(base, rule) === totalCents) { out.push({ base, rule }); break; }
    }
  }
  return out;
}

/** Cartesian product, for the handful of items a description ever names. */
function combinations(lists: number[][]): number[][] {
  return lists.reduce<number[][]>((acc, xs) => acc.flatMap((a) => xs.map((x) => [...a, x])), [[]]);
}

function treatmentFor(label: string, cfg: LineSplitConfig): Treatment {
  for (const c of cfg.classify) if (c.match.test(label)) return { sku: c.sku, rate: c.rate };
  return cfg.base;
}

/** The label without the form title the description prefixes onto the first
 *  item. Falls back to the first " - " for a form the recipe does not name. */
function bareLabel(label: string, cfg: LineSplitConfig): string {
  for (const t of cfg.formTitles) if (label.startsWith(t + " - ")) return label.slice(t.length + 3);
  const i = label.indexOf(" - ");
  return i > 0 ? label.slice(i + 3) : label;
}

/** The declared price(s) of an item, as written and then without the prefix. */
function pricesOf(label: string, cfg: LineSplitConfig): number[] | null {
  return cfg.prices.get(label) ?? cfg.prices.get(bareLabel(label, cfg)) ?? null;
}

/**
 * Split one payment into lines, or answer null and leave it alone.
 *
 * The search is over the shapes of fee the merchant has used and the declared
 * price of each named item. One item may be left free, and the total then says
 * what it cost — that is how a payment naming an option the merchant has since
 * repriced still resolves. A solution whose derived unit price is a round figure
 * is preferred over one that is not, because real price lists are round.
 *
 * Returns null rather than guessing: a document whose lines do not add up to the
 * money received is worse than no document.
 */
export function splitStripePayment(
  totalCents: number,
  description: string,
  cfg: LineSplitConfig,
): SplitLine[] | null {
  const items = parseDescriptionItems(description);
  if (items.length === 0) return null;

  const priced = items.map((it) => ({ ...it, cands: pricesOf(it.label, cfg) }));
  const unknown = priced.map((p, i) => (p.cands == null ? i : -1)).filter((i) => i >= 0);
  // Two unknowns in one payment is an underdetermined equation, and inventing a
  // split between them is precisely the guess this module refuses to make.
  if (unknown.length > 1) return null;

  const rules = cfg.fee?.rules ?? [{ pct: 0, fixedCents: 0, trunc: false }];
  const freeChoices = unknown.length === 1 ? [unknown[0]] : [-1, ...items.map((_, i) => i)];

  let best: { lines: SplitLine[]; feeCents: number; round: boolean } | null = null;

  for (const free of freeChoices) {
    for (const { base } of solveBases(totalCents, rules)) {
      const fixed = priced.map((p, i) => ({ p, i })).filter(({ i }) => i !== free);
      if (fixed.some(({ p }) => p.cands == null)) continue;

      for (const combo of combinations(fixed.map(({ p }) => p.cands!))) {
        const fixedSum = combo.reduce((s, unit, k) => s + unit * fixed[k].p.qty, 0);
        const rest = base - fixedSum;
        if (free < 0 ? rest !== 0 : rest <= 0 || rest % items[free].qty !== 0) continue;

        const lines: SplitLine[] = priced.map((p, i) => {
          const t = treatmentFor(p.label, cfg);
          const gross = i === free ? rest : combo[fixed.findIndex((f) => f.i === i)] * p.qty;
          return { title: bareLabel(p.label, cfg), sku: t.sku, rate: t.rate, grossCents: gross, qty: p.qty, ...(i === free ? { derived: true } : {}) };
        });
        // A derived price has to earn its place. When the item had NO declared
        // price there is nothing better to go on, so any figure that closes the
        // total is accepted. When it HAD one and the total disagrees, only a
        // figure shaped like a real price is — a multiple of 50 cents. Without
        // that, the search always succeeds by re-pricing a known item to
        // whatever makes the sum work (20,00 € becoming 0,41 €), and a guard
        // that never refuses is not a guard.
        const round = free < 0 || (rest / items[free].qty) % 50 === 0;
        if (free >= 0 && priced[free].cands != null && !round) continue;
        if (!best || (round && !best.round)) best = { lines, feeCents: totalCents - base, round };
        if (round) break;
      }
      if (best?.round) break;
    }
    if (best?.round) break;
  }

  if (!best) return null;

  const lines = best.lines.filter((l) => l.grossCents > 0);
  if (best.feeCents > 0 && cfg.fee) {
    lines.push({ title: cfg.fee.title, sku: cfg.fee.sku, rate: cfg.fee.rate, grossCents: best.feeCents, qty: 1 });
  } else if (best.feeCents !== 0) {
    return null;
  }

  // The invariant this module exists to keep. Cheap, and it is the difference
  // between a wrong document and no document.
  if (lines.reduce((s, l) => s + l.grossCents, 0) !== totalCents) return null;
  return lines.length ? lines : null;
}
