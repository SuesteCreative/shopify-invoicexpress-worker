import { describe, it, expect } from "vitest";
import { redactSecrets, redactDeep } from "./redact";

/**
 * The string that prompted this, verbatim from a live sweep response on
 * 2026-09-02, on its way into `dev_jobs.results`, `incidents.summary` and the
 * ops digest email:
 *
 *   Request timed out: GET https://<account>.app.invoicexpress.com/invoices/268954123.json?api_key=<real key>
 *
 * InvoiceXpress takes its credential in the query string, so every timeout,
 * every 5xx, every "Request failed" carries a merchant's API key in its message.
 */
const LIVE_ERROR =
  'Fetch failed: {"data":null,"success":false,"error":{"message":"Request timed out: '
  + 'GET https://pelicanzooparquez.app.invoicexpress.com/invoices/268954123.json?api_key=d795a623e8f04c11bd77"}}';

describe("redactSecrets", () => {
  it("removes the key from the error that started this", () => {
    const out = redactSecrets(LIVE_ERROR);
    expect(out).not.toContain("d795a623e8f04c11bd77");
    expect(out).toContain("api_key=«redacted»");
    // Everything an operator needs to act on must survive.
    expect(out).toContain("Request timed out");
    expect(out).toContain("invoices/268954123.json");
  });

  it("handles the other shapes a credential arrives in", () => {
    expect(redactSecrets('"x-api-key": "abc123def456"')).not.toContain("abc123def456");
    expect(redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc")).not.toContain("eyJhbGciOiJIUzI1NiJ9.abc");
    expect(redactSecrets("?token=t0ps3cr3t&page=2")).toBe("?token=«redacted»&page=2");
  });

  it("leaves clean text exactly as it was", () => {
    const clean = "Invoice 268954123 created for order #ZL5366 — 51,00 €";
    expect(redactSecrets(clean)).toBe(clean);
  });

  it("does not swallow the rest of a query string", () => {
    // The redaction must stop at the separator, or the operator loses context.
    expect(redactSecrets("/invoices.json?api_key=SECRET&page=3&per_page=100"))
      .toBe("/invoices.json?api_key=«redacted»&page=3&per_page=100");
  });
});

describe("redactDeep", () => {
  it("redacts a credential held under a telltale key, whatever it looks like", () => {
    // No `?api_key=` to pattern-match on here — only the field name gives it away.
    const out = redactDeep({ shop: "zoolagos", ix_api_key: "d795a623e8f04c11bd77" });
    expect(out).toEqual({ shop: "zoolagos", ix_api_key: "«redacted»" });
  });

  it("walks arrays and nested objects", () => {
    const out = redactDeep({ results: [{ message: LIVE_ERROR }] }) as any;
    expect(out.results[0].message).not.toContain("d795a623e8f04c11bd77");
  });

  it("keeps non-strings usable — an id stays a number, not a string", () => {
    const out = redactDeep({ invoice_id: 268954123, total: 51, ok: true, missing: null }) as any;
    expect(out).toEqual({ invoice_id: 268954123, total: 51, ok: true, missing: null });
  });

  it("terminates on a self-referencing structure instead of recursing forever", () => {
    const loop: any = { name: "a" };
    loop.self = loop;
    expect(() => redactDeep(loop)).not.toThrow();
  });
});
