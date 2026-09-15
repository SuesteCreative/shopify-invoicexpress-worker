import { describe, it, expect, vi, afterEach } from "vitest";
import { StripeSource } from "./stripe-source";
import type { AdapterCtx } from "../types";

// A fatura-recibo states that the money was received on its date. For a card
// that is the second the charge object was made, and reading `charge.created`
// is right. For a direct debit it is not: the charge is made when the debit is
// instructed and the money clears days later.
//
// Measured on Bestisafil, 15/09/2026 — billed monthly by SEPA, 66 of 81
// September payments are debits:
//
//   pi.created          2026-09-05 01:01   the debit is instructed
//   charge.created      2026-09-05 01:01   the charge object is made
//   balance_transaction 2026-09-07 06:46   submitted to the bank
//   invoice paid_at     2026-09-15 01:15   THE MONEY ARRIVES
//
// `balance_transaction.created` is deliberately not the answer: it is two days
// early, and being wrong by less is still wrong.
const INSTRUCTED = 1_788_570_089; // 2026-09-05T01:01:29Z
const SETTLED = 1_789_434_000;    // 2026-09-15T01:00:00Z

const piEvent = () => ({
  type: "payment_intent.succeeded",
  data: {
    object: {
      id: "pi_3UC7z3BTTqGjulMG2ZuwZP9s",
      status: "succeeded",
      amount: 23100,
      amount_received: 23100,
      currency: "eur",
      created: INSTRUCTED,
      customer: "cus_sepa",
      description: "Subscription update",
    },
  },
});

const chargeEvent = (invoice: string | null) => ({
  type: "charge.succeeded",
  data: {
    object: {
      id: "py_3UC7z3BTTqGjulMG2wFgwz9e",
      payment_intent: "pi_3UC7z3BTTqGjulMG2ZuwZP9s",
      status: "succeeded",
      paid: true,
      amount: 23100,
      currency: "eur",
      created: INSTRUCTED,
      customer: "cus_sepa",
      invoice,
      billing_details: { name: "Agência Funerária Pedra Lda.", address: null },
    },
  },
});

const ctx = { sourceConfig: { restricted_key: "rk_live_test" } } as unknown as AdapterCtx;

/** The PI expand carries the invoice inline; a bare invoice id is fetched. */
function stubStripe({ paidAt }: { paidAt: number | null }) {
  const invoice = {
    id: "in_sepa",
    number: "LLJCSSOJ-0306",
    status_transitions: paidAt ? { paid_at: paidAt } : {},
  };
  return vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    const body = u.includes("/customers/") ? { id: "cus_sepa", tax_ids: { data: [] } }
      : u.includes("/invoices/") ? invoice
        : { latest_charge: { created: INSTRUCTED, billing_details: { name: null }, invoice } };
    return { ok: true, json: async () => body } as unknown as Response;
  }));
}

afterEach(() => vi.unstubAllGlobals());

const day = (n: any) => String(n.order.created_at).slice(0, 10);

describe("the date a Stripe document carries", () => {
  it("is the day the money arrived, not the day the debit was instructed", async () => {
    stubStripe({ paidAt: SETTLED });
    const n = (await new StripeSource().toNormalized(piEvent(), ctx))!;

    expect(day(n)).toBe("2026-09-15");
    expect(n.order.meta?.processed_at?.slice(0, 10)).toBe("2026-09-15");
  });

  // All three shapes dedup onto one PaymentIntent and only one builds the
  // document, so a charge-shaped delivery must reach the same date.
  it("reaches the same date from a charge-shaped event", async () => {
    stubStripe({ paidAt: SETTLED });
    const n = (await new StripeSource().toNormalized(chargeEvent("in_sepa"), ctx))!;

    expect(day(n)).toBe("2026-09-15");
  });

  // A payment with no invoice behind it has no paid_at to read, and for the card
  // payments that shape describes, the charge's own date is already right.
  it("keeps the charge date when there is no invoice", async () => {
    stubStripe({ paidAt: null });
    const n = (await new StripeSource().toNormalized(chargeEvent(null), ctx))!;

    expect(day(n)).toBe("2026-09-05");
  });

  it("keeps the charge date when the invoice states no paid_at", async () => {
    stubStripe({ paidAt: null });
    const n = (await new StripeSource().toNormalized(piEvent(), ctx))!;

    expect(day(n)).toBe("2026-09-05");
  });
});
