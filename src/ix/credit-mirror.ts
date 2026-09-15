import { ixExpectedTotals } from "./create-invoice";

/**
 * A credit note is a mirror of the document it credits.
 *
 * Not a paraphrase of it, and never an amount of money with a tax rate picked to
 * make the total come out right. The lines, the unit prices, the rates, the
 * discounts and the exemption all come from the invoice as InvoiceXpress stored
 * it; a partial refund keeps those and changes only the quantity.
 *
 * This exists because the refund path used to rebuild the lines from Shopify's
 * refund numbers instead. On a shop that prices VAT-inclusive, `subtotal` is the
 * gross, so `total_tax / subtotal` yielded 5.67% for a 6% book — a rate no IX
 * account has. The proxy's tax resolver then fell back to the exempt tax, the
 * document was refused for having no exemption reason, and the refund was never
 * credited (Bikini Books OL1373, 2026-09-14). The same arithmetic, when it did
 * not trip that refusal, published a 23% "Refund amount" service line in place
 * of the 6% book that was actually returned.
 *
 * A rate that is not on the invoice can never be on its credit note. That is the
 * whole rule, and mirroring is how it is enforced rather than checked.
 */

export type MirrorTax = number | { id?: number; name: string; value: number };

/** One line of a credit note, in the shape InvoiceXpress accepts on POST. */
export interface MirrorLine {
  quantity: number;
  name: string;
  description?: string;
  unit_price: number;
  tax: MirrorTax;
  discount?: number;
}

/**
 * Where a rebuilt line came from in the source order, so a refunded Shopify line
 * can be matched to the invoice line it produced. `id` is null for a shipping
 * line the source did not number.
 */
export type LineSource = { kind: "line" | "shipping"; id: number | null };

export type MirrorPlan =
  | { ok: true; items: MirrorLine[]; total: number; basis: "document" | "lines" | "shipping" }
  // `nothingToCredit`: the refund leaves the invoiced sale exactly as it was, so
  // there is no credit note to issue and nobody to alert — distinct from a
  // refund that cannot be mirrored, which a person has to look at.
  | { ok: false; reason: string; detail: Record<string, unknown>; nothingToCredit?: boolean };

const round2 = (n: number) => Math.round(n * 100) / 100;

function rateOf(tax: MirrorTax): number {
  return typeof tax === "number" ? tax : Number(tax?.value ?? 0);
}

/** What one line is worth with tax, under IX's round-once model. */
function lineGross(line: MirrorLine): number {
  return ixExpectedTotals([line]).gross;
}

/**
 * The document's own lines, as lines we can send back.
 *
 * Lifted out of `IxDestination.creditFullDocument`, which has carried this since
 * the cancel path started crediting documents in full — including the two traps
 * it learned the hard way:
 *
 *  - a line `discount` is part of what the line is WORTH. Dropping it credited
 *    the undiscounted price, so a 50%-off document got a credit note worth twice
 *    the invoice.
 *  - a document can carry a discount its LINES do not. IX totals a header-level
 *    discount on top of the per-line one and reports both on read-back, so
 *    mirroring the lines alone credits the pre-header-discount amount (47,97 €
 *    against an invoice of 23,24 €). The line's own `subtotal` is what it is
 *    worth after every layer, so falling back to it reproduces the document's
 *    total by construction.
 *
 * Throws when the rebuild does not reproduce the stored total: then the read-back
 * is not the document we think it is, and there is nothing safe to credit.
 */
