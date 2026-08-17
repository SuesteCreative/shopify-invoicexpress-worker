import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `findByReference` answers the question every create asks before issuing a
 * document: "do you already hold this one?". It is the last guard between a
 * re-delivered webhook and a duplicate fiscal document.
 *
 * It used to ignore the error entirely and return `null` — "no such document" —
 * whichever way the call went. The proxy in front of InvoiceXpress sits on
 * shared hosting and falls over under load, so the guard answered "no" precisely
 * when the destination was least able to say. These tests pin the rule that
 * replaced it: `null` means NO, and nothing else may produce it.
 */

const referencePost = vi.fn();

vi.mock("../../api/ix", () => ({
  IxApi: {
    v2: {
      documents: {
        reference: { post: (...args: any[]) => referencePost(...args) },
      },
    },
  },
}));

const { InvoiceXpressDestination } = await import("./ix-destination");

const ctx: any = {
  apiKey: "k",
  config: { ix_account_name: "acct", ix_api_key: "key", ix_environment: "production" },
};

const dest: any = new (InvoiceXpressDestination as any)();

beforeEach(() => referencePost.mockReset());

describe("findByReference", () => {
  it("returns the document when the destination holds one", async () => {
    referencePost.mockResolvedValue({ data: { data: { id: 12345 } } });
    expect(await dest.findByReference("Order #1013", ctx)).toEqual({ id: "12345" });
  });

  it("answers absent when the destination genuinely has no such document", async () => {
    referencePost.mockResolvedValue({ data: { data: null } });
    expect(await dest.findByReference("Order #1013", ctx)).toBeNull();
  });

  it("answers absent on an explicit not-found", async () => {
    referencePost.mockResolvedValue({
      error: { message: "Document not found", code: "DOC404" },
      response: { status: 404 },
    });
    expect(await dest.findByReference("Order #1013", ctx)).toBeNull();
  });

  it("REFUSES to answer when the proxy is down — this is the duplicate guard", async () => {
    // The exact shape that used to read as "no such document" and mint a second
    // invoice for a sale that already had one.
    referencePost.mockResolvedValue({
      error: { message: "Bad gateway", code: "UPSTREAM" },
      response: { status: 502 },
    });
    await expect(dest.findByReference("Order #1013", ctx)).rejects.toThrow(/reference lookup failed/i);
  });

  it("REFUSES on a 200 that carries success:false", async () => {
    // InvoiceXpress answers some failures with an HTTP 200 whose body says the
    // opposite, which the SDK never surfaces as an error.
    referencePost.mockResolvedValue({
      data: { success: false, error: { message: "Rate limited", code: "TOO_MANY" }, data: null },
    });
    await expect(dest.findByReference("Order #1013", ctx)).rejects.toThrow(/reference lookup failed/i);
  });

  it("names the reference it could not resolve", async () => {
    referencePost.mockResolvedValue({ error: { message: "boom", code: "X" }, response: { status: 500 } });
    await expect(dest.findByReference("Order #pi_3U3vtj", ctx)).rejects.toThrow(/Order #pi_3U3vtj/);
  });
});
