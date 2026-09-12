import { describe, it, expect } from "vitest";
import { missingDestinationCredential } from "./connection-health";

/**
 * The three live shapes this was written for, on 2026-09-12:
 *
 *   Bestisafil  — no `integrations` row at all, never had one.
 *   MeetFrank   — had one for months; an admin delete took it away.
 *   Farracemota — row still there, both credentials blanked.
 *
 * All three read as ACTIVE and issued nothing. What matters is not only that
 * each is caught but that the sentence sent to the merchant names the step
 * they have to go and do.
 */
describe("missingDestinationCredential — InvoiceXpress", () => {
  it("passes a connection with both halves", () => {
    expect(missingDestinationCredential("invoicexpress", {}, { ix_account_name: "whmservicesunipes", ix_api_key: "k" }))
      .toBeNull();
  });

  it("catches an account with no integrations row", () => {
    expect(missingDestinationCredential("invoicexpress", {}, null))
      .toMatch(/Não há credenciais de InvoiceXpress/);
  });

  it("catches a row whose credentials were blanked", () => {
    expect(missingDestinationCredential("invoicexpress", {}, { ix_account_name: "", ix_api_key: null }))
      .toMatch(/por preencher/);
  });

  it("says which half is missing when only one is", () => {
    expect(missingDestinationCredential("invoicexpress", {}, { ix_account_name: "conta", ix_api_key: "  " }))
      .toMatch(/chave API/);
    expect(missingDestinationCredential("invoicexpress", {}, { ix_account_name: "", ix_api_key: "k" }))
      .toMatch(/nome da conta/);
  });
});

describe("missingDestinationCredential — the other destinations", () => {
  it("accepts Moloni on OAuth or on the legacy pair", () => {
    expect(missingDestinationCredential("moloni", { moloni_auth_mode: "oauth" }, null)).toBeNull();
    expect(missingDestinationCredential("moloni", { moloni_refresh_token: "r" }, null)).toBeNull();
    expect(missingDestinationCredential("moloni", { moloni_client_id: "c", moloni_username: "u" }, null)).toBeNull();
    expect(missingDestinationCredential("moloni", {}, null)).toMatch(/Moloni/);
  });

  it("accepts Vendus on its api key", () => {
    expect(missingDestinationCredential("vendus", { vendus_api_key: "v" }, null)).toBeNull();
    expect(missingDestinationCredential("vendus", {}, null)).toMatch(/Vendus/);
  });

  it("stays quiet about a destination it does not know", () => {
    expect(missingDestinationCredential("something_new", {}, null)).toBeNull();
  });

  it("does not fault a Moloni connection for having no InvoiceXpress row", () => {
    // The legacy row is InvoiceXpress's credential store and nobody else's.
    // Reading it for every destination is how a healthy Moloni merchant would
    // have been emailed every night about a system they do not use.
    expect(missingDestinationCredential("moloni", { moloni_auth_mode: "oauth" }, { ix_account_name: null, ix_api_key: null }))
      .toBeNull();
  });
});
