import { describe, it, expect } from "vitest";
import { ixDocumentState, ixEnvelopeError } from "./ix-destination";

/**
 * Grounded in the ix-proxy OpenAPI spec (src/api/ix/client/types.gen.ts) and the
 * InvoiceXpress docs: a GET reads back `status` as one of
 * draft | final | settled | canceled | second_copy, and EVERY response — 200
 * included — carries a `success` flag and a nullable `error` beside `data`.
 */

describe("ixDocumentState", () => {
  it("reads a draft as a draft", () => {
    expect(ixDocumentState("draft")).toBe("draft");
  });

  it("treats every certified status as finalized", () => {
    // IX answers "final" to a document we asked to make "finalized"; settled and
    // second_copy are equally certified as far as recovery is concerned.
    for (const s of ["final", "settled", "second_copy", "sent"]) {
      expect(ixDocumentState(s)).toBe("finalized");
    }
  });

  it("keeps canceled distinct from finalized", () => {
    // The bug this guards: folding canceled into finalized makes delete-draft
    // answer "issue a credit note" and lets a credit note be issued against a
    // document that was already voided.
    expect(ixDocumentState("canceled")).toBe("canceled");
    expect(ixDocumentState("cancelled")).toBe("canceled");
  });

  it("is case-insensitive", () => {
    expect(ixDocumentState("Draft")).toBe("draft");
    expect(ixDocumentState("CANCELED")).toBe("canceled");
  });

  it("reads an unknown status as certified, never as a draft", () => {
    // Safe direction: mistaking a certified document for a draft would delete a
    // fiscal document; the reverse merely refuses to.
    expect(ixDocumentState("something_new")).toBe("finalized");
    expect(ixDocumentState(undefined)).toBe("finalized");
  });
});

describe("ixEnvelopeError", () => {
  it("passes a healthy envelope", () => {
    expect(ixEnvelopeError({ data: { id: 1 }, success: true, error: null })).toBeNull();
  });

  it("catches a failure wearing a 200", () => {
    // The dangerous case: success:false with no data would otherwise read as
    // "the document is not there" and the caller would clear its DB row.
    const err = ixEnvelopeError({ success: false, error: { message: "boom", code: "DOC010" } });
    expect(err).toEqual({ message: "boom", code: "DOC010" });
  });

  it("still reports a failure when success:false carries no error body", () => {
    expect(ixEnvelopeError({ success: false })).toEqual({ message: "unknown failure", code: "UNKNOWN" });
  });

  it("catches an error object alongside success:true", () => {
    const err = ixEnvelopeError({ data: null, success: true, error: { message: "nope", code: "X" } });
    expect(err).toEqual({ message: "nope", code: "X" });
  });
});
