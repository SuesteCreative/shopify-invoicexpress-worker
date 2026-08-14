import { describe, it, expect } from "vitest";
import { toPreloadedFromItem } from "./lodgify-booking";

/**
 * These assertions exist because Lodgify blocks this Worker's egress, so the
 * per-booking detail call that used to supply the guest's address and NIF now
 * happens outside and rides in on the item itself. If this mapping drops a
 * field, every Moloni customer is created with a blank address and nothing
 * fails loudly — the documents are simply wrong.
 */

const enrichedItem = () => ({
  id: 21544049,
  status: "Booked",
  total_amount: 805,
  currency_code: "EUR",
  arrival: "2026-08-15T00:00:00",
  departure: "2026-08-20T00:00:00",
  note: "NIF 263743268",
  guest: {
    name: "Sandrina Teixeira",
    email: "s@example.pt",
    country_code: "PT",
    phone: "+351912345678",
    street_address1: "Rua das Flores 12",
    street_address2: "2º Esq",
    city: "Porto",
    postal_code: "4050-262",
    state: "Porto",
  },
  _enriched: true,
});

describe("toPreloadedFromItem", () => {
  it("carries the postal address the enricher merged in", () => {
    const p = toPreloadedFromItem(enrichedItem()) as any;
    expect(p.guest.address1).toBe("Rua das Flores 12");
    expect(p.guest.address2).toBe("2º Esq");
    expect(p.guest.city).toBe("Porto");
    expect(p.guest.zip).toBe("4050-262");
    expect(p.guest.state).toBe("Porto");
  });

  it("carries the guest note, which is where a PT NIF arrives", () => {
    expect((toPreloadedFromItem(enrichedItem()) as any).notes).toBe("NIF 263743268");
  });

  it("passes the _enriched marker through so the pipeline skips its blocked call", () => {
    expect((toPreloadedFromItem(enrichedItem()) as any)._enriched).toBe(true);
  });

  it("reports _enriched false for a plain list item, never undefined", () => {
    // The pipeline branches on this. A missing marker must read as "nobody has
    // enriched this yet", so enrichment is attempted again the day it works.
    const p = toPreloadedFromItem({ id: 1, status: "Booked", total_amount: 10 }) as any;
    expect(p._enriched).toBe(false);
  });

  it("leaves address fields null when the item has none", () => {
    const p = toPreloadedFromItem({ id: 1, guest: { name: "X" } }) as any;
    expect(p.guest.address1).toBeNull();
    expect(p.guest.zip).toBeNull();
  });

  it("still reads the alternative v1 field names", () => {
    const p = toPreloadedFromItem({ id: 1, guest: { address1: "Rua A", zip: "1000-001" } }) as any;
    expect(p.guest.address1).toBe("Rua A");
    expect(p.guest.zip).toBe("1000-001");
  });
});
