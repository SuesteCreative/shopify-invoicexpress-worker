import { describe, it, expect, vi, afterEach } from "vitest";
import { VendusDestination } from "./vendus-destination";

/**
 * The last guard between a redelivered webhook and a duplicate fiscal document.
 *
 * Two defects, both fixed here, and both of the kind that issues a second
 * invoice rather than merely slowing something down:
 *
 *  - it answered `null` on any non-2xx, so the destination being unreachable
 *    read as "there is no such document" and a duplicate followed. IX had the
 *    same bug and was fixed; Moloni already re-throws transient errors.
 *  - Vendus's `?reference=` is a documented SUBSTRING match and this took
 *    `list[0]` regardless, so "Order #536" could hand back the document for
 *    "Order #5366" — somebody else's invoice id.
 */

const ctx: any = {
  config: {},
  destinationConfig: { vendus_api_key: "k" },
};
const dest: any = new (VendusDestination as any)();
const reply = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Vendus findByReference", () => {
  it("returns the document whose reference matches exactly", async () => {
    reply(200, [{ id: 77, reference: "Order #5366" }]);
    await expect(dest.findByReference("Order #5366", ctx)).resolves.toEqual({ id: "77" });
  });

  it("does not hand back a substring neighbour", async () => {
    // The live filter really does return this for "Order #536".
    reply(200, [{ id: 99, reference: "Order #5366" }]);
    await expect(dest.findByReference("Order #536", ctx)).resolves.toBeNull();
  });

  it("says no when the destination genuinely holds nothing", async () => {
    reply(200, []);
    await expect(dest.findByReference("Order #1", ctx)).resolves.toBeNull();
  });

  it("treats an explicit 404 as the answer", async () => {
    reply(404, { error: "not found" });
    await expect(dest.findByReference("Order #1", ctx)).resolves.toBeNull();
  });

  it("REFUSES to answer when Vendus is down — this is the duplicate guard", async () => {
    reply(500, { error: "boom" });
    await expect(dest.findByReference("Order #1", ctx)).rejects.toThrow(/HTTP 500/);
  });

  it("REFUSES when candidates came back with nothing to match on", async () => {
    // Claiming "no document" here would be a lie: the destination just handed
    // us documents, we simply cannot tell whether one of them is ours.
    reply(200, [{ id: 5 }, { id: 6 }]);
    await expect(dest.findByReference("Order #1", ctx)).rejects.toThrow(/no reference field/);
  });
});