export function mirrorItemsFromIxDocument(inv: any): { items: MirrorLine[]; gross: number } {
  const items: MirrorLine[] = Array.isArray(inv?.items) ? inv.items.map((it: any) => ({
    quantity: Number(it.quantity ?? 1),
    name: String(it.name ?? "Refund"),
    ...(it.description ? { description: String(it.description) } : {}),
    unit_price: Number(it.unit_price ?? 0),
    tax: it.tax?.id
      ? { id: Number(it.tax.id), name: String(it.tax.name ?? ""), value: Number(it.tax.value ?? 0) }
      : { name: String(it.tax?.name ?? "VAT"), value: Number(it.tax?.value ?? 0) },
    ...(typeof it.discount === "number" && it.discount > 0 ? { discount: it.discount } : {}),
  })) : [];

  // IX rounds unit_price to 2dp while adding up in full precision, so a faithful
  // mirror can land a cent off per line.
  const storedTotal = Number(inv?.total);
  const tolerance = 0.02 + 0.01 * items.length;
  const off = (built: { gross: number }) =>
    Number.isFinite(storedTotal) && Math.abs(built.gross - storedTotal) > tolerance;

  let rebuilt = ixExpectedTotals(items);

  if (off(rebuilt) && Array.isArray(inv?.items)) {
    const fromSubtotals = items.map((line, i) => {
      const qty = Number(line.quantity) || 1;
      const net = Number(inv.items[i]?.subtotal);
      if (!Number.isFinite(net)) return line;
      const { discount, ...semDesconto } = line;      // o subtotal já o inclui
      return { ...semDesconto, unit_price: net / qty };
    });
    const retry = ixExpectedTotals(fromSubtotals);
    if (!off(retry)) {
      items.length = 0;
      items.push(...fromSubtotals);
      rebuilt = retry;
    }
  }

  if (off(rebuilt)) {
    throw new Error(
      `A nota de crédito daria ${rebuilt.gross.toFixed(2)}€ mas o documento tem `
      + `${storedTotal.toFixed(2)}€ — não credito um valor diferente do que foi facturado`,
    );
  }

  return { items, gross: rebuilt.gross };
}

/** The builder has named every shipping line this way, in every version it has had. */
export function isShippingLineName(name: unknown): boolean {
  return /^portes de envio/i.test(String(name ?? "").trim());
}

/**
 * The money that actually went back to the buyer: the refund's successful
 * `refund` transactions.
 *
 * A CHECK on the credit note, never its source. The credit note mirrors the
 * lines that left the sale. When money moved, it has to equal those lines to the
 * cent. When no money moved, the lines left the sale all the same — a paid order
 * cancelled in Shopify arrives as a refund with `restock_type: cancel` and no
 * transaction at all (lliberta #1021: 119,00 € paid, every line cancelled, zero
 * refund transactions) — and a cancelled line is credited like a refunded one.
 *
 * And not the normalizer's `amount` either. That figure is computed from the
 * returned lines and, on a VAT-inclusive shop, adds the tax a second time: Soul
 * Krave #1262 came through as 42,73 € (36,00 + 6,73) for a line worth 36,00 €.
 *
 * Falls back to the normalizer only when the raw refund carries no transactions
 * array at all — that is "we were not told", not "nothing was paid".
 */
export function moneyRefunded(rawRefund: any, fallback: number): number {
  const txs = rawRefund?.transactions;
  if (!Array.isArray(txs)) return round2(Number(fallback));
  return round2(txs
    .filter((t: any) => String(t?.kind ?? "") === "refund" && String(t?.status ?? "") === "success")
    .reduce((acc: number, t: any) => acc + Number(t?.amount ?? 0), 0));
}

/**
 * Which invoice line each returned article is.
 *
 * The rebuild runs the same builder that produced the invoice, so the ARTICLES
 * come out in the same order — and only the articles are aligned. Shipping is
 * left out on purpose: the builder has split shipping into rate bands differently
 * over time, so an invoice issued in May carries one shipping line where today's
 * rebuild makes two, and aligning every line by position refused five perfectly
 * ordinary refunds across two shops for that reason alone.
 *
 * Each pair is verified rather than assumed — same rate, same money — so an
 * invoice edited by hand after issue still refuses instead of quietly attaching
 * the refund to the wrong article at the wrong rate.
 */
