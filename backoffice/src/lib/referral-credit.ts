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
 * Two things the ledger does to you if you read it naively:
 *
 * - A credit poisons the next reading. Once an inviter holds 18,46 € of balance,
 *   Stripe still finalizes their next invoices and still fires `invoice.paid`,
 *   with amount_paid = 0. Taking "the most recent invoice.paid" without
 *   `amount_cents > 0` therefore reads 0 for the two months that the FIRST
 *   referral paid for, and parks the second referral as unpayable — precisely
 *   the account that earned the most gets paid the least.
 * - The period is a property of that invoice, not of the account. Reading the
 *   amount from one row and the interval from a `subscriptions` row picked by a
 *   different ordering can pair an annual invoice with a monthly plan and credit
 *   twelve times what is owed, or the mirror of it.
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

/**
 * The billing period of the invoice we are doubling, read off that same invoice.
 *
 * `billing_events.raw_json` holds the Stripe invoice verbatim, so the interval
 * is there beside the amount and no second row has to be trusted to agree with
 * it. Null when it cannot be read, and the caller falls back to the plan column.
 */
export function intervalOfInvoice(rawJson: string | null | undefined): "month" | "year" | null {
    if (!rawJson) return null;
    try {
        const inv: any = JSON.parse(rawJson);
        const line = inv?.lines?.data?.[0];
        const i = line?.price?.recurring?.interval ?? line?.plan?.interval ?? null;
        return i === "year" || i === "month" ? i : null;
    } catch {
        return null;
    }
}

export interface DrainResult {
    credited: number;
    cents: number;
    parked: { invitee_user_id: string; reason: string }[];
}

/**
 * Pay every referral this account has earned and not yet been paid for.
 *
 * Called from three places in the Stripe webhook: when an invitee first pays
 * (the moment the debt is incurred), when the inviter completes a checkout (the
 * moment they first have a Stripe customer to credit), and when the inviter
 * themselves pays an invoice. The third is not redundant — an inviter who is
 * already a subscriber never completes another Checkout, so without it a credit
 * parked for any reason would sit until somebody noticed the note by hand.
 *
 * Idempotency is trebled, because the failure is money. The UPDATE is
 * conditional on `credited_at IS NULL`; the Stripe call carries an idempotency
 * key; and before posting anything the customer's recent balance transactions
 * are read for one that already names this referral — that last one is what
 * survives Stripe dropping idempotency keys after 24 hours, which is exactly the
 * window in which someone presses the manual drain button on a stuck row.
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
        // rows stay `paid` and the next payment or checkout drains them.
        await note(db, pending, "no_stripe_customer");
        for (const r of pending) out.parked.push({ invitee_user_id: r.invitee_user_id, reason: "no_stripe_customer" });
        return out;
    }

    // `amount_cents > 0` is load-bearing: see the header. A balance-covered
    // invoice is a real `invoice.paid` row worth zero, and it is the direct
    // consequence of the last credit we posted.
    const lastPaid: any = await db.prepare(
        `SELECT amount_cents, raw_json FROM billing_events
          WHERE user_id = ? AND type = 'invoice.paid' AND amount_cents > 0
          ORDER BY created_at DESC LIMIT 1`
    ).bind(inviterUserId).first();
    const sub: any = await db.prepare(
        `SELECT plan FROM subscriptions WHERE user_id = ? AND plan IS NOT NULL
          ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`
    ).bind(inviterUserId).first();

    // The invoice's own interval wins over the plan column, because the amount
    // came from that invoice and the two must describe the same thing.
    const interval = intervalOfInvoice(lastPaid?.raw_json);
    const plan = interval ? (interval === "year" ? "annual" : "monthly") : sub?.plan;

    const cents = creditCentsFrom(lastPaid?.amount_cents, plan);
    if (!cents) {
        // They have a customer but no invoice we can double. Parked rather than
        // guessed at, and retried on their next payment.
        await note(db, pending, "no_ledger_amount");
        for (const r of pending) out.parked.push({ invitee_user_id: r.invitee_user_id, reason: "no_ledger_amount" });
        return out;
    }

    const alreadyPaid = await creditedInviteeIds(stripe, customer.stripe_customer_id);

    for (const row of pending) {
        try {
            // Somebody already credited this referral and the row never caught
            // up. Reconcile instead of paying twice.
            if (alreadyPaid.has(row.invitee_user_id)) {
                await db.prepare(
                    `UPDATE referrals SET state = 'credited', credited_at = ?, note = 'reconciled_from_stripe'
                      WHERE invitee_user_id = ? AND credited_at IS NULL`
                ).bind(new Date().toISOString(), row.invitee_user_id).run();
                out.parked.push({ invitee_user_id: row.invitee_user_id, reason: "already_credited_in_stripe" });
                continue;
            }

            // Self-dealing costs one real payment and buys two months, so it is
            // profitable if nothing stops it. The copy promises "uma vez por
            // empresa convidada", and by now both sides have been through a
            // checkout, which is where a fiscal number gets collected: same
            // number, same company, no credit.
            const shared = await sharesFiscalId(db, inviterUserId, row.invitee_user_id);
            if (shared) {
                await db.prepare(
                    "UPDATE referrals SET note = 'same_fiscal_id' WHERE invitee_user_id = ? AND credited_at IS NULL"
                ).bind(row.invitee_user_id).run();
                out.parked.push({ invitee_user_id: row.invitee_user_id, reason: "same_fiscal_id" });
                continue;
            }

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

/**
 * Referrals this customer has already been credited for, according to Stripe.
 *
 * The only record that survives our own write failing, and the only guard left
 * once Stripe has forgotten the idempotency key. Fails OPEN — an empty set on a
 * read error means the idempotency key is the guard again, which is the
 * behaviour without this at all, not a worse one.
 */
async function creditedInviteeIds(stripe: any, customerId: string): Promise<Set<string>> {
    const seen = new Set<string>();
    try {
        const page = await stripe.customers.listBalanceTransactions(customerId, { limit: 100 });
        for (const t of page?.data ?? []) {
            const id = t?.metadata?.referral_invitee;
            if (id) seen.add(String(id));
        }
    } catch {
        /* fail open */
    }
    return seen;
}

/** Same fiscal number on both sides of a referral is one company, twice. */
async function sharesFiscalId(db: D1Database, inviterUserId: string, inviteeUserId: string): Promise<boolean> {
    const nifOf = async (userId: string): Promise<string | null> => {
        const s: any = await db.prepare(
            `SELECT nif FROM subscriptions WHERE user_id = ? AND nif IS NOT NULL AND TRIM(nif) <> ''
              ORDER BY updated_at DESC LIMIT 1`
        ).bind(userId).first();
        if (s?.nif) return String(s.nif).replace(/\D/g, "");
        const u: any = await db.prepare(
            "SELECT nif FROM users WHERE id = ? AND nif IS NOT NULL AND TRIM(nif) <> ''"
        ).bind(userId).first();
        return u?.nif ? String(u.nif).replace(/\D/g, "") : null;
    };
    const [a, b] = await Promise.all([nifOf(inviterUserId), nifOf(inviteeUserId)]);
    return Boolean(a && b && a === b);
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
