/**
 * Can this billing event ever carry a Kapta document?
 *
 * The rule `cron/ix-match` sweeps by: a paid invoice or a refund, with money on
 * it. A failed attempt invoices nothing, and neither does a payment of zero (a
 * fully discounted or credit-balance invoice), so a row that says "A processar"
 * beside one of those says it forever.
 */
export function canHaveKaptaDocument(e: {
    type: string;
    status: string | null;
    amount_cents: number | null;
}): boolean {
    return (e.type === "invoice.paid" || e.type === "charge.refunded")
        && (e.status === "paid" || e.status === "refunded")
        && Number(e.amount_cents) > 0;
}
