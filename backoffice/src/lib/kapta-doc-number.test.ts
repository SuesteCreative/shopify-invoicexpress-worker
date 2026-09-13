import { describe, it, expect } from "vitest";
import { documentFromGetResponse, findInIndex, remainingPages, summarizeIxDoc, type KaptaDocSummary } from "./kapta-doc-number";

describe("reading one document without walking the account", () => {
    it("finds the document whatever the root key of the GET is", () => {
        expect(documentFromGetResponse({ invoice_receipt: { id: 269984367, state: "final" } })?.id).toBe(269984367);
        expect(documentFromGetResponse({ invoice: { id: "1", state: "final" } })?.id).toBe("1");
        expect(documentFromGetResponse({ credit_note: { id: 7 } })?.id).toBe(7);
    });

    it("is not fooled by an error body or a 200 that failed", () => {
        expect(documentFromGetResponse({ errors: [{ error: "not found" }] })).toBeNull();
        expect(documentFromGetResponse({ success: false, message: "x" })).toBeNull();
        expect(documentFromGetResponse(null)).toBeNull();
    });

    it("summarises with the printed number and IX's own permalink", () => {
        const s = summarizeIxDoc(
            { id: "268993350.0", sequence_number: "673/Kapta2026", inverted_sequence_number: "Kapta2026/673", permalink: "https://public/x" },
            "https://backoffice/invoices/268993350",
        );
        expect(s).toMatchObject({ id: "268993350", number: "Kapta2026/673", permalink: "https://public/x" });
        expect(summarizeIxDoc({ id: 1 }, "https://backoffice/invoices/1").permalink).toBe("https://backoffice/invoices/1");
    });
});

describe("remainingPages", () => {
    it("lists the pages after the first, capped", () => {
        expect(remainingPages({ pagination: { total_pages: 4 } }, 20)).toEqual([2, 3, 4]);
        expect(remainingPages({ pagination: { total_pages: 50 } }, 3)).toEqual([2, 3]);
        expect(remainingPages({ pagination: { total_pages: 1 } }, 20)).toEqual([]);
    });

    it("says it does not know when IX does not say", () => {
        expect(remainingPages({ invoices: [] }, 20)).toBeNull();
        expect(remainingPages({ pagination: { total_pages: "abc" } }, 20)).toBeNull();
    });
});

/**
 * Looking a Kapta document up by the number printed on it.
 *
 * This is what an admin types to replace a wrong service invoice, so getting it
 * wrong either attaches the wrong document or claims a real number does not
 * exist. InvoiceXpress has no lookup by `sequence_number`, so the match is ours
 * to make.
 */

const doc = (id: string, number: string, state = "finalized"): KaptaDocSummary =>
    ({ id, number, state, reference: null, total: "50.00", date: "12/09/2026", permalink: `https://x/${id}` });

const index = new Map<string, KaptaDocSummary>([
    ["267793087", doc("267793087", "Kapta2026/615", "canceled")],
    ["268993350", doc("268993350", "Kapta2026/673")],
    ["269288271", doc("269288271", "Kapta2026/6")],
]);

/** What the list endpoints answer when `inverted_sequence_number` is absent. */
const ixSpelling = new Map<string, KaptaDocSummary>([
    ["268993350", doc("268993350", "673/Kapta2026")],
]);

describe("findInIndex", () => {
    it("finds the document by its printed number", () => {
        expect(findInIndex(index, "KAPTA2026/673")?.id).toBe("268993350");
    });

    it("ignores case and stray spaces, which is how a number gets typed", () => {
        expect(findInIndex(index, " kapta2026 / 673 ")?.id).toBe("268993350");
    });

    it("does not settle for a prefix — /6 is not /673", () => {
        expect(findInIndex(index, "KAPTA2026/6")?.id).toBe("269288271");
    });

    it("returns null for a number the account does not have", () => {
        expect(findInIndex(index, "KAPTA2026/999")).toBeNull();
    });

    it("finds it when the account answers NUMBER/SERIES and the admin types SERIES/NUMBER", () => {
        expect(findInIndex(ixSpelling, "KAPTA2026/673")?.id).toBe("268993350");
    });

    it("and the other way round, when the number is typed as IX spells it", () => {
        expect(findInIndex(index, "673/Kapta2026")?.id).toBe("268993350");
    });

    it("returns null on empty input instead of the first document", () => {
        expect(findInIndex(index, "")).toBeNull();
        expect(findInIndex(index, "   ")).toBeNull();
    });

    it("still finds a cancelled document — refusing it is the caller's job", () => {
        expect(findInIndex(index, "KAPTA2026/615")?.state).toBe("canceled");
    });
});
