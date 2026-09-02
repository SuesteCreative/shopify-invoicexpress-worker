import { describe, it, expect, vi, afterEach } from "vitest";
import { findIxDocumentIdByReference } from "./ix-find-reference";

/**
 * The fallback path, which is the one that runs whenever the direct
 * InvoiceXpress lookup cannot answer — including on every non-production
 * connection, where it is the ONLY path.
 *
 * It exists because `ix-proxy` answers a miss in ~152s. Before this, the helper
 * retried that call twice with no deadline: ~305s inside a webhook that holds an
 * `order_claims` CAS claim, which `claimOrder` steals after 180s. The claim was
 * therefore defeated by its own slow path, and both deliveries created a
 * document. The deadline is what re-arms that guard.
 */

const HEADERS = { "x-account-name": "acct", "x-api-key": "k", "x-env": "dev" as const };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("findIxDocumentIdByReference — proxy fallback", () => {
  it("returns the id the proxy found", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ data: { data: { id: 268953515 } } }), { status: 200 },
    )));
    await expect(findIxDocumentIdByReference(HEADERS, "Order #5366")).resolves.toBe("268953515");
  });

  it("treats 404 as the answer, not an error, and does not retry it", async () => {
    // Retrying a 404 buys nothing and costs another ~152s to be told the same.
    const fetchMock = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(findIxDocumentIdByReference(HEADERS, "Order #999999")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx, which could be transient", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: 7 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(findIxDocumentIdByReference(HEADERS, "Order #1")).resolves.toBe("7");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up rather than hanging when the proxy never answers", async () => {
    // The real failure shape: the socket stays open and nothing comes back.
    vi.stubGlobal("fetch", vi.fn((_url: any, init: any) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
    })));
    const started = Date.now();
    await expect(
      findIxDocumentIdByReference(HEADERS, "Order #1", { proxyAttempts: 2, proxyTimeoutMs: 40 }),
    ).resolves.toBeNull();
    // Two attempts plus the 300ms gap, nowhere near the ~305s it used to take.
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("passes a deadline to every proxy attempt", async () => {
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await findIxDocumentIdByReference(HEADERS, "Order #1");
    expect(fetchMock).toHaveBeenCalled();
  });
});
