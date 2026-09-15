import { describe, it, expect } from "vitest";
import { classifyPipelineError } from "./generic-pipeline";
import { platformError } from "../services/platform-error";

/**
 * The classifier reads the message text, and the legacy Shopify→IX handler
 * phrases its refusal differently from the adapter path ("Failed to create
 * invoice for order N" vs "InvoiceXpress create failed"). That one mismatch
 * decided a lot: an unmatched message fell through to the default branch —
 * destination_reject, non-permanent — which is the single branch exempted from
 * the transient give-up, so a bad NIF that could never succeed took all ten
 * retries into the dead-letter queue, where the incident carried no error text.
 *
 * The two phrasings must therefore classify alike, which is what this pins.
 */

const legacy = (body: string) => `Failed to create invoice for order 7781137449306: ${body}`;
const adapter = (body: string) => `InvoiceXpress create failed: ${body}`;

describe("classifyPipelineError — legacy and adapter phrasings agree", () => {
  it("reads a bad NIF as permanent on both paths", () => {
    const want = { kind: "nif_invalid", severity: "critical", permanent: true };
    expect(classifyPipelineError(new Error(legacy('{"message":"Fiscal is invalid"}')))).toEqual(want);
    expect(classifyPipelineError(new Error(adapter('{"message":"Fiscal is invalid"}')))).toEqual(want);
  });

  it("reads a deterministic 4xx as permanent on both paths", () => {
    const want = { kind: "destination_reject", severity: "critical", permanent: true };
    expect(classifyPipelineError(new Error(legacy('{"status":422,"message":"unprocessable"}')))).toEqual(want);
    expect(classifyPipelineError(new Error(adapter('{"status":422,"message":"unprocessable"}')))).toEqual(want);
  });

  it("reads rejected credentials as an auth failure on both paths", () => {
    const want = { kind: "auth_failure_destination", severity: "critical", permanent: true };
    expect(classifyPipelineError(new Error(legacy('{"status":401,"message":"unauthorized"}')))).toEqual(want);
    expect(classifyPipelineError(new Error(adapter('{"status":401,"message":"unauthorized"}')))).toEqual(want);
  });

  it("leaves a destination outage retryable — the retries are the fix there", () => {
    const got = classifyPipelineError(new Error(legacy('{"status":502,"message":"Bad Gateway"}')));
    expect(got.permanent).toBe(false);
    expect(got.kind).toBe("destination_reject");
  });

  it("classifies the same whether or not the error carries a status", () => {
    const body = '{"message":"Fiscal is invalid"}';
    expect(classifyPipelineError(platformError(legacy(body), 422)))
      .toEqual(classifyPipelineError(new Error(legacy(body))));
  });
});

describe("classifyPipelineError — the guards that must not regress", () => {
  it("still recognises the reconcile guard, which no retry can satisfy", () => {
    expect(classifyPipelineError(new Error("Invoice total mismatch: paid=58.00 expected=54.72 drift=3.28")))
      .toEqual({ kind: "reconcile_drift", severity: "critical", permanent: true });
  });

  it("still recognises an empty document", () => {
    expect(classifyPipelineError(new Error("Order 123 has no line items")))
      .toEqual({ kind: "normalize_fail", severity: "critical", permanent: true });
  });

  it("keeps paid-before-created self-healing rather than alerting on it", () => {
    const got = classifyPipelineError(new Error("Invoice not found by order.order_number=4657"));
    expect(got.permanent).toBe(false);
    expect(got.severity).toBe("info");
  });

  it("does not mistake a credit-note refusal for a create", () => {
    const got = classifyPipelineError(new Error('InvoiceXpress credit create failed: {"message":"Fiscal is invalid"}'));
    expect(got.kind).toBe("nif_invalid");
    expect(got.permanent).toBe(true);
  });
});

describe("classifyPipelineError — an InvoiceXpress validation refusal is permanent", () => {
  // 2026-09-14: InvoiceXpress refused one refund's credit note for a missing
  // exemption reason. The message carries no HTTP status — the proxy forwards
  // IX's own wording inside a 200 envelope — so `looksPermanent4xx` saw nothing,
  // the queue spent its whole budget, and every attempt created another credit
  // note for the OTHER refund on the same order. 22 documents out of one refusal.
  it("stops retrying a create InvoiceXpress will never accept", () => {
    const got = classifyPipelineError(new Error(
      'InvoiceXpress credit create failed for refund 1041494901012: {"error":{"message":"Razão de isenção deve ter uma opção selecionada"}}',
    ));
    expect(got.permanent).toBe(true);
    expect(got.severity).toBe("critical");
  });

  it("stops retrying a finalize InvoiceXpress will never accept", () => {
    const got = classifyPipelineError(new Error(
      'InvoiceXpress finalize failed for credit note 270277803: {"error":{"message":"O total não pode ser superior ao total dos documentos relacionados"}}',
    ));
    expect(got.permanent).toBe(true);
    expect(got.severity).toBe("critical");
  });

  it("stops retrying a credit note against a document that is, or was, a draft", () => {
    // 50xbtj-vv #1070/#1071, 15/09/2026: the invoices were drafts later deleted.
    const got = classifyPipelineError(new Error(
      'InvoiceXpress credit create failed for refund 1188256416128: {"error":{"message":"Owner document must not be in draft"}}',
    ));
    expect(got.permanent).toBe(true);
  });

  it("leaves a destination that is merely down with its full retry budget", () => {
    const got = classifyPipelineError(new Error(
      'InvoiceXpress credit create failed for refund 1: {"error":{"message":"Bad Gateway upstream"}}',
    ));
    expect(got.permanent).toBe(false);
  });
});
