import { describe, it, expect } from "vitest";
import { renderInLang, renderInTheme, T, lang, legalLinks, renderIncidentTemplate } from "./email-templates";

/**
 * The language an email comes out in.
 *
 * Three things this guards, all of them silent when they break:
 *
 * - the ambient language has to be restored after a render, or one merchant's
 *   English leaks into the next merchant's email in the same isolate;
 * - the default has to be Portuguese, because that is what every account
 *   received before `users.language` existed and what an unreadable column
 *   falls back to;
 * - an English render must not leave Portuguese chrome behind — the footer, the
 *   legal links and the `lang` attribute are shared by every template, so they
 *   are the ones a per-template translation cannot catch.
 */

describe("the ambient language", () => {
    it("is Portuguese unless someone says otherwise", () => {
        expect(lang()).toBe("pt");
        expect(T("olá", "hello")).toBe("olá");
    });

    it("is put back exactly as it was found, even when the render throws", () => {
        renderInLang("en", () => expect(lang()).toBe("en"));
        expect(lang()).toBe("pt");

        expect(() => renderInLang("en", () => { throw new Error("boom"); })).toThrow("boom");
        expect(lang()).toBe("pt");
    });

    it("nests, so a language render can wrap a theme render", () => {
        const out = renderInLang("en", () => renderInTheme("day", () => T("português", "english")));
        expect(out).toBe("english");
        expect(lang()).toBe("pt");
    });

    it("treats anything that is not 'en' as Portuguese", () => {
        expect(renderInLang(undefined, () => lang())).toBe("pt");
        expect(renderInLang("pt", () => lang())).toBe("pt");
    });
});

describe("the shared chrome", () => {
    it("links the legal pages of the language it is written in", () => {
        const pt = legalLinks();
        expect(pt).toContain("https://rioko.online/pt/privacy");
        expect(pt).toContain("Política de privacidade");

        const en = renderInLang("en", () => legalLinks());
        expect(en).toContain("https://rioko.online/en/privacy");
        expect(en).toContain("Privacy policy");
        // The Livro de Reclamações is a Portuguese public service; it has one
        // address and keeps its name.
        expect(en).toContain("livroreclamacoes.pt");
    });
});

/** One incident the merchant actually receives, rendered both ways. */
const INPUT = {
    occurrences: 1,
    firstSeenAt: "2026-09-13T10:00:00Z",
    lastSeenAt: "2026-09-13T10:00:00Z",
    summary: "InvoiceXpress recusou o documento",
    merchantName: "Loja de Teste",
    connectionLabel: "Shopify → InvoiceXpress",
};

describe("an email a merchant receives", () => {
    it("declares the language it is written in", () => {
        const pt = renderInLang("pt", () => renderIncidentTemplate("destination_reject", INPUT));
        expect(pt.html).toContain(`<html lang="pt-PT">`);

        const en = renderInLang("en", () => renderIncidentTemplate("destination_reject", INPUT));
        expect(en.html).toContain(`<html lang="en">`);
    });

    it("leaves no Portuguese chrome in an English email", () => {
        const en = renderInLang("en", () => renderIncidentTemplate("destination_reject", INPUT));
        expect(en.html).toContain("Need a hand?");
        expect(en.html).toContain("Open the dashboard");
        expect(en.html).not.toContain("Precisa de ajuda?");
        expect(en.html).not.toContain("Abrir painel");
        expect(en.html).not.toContain("Notificação automática");
    });

    it("says something different in each language, subject included", () => {
        const pt = renderInLang("pt", () => renderIncidentTemplate("destination_reject", INPUT));
        const en = renderInLang("en", () => renderIncidentTemplate("destination_reject", INPUT));
        expect(en.subject).not.toBe(pt.subject);
        expect(en.html).not.toBe(pt.html);
    });
});
