import { describe, it, expect, vi, afterEach } from "vitest";
import { StripeSource } from "./stripe-source";
import { extractPtNif, hasPtFiscalMarker, ptNifApplies } from "../destinations/moloni-destination";
import type { AdapterCtx } from "../types";
import type { Normalized } from "../../api/normalize-shopify";

// A Stripe payment does not have to carry the buyer's name anywhere the event
// can see. Multibanco (and Link, and off-session subscription charges) leave
// `pi.shipping` unset AND `charge.billing_details.name` null, so both identity
// tiers came back empty and the invoice went out to the shared "Consumidor
// Final" record — while the Stripe Customer held the buyer's full name, PT
// address and a valid NIF the whole time (pi_3Tz3w0…, 130,00 €, 2026-08-14).
//
// Two independent halves had to be fixed and both are pinned here:
//   1. the Customer record is read for identity, not just tax_ids;
//   2. a PT-prefixed fiscal id counts as evidence of Portugal, because the
//      address that used to gate the NIF is absent on most Stripe payments.

const CUSTOMER = {
  id: "cus_UlKKfAZvsi6CJ2",
  name: "Luís André de Almeida Filipe",
  email: "luisandrefilipe@gmail.com",
  phone: null,
  address: { line1: "", line2: null, city: "", state: null, postal_code: "", country: "PT" },
  tax_ids: { data: [{ type: "eu_vat", value: "PT196940737" }] },
};

/** The real timeline of pi_3Tz3w0…: Multibanco reference generated 31/07, paid
 * 12/08. Twelve days between wanting to pay and paying. */
const STARTED_AT = 1_785_456_260; // 2026-07-31T00:04:20Z — pi.created
const PAID_AT = 1_786_520_515;    // 2026-08-12T07:41:55Z — charge.created

const piEvent = (overrides: Record<string, any> = {}) => ({
  type: "payment_intent.succeeded",
  data: {
    object: {
      id: "pi_3Tz3w0PlaNsBkqDI0Ooe7W5x",
      status: "succeeded",
      amount: 13000,
      amount_received: 13000,
      currency: "eur",
      created: STARTED_AT,
      customer: "cus_UlKKfAZvsi6CJ2",
      receipt_email: "luisandrefilipe@gmail.com",
      description: "Subscription update",
      ...overrides,
    },
  },
});

const ctx = { sourceConfig: { restricted_key: "rk_live_test" } } as unknown as AdapterCtx;

/** Stripe responds to exactly two GETs here: the Customer expand and the
 * latest_charge expand. The charge defaults to the real payload — a null name
 * and the Multibanco settlement 12 days after the intent was created. */
function stubStripe(customer: any, charge: Record<string, any> = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    const body = String(url).includes("/customers/")
      ? customer
      : { latest_charge: { billing_details: { name: null }, created: PAID_AT, ...charge } };
    return { ok: true, json: async () => body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("Stripe buyer identity", () => {
  it("recovers name, address and NIF from the Customer when the payment carries none", async () => {
    stubStripe(CUSTOMER);
    const n = (await new StripeSource().toNormalized(piEvent(), ctx))!;

    expect(n.order.customer?.name).toBe("Luís André de Almeida Filipe");
    expect(n.order.billing_address?.name).toBe("Luís André de Almeida Filipe");
    expect(n.order.billing_address?.country_code).toBe("PT");
    // Normalized to bare digits, check digit verified.
    expect(extractPtNif(n as Normalized)).toBe("196940737");
  });

  it("does not overwrite identity the event already carried", async () => {
    stubStripe({ ...CUSTOMER, name: "Stale Customer Record" }, {});
    const n = (await new StripeSource().toNormalized(
      piEvent({ shipping: { name: "Nome Na Encomenda", address: { line1: "Rua A", city: "Lisboa", postal_code: "1000-001", country: "PT" } } }),
      ctx,
    ))!;

    expect(n.order.customer?.name).toBe("Nome Na Encomenda");
    expect(n.order.billing_address?.address1).toBe("Rua A");
  });

  it("survives a Customer read failure — the invoice is still issued", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => "" } as unknown as Response)));
    const n = await new StripeSource().toNormalized(piEvent(), ctx);

    expect(n).not.toBeNull();
    expect(n!.order.total).toBe(130);
  });
});

