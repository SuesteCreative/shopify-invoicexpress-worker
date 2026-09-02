import { describe, it, expect } from "vitest";
import { pickExactReference } from "./ix-find-reference";

/**
 * The direct InvoiceXpress lookup is a TEXT search, so the exact-match filter is
 * what makes its answer usable. Measured against the live account on 2026-09-02:
 * "Order #999999" comes back with ten unrelated documents, and "Order #536"
 * matches nothing belonging to "Order #5366".
 *
 * Getting this wrong is not a slow path, it is a wrong invoice: a false positive
 * makes a create think the document already exists and silently skip a real
 * sale, which is the exact failure this whole subsystem exists to prevent.
 */
describe("pickExactReference", () => {
  it("finds the document whose reference matches exactly", () => {
    const docs = [
      { id: 1, reference: "Order #5360" },
      { id: 268953515, reference: "Order #5366" },
    ];
    expect(pickExactReference(docs, "Order #5366")).toBe("268953515");
  });

  it("returns null when the search only returned near misses", () => {
    // What the live endpoint actually does: ten documents, none of them it.
    const docs = Array.from({ length: 10 }, (_, i) => ({ id: i, reference: `Order #${5300 + i}` }));
    expect(pickExactReference(docs, "Order #999999")).toBeNull();
  });

  it("does not treat a prefix as a match", () => {
    expect(pickExactReference([{ id: 7, reference: "Order #5366" }], "Order #536")).toBeNull();
  });

  it("does not treat a longer reference as a match", () => {
    expect(pickExactReference([{ id: 7, reference: "Order #536" }], "Order #5366")).toBeNull();
  });

  it("ignores surrounding whitespace on both sides", () => {
    expect(pickExactReference([{ id: 9, reference: "  Order #5366 " }], "Order #5366")).toBe("9");
  });

  it("survives an empty, missing or malformed list", () => {
    expect(pickExactReference([], "Order #1")).toBeNull();
    expect(pickExactReference(undefined as any, "Order #1")).toBeNull();
    expect(pickExactReference([null, { reference: "Order #1" }] as any, "Order #1")).toBeNull();
  });

  it("returns the id as a string, whatever the API sent", () => {
    expect(pickExactReference([{ id: 268953515, reference: "Order #1" }], "Order #1")).toBe("268953515");
    expect(pickExactReference([{ id: "268953515", reference: "Order #1" }], "Order #1")).toBe("268953515");
  });
});
