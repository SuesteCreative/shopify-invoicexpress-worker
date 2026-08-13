import { describe, it, expect } from "vitest";
import {
    buildRecoveryRequest, recordIdPayload, usesLegacyShopifyRoutes, connKey,
    type Connection,
} from "./recovery-request";

const conn = (source: string, destination: string, idKind = "external_id"): Connection => ({
    source,
    destination,
    label: `${source} → ${destination}`,
    external_id: { kind: idKind, label: "ID", placeholder: "" },
    capabilities: {
        backfill: true, reemit: true, forceReemit: true, deleteDraft: true,
        creditNote: true, finalizeDrafts: true, orderNumberFilter: false, paidTotals: true,
    },
});

const shopify = conn("shopify", "invoicexpress", "order_number");
const stripeMoloni = conn("stripe", "moloni", "stripe_id");
const lodgify = conn("lodgify", "moloni", "booking_id");

describe("usesLegacyShopifyRoutes", () => {
    it("is true only for Shopify to InvoiceXpress", () => {
        expect(usesLegacyShopifyRoutes(shopify)).toBe(true);
        expect(usesLegacyShopifyRoutes(stripeMoloni)).toBe(false);
        expect(usesLegacyShopifyRoutes(lodgify)).toBe(false);
    });

    it("sends a Shopify to Moloni connection down the generic path", () => {
        // The legacy endpoints are InvoiceXpress-only; routing a Shopify→Moloni
        // shop to them would issue against the wrong destination entirely.
        expect(usesLegacyShopifyRoutes(conn("shopify", "moloni"))).toBe(false);
    });
});

describe("buildRecoveryRequest", () => {
    it("keeps Shopify on its legacy endpoint and sends no connection", () => {
        const r = buildRecoveryRequest(shopify, "reemit", "user_1", { force: true });
        expect(r.url).toBe("/api/admin/dev-mode/reemit");
        expect(r.body).toEqual({ targetUserId: "user_1", force: true });
        expect(r.body).not.toHaveProperty("source");
    });

    it("names the connection on the generic endpoint", () => {
        // Without source+destination the worker answers 409 for any user with
        // more than one active connection, rather than guessing.
        const r = buildRecoveryRequest(stripeMoloni, "delete-draft", "user_2", { reason: "x" });
        expect(r.url).toBe("/api/admin/dev-mode/connection/delete-draft");
        expect(r.body).toEqual({
            targetUserId: "user_2", source: "stripe", destination: "moloni", reason: "x",
        });
    });

    it("routes every action to a matching path", () => {
        for (const action of ["backfill", "reemit", "delete-draft", "issue-credit-note", "finalize-drafts"] as const) {
            expect(buildRecoveryRequest(lodgify, action, "u", {}).url)
                .toBe(`/api/admin/dev-mode/connection/${action}`);
        }
    });
});

describe("recordIdPayload", () => {
    it("sends a number for legacy Shopify", () => {
        expect(recordIdPayload(shopify, "1137")).toEqual({ order_number: 1137 });
    });

    it("tolerates the # an operator copies off the storefront", () => {
        expect(recordIdPayload(shopify, " 1137 ")).toEqual({ order_number: 1137 });
    });

    it("sends the raw string for Stripe", () => {
        // The bug this pins: Number("pi_3Tp…") is NaN, and the old card used a
        // numeric input that could not hold the value in the first place.
        expect(recordIdPayload(stripeMoloni, "pi_3TYl5aJNp2FcbLOX0r6MBkwi"))
            .toEqual({ external_id: "pi_3TYl5aJNp2FcbLOX0r6MBkwi" });
    });

    it("sends the raw string for Lodgify", () => {
        expect(recordIdPayload(lodgify, "4429")).toEqual({ external_id: "4429" });
    });

    it("trims whatever was pasted", () => {
        expect(recordIdPayload(stripeMoloni, "  pi_abc \n")).toEqual({ external_id: "pi_abc" });
    });
});

describe("connKey", () => {
    it("distinguishes two connections of the same source", () => {
        expect(connKey(conn("stripe", "moloni"))).not.toBe(connKey(conn("stripe", "invoicexpress")));
    });
});
