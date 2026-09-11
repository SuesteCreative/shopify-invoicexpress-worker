import { describe, it, expect } from "vitest";
import { ixSubdomain } from "./ix-account";

/**
 * The account name is the one field of the onboarding a merchant fills in from
 * memory, and every wrong shape of it produces the same InvoiceXpress answer:
 * 530, Site Not Found. These are the shapes that actually arrive.
 */
describe("ixSubdomain", () => {
    it("keeps a plain account name", () => {
        expect(ixSubdomain("ultramegasonico")).toBe("ultramegasonico");
    });

    it("trims the address a merchant pasted from the browser bar", () => {
        expect(ixSubdomain("https://ultramegasonico.app.invoicexpress.com/invoices")).toBe("ultramegasonico");
        expect(ixSubdomain("ultramegasonico.invoicexpress.com")).toBe("ultramegasonico");
        expect(ixSubdomain("ultramegasonico.macewindu.invoicexpress.com")).toBe("ultramegasonico");
    });

    it("normalises case and stray whitespace", () => {
        expect(ixSubdomain("  UltraMegaSonico  ")).toBe("ultramegasonico");
    });

    it("answers empty for nothing typed, which is what disables the button", () => {
        expect(ixSubdomain("   ")).toBe("");
    });
});
