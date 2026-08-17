import { describe, it, expect } from "vitest";
import { redactIncident } from "./anthropic";

/**
 * `redactIncident` is the only thing that leaves the worker for the triage
 * model, and it is a whitelist — which is why the diagnostics read as vague for
 * so long. Six of the eight producers of `queue_retry_exhausted` never set
 * `detail.message`, the one free-text field the whitelist copies, so the model
 * was handed a kind and a connection label and correctly answered that it had
 * nothing to work with.
 *
 * Two properties are pinned here: the new technical fields do reach the model,
 * and the whitelist stays a whitelist while they do.
 */

const base = { kind: "queue_retry_exhausted", severity: "critical" } as any;

describe("redactIncident — what the model receives", () => {
  it("passes the destination's status and the attempt count through", () => {
    const red = redactIncident({
      ...base,
      connection_label: "shopify → invoicexpress",
      detail: { message: "IX create failed", http_status: 422, attempts: 10 },
    });
    expect(red.http_status).toBe(422);
    expect(red.attempts).toBe(10);
    expect(red.error_message).toContain("IX create failed");
  });

  it("leaves the status out rather than inventing one", () => {
    const red = redactIncident({ ...base, detail: { message: "transporte falhou" } });
    expect(red.http_status).toBeUndefined();
    expect(red.attempts).toBeUndefined();
  });

  it("refuses a status that is not a number — the field must not carry prose", () => {
    const red = redactIncident({
      ...base,
      detail: { message: "erro", http_status: "422 — Fiscal is invalid <cliente@exemplo.pt>" },
    } as any);
    expect(red.http_status).toBeUndefined();
  });

  it("carries the dead-letter join-back, the case that used to arrive empty", () => {
    const red = redactIncident({
      ...base,
      connection_label: "shopify → invoicexpress",
      detail: {
        sourceQueue: "shopifyordersqueue",
        message: 'IX create failed (HTTP 422): {"message":"Fiscal is invalid"}',
        http_status: 422,
        last_error_source: "document_events",
      },
    });
    expect(red.error_message).toContain("Fiscal is invalid");
    expect(red.http_status).toBe(422);
  });
});

describe("redactIncident — the whitelist still holds", () => {
  it("scrubs PII out of an error body that echoes it back", () => {
    const red = redactIncident({
      ...base,
      client_name: "Maria Silva",
      order_ref: "#4659",
      detail: {
        message: 'IX create failed: {"email":"maria@exemplo.pt","fiscal_id":"214659801","client":"Maria Silva","ref":"#4659"}',
        http_status: 422,
      },
    });
    expect(red.error_message).not.toContain("maria@exemplo.pt");
    expect(red.error_message).not.toContain("214659801");
    expect(red.error_message).not.toContain("Maria Silva");
    expect(red.error_message).not.toContain("#4659");
    // Scrubbed, not emptied — the technical reason has to survive.
    expect(red.error_message).toContain("IX create failed");
    expect(red.http_status).toBe(422);
  });

  it("copies no field it was not asked to copy", () => {
    const red = redactIncident({
      ...base,
      detail: {
        message: "erro",
        shopDomain: "angel.myshopify.com",
        messageBody: '{"customer":{"email":"cliente@exemplo.pt"}}',
        clientName: "Maria Silva",
        api_key: "sk_live_supersecret",
      },
    });
    const serialized = JSON.stringify(red);
    expect(serialized).not.toContain("angel.myshopify.com");
    expect(serialized).not.toContain("sk_live_supersecret");
    expect(serialized).not.toContain("cliente@exemplo.pt");
    // No key outside the declared whitelist, whatever the detail carried. This
    // is the assertion that fails the day someone widens the redaction.
    const ALLOWED = [
      "kind", "connection_label", "source", "destination", "currency",
      "error_message", "http_status", "attempts", "totals", "lines",
    ];
    expect(Object.keys(red).filter((k) => !ALLOWED.includes(k))).toEqual([]);
  });

  it("still parses reconcile drift into totals and lines", () => {
    const red = redactIncident({
      ...base,
      kind: "reconcile_drift",
      detail: {
        message: 'Invoice total mismatch: paid=58.00 expected=54.72 drift=3.28. Lines=[{"name":"Bilhete Adulto","quantity":1,"unit_price":54.72,"tax_rate":0}]',
      },
    });
    expect(red.totals).toEqual({ paid: 58, expected: 54.72, drift: 3.28 });
    expect(red.lines?.[0]?.name).toBe("Bilhete Adulto");
    // The Lines blob must not also ride along inside the message.
    expect(red.error_message).not.toContain("Lines=");
  });
});
