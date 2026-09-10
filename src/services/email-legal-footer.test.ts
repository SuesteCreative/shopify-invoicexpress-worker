import { describe, it, expect } from "vitest";
import {
    renderInTheme,
    renderQuotaEmail,
    tplDigest,
    tplWeeklyUnprocessed,
    renderPaymentFailedEmail,
    tplNifInvalid,
} from "./email-templates";

/** Four of these templates build their own <!doctype> instead of going through
 *  shell(), so each one carries a hand-copied footer. That is exactly how the
 *  legal links went missing from three of them in the first place — a footer
 *  added to shell() reaches 21 templates and silently skips the other four. */

const LINKS = [
    "https://rioko.online/pt/privacy",
    "https://rioko.online/pt/terms",
    "https://rioko.online/pt/privacy#litigios",
    "https://www.livroreclamacoes.pt/inicio",
];

const incident = {
    kind: "nif_invalid" as const,
    merchantName: "Loja Teste",
    connectionLabel: "shopify → invoicexpress",
    occurrences: 1,
    firstSeenAt: "2026-09-10 10:00",
    lastSeenAt: "2026-09-10 10:00",
    dashboardUrl: "https://rioko.online",
    helpUrl: "mailto:suporte@kapta.pt",
    details: {},
};

const digestIncident = {
    kind: "nif_invalid" as const,
    severity: "warning" as const,
    title: "NIF inválido",
    detail: "O NIF do cliente não passou a validação.",
    occurrences: 2,
    lastSeenAt: "2026-09-10 10:00",
    connectionLabel: "shopify → invoicexpress",
};

const weeklyItem = {
    severity: "warning" as const,
    connectionLabel: "shopify → invoicexpress",
    missingIds: ["1001", "1002"],
    count: 2,
};

const rendered: Array<[string, () => { html: string }]> = [
    ["shell (incident)", () => tplNifInvalid(incident as never)],
    ["quota", () => renderQuotaEmail({
        kind: "warning",
        merchantName: "Loja Teste",
        ixAccount: "lojateste",
        periodStart: "01/09/2026",
        periodEnd: "30/09/2026",
        used: 90,
        limit: 100,
    })],
    ["daily digest", () => tplDigest({
        merchantName: "Loja Teste",
        incidents: [digestIncident as never],
    })],
    ["weekly digest", () => tplWeeklyUnprocessed({
        merchantName: "Loja Teste",
        items: [weeklyItem as never],
        totalMissing: 2,
    })],
    ["payment failed", () => renderPaymentFailedEmail({
        accountLabel: "Loja Teste",
        updateUrl: "https://billing.stripe.com/p/session/live_abc123",
        amountLabel: "7,50 €",
        nextAttemptLabel: "12/09/2026",
    } as never)],
];

describe("every email footer carries the legal links", () => {
    for (const [name, render] of rendered) {
        for (const theme of ["night", "day"] as const) {
            it(`${name} · ${theme}`, () => {
                const { html } = renderInTheme(theme, render);
                for (const href of LINKS) {
                    expect(html, `${name}/${theme} is missing ${href}`).toContain(href);
                }
            });
        }
    }

    it("the day skin uses the day wordmark, the night skin the night one", () => {
        const day = renderInTheme("day", () => tplNifInvalid(incident as never)).html;
        const night = renderInTheme("night", () => tplNifInvalid(incident as never)).html;
        expect(day).toContain("rioko2-logo-light2.png");
        expect(night).toContain("rioko2-logo.png");
        // A white wordmark on the cream day card is the bug this guards.
        expect(day).not.toContain("images/rioko2-logo.png");
    });

    it("no email ships an SVG logo — Gmail and Outlook strip them", () => {
        for (const [, render] of rendered) {
            for (const theme of ["night", "day"] as const) {
                const { html } = renderInTheme(theme, render);
                expect(html).not.toMatch(/<img[^>]+\.svg/i);
            }
        }
    });
});