// The document is dated by the payment. A Multibanco reference is generated on
// day one and paid days later; dating from the PaymentIntent put the invoice
// almost two weeks before the money existed (and Moloni then clamped it to the
// series floor, a date that was neither).
describe("document date", () => {
  it("is when the money arrived, not when the payment was started", async () => {
    stubStripe(CUSTOMER); // charge.created = 2026-08-12T07:41:55Z
    const n = (await new StripeSource().toNormalized(piEvent(), ctx))!;

    // pi.created is 2026-07-31T00:04:20Z — 12 days earlier.
    expect(n.order.created_at).toBe("2026-08-12T07:41:55.000Z");
    expect(n.order.meta.processed_at).toBe("2026-08-12T07:41:55.000Z");
  });

  it("falls back to the PaymentIntent when the charge cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)));
    const n = (await new StripeSource().toNormalized(piEvent(), ctx))!;

    expect(n.order.created_at).toBe("2026-07-31T00:04:20.000Z");
  });

  it("leaves a card payment where it was — intent and charge are the same moment", async () => {
    stubStripe(CUSTOMER, { created: STARTED_AT });
    const n = (await new StripeSource().toNormalized(piEvent(), ctx))!;

    expect(n.order.created_at).toBe("2026-07-31T00:04:20.000Z");
  });
});

describe("PT fiscal marker", () => {
  const order = (attrs: Array<{ name: string; value: string }>) =>
    ({ note_attributes: attrs } as unknown as Normalized["order"]);

  it("reads Portugal out of the fiscal id when the address is empty", () => {
    expect(hasPtFiscalMarker(order([{ name: "vat (eu_vat)", value: "PT196940737" }]))).toBe(true);
    expect(hasPtFiscalMarker(order([{ name: "vat (pt_nif)", value: "196940737" }]))).toBe(true);
  });

  it("does not claim Portugal for another member state", () => {
    expect(hasPtFiscalMarker(order([{ name: "vat (eu_vat)", value: "ES12345678Z" }]))).toBe(false);
    expect(hasPtFiscalMarker(order([]))).toBe(false);
  });
});

// An invoice may carry a NIF and no billing address — that is an ordinary
// document, not a suspicious one. Only a CONTRADICTING address disqualifies the
// number, and a fiscal id that names Portugal outranks even that.
describe("when a NIF may be stamped", () => {
  const order = (country: string, attrs: Array<{ name: string; value: string }> = []) =>
    ({ billing_address: { country_code: country }, note_attributes: attrs } as unknown as Normalized["order"]);

  it("keeps the NIF when there is no address at all", () => {
    expect(ptNifApplies(order(""), "196940737")).toBe(true);
    expect(ptNifApplies({} as Normalized["order"], "196940737")).toBe(true);
  });

  it("keeps the NIF for a PT address", () => {
    expect(ptNifApplies(order("PT"), "196940737")).toBe(true);
    expect(ptNifApplies(order("pt"), "196940737")).toBe(true);
  });

  it("drops a bare number when the address names another country", () => {
    expect(ptNifApplies(order("ES"), "196940737")).toBe(false);
  });

  it("keeps a PT-spelled fiscal id even against a foreign address", () => {
    expect(ptNifApplies(order("FR", [{ name: "vat (eu_vat)", value: "PT196940737" }]), "196940737")).toBe(true);
  });

  it("has nothing to stamp when no NIF was extracted", () => {
    expect(ptNifApplies(order("PT"), null)).toBe(false);
  });
});
