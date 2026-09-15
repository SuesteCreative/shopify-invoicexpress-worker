import { describe, it, expect, vi, afterEach } from "vitest";
import { LodgifySource } from "./lodgify-source";
import { IxBuilder } from "../../ix/builder";
import { ixExpectedTotals } from "../../ix/create-invoice";
import { reconcileTotalOrThrow } from "../reconcile";

/**
 * The tourist tax on its own exempt line (`lodgify_split_taxes`).
 *
 * Amounts are Farracemota's own invoice FARRACEMOTAUNIPES/141, booking 22884380:
 * 311,00 € = Room rate 282,08 € at 6% + tourist tax 12,00 € isento (M99). The
 * `subtotals` shape is the v2 one `parseBookingSubtotals` reads; how these
 * amounts sit in it is inferred from that invoice, not read off a v2 payload.
 */

const body = (booking: Record<string, any>) => ({
  event: "booking_new_status_booked",
  data: { bookingId: 22884380 },
  _preloaded_booking: {
    status: "Booked",
    total: 311,
    currency_code: "EUR",
    source: "AirbnbIntegration",
    arrival: "2026-09-03",
    departure: "2026-09-05",
    property_id: 655895,
    amount_paid: 0,
    amount_due: 0,
    // The guest detail is merged in already, so no v1 call leaves the test.
    _enriched: true,
    guest: { name: "Hóspede Teste", email: "", country_code: "PT" },
    subtotals: { stay: 299, promotions: 0, fees: 0, addons: 0, taxes: 12, vat: 0 },
    ...booking,
  },
});

const ctx = (destinationConfig: Record<string, any>, config: Record<string, any> = {}) => ({
  apiKey: "",
  config: { force_tax_rate: null, ix_exemption_reason: "M99", ...config },
  sourceConfig: { api_key: "test-key" },
  destinationConfig,
}) as any;

const SPLIT = { lodgify_split_taxes: true };

async function build(booking: Record<string, any>, dest: Record<string, any>, config?: Record<string, any>) {
  const c = ctx(dest, config);
  const normalized = (await new LodgifySource().toNormalized(body(booking), c))!;
  const { invoice } = new IxBuilder(c.config).createInvoiceFromNormalizedOrder(normalized);
  return { normalized, invoice };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("LodgifySource — tourist tax on an exempt line", () => {
  it("issues invoice 141 the way the merchant does: the stay at 6%, the tax at 0% under M99", async () => {
    const { invoice } = await build({}, SPLIT);
    expect(invoice.items.map((i: any) => [i.name, i.tax])).toEqual([
      ["Alojamento 2026-09-03 - 2026-09-05", 6],
      ["Taxa turística", 0],
    ]);
    expect(invoice.items[1].unit_price).toBe(12);
    expect(invoice.tax_exemption_reason).toBe("M99");
    expect(ixExpectedTotals(invoice.items)).toEqual({ gross: 311, vat: 16.92 });
  });

  it("passes the destination's reconcile against the booking total", async () => {
    const { normalized, invoice } = await build({}, SPLIT);
    expect(() => reconcileTotalOrThrow(Number(normalized.order.total), invoice.items.map((it: any) => ({
      name: it.name,
      quantity: Number(it.quantity),
      unit_price: Number(it.unit_price),
      tax_rate: Number(it.tax),
      discount_percent: Number(it.discount ?? 0),
    })))).not.toThrow();
  });

  it("leaves every other connection on one line at 6%", async () => {
    const { invoice } = await build({}, {});
    expect(invoice.items).toHaveLength(1);
    expect(ixExpectedTotals(invoice.items)).toEqual({ gross: 311, vat: 17.6 });
  });

  it("keeps one line for a booking that carries no tourist tax", async () => {
    const { invoice } = await build(
      { total: 288.14, subtotals: { stay: 288.14, promotions: 0, fees: 0, addons: 0, taxes: 0, vat: 0 } },
      SPLIT,
    );
    expect(invoice.items).toHaveLength(1);
    expect(invoice.tax_exemption_reason).toBeUndefined();
  });

  it("separates the tax and the extras together", async () => {
    const { invoice } = await build(
      { total: 679, subtotals: { stay: 554, promotions: 0, fees: 115, addons: 0, taxes: 10, vat: 0 } },
      { ...SPLIT, lodgify_extras_vat_rate: 23 },
    );
    expect(invoice.items.map((i: any) => i.tax)).toEqual([6, 23, 0]);
    expect(ixExpectedTotals(invoice.items).gross).toBe(679);
  });

  it("refuses a breakdown that does not add up to the total", async () => {
    await expect(build({ subtotals: { stay: 250, promotions: 0, fees: 0, addons: 0, taxes: 12, vat: 0 } }, SPLIT))
      .rejects.toThrow(/não soma o total/);
  });

  it("refuses rather than put VAT on the tax when Lodgify gives no breakdown", async () => {
    vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
    const c = ctx(SPLIT);
    c.lodgifyGateway = { base: "https://relay.invalid", key: "k", relayed: true };
    await expect(new LodgifySource().toNormalized(body({ subtotals: undefined }), c))
      .rejects.toThrow(/sem decomposição/);
  });

  it("refuses when a forced rate would tax the exempt line", async () => {
    await expect(build({}, SPLIT, { force_tax_rate: 6 })).rejects.toThrow(/force_tax_rate/);
  });
});
