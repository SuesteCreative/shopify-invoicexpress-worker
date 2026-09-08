import { describe, it, expect } from "vitest";
import { pausedNoticeEmail } from "./subscription-paused-notice";

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
