import { describe, it, expect } from "vitest";
import { redactConnectionConfig, redactConfigJson, FISCAL_CONFIG_KEYS } from "./redact";

/**
 * The rules console sends a connection's configuration to a browser, and that
 * configuration holds Moloni passwords and Vendus API keys next to the VAT
 * settings it exists to show. The redaction is an allowlist for one reason: a
 * denylist is only correct until someone adds a key it has never heard of, and
 * the whole point is that nobody has to remember to update it.
 */

const FULL_MOLONI_CONFIG = {
  moloni_client_id: "app-123",
  moloni_client_secret: "sh_supersecret",
  moloni_username: "conta@exemplo.pt",
  moloni_password: "hunter2",
  moloni_company_id: 4242,
  moloni_document_set_name: "Faturas 2026",
  moloni_category_id: 91,
  moloni_maturity_date_id: 7,
  vat_included: false,
  exemption_reason: "M05",
  custom_invoice_note: "Regime de IVA de caixa",
};

describe("redactConnectionConfig", () => {
  it("returns the fiscal settings verbatim — they are the point of the console", () => {
    const { fiscal } = redactConnectionConfig(FULL_MOLONI_CONFIG);
    expect(fiscal.moloni_company_id).toBe(4242);
    expect(fiscal.vat_included).toBe(false);
    expect(fiscal.exemption_reason).toBe("M05");
    expect(fiscal.custom_invoice_note).toBe("Regime de IVA de caixa");
    // The three settings that previously had no UI at all.
    expect(fiscal.moloni_category_id).toBe(91);
    expect(fiscal.moloni_maturity_date_id).toBe(7);
  });

  it("never returns a credential, in any field", () => {
    const out = redactConnectionConfig(FULL_MOLONI_CONFIG);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("sh_supersecret");
    expect(serialized).not.toContain("conta@exemplo.pt");
  });

  it("still says whether a credential is set, without saying what it is", () => {
    const { present } = redactConnectionConfig(FULL_MOLONI_CONFIG);
    expect(present.moloni_password).toBe(true);
    expect(present.moloni_client_secret).toBe(true);
    // Never held — reported as absent rather than missing from the payload.
    expect(present.vendus_api_key).toBe(false);
  });

  it("treats an unknown key as a secret rather than as data", () => {
    // The property that makes this an allowlist: a key added to the worker
    // tomorrow leaks nothing today.
    const { fiscal, present } = redactConnectionConfig({
      some_future_token: "tok_live_abcdef",
      moloni_company_id: 1,
    });
    expect(JSON.stringify(fiscal)).not.toContain("tok_live_abcdef");
    expect(fiscal.some_future_token).toBeUndefined();
    expect(present.some_future_token).toBe(true);
  });

  it("distinguishes an empty credential from a set one", () => {
    const { present } = redactConnectionConfig({ moloni_password: "", vendus_api_key: null });
    expect(present.moloni_password).toBe(false);
    expect(present.vendus_api_key).toBe(false);
  });

  it("lists no credential name among the fiscal keys", () => {
    const suspicious = FISCAL_CONFIG_KEYS.filter((k) =>
      /secret|password|token|api_key|hmac|restricted/.test(k));
    expect(suspicious).toEqual([]);
  });
});

describe("redactConfigJson", () => {
  it("parses and redacts in one step", () => {
    const { fiscal } = redactConfigJson(JSON.stringify(FULL_MOLONI_CONFIG));
    expect(fiscal.exemption_reason).toBe("M05");
  });

  it("survives the malformed or absent JSON D1 can hold", () => {
    for (const bad of [null, undefined, "", "{not json", "[]"]) {
      expect(() => redactConfigJson(bad as any)).not.toThrow();
      expect(redactConfigJson(bad as any).fiscal).toEqual({});
    }
  });
});
