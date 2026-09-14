import { describe, it, expect } from "vitest";
import { prettyConnectionLabel, connectionPill } from "./platform-names";
import { connectionLabelOf } from "./connection-context";
import { renderIncidentTemplate } from "./email-templates";

describe("connection labels", () => {
  it("spells the kinds the pipeline writes", () => {
    expect(prettyConnectionLabel("lodgify → moloni")).toBe("Lodgify → Moloni");
    expect(prettyConnectionLabel("shopify → invoicexpress")).toBe("Shopify → InvoiceXpress");
    expect(prettyConnectionLabel("stripe_connect → moloni")).toBe("Stripe Connect → Moloni");
    expect(connectionLabelOf("eupago", "invoicexpress")).toBe("EuPago → InvoiceXpress");
  });

  it("names the platforms an account actually has, not a guess", () => {
    // The real shapes in the fleet. A legacy `integrations` row that names a
    // shop IS the Shopify pipe and has no row in `connections`; one holding
    // nothing but IX credentials (MeetFrank's) is not a pipe at all.
    expect(connectionPill(["shopify"], "invoicexpress")).toBe("Shopify → InvoiceXpress");
    expect(connectionPill(["stripe"], "invoicexpress")).toBe("Stripe → InvoiceXpress");
    expect(connectionPill(["lodgify"], "invoicexpress")).toBe("Lodgify → InvoiceXpress");
    expect(connectionPill(["stripe_connect"], "invoicexpress")).toBe("Stripe Connect → InvoiceXpress");
    // WHM invoices IX from both.
    expect(connectionPill(["stripe", "shopify"], "invoicexpress")).toBe("Stripe · Shopify → InvoiceXpress");
    expect(connectionPill(["stripe", "stripe", " "], "invoicexpress")).toBe("Stripe → InvoiceXpress");
    // Nothing known: no chip beats a wrong chip.
    expect(connectionPill([], "invoicexpress")).toBeUndefined();
  });

  it("leaves a label it cannot spell exactly as written", () => {
    expect(prettyConnectionLabel("Cloudflare → worker")).toBe("Cloudflare → worker");
    expect(prettyConnectionLabel("Subscrição Rioko")).toBe("Subscrição Rioko");
    expect(prettyConnectionLabel(undefined)).toBeUndefined();
  });
});

describe("the alert email header", () => {
  const base = {
    occurrences: 1,
    firstSeenAt: "2026-09-14T08:00:00.000Z",
    lastSeenAt: "2026-09-14T08:00:00.000Z",
    summary: "Falha ao registar pagamento da reserva 20851430",
    severity: "warning" as const,
    connectionLabel: "lodgify → moloni",
  };

  it("names the account and quotes its number", () => {
    const { html } = renderIncidentTemplate("destination_reject", {
      ...base, merchantName: "Bestisafil", clientCode: "RIO-D97EC7",
    });
    expect(html).toContain("Bestisafil");
    expect(html).toContain("RIO-D97EC7");
    expect(html).toContain("Lodgify → Moloni");
    // The regression: the Clerk placeholder reached the header through
    // `SELECT name FROM users`, and every alert introduced the account as "User".
    expect(html).not.toMatch(/>\s*User\s*</);
  });

  it("prints no name line at all when there is no account to name", () => {
    const { html } = renderIncidentTemplate("destination_reject", base);
    expect(html).toContain("Lodgify → Moloni");
    expect(html).not.toMatch(/>\s*User\s*</);
  });
});
