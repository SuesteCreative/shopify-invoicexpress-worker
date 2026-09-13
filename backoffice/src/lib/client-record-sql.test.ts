import { describe, it, expect } from "vitest";
import {
    LEGACY_CONNECTION_KEY, connectionKeyForScope,
    connectionKeyForDocumentEvent, attributeDocumentEvent, groupByConnection,
    identityRequestStates, unreadIdentityOutcomes,
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

describe("attributeDocumentEvent", () => {
    it("keeps the exact answer when the row carries one", () => {
        expect(attributeDocumentEvent({ source_kind: "stripe", destination_kind: "moloni" }, ["lodgify:moloni"]))
            .toBe("stripe:moloni");
    });

    it("files a source-only row under the one connection that takes that source", () => {
        // The dead-letter queue's create_failed: "stripe", no destination, on an
        // account whose only connection is Stripe Connect.
        expect(attributeDocumentEvent({ source_kind: "stripe" }, ["stripe_connect:invoicexpress"]))
            .toBe("stripe_connect:invoicexpress");
        expect(attributeDocumentEvent({ source_kind: "lodgify" }, ["lodgify:moloni", "shopify:invoicexpress"]))
            .toBe("lodgify:moloni");
    });

    it("does not choose between two, or invent one", () => {
        expect(attributeDocumentEvent({ source_kind: "stripe" }, ["stripe:moloni", "stripe_connect:invoicexpress"])).toBeNull();
        expect(attributeDocumentEvent({ source_kind: "stripe" }, ["lodgify:moloni"])).toBeNull();
        expect(attributeDocumentEvent({}, ["stripe:moloni"])).toBeNull();
    });
});

describe("identityRequestStates", () => {
    // Rows arrive NEWEST FIRST, the way both queries order them
    // (created_at DESC, rowid DESC). The array order is the recency, on purpose:
    // config_audit.created_at has one-second resolution.
    const req = (field: string, value: string, at: string) =>
        ({ scope: "profile_change_request", field, old_value: null, new_value: value, created_at: at });
    const applied = (field: string, value: string, at: string, actor = "user_admin") =>
        ({ scope: "profile", field, old_value: null, new_value: value, created_at: at, actor });
    const rejected = (field: string, reason: string | null, at: string, actor = "user_admin") =>
        ({ scope: "profile_change_rejected", field, old_value: null, new_value: reason, created_at: at, actor });

    it("is pending while nothing has answered it", () => {
        const [s] = identityRequestStates([req("nif", "517569493", "2026-09-13 08:00:00")], { nif: "222373555" });
        expect(s.outcome).toBe("pending");
        expect(s.decided_at).toBeNull();
    });

    it("is granted when a decision followed", () => {
        const [s] = identityRequestStates([
            applied("company_name", "VANESSA ALEXANDRA MACHADO DOS SANTOS", "2026-09-13 09:10:00"),
            req("company_name", "VANESSA ALEXANDRA MACHADO DOS SANTOS", "2026-09-13 08:53:00"),
        ], { company_name: "VANESSA ALEXANDRA MACHADO DOS SANTOS" });
        expect(s.outcome).toBe("applied");
        expect(s.decided_at).toBe("2026-09-13 09:10:00");
        expect(s.decided_by).toBe("user_admin");
    });

    it("reports what was written, not what was asked", () => {
        // The operator corrected a typo in the number the client sent. Telling
        // the client their record now says what they typed would be a lie about
        // the field that prints on every invoice.
        const [s] = identityRequestStates([
            applied("nif", "517569493", "2026-09-13 09:10:00"),
            req("nif", "51756949", "2026-09-13 08:53:00"),
        ], { nif: "517569493" });
        expect(s.requested).toBe("51756949");
        expect(s.decided_value).toBe("517569493");
    });

    it("is granted when the value is already stored, even with no decision row", () => {
        // Changed from somewhere else — the fiscal console, an onboarding form
        // filled in under impersonation. Telling the client they are still
        // waiting would be false.
        const [s] = identityRequestStates([req("nif", "517569493", "2026-09-13 08:00:00")], { nif: "517569493" });
        expect(s.outcome).toBe("applied");
        expect(s.decided_at).toBeNull();
        expect(s.decided_value).toBeNull();
    });

    it("carries the operator's reason for a refusal, and only theirs", () => {
        const [s] = identityRequestStates([
            rejected("nif", "O NIF não corresponde à empresa registada", "2026-09-13 08:30:00"),
            req("nif", "111111111", "2026-09-13 08:00:00"),
        ], { nif: "222373555" });
        expect(s.outcome).toBe("rejected");
        expect(s.reason).toBe("O NIF não corresponde à empresa registada");
    });

    it("says nothing rather than inventing a reason when none was written", () => {
        const [s] = identityRequestStates([
            rejected("nif", null, "2026-09-13 08:30:00"),
            req("nif", "111111111", "2026-09-13 08:00:00"),
        ], { nif: "222373555" });
        expect(s.outcome).toBe("rejected");
        expect(s.reason).toBeNull();
    });

    it("lets a client ask again after a refusal", () => {
        // The new ask is newer than the refusal, so nothing decides it. This is
        // what a status column gets wrong: that row was closed, and the second
        // ask reopens nothing.
        const [s] = identityRequestStates([
            req("nif", "517569493", "2026-09-13 08:00:00"),
            rejected("nif", "falta documento", "2026-09-10 09:00:00"),
            req("nif", "111111111", "2026-09-10 08:00:00"),
        ], { nif: "222373555" });
        expect(s.outcome).toBe("pending");
        expect(s.requested).toBe("517569493");
    });

    it("does not read a refusal and a re-ask in the same second as a refusal", () => {
        // CURRENT_TIMESTAMP is second-resolution, so these two compare EQUAL.
        // Deciding by timestamp would be a coin flip on whether a request made
        // seconds ago already reads as refused; the query's rowid tiebreak puts
        // the newer row first and this trusts that order.
        const sameSecond = "2026-09-13 08:30:00";
        const [s] = identityRequestStates([
            req("nif", "517569493", sameSecond),
            rejected("nif", "falta documento", sameSecond),
            req("nif", "111111111", "2026-09-13 08:00:00"),
        ], { nif: "222373555" });
        expect(s.outcome).toBe("pending");
        expect(s.requested).toBe("517569493");
    });

    it("keeps the two fields apart and ignores everything else in the trail", () => {
        const states = identityRequestStates([
            { scope: "integrations", field: "force_tax_rate", new_value: "23", created_at: "2026-09-13 08:06:00" },
            req("company_name", "Bikini Books Unipessoal Lda", "2026-09-13 08:05:00"),
            req("nif", "517569493", "2026-09-13 08:00:00"),
        ], { nif: "222373555", company_name: null });
        expect(states.map(s => s.field).sort()).toEqual(["company_name", "nif"]);
        expect(states.every(s => s.outcome === "pending")).toBe(true);
    });

    it("is empty for an account that never asked for anything", () => {
        expect(identityRequestStates([], { nif: "222373555" })).toEqual([]);
    });
});

describe("unreadIdentityOutcomes", () => {
    const NOW = new Date("2026-09-13T12:00:00Z");
    const decided = (at: string, outcome: "applied" | "rejected" = "applied") => ({
        field: "nif", requested: "517569493", requested_at: "2026-09-13 08:00:00",
        outcome, decided_at: at, decided_by: "user_admin", reason: null, decided_value: "517569493",
    });

    it("shows an answer the client has never dismissed", () => {
        expect(unreadIdentityOutcomes([decided("2026-09-13 09:00:00")], null, NOW)).toHaveLength(1);
    });

    it("stops showing one dismissed after it was decided", () => {
        expect(unreadIdentityOutcomes([decided("2026-09-13 09:00:00")], "2026-09-13 09:30:00", NOW)).toEqual([]);
    });

    it("shows a NEWER answer even though an older one was dismissed", () => {
        expect(unreadIdentityOutcomes([decided("2026-09-13 10:00:00")], "2026-09-13 09:30:00", NOW)).toHaveLength(1);
    });

    it("never announces something still pending", () => {
        const pending = { ...decided("2026-09-13 09:00:00"), outcome: "pending" as const, decided_at: null };
        expect(unreadIdentityOutcomes([pending], null, NOW)).toEqual([]);
    });

    it("does not greet an account with an answer from months ago", () => {
        // The column arrives null for every account that predates 0059, so
        // without the window the notice would announce old history as news.
        expect(unreadIdentityOutcomes([decided("2026-06-01 09:00:00")], null, NOW)).toEqual([]);
        expect(unreadIdentityOutcomes([decided("2026-09-01 09:00:00")], null, NOW)).toHaveLength(1);
    });

    it("never announces a grant nobody recorded", () => {
        // Derived from the stored value, so it has no date — and a change with no
        // date cannot honestly be announced as having just happened.
        const derived = { ...decided("2026-09-13 09:00:00"), decided_at: null };
        expect(unreadIdentityOutcomes([derived], null, NOW)).toEqual([]);
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
