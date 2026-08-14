import { describe, it, expect } from "vitest";
// @ts-expect-error — plain-JS sibling, deliberately outside the Worker's tsconfig
import { mergeDetailIntoItem } from "./merge.js";

const listItem = () => ({
  id: 21544049,
  status: "Booked",
  total_amount: 805,
  amount_paid: 402.5,
  amount_to_pay: 402.5,
  currency: { code: "EUR" },
  guest: { name: "Sandrina Teixeira", email: "s@example.pt" },
});

const detail = () => ({
  id: 21544049,
  note: "NIF 263743268",
  guest: {
    guest_name: { first_name: "Sandrina", last_name: "Teixeira", full_name: "Sandrina Teixeira" },
    email: "s@example.pt",
    country_code: "PT",
    phone_numbers: ["+351912345678"],
    street_address1: "Rua das Flores 12",
    street_address2: "2º Esq",
    city: "Porto",
    postal_code: "4050-262",
    state: "Porto",
  },
});

describe("mergeDetailIntoItem", () => {
  it("carries the guest note, which is the only path a NIF has", () => {
    const merged = mergeDetailIntoItem(listItem(), detail());
    expect(merged.note).toBe("NIF 263743268");
  });

  it("carries the postal address under v1's own field names", () => {
    const merged = mergeDetailIntoItem(listItem(), detail());
    expect(merged.guest.street_address1).toBe("Rua das Flores 12");
    expect(merged.guest.street_address2).toBe("2º Esq");
    expect(merged.guest.city).toBe("Porto");
    expect(merged.guest.postal_code).toBe("4050-262");
    expect(merged.guest.state).toBe("Porto");
  });

  it("flattens phone_numbers[] to phone, which is the field the worker reads", () => {
    const merged = mergeDetailIntoItem(listItem(), detail());
    expect(merged.guest.phone).toBe("+351912345678");
  });

  it("marks the item so the worker skips its own blocked enrichment call", () => {
    expect(mergeDetailIntoItem(listItem(), detail())._enriched).toBe(true);
  });

  it("never overwrites what the list already reported", () => {
    const item = { ...listItem(), note: "NIF 999999990", guest: { ...listItem().guest, city: "Lisboa" } };
    const merged = mergeDetailIntoItem(item, detail());
    expect(merged.note).toBe("NIF 999999990");
    expect(merged.guest.city).toBe("Lisboa");
  });

  it("treats a blank existing address as absent, not as a value to keep", () => {
    const item = { ...listItem(), guest: { ...listItem().guest, city: "   " } };
    expect(mergeDetailIntoItem(item, detail()).guest.city).toBe("Porto");
  });

  it("never touches money, status or currency", () => {
    const merged = mergeDetailIntoItem(listItem(), {
      ...detail(),
      total_amount: 1,
      amount_paid: 1,
      amount_to_pay: 0,
      status: "Declined",
      currency: { code: "USD" },
    });
    expect(merged.total_amount).toBe(805);
    expect(merged.amount_paid).toBe(402.5);
    expect(merged.amount_to_pay).toBe(402.5);
    expect(merged.status).toBe("Booked");
    expect(merged.currency).toEqual({ code: "EUR" });
  });

  it("is a no-op when there is no detail to merge", () => {
    const item = listItem();
    expect(mergeDetailIntoItem(item, null)).toEqual(item);
    expect(mergeDetailIntoItem(item, null)._enriched).toBeUndefined();
  });

  it("does not mutate its inputs", () => {
    const item = listItem();
    const d = detail();
    mergeDetailIntoItem(item, d);
    expect(item.note).toBeUndefined();
    expect(item.guest.city).toBeUndefined();
    expect(d.guest.phone_numbers).toEqual(["+351912345678"]);
  });
});
