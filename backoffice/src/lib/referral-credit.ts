/**
 * Paying the inviter their two months.
 *
 * A Stripe customer BALANCE credit, not a coupon on the subscription. The
 * inviter may be monthly or annual, on the current price or the legacy one, or
 * not paying at all yet; a balance credit is the only instrument that behaves in
 * all four cases, stacks without limit across referrals (the copy promises no
 * cap) and lands on whatever invoice comes next without anyone having to choose
 * which subscription it belongs to.
 *
 * The amount comes off the LEDGER, not the price book: two times what this
 * account actually last paid, tax included. That is what "2 meses grátis" means
 * to the person reading it — two invoices they do not pay — and it is right for
 * a legacy client, for a discounted one, and for anyone whose price changes
 * later, none of which a constant would survive.
 *
 * In Stripe, a NEGATIVE balance is a credit against future invoices. Getting
 * that sign backwards would charge the inviter two extra months for having
 * recommended us, so it is stated here and asserted in the test.
 */

export type Plan = string | null | undefined;

/** Two months of what they pay. An annual invoice is twelve of them. */
export function creditCentsFrom(lastPaidCents: number | null | undefined, plan: Plan): number | null {
    if (!lastPaidCents || lastPaidCents <= 0) return null;
    return plan === "annual" ? Math.round(lastPaidCents / 6) : lastPaidCents * 2;
}

export interface DrainResult {
    credited: number;
    cents: number;
    parked: { invitee_user_id: string; reason: string }[];
}

/**
 * Pay every referral this account has earned and not yet been paid for.
 *
 * Called from two places in the Stripe webhook: when an invitee first pays (the
 * moment the debt is incurred) and when the inviter themselves completes a
 * checkout (the moment they first have a Stripe customer to credit). The second
 * is what pays an early bird who invited people before ever paying us.
 *
 * Idempotency is doubled on purpose. The UPDATE is conditional on
 * `credited_at IS NULL`, and the Stripe call carries an idempotency key derived
 * from the referral — so a retry after a network timeout, where the credit was
 * applied but the row never updated, cannot credit twice.
 */
export async function drainPendingReferralCredits(
    db: D1Database,
    stripe: any,
    inviterUserId: string,
): Promise<DrainResult> {
    const out: DrainResult = { credited: 0, cents: 0, parked: [] };
    if (!inviterUserId) return out;

    const { results } = await db.prepare(
        `SELECT invitee_user_id, code FROM referrals
          WHERE inviter_user_id = ? AND state = 'paid' AND credited_at IS NULL`
    ).bind(inviterUserId).all();
    const pending = (results ?? []) as any[];
    if (!pending.length) return out;

    const customer: any = await db.prepare(
        `SELECT stripe_customer_id FROM subscriptions
          WHERE user_id = ? AND stripe_customer_id IS NOT NULL
          ORDER BY created_at ASC LIMIT 1`
    ).bind(inviterUserId).first();

    if (!customer?.stripe_customer_id) {
        // Nothing to credit against yet. No Stripe customer is created here: the
        // rows stay `paid` and the next checkout drains them.
        await note(db, pending, "no_stripe_customer");
        for (const r of pending) out.parked.push({ invitee_user_id: r.invitee_user_id, reason: "no_stripe_customer" });
        return out;
    }

    const lastPaid: any = await db.prepare(
        `SELECT amount_cents FROM billing_events
          WHERE user_id = ? AND type = 'invoice.paid' AND amount_cents IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`
    ).bind(inviterUserId).first();
    const sub: any = await db.prepare(
        `SELECT plan FROM subscriptions WHERE user_id = ? AND plan IS NOT NULL
          ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`
    ).bind(inviterUserId).first();

    const cents = creditCentsFrom(lastPaid?.amount_cents, sub?.plan);
    if (!cents) {
        // They have a customer but have never been invoiced, so there is no
        // amount to double. Parked rather than guessed at.
        await note(db, pending, "no_ledger_amount");
        for (const r of pending) out.parked.push({ invitee_user_id: r.invitee_user_id, reason: "no_ledger_amount" });
        return out;
    }

    for (const row of pending) {
        try {
            const txn = await stripe.customers.createBalanceTransaction(
                customer.stripe_customer_id,
                {
                    // Negative is a credit against future invoices.
                    amount: -cents,
                    currency: "eur",
                    description: `Rioko — convite ${row.code} (2 meses)`,
                    metadata: { app: "rioko", referral_invitee: row.invitee_user_id },
                },
                { idempotencyKey: `rioko-referral-${row.invitee_user_id}` },
            );
            await db.prepare(
                `UPDATE referrals
                    SET state = 'credited', credit_cents = ?, credit_txn_id = ?,
                        credited_at = ?, note = NULL
                  WHERE invitee_user_id = ? AND credited_at IS NULL`
            ).bind(cents, txn?.id ?? null, new Date().toISOString(), row.invitee_user_id).run();
            out.credited++;
            out.cents += cents;
        } catch (e: any) {
            const reason = e?.message ?? String(e);
            await note(db, [row], reason.slice(0, 200));
            out.parked.push({ invitee_user_id: row.invitee_user_id, reason });
        }
    }

    return out;
}

async function note(db: D1Database, rows: any[], text: string): Promise<void> {
    for (const r of rows) {
        await db.prepare("UPDATE referrals SET note = ? WHERE invitee_user_id = ? AND credited_at IS NULL")
            .bind(text, r.invitee_user_id).run();
    }
}

/**
 * The invitee's first paid invoice is what the inviter was promised.
 *
 * Claimed with a conditional UPDATE so a re-delivery of the same Stripe event
 * finds nothing left to claim, and returns the inviter to credit — or null when
 * this payment was not somebody's referral, which is almost always.
 */
export async function claimInviteePayment(
    db: D1Database,
    inviteeUserId: string,
    invoiceId: string,
    nowIso = new Date().toISOString(),
): Promise<string | null> {
    const res = await db.prepare(
        `UPDATE referrals
            SET state = 'paid', invitee_first_invoice_id = ?, invitee_paid_at = ?
          WHERE invitee_user_id = ? AND state = 'pending'`
    ).bind(invoiceId, nowIso, inviteeUserId).run();

    if (((res as any)?.meta?.changes ?? 0) === 0) return null;

    const row: any = await db.prepare(
        "SELECT inviter_user_id FROM referrals WHERE invitee_user_id = ?"
    ).bind(inviteeUserId).first();
    return row?.inviter_user_id ?? null;
}
