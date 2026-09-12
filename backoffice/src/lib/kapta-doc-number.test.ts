import { describe, it, expect } from "vitest";
import { findInIndex, type KaptaDocSummary } from "./kapta-doc-number";

/**
 * Looking a Kapta document up by the number printed on it.
 *
 * This is what an admin types to replace a wrong service invoice, so getting it
 * wrong either attaches the wrong document or claims a real number does not
 * exist. InvoiceXpress has no lookup by `sequence_number`, so the match is ours
 * to make.
 */

const doc = (id: string, number: string, state = "finalized"): KaptaDocSummary =>
    ({ id, number, state, total: "50.00", date: "12/09/2026", permalink: `https://x/${id}` });

const index = new Map<string, KaptaDocSummary>([
    ["267793087", doc("267793087", "KAPTA2026/615", "canceled")],
    ["268993350", doc("268993350", "KAPTA2026/673")],
    ["269288271", doc("269288271", "KAPTA2026/6")],
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

    it("returns null on empty input instead of the first document", () => {
        expect(findInIndex(index, "")).toBeNull();
        expect(findInIndex(index, "   ")).toBeNull();
    });

    it("still finds a cancelled document — refusing it is the caller's job", () => {
        expect(findInIndex(index, "KAPTA2026/615")?.state).toBe("canceled");
    });
});
