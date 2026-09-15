/**
 * The nightly Stripe heal has to run on the merchant's real config.
 *
 * It used to hand-build a minimal one — `{ user_id, shopify_domain: null,
 * b2b_reverse_charge: 0, ix_send_email: 0, auto_finalize: 0 }` — on the belief
 * that the pipeline would resolve credentials from the connection. True of
 * Moloni and Vendus, whose credentials live in the connection blob. False of
 * InvoiceXpress, whose `ix_account_name` and `ix_api_key` live on the legacy
 * `integrations` row and are read straight off `config`.
 *
 * So every night, for every Stripe→IX client, the heal called the proxy with no
 * credentials and got the same answer, on every payment:
 *
 *   2026-09-09 04:05 · WHM · x108
 *   UNAUTHENTICATED — "x-account-name and x-api-key are required"
 *
 * The automatic recovery could never have worked for those clients, while the
 * manual admin route beside it worked fine on the same data — because that one
 * resolves the config properly. This pins that they now agree.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const listActiveConnections = vi.fn();
const getMerchantDisplayNames = vi.fn();
const processStripeBackfill = vi.fn();
const resolveConnectionContext = vi.fn();
const checkSubscriptionGate = vi.fn();
const reportIncident = vi.fn();

vi.mock("../storage", () => ({
  AppStorage: class {
    listActiveConnections = (...a: any[]) => listActiveConnections(...a);
    getMerchantDisplayNames = (...a: any[]) => getMerchantDisplayNames(...a);
  },
}));
vi.mock("./admin-stripe", () => ({ processStripeBackfill: (...a: any[]) => processStripeBackfill(...a) }));
vi.mock("./admin", () => ({ processOrders: vi.fn() }));
vi.mock("../services/incidents", () => ({ reportIncident: (...a: any[]) => reportIncident(...a), INVOICE_FAILURE_KINDS: new Set() }));
vi.mock("../services/subscription-gate", () => ({ checkSubscriptionGate: (...a: any[]) => checkSubscriptionGate(...a) }));
vi.mock("../services/email", () => ({ sendEmail: vi.fn() }));
vi.mock("../services/connection-context", () => ({
  resolveConnectionContext: (...a: any[]) => resolveConnectionContext(...a),
}));

const { runStripeHeal } = await import("./reconciliation-sweep");

const env: any = { STRIPE_HEAL_DAYS: "30", STRIPE_HEAL_USERS: "" };

beforeEach(() => {
  listActiveConnections.mockReset();
  getMerchantDisplayNames.mockReset();
  processStripeBackfill.mockReset();
  resolveConnectionContext.mockReset();
  checkSubscriptionGate.mockReset();
  reportIncident.mockReset();

  checkSubscriptionGate.mockResolvedValue({ allowed: true });
  listActiveConnections.mockResolvedValue([
    { user_id: "user_WHM", source_kind: "stripe", destination_kind: "invoicexpress", created_at: "2026-09-08T14:49:59.950Z", invoice_cutoff: null },
  ]);
  getMerchantDisplayNames.mockResolvedValue(new Map([["user_WHM", "WHM"]]));
  processStripeBackfill.mockResolvedValue({ success: 0, skipped: 0, errors: 0 });
});

describe("runStripeHeal — the config it heals with", () => {
  it("hands over the InvoiceXpress credentials, which only the legacy row has", async () => {
    resolveConnectionContext.mockResolvedValue({
      ok: true,
      ctx: { config: { user_id: "user_WHM", ix_account_name: "whmservicesunipes", ix_api_key: "k", auto_finalize: 0 } },
    });

    await runStripeHeal(env, {});

    const config = processStripeBackfill.mock.calls[0][1];
    expect(config.ix_account_name).toBe("whmservicesunipes");
    expect(config.ix_api_key).toBe("k");
  });

  it("asks for the connection being healed, not for whichever is newest", async () => {
    // A merchant can run Stripe→IX and Stripe→Moloni at once; healing one with
    // the other's credentials is worse than not healing at all.
    resolveConnectionContext.mockResolvedValue({ ok: true, ctx: { config: { user_id: "user_WHM" } } });

    await runStripeHeal(env, {});

    expect(resolveConnectionContext).toHaveBeenCalledWith(env, {
      userId: "user_WHM",
      source: "stripe",
      destination: "invoicexpress",
    });
  });

  it("still runs, on the old minimal config, when the connection cannot be resolved", async () => {
    // Degrading to yesterday's behaviour beats skipping the merchant silently.
    resolveConnectionContext.mockResolvedValue({ ok: false, error: "not_found" });

    await runStripeHeal(env, {});

    expect(processStripeBackfill).toHaveBeenCalledTimes(1);
    expect(processStripeBackfill.mock.calls[0][1]).toMatchObject({ user_id: "user_WHM", shopify_domain: null });
  });
});

describe("runStripeHeal — what it escalates", () => {
  beforeEach(() => {
    resolveConnectionContext.mockResolvedValue({ ok: true, ctx: { config: { user_id: "user_WHM" } } });
  });

  it("leaves a connection the paywall refuses alone, and says nothing about it", async () => {
    checkSubscriptionGate.mockResolvedValue({ allowed: false, reason: "no_subscription for stripe:invoicexpress" });

    const result = await runStripeHeal(env, {});

    expect(processStripeBackfill).not.toHaveBeenCalled();
    expect(reportIncident).not.toHaveBeenCalled();
    expect(result.totals.connectionsSkipped).toBe(1);
  });

  it("names each unbilled payment, so the incident closes on its document and not on silence", async () => {
    // Diogo Acabado (15/09/2026): a heal incident with no ids was auto-resolved
    // after 24h while pi_3UEruPLRr9ut1iRi0AseOQaa was still unbilled.
    processStripeBackfill.mockResolvedValue({
      success: 0, skipped: 0, errors: 1,
      results: [{ external_id: "pi_3UEruPLRr9ut1iRi0AseOQaa", status: "error", message: "Moloni: company not found" }],
    });

    await runStripeHeal(env, {});

    expect(reportIncident.mock.calls[0][1]).toMatchObject({
      kind: "auto_heal_failed",
      affected_ids: ["pi_3UEruPLRr9ut1iRi0AseOQaa"],
    });
  });
});