export function alignProductLines(
  docItems: MirrorLine[],
  sources: LineSource[],
  rebuilt?: MirrorLine[],
): { ok: true; byLineId: Map<string, number> } | { ok: false; reason: string } {
  const docProducts = docItems.map((it, i) => (isShippingLineName(it.name) ? -1 : i)).filter(i => i >= 0);
  const srcProducts = sources.map((s, i) => (s.kind === "line" ? i : -1)).filter(i => i >= 0);
  if (docProducts.length !== srcProducts.length) {
    return { ok: false, reason: `a fatura tem ${docProducts.length} artigo(s) e a encomenda tem ${srcProducts.length}` };
  }
  const byLineId = new Map<string, number>();
  for (let k = 0; k < docProducts.length; k++) {
    const doc = docItems[docProducts[k]];
    const source = sources[srcProducts[k]];
    if (rebuilt) {
      const again = rebuilt[srcProducts[k]];
      if (!again) return { ok: false, reason: `a reconstrução da encomenda não tem o artigo "${doc.name}"` };
      if (Math.abs(rateOf(doc.tax) - rateOf(again.tax)) > 0.001) {
        return { ok: false, reason: `o artigo "${doc.name}" está a ${rateOf(doc.tax)}% na fatura e a ${rateOf(again.tax)}% na encomenda` };
      }
      if (Math.abs(lineGross(doc) - lineGross(again)) > 0.02) {
        return { ok: false, reason: `o artigo "${doc.name}" vale ${lineGross(doc).toFixed(2)}€ na fatura e ${lineGross(again).toFixed(2)}€ na encomenda` };
      }
    }
    if (source.id != null) byLineId.set(String(source.id), docProducts[k]);
  }
  return { ok: true, byLineId };
}

/**
 * The credit note for one refund, mirrored off the invoice — or a refusal.
 *
 * The owner's rule, which this implements:
 *   - total: an invoiced order refunded or cancelled in full gets a credit note
 *     identical to the invoice;
 *   - partial: it gets the invoice's own lines for exactly what came back — 3 of
 *     4 units means 3 units, products A and B of A-B-C-D means A and B.
 *
 * Refusing is a first-class outcome here, not a failure to handle a case. A
 * credit note is a certified fiscal document, and attributing VAT to an amount
 * that matches no line of the invoice is a decision for a person: get it wrong
 * and it takes a second fiscal document to undo. The cost of stopping is one
 * credit note issued by hand; the cost of guessing is already in production.
 */
