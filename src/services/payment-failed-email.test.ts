import { describe, it, expect } from "vitest";
import { renderPaymentFailedEmail } from "./email-templates";

/**
 * The dunning email is the only thing standing between a card that stopped
 * working and a subscription that stops with it, so the two things it has to
 * carry — the link that fixes it, and what happens if nobody clicks — are
 * checked here rather than discovered in an inbox.
 */

const BASE = {
  accountLabel: "Overbuilding",
  updateUrl: "https://billing.stripe.com/p/session/live_abc123",
  amountLabel: "7,50 €",
};

describe("renderPaymentFailedEmail", () => {
  it("puts the payment link in the button, whole and unescaped", () => {
    const { html } = renderPaymentFailedEmail({ ...BASE, nextAttemptLabel: "12/09/2026" });
    expect(html).toContain(`href="${BASE.updateUrl}"`);
    expect(html).toContain("Atualizar método de pagamento");
  });

  it("names the retry date when Stripe still has one", () => {
    const { subject, html } = renderPaymentFailedEmail({ ...BASE, nextAttemptLabel: "12/09/2026" });
    expect(html).toContain("12/09/2026");
    expect(html).not.toContain("última tentativa de cobrança");
    expect(subject).toBe("O pagamento da subscrição Rioko não foi concluído");
  });

  it("says the retries are over instead of promising one that is not coming", () => {
    const { subject, html } = renderPaymentFailedEmail({ ...BASE, finalAttempt: true });
    expect(html).toContain("última tentativa de cobrança");
    expect(html).not.toContain("Voltamos a tentar cobrar");
    expect(subject).toContain("Última tentativa falhada");
  });

  it("offers the hosted invoice only when it is not already the button", () => {
    const withBoth = renderPaymentFailedEmail({ ...BASE, invoiceUrl: "https://invoice.stripe.com/i/live_xyz" });
    expect(withBoth.html).toContain("Pagar a fatura em aberto");

    // Fallback case: the portal link could not be minted, so the hosted invoice
    // IS the button — offering it twice would read as two different remedies.
    const fallback = renderPaymentFailedEmail({
      ...BASE,
      updateUrl: "https://invoice.stripe.com/i/live_xyz",
      invoiceUrl: "https://invoice.stripe.com/i/live_xyz",
    });
    expect(fallback.html).not.toContain("Pagar a fatura em aberto");
  });

  it("names the account and the amount so the reader knows whose card it is", () => {
    const { html } = renderPaymentFailedEmail(BASE);
    expect(html).toContain("Overbuilding");
    expect(html).toContain("7,50 €");
  });
});
