import { describe, it, expect } from "vitest";
import { PUBLIC_INTEGRATIONS, statusLine } from "./integration-status";
import { SOURCE_KINDS, DESTINATION_KINDS } from "./connection-kinds";

/**
 * The public integration story drifted from reality for months: the FAQ, the
 * SoftwareApplication schema and both llms files still called Moloni and Vendus
 * "roadmap" long after they shipped, and never mentioned Lodgify at all. Those
 * files are exactly what an AI assistant reads to answer "does Rioko support
 * Moloni?", so the stale copy was answering no on our behalf.
 *
 * These tests guard the class of bug, not the one instance: anything the
 * internal registry accepts has to have a public status, and a live product may
 * never be described as unreleased.
 */
describe("public integration status", () => {
    it("covers every kind the connections API accepts", () => {
        const published = new Set(PUBLIC_INTEGRATIONS.map((i) => i.id));
        // `stripe_connect` is one public product ("Stripe") with two internal
        // wiring modes — the merchant does not distinguish them.
        const internal = [...SOURCE_KINDS, ...DESTINATION_KINDS].filter((k) => k !== "stripe_connect");
        const missing = internal.filter((k) => !published.has(k));
        expect(missing).toEqual([]);
    });

    it("lists every live integration in its status line", () => {
        for (const locale of ["pt", "en"] as const) {
            for (const kind of ["payments", "invoicing"] as const) {
                const line = statusLine(kind, locale);
                const live = PUBLIC_INTEGRATIONS.filter((i) => i.kind === kind && i.status === "live");
                expect(live.length).toBeGreaterThan(0);
                for (const i of live) expect(line).toContain(i.name);
            }
        }
    });

    it("never describes a live integration as unreleased", () => {
        const live = PUBLIC_INTEGRATIONS.filter((i) => i.status === "live").map((i) => i.name);
        for (const locale of ["pt", "en"] as const) {
            for (const kind of ["payments", "invoicing"] as const) {
                const line = statusLine(kind, locale);
                // Everything after the "coming soon"/"planned" marker is the
                // not-yet list; no live product may appear there.
                const marker = locale === "pt" ? "Em breve:" : "Coming soon:";
                const tail = line.includes(marker) ? line.slice(line.indexOf(marker)) : "";
                for (const name of live) expect(tail).not.toContain(name);
            }
        }
    });

    it("keeps InvoiceXpress, Moloni and Vendus live — the drift that started this", () => {
        for (const name of ["InvoiceXpress", "Moloni", "Vendus", "Lodgify"]) {
            const found = PUBLIC_INTEGRATIONS.find((i) => i.name === name);
            expect(found?.status).toBe("live");
        }
    });
});
