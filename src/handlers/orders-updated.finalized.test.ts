import { describe, it, expect } from "vitest";
import { isAlreadyFinalizedIxError } from "../adapters/destinations/ix-finalize";

// The exact body InvoiceXpress returned on lliberta-shop and Angel Piercing
// when orders/updated tried to PUT a document the shop had already certified.
// The guard in handleOrderUpdated keys on this, so the string is worth pinning:
// it is what tells a lawful refusal apart from a real update failure.
describe("orders/updated on a certified document", () => {
  it("reads InvoiceXpress's Portuguese refusal as already-finalized", () => {
    const ixError = { message: "O documento já foi finalizado, não pode ser alterado." };
    expect(isAlreadyFinalizedIxError(ixError)).toBe(true);
  });

  it("still treats an unrelated refusal as a failure", () => {
    expect(isAlreadyFinalizedIxError({ message: "Cliente/Fiscal não é válido" })).toBe(false);
  });
});
