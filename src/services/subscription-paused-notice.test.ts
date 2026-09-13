import { describe, it, expect } from "vitest";
import { pausedNoticeEmail } from "./subscription-paused-notice";
import { renderInLang } from "./email-templates";

describe("pausedNoticeEmail", () => {
  it("agrees in number with the pending count", () => {
    const one = pausedNoticeEmail("Soul Krave", 1, "07/09/2026");
    expect(one.subject).toBe("A tua faturação está parada: 1 fatura por emitir");
    expect(one.html).toContain("encomenda paga à espera de fatura");

    const many = pausedNoticeEmail("Soul Krave", 6, "01/09/2026");
    expect(many.subject).toBe("A tua faturação está parada: 6 faturas por emitir");
    expect(many.html).toContain("encomendas pagas à espera de fatura");
  });

  it("shows the count and the date the orders started piling up", () => {
    const { html } = pausedNoticeEmail("Bikini Books", 3, "01/09/2026");
    expect(html).toContain(">3</p>");
    expect(html).toContain("01/09/2026");
  });

  it("omits the date rather than inventing one", () => {
    const { html } = pausedNoticeEmail("Artway", 2, null);
    expect(html).not.toContain("desde <strong>");
    expect(html).toContain("encomendas pagas à espera de fatura.");
  });

  it("greets by first name, and falls back when there is none", () => {
    expect(pausedNoticeEmail("Mafalda Delgado Unipessoal Lda", 1, null).html).toContain(">Mafalda,</h1>");
    expect(pausedNoticeEmail(null, 1, null).html).toContain(">Olá,</h1>");
  });

  it("sends the merchant to the billing page, where the plan cards are", () => {
    const { html } = pausedNoticeEmail("Arandis Editora", 4, "03/09/2026");
    expect(html).toContain('href="https://rioko.online/pt/faturacao"');
    expect(html).toContain("Ativar subscrição");
  });
});

/**
 * The same notice, for a client whose record says English.
 *
 * Worth its own block because this email is built by hand rather than through
 * the shell: the number agreement, the price line and the link are all written
 * here, so all three can stay Portuguese while the rest of the email turns.
 */
describe("pausedNoticeEmail, in English", () => {
  const en = (name: string | null, n: number, since: string | null) =>
    renderInLang("en", () => pausedNoticeEmail(name, n, since));

  it("agrees in number in English too", () => {
    expect(en("Soul Krave", 1, "07/09/2026").subject)
      .toBe("Your invoicing is paused: 1 invoice still to be issued");
    expect(en("Soul Krave", 6, "01/09/2026").subject)
      .toBe("Your invoicing is paused: 6 invoices still to be issued");
  });

  it("links the English billing page and prices in English", () => {
    const { html } = en("Arandis Editora", 4, "03/09/2026");
    expect(html).toContain('href="https://rioko.online/en/faturacao"');
    expect(html).toContain("&euro;7.50/month");
    expect(html).toContain("Privacy policy");
    expect(html).not.toContain("Ativar subscrição");
    expect(html).not.toContain("Política de privacidade");
  });

  it("leaves Portuguese untouched for everyone else", () => {
    // The ambient language is restored, so the next merchant in this isolate
    // gets what they have always got.
    en("Soul Krave", 1, null);
    expect(pausedNoticeEmail("Soul Krave", 1, null).subject)
      .toBe("A tua faturação está parada: 1 fatura por emitir");
  });
});
