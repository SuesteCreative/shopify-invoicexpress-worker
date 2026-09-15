/**
 * A malformed buyer email must not block a fiscal document.
 *
 * Moloni refuses the whole customer insert over a bad email (`["3 email"]`), and
 * the email only matters for mailing the PDF. Measured on Escola Lá Fora
 * (15/09/2026): an address with sixteen digits glued onto its domain stopped a
 * 198,17 € sale from being invoiced at all.
 */
import { describe, it, expect } from "vitest";
import { moloniEmail } from "./moloni-destination";

describe("moloniEmail", () => {
  it("passes an ordinary address through", () => {
    expect(moloniEmail("maria.silva@gmail.com")).toBe("maria.silva@gmail.com");
    expect(moloniEmail("  joao+escola@sapo.pt ")).toBe("joao+escola@sapo.pt");
    expect(moloniEmail("ana@sub.dominio.co.uk")).toBe("ana@sub.dominio.co.uk");
  });

  it("drops the shape that blocked a real document", () => {
    // The TLD carries digits: something was pasted straight after the address.
    expect(moloniEmail("nome.apelido@hotmail.pt9123456789012345")).toBe("");
  });

  it("drops other things that are not addresses", () => {
    expect(moloniEmail("sem arroba")).toBe("");
    expect(moloniEmail("a@b")).toBe("");
    expect(moloniEmail("dois@@arrobas.pt")).toBe("");
    expect(moloniEmail("espaço no@meio.pt")).toBe("");
  });

  it("is empty, not an error, when there is no email", () => {
    expect(moloniEmail(null)).toBe("");
    expect(moloniEmail(undefined)).toBe("");
    expect(moloniEmail("")).toBe("");
  });
});