export function planRefundCredit(input: {
  /** `total` of the invoice being credited, as InvoiceXpress stores it. */
  docTotal: number;
  /** The invoice's own lines — see `mirrorItemsFromIxDocument`. */
  docItems: MirrorLine[];
  /** Where each rebuilt line came from, index-aligned with `rebuilt`. */
  sources: LineSource[];
  refund: {
    refundId: string | number;
    amount: number;
    lineItems: Array<{ id: number; quantity: number; subtotal: number; total_tax: number }>;
  };
  /** The raw Shopify refund: its transactions and its adjustments. */
  rawRefund: any | null;
  /** Shopify's `taxes_included` for this order. */
  taxesIncluded: boolean;
  /** What other credit notes have already taken off this invoice. */
  alreadyCredited: number;
  /**
   * What the order is worth NOW, per Shopify (`current_total_price`). Only pass
   * it when it is comparable with the invoice — same currency — else null.
   */
  orderCurrentTotal?: number | null;
  /** The rebuild of the order through the invoice builder, index-aligned with `sources`. */
  rebuilt?: MirrorLine[];
}): MirrorPlan {
  const { docTotal, docItems, sources, refund, rawRefund, taxesIncluded, alreadyCredited } = input;
  const current = input.orderCurrentTotal != null && Number.isFinite(input.orderCurrentTotal)
    ? round2(input.orderCurrentTotal)
    : null;
  const money = moneyRefunded(rawRefund, refund.amount);
  const remaining = round2(docTotal - alreadyCredited);
  const detail = { refundId: String(refund.refundId), money, docTotal, alreadyCredited, orderCurrentTotal: current };

  // Every check below measures against the invoice total, and an unreadable one
  // does not FAIL those checks — NaN compares false — it silently passes them.
  if (!Number.isFinite(docTotal) || docTotal <= 0) {
    return { ok: false, reason: `não consigo ler o total da fatura (${String(docTotal)}) — não credito sem saber quanto foi facturado`, detail };
  }

  // No money moved, and the invoice already says what the order is worth now:
  // this refund removed something the invoice never billed. Estrela #1401 — two
  // necklaces ordered, one paid, an invoice of 89,49 €, and the unpaid one
  // "returned" at 0,00 € with the order still worth 89,49 €.
  if (money <= 0.005 && current != null && Math.abs(remaining - current) <= 0.01) {
    return {
      ok: false,
      nothingToCredit: true,
      reason: `a fatura (${remaining.toFixed(2)} €) já corresponde ao valor atual da encomenda — `
        + `esta devolução não mexe em nada que tenha sido facturado`,
      detail,
    };
  }

  // The whole document, refunded in full and credited in full. No mapping to
  // Shopify at all, so this is right even for an invoice edited after issue.
  if (Math.abs(money - docTotal) <= 0.01 && alreadyCredited <= 0.005) {
    const total = ixExpectedTotals(docItems).gross;
    if (Math.abs(total - money) > 0.01) {
      return { ok: false, reason: `o espelho da fatura dá ${total.toFixed(2)} € e o reembolso foi de ${money.toFixed(2)} €`, detail };
    }
    return { ok: true, items: docItems.map(l => ({ ...l })), total, basis: "document" };
  }

  const items: MirrorLine[] = [];

  // Returned or cancelled articles: the invoice's own line, with the quantity
  // that left the sale.
  const returned = (refund.lineItems ?? []).filter(rl => (Number(rl.quantity) || 0) > 0);
  let byLineId = new Map<string, number>();
  if (returned.length > 0) {
    const alignment = alignProductLines(docItems, sources, input.rebuilt);
    if (!alignment.ok) {
      return {
        ok: false,
        reason: `não consigo dizer que linha da fatura corresponde a cada artigo devolvido: ${alignment.reason}`,
        detail,
      };
    }
    byLineId = alignment.byLineId;
  }
  for (const rl of returned) {
    const qty = Number(rl.quantity);
    const idx = byLineId.get(String(rl.id)) ?? -1;
    if (idx < 0) {
      return { ok: false, reason: `o artigo devolvido ${rl.id} não corresponde a nenhuma linha da fatura`, detail };
    }
    const source = docItems[idx];
    const line: MirrorLine = { ...source, quantity: qty };
    // `subtotal` is gross on a VAT-inclusive shop and net on the other kind —
    // the distinction the old code missed, and the one that produced 5.67%.
    const wantGross = round2(taxesIncluded
      ? Number(rl.subtotal)
      : Number(rl.subtotal) + Number(rl.total_tax ?? 0));
    const got = lineGross(line);
    if (Math.abs(got - wantGross) > 0.02) {
      return {
        ok: false,
        reason: `a devolução de ${qty} x "${source.name}" vale ${wantGross.toFixed(2)} € `
          + `mas a mesma linha na fatura vale ${got.toFixed(2)} € — reembolso de valor parcial não se espelha`,
        detail,
      };
    }
    items.push(line);
  }

  // Shipping comes back as an adjustment, not as a line: `refund_line_items` is
  // empty and the money sits in `order_adjustments`, tax apart from amount.
  //
  // Summed PER KIND before being judged, because Shopify writes adjustments in
  // pairs that cancel: the shipping refund on OL1373 arrived as
  // `shipping_refund −12,20/−2,80` alongside `refund_discrepancy +15,00` and
  // `refund_discrepancy −15,00`. Read one at a time, that bookkeeping pair looks
  // like 30 € of money nobody can explain; netted, it is nothing at all.
  const adjustments = Array.isArray(rawRefund?.order_adjustments) ? rawRefund.order_adjustments : [];
  const byKind = new Map<string, number>();
  for (const adj of adjustments) {
    const kind = String(adj?.kind ?? "");
    const net = Number(adj?.amount ?? 0) + Number(adj?.tax_amount ?? 0);
    byKind.set(kind, (byKind.get(kind) ?? 0) + net);
  }
  let shippingGross = 0;
  for (const [kind, net] of byKind) {
    const value = Math.abs(net);
    if (value <= 0.005) continue;
    if (kind === "shipping_refund") { shippingGross += value; continue; }
    // A discrepancy on a refund that also returned lines is Shopify saying the
    // money did not match those lines — the money check below says it better.
    if (kind === "refund_discrepancy" && returned.length > 0) continue;
    return {
      ok: false,
      reason: `o reembolso traz um ajuste "${kind}" de ${value.toFixed(2)} € que não corresponde a nenhuma linha da fatura`,
      detail,
    };
  }
  if (shippingGross > 0.005) {
    // By name, not by position — the invoice may carry its shipping in a
    // different number of rate bands than today's rebuild would. A shipping
    // refund credits every shipping line the invoice actually has.
    const shipIdx = docItems.map((it, i) => (isShippingLineName(it.name) ? i : -1)).filter(i => i >= 0);
    if (shipIdx.length === 0) {
      return { ok: false, reason: `foram devolvidos ${shippingGross.toFixed(2)} € de portes mas a fatura não tem linha de portes`, detail };
    }
    const shipLines = shipIdx.map(i => ({ ...docItems[i] }));
    const shipTotal = ixExpectedTotals(shipLines).gross;
    if (Math.abs(shipTotal - round2(shippingGross)) > 0.02) {
      return {
        ok: false,
        reason: `foram devolvidos ${shippingGross.toFixed(2)} € de portes e a fatura tem ${shipTotal.toFixed(2)} € — `
          + `devolução parcial de portes não se espelha`,
        detail,
      };
    }
    items.push(...shipLines);
  }

  if (items.length === 0) {
    if (money > 0.005) {
      return {
        ok: false,
        reason: `o reembolso de ${money.toFixed(2)} € não devolve nenhum artigo nem portes `
          + `— é dinheiro devolvido à parte e não há linha da fatura que o espelhe`,
        detail,
      };
    }
    return { ok: false, nothingToCredit: true, reason: `o reembolso não devolve artigos, portes nem dinheiro — não há nada para creditar`, detail };
  }

  const total = ixExpectedTotals(items).gross;

  // Money that moved has to be exactly the lines that left. Money that did NOT
  // move is a cancellation, or a refund settled outside Shopify: the lines left
  // the sale all the same, and are credited all the same.
  if (money > 0.005 && Math.abs(total - money) > 0.01) {
    return {
      ok: false,
      reason: `o espelho das linhas devolvidas dá ${total.toFixed(2)} € e foram reembolsados ${money.toFixed(2)} €`,
      detail: { ...detail, mirrored: total },
    };
  }

  // A credit note can never be worth more than what is left of the document it
  // credits — InvoiceXpress enforces that at FINALIZE, and only against the
  // invoice total, so it let three 15 € notes through on a 57 € invoice and
  // refused the fourth. Counting the notes already issued is what turns that
  // into one note instead of three.
  if (total - remaining > 0.01) {
    return {
      ok: false,
      reason: alreadyCredited > 0.005
        ? `a fatura é de ${docTotal.toFixed(2)} €, já tem ${alreadyCredited.toFixed(2)} € creditados, `
          + `e este reembolso de ${total.toFixed(2)} € não cabe nos ${remaining.toFixed(2)} € que sobram`
        : `o reembolso é de ${total.toFixed(2)} € e a fatura que ele credita é de ${docTotal.toFixed(2)} €`,
      detail: { ...detail, mirrored: total },
    };
  }

  // Never below what the order is still worth. If crediting these lines would
  // leave the invoice under Shopify's current total, the invoice and the order
  // disagree about what was sold, and picking one is not ours to do.
  if (current != null && remaining - total < current - 0.01) {
    return {
      ok: false,
      reason: `creditar ${total.toFixed(2)} € deixaria a fatura em ${(remaining - total).toFixed(2)} € `
        + `e a encomenda ainda vale ${current.toFixed(2)} € — a fatura não corresponde à encomenda`,
      detail: { ...detail, mirrored: total },
    };
  }

  return { ok: true, items, total, basis: shippingGross > 0.005 && returned.length === 0 ? "shipping" : "lines" };
}
