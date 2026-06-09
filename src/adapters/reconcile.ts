// Shared reconciliation helper for all destination adapters (IX, Moloni, Vendus,
// future). The invariant: the total of the invoice we're about to issue must
// equal the amount the customer actually paid in the source event (Stripe
// amount_received / Shopify total_price / EuPago valor). If our line-item math
// drifts by more than 1 cent we abort rather than ship a wrong document.
//
// Source-of-truth: payment processor. Never trust derived line-item math alone.

export interface ReconcileLine {
    /** Quantity of the line (units sold). */
    quantity: number;
    /** Net unit price (VAT-exclusive). Per-cent precision. */
    unit_price: number;
    /** Tax rate as a percentage (e.g. 23 for 23%). 0 for exempt/reverse-charge. */
    tax_rate: number;
    /** Optional per-line discount as a percentage. Defaults to 0. */
    discount_percent?: number;
    /** Optional per-line absolute discount amount (after percent). Defaults to 0. */
    discount_amount?: number;
    /** Optional human label for diagnostics in the error message. */
    name?: string;
}

export interface ReconcileOptions {
    /** Drift in source currency units beyond which we throw. Defaults to 0.01 (1¢). */
    driftTolerance?: number;
    /** Free-text context (e.g. "Stripe→Moloni", "Shopify→Vendus") for the error message. */
    context?: string;
}

/**
 * Compute the expected gross total of an invoice from its lines. Mirrors the
 * formula every certified PT invoicer uses internally: per-line
 *   gross = (unit_price * qty - discount_amount) * (1 - discount_percent/100) * (1 + tax_rate/100)
 * rounded to 2dp per line BEFORE aggregating — IX/Moloni/Vendus all round
 * per-line, which matches how Shopify derives total_price from line-level totals.
 */
export function computeExpectedGross(lines: ReconcileLine[]): number {
    let total = 0;
    for (const line of lines) {
        const qty = Number(line.quantity) || 0;
        const unit = Number(line.unit_price) || 0;
        const discAmt = Number(line.discount_amount ?? 0) || 0;
        const discPct = Number(line.discount_percent ?? 0) || 0;
        const taxRate = Number(line.tax_rate) || 0;
        const lineNetGross = unit * qty - discAmt;
        const lineNet = lineNetGross * (1 - discPct / 100);
        const lineGross = lineNet * (1 + taxRate / 100);
        total += Math.round(lineGross * 100) / 100;
    }
    return Math.round(total * 100) / 100;
}

/**
 * Signed residual between the amount actually paid and the gross our lines add
 * up to: `paid - expected`. Positive means our invoice undercounts the payment
 * (add a small adjustment); negative means it overcounts. Used to decide whether
 * a sub-cent-per-line rounding drift can be absorbed by a rounding-adjustment
 * line instead of aborting the whole invoice.
 */
export function computeResidual(sourcePaidAmount: number, lines: ReconcileLine[]): number {
    const paid = Number(sourcePaidAmount);
    if (!Number.isFinite(paid) || paid <= 0) return 0;
    return Math.round((paid - computeExpectedGross(lines)) * 100) / 100;
}

/**
 * Throw if expected total drifts from source paid amount by more than tolerance.
 * Caller MUST catch and abort the destination call rather than ship a wrong
 * invoice. The thrown Error message is safe to log/persist (no PII beyond the
 * monetary values themselves).
 */
export function reconcileTotalOrThrow(
    sourcePaidAmount: number,
    lines: ReconcileLine[],
    opts: ReconcileOptions = {},
): void {
    const paid = Number(sourcePaidAmount);
    if (!Number.isFinite(paid) || paid <= 0) return; // nothing to reconcile against
    const tolerance = opts.driftTolerance ?? 0.01;
    const expected = computeExpectedGross(lines);
    const drift = Math.abs(expected - paid);
    if (drift > tolerance) {
        const breakdown = lines.map((l) => ({
            name: l.name,
            quantity: l.quantity,
            unit_price: l.unit_price,
            tax_rate: l.tax_rate,
            discount_percent: l.discount_percent,
            discount_amount: l.discount_amount,
        }));
        const ctx = opts.context ? `[${opts.context}] ` : "";
        throw new Error(
            `${ctx}Invoice total mismatch: paid=${paid.toFixed(2)} expected=${expected.toFixed(2)} drift=${drift.toFixed(2)}. Lines=${JSON.stringify(breakdown)}`,
        );
    }
}
