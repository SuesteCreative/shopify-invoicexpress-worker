import { describe, it, expect } from "vitest";
import {
    LEGACY_CONNECTION_KEY, connectionKeyForScope,
    connectionKeyForDocumentEvent, groupByConnection,
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
