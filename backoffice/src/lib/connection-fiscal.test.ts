import { describe, it, expect } from "vitest";
import { readConnectionFiscal, fiscalPatchFrom } from "./connection-fiscal";

describe("readConnectionFiscal", () => {
    it("returns what the connection states and stays silent about the rest", () => {
        expect(readConnectionFiscal(JSON.stringify({
            ix_sequence_name: "FARRACEMOTAUNIPES",
            ix_document_type: "invoice",
            force_tax_rate: 6,
        }))).toEqual({ ix_sequence_name: "FARRACEMOTAUNIPES", ix_document_type: "invoice" });
    });

    it("accepts SQLite's 0/1 for the booleans as well as real ones", () => {
        expect(readConnectionFiscal(JSON.stringify({ vat_included: 1, auto_finalize: false })))
            .toEqual({ vat_included: true, auto_finalize: false });
    });

    it("survives a null or unparseable blob", () => {
        expect(readConnectionFiscal(null)).toEqual({});
        expect(readConnectionFiscal("{not json")).toEqual({});
    });
});

describe("fiscalPatchFrom", () => {
    it("carries only the keys the request states, so a partial post keeps its siblings", () => {
        expect(fiscalPatchFrom({ ix_sequence_name: " FR-ROW " }))
            .toEqual({ ix_sequence_name: "FR-ROW" });
    });

    it("keeps an empty string, which is how a field is handed back to the legacy row", () => {
        expect(fiscalPatchFrom({ ix_sequence_name: "" })).toEqual({ ix_sequence_name: "" });
    });

    it("returns null when nothing is stated, so the caller leaves the row alone", () => {
        expect(fiscalPatchFrom(undefined)).toBeNull();
        expect(fiscalPatchFrom({})).toBeNull();
        expect(fiscalPatchFrom({ vat_included: "yes", ix_sequence_name: 7 } as any)).toBeNull();
    });

    it("takes false as a value, not as absence — it is the whole point of vat_included", () => {
        expect(fiscalPatchFrom({ vat_included: false, auto_finalize: false }))
            .toEqual({ vat_included: false, auto_finalize: false });
    });
});
