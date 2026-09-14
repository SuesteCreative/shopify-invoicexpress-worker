import { describe, it, expect } from "vitest";
import { errorText } from "./upstream-error";

describe("errorText", () => {
    it("reduces the shape that blanked the wizard page", () => {
        // InvoiceXpress's answer to a rejected key, verbatim.
        expect(errorText({ error: "Invalid API key" }, "fb")).toBe("Invalid API key");
    });

    it("keeps a plain sentence as itself", () => {
        expect(errorText("Account not found", "fb")).toBe("Account not found");
    });

    it("falls back for nothing at all", () => {
        expect(errorText(null, "fb")).toBe("fb");
        expect(errorText("   ", "fb")).toBe("fb");
        expect(errorText({}, "fb")).toBe("{}");
    });

    it("joins a list, and digs through a nested one", () => {
        expect(errorText(["a", "b"], "fb")).toBe("a; b");
        expect(errorText({ errors: [{ message: "bad" }] }, "fb")).toBe("bad");
    });

    it("never answers with an object", () => {
        for (const raw of [{ error: { deep: 1 } }, { unknown: "x" }, 42, true]) {
            expect(typeof errorText(raw, "fb")).toBe("string");
        }
    });
});
