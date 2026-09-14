import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { moloniNotes, MOLONI_NOTES_MAX } from "./moloni-destination";

/**
 * Moloni's `notes` field, which is the Moloni half of what `observations` is on
 * InvoiceXpress, and it now has to hold one more thing: the merchant's standing
 * note.
 *
 * That changes the stakes of the ordering. The field used to carry a booking
 * reference and a guest note, comfortably short, so appending anything was
 * safe. A standing note fills the field on every document, and from then on
 * whatever is appended last is what the cap removes. What gets appended on a
 * redate is "Data do pagamento: dd/mm/aaaa" — the one line tying a document to
 * the payment it covers, on precisely the documents whose date was moved.
 *
 * So these pin the order, not the wording: obligatory first, merchant last.
 */

describe("moloniNotes", () => {
  it("joins what it is given, in the order it is given", () => {
    expect(moloniNotes("AIRBNB-123", "NIF 123456789")).toBe("AIRBNB-123 | NIF 123456789");
  });

  it("drops what is absent instead of leaving empty separators", () => {
    expect(moloniNotes("AIRBNB-123", null, undefined, "   ", "Nota")).toBe("AIRBNB-123 | Nota");
    expect(moloniNotes(null, undefined)).toBe("");
  });

  it("trims each part", () => {
    expect(moloniNotes("  AIRBNB-123  ", " Nota ")).toBe("AIRBNB-123 | Nota");
  });

  it("cuts at the cap, which means it cuts the LAST part", () => {
    const notes = moloniNotes("Data do pagamento: 30/07/2026", "N".repeat(400));
    expect(notes.length).toBe(MOLONI_NOTES_MAX);
    expect(notes.startsWith("Data do pagamento: 30/07/2026")).toBe(true);
  });

  it("leaves a payment date intact behind a standing note at the cap", () => {
    // The redate case. Before the reordering this read
    // `${existing} | ${paymentNote}`, so a merchant with a 200-char standing
    // note lost the payment date entirely.
    const existing = `AIRBNB-123 | ${"N".repeat(400)}`;
    const notes = moloniNotes("Data do pagamento: 30/07/2026", existing);
    expect(notes).toContain("Data do pagamento: 30/07/2026");
  });

  it("is unchanged for a document with no standing note", () => {
    // What every existing merchant gets: byte for byte what they get today.
    expect(moloniNotes("AIRBNB-123", "NIF 123456789", "")).toBe("AIRBNB-123 | NIF 123456789");
  });
});

/**
 * The helper cannot enforce the order; only the call sites choose it, and the
 * order is the entire point. Checked against the source because reaching these
 * two paths for real means faking a Moloni series rejection and a redate, which
 * would test the mock rather than the ordering.
 */
describe("the call sites put the obligatory part first", () => {
  // Relative to the repo root, as the other source-reading tests here do:
  // this project's tsconfig has no Node types beyond what those already use.
  const SOURCE = readFileSync(join("src", "adapters", "destinations", "moloni-destination.ts"), "utf8");

  it("the insert retry leads with the payment date", () => {
    expect(SOURCE).toContain("moloniNotes(paymentNote, existingNotes)");
  });

  it("the redate leads with the transaction note", () => {
    expect(SOURCE).toContain("moloniNotes(note, o.existingNotes)");
  });

  it("the document itself ends with the merchant's note", () => {
    // `customNoteOf(ctx)` last in the create call, after reference and note.
    expect(SOURCE).toMatch(
      /moloniNotes\(\s*normalized\.order\.channel_reference,\s*normalized\.order\.note,\s*customNoteOf\(ctx\),\s*\)/,
    );
  });

  it("no raw slice(0, 200) is left on a notes field", () => {
    // Every `notes` composition goes through the helper, so the cap and the
    // ordering live in one place.
    expect(SOURCE).not.toMatch(/notes:.*slice\(0, 200\)/);
  });
});
