import { describe, it, expect } from "vitest";
import {
    LEGACY_CONNECTION_KEY, connectionKeyForScope,
    connectionKeyForDocumentEvent, groupByConnection, outstandingIdentityRequests,
} from "./client-record-sql";

/**
 * Filing a row under the wrong connection is the failure this guards against,
 * and it is silent: the record shows a fiscal change under a pipe that never
 * had it, and the operator reads that as fact. So the shapes checked here are
 * the ones actually written — `scope` by lib/config-audit, the pair by the
 * worker's document log — including the ones that have no answer.
 */

describe("connectionKeyForScope", () => {
    it("reads the pair straight off a connection scope", () => {
        expect(connectionKeyForScope("connection:stripe->invoicexpress")).toBe("stripe:invoicexpress");
        expect(connectionKeyForScope("connection:lodgify->moloni")).toBe("lodgify:moloni");
        expect(connectionKeyForScope("connection:stripe_connect->moloni")).toBe("stripe_connect:moloni");
    });

    it("files the legacy row under the only pair it can describe", () => {
        expect(connectionKeyForScope("integrations")).toBe(LEGACY_CONNECTION_KEY);
    });

    it("leaves account-wide scopes unattributed instead of guessing", () => {
        expect(connectionKeyForScope("company_rules")).toBeNull();
        expect(connectionKeyForScope("billing_event:evt_1Tq")).toBeNull();
        expect(connectionKeyForScope("profile")).toBeNull();
        expect(connectionKeyForScope("")).toBeNull();
        expect(connectionKeyForScope(null)).toBeNull();
    });

    it("refuses a half-written connection scope", () => {
        expect(connectionKeyForScope("connection:stripe->")).toBeNull();
        expect(connectionKeyForScope("connection:->moloni")).toBeNull();
        expect(connectionKeyForScope("connection:stripe")).toBeNull();
    });
});

describe("connectionKeyForDocumentEvent", () => {
    it("uses the pair the row carries", () => {
        expect(connectionKeyForDocumentEvent({ source_kind: "stripe", destination_kind: "moloni" }))
            .toBe("stripe:moloni");
    });

    it("falls back to the legacy pair for a row that only knows a shop", () => {
        // The legacy Shopify handlers never ran any other pair.
        expect(connectionKeyForDocumentEvent({ shopify_domain: "166c6d-82.myshopify.com" }))
            .toBe(LEGACY_CONNECTION_KEY);
        expect(connectionKeyForDocumentEvent({
            source_kind: null, destination_kind: null, shopify_domain: "166c6d-82.myshopify.com",
        })).toBe(LEGACY_CONNECTION_KEY);
    });

    it("says nothing rather than something wrong", () => {
        expect(connectionKeyForDocumentEvent({})).toBeNull();
        expect(connectionKeyForDocumentEvent({ source_kind: "stripe" })).toBeNull();
        expect(connectionKeyForDocumentEvent({ destination_kind: "moloni" })).toBeNull();
    });
});

describe("outstandingIdentityRequests", () => {
    const asked = (field: string, value: string, at = "2026-09-13T10:00:00Z") =>
        ({ field, new_value: value, created_at: at });

    it("keeps a request whose value is not what is stored", () => {
        const rows = [asked("nif", "517569493")];
        expect(outstandingIdentityRequests(rows, { nif: "256647976" })).toHaveLength(1);
    });

    it("drops one that has been granted — applying it is closing it", () => {
        const rows = [asked("nif", "517569493")];
        expect(outstandingIdentityRequests(rows, { nif: "517569493" })).toEqual([]);
    });

    it("treats null and empty string as the same absence", () => {
        expect(outstandingIdentityRequests([asked("company_name", "")], { company_name: null })).toEqual([]);
        expect(outstandingIdentityRequests([asked("company_name", " Bikini Books ")], { company_name: "Bikini Books" })).toEqual([]);
    });

    it("shows only the latest ask per field, not every attempt", () => {
        // Newest first, the order the query returns. An older ask for the same
        // field was superseded, not granted — listing both reads as two requests.
        const rows = [
            asked("nif", "999999999", "2026-09-13T12:00:00Z"),
            asked("nif", "517569493", "2026-09-10T09:00:00Z"),
        ];
        const out = outstandingIdentityRequests(rows, { nif: "256647976" });
        expect(out).toHaveLength(1);
        expect(out[0].new_value).toBe("999999999");
    });

    it("keeps requests for different fields apart", () => {
        const rows = [asked("nif", "517569493"), asked("company_name", "Bikini Books Unipessoal Lda")];
        expect(outstandingIdentityRequests(rows, { nif: "111111111", company_name: null })).toHaveLength(2);
    });
});

describe("groupByConnection", () => {
    it("keeps the unattributable rows instead of dropping them", () => {
        const rows = [
            { scope: "connection:stripe->moloni" },
            { scope: "integrations" },
            { scope: "company_rules" },
            { scope: "connection:stripe->moloni" },
        ];
        const grouped = groupByConnection(rows, r => connectionKeyForScope(r.scope));

        expect(grouped.get("stripe:moloni")).toHaveLength(2);
        expect(grouped.get(LEGACY_CONNECTION_KEY)).toHaveLength(1);
        expect(grouped.get(null)).toHaveLength(1);
        // Nothing vanished on the way.
        expect([...grouped.values()].flat()).toHaveLength(rows.length);
    });
});
