import { describe, it, expect, vi, afterEach } from "vitest";
import { probeConnectionTax } from "./stripe-tax-probe";

/**
 * Absence of VAT is not a fault.
 *
 * A large part of this fleet is legitimately exempt — art.53, M01/M05/M10/M40 —
 * and a 0% document with the right code is the correct output for them. So the
 * probe reports a MISMATCH between what a connection declares and what its
 * Stripe account shows, and the only thing it ever changes by itself is the one
 * case that is unambiguous: the account demonstrably charges tax and we were
 * about to invoice it at 0%.
 */

const SOURCE = JSON.stringify({ auth_mode: "connect", stripe_account_id: "acct_m", livemode: true });

function conn(destinationConfig: Record<string, any>) {
  return {
    id: "c1", user_id: "user_1", destination_kind: "moloni",
    source_config_json: SOURCE,
    destination_config_json: JSON.stringify(destinationConfig),
  };
}

/** Records every statement so the test can assert what was written. */
function envWith(writes: any[]) {
  return {
    STRIPE_PLATFORM_SECRET_KEY: "sk_platform",
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: any[]) => ({ run: async () => { writes.push({ sql, args }); return {}; } }),
      }),
    },
  } as any;
}

/** `sessions` answers /checkout/sessions, `invoices` answers /invoices. */
function stubStripe(sessions: any[], invoices: any[]) {
  const fetchMock = vi.fn(async (url: string) => new Response(
    JSON.stringify({ data: String(url).includes("/checkout/sessions") ? sessions : invoices }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  ));
  vi.stubGlobal("fetch", fetchMock as any);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("probeConnectionTax", () => {
  it("turns the flag on when the account charges tax, as a JSON boolean", async () => {
    stubStripe([{ total_details: { amount_tax: 2300 } }], []);
    const writes: any[] = [];

    const r = await probeConnectionTax(envWith(writes), conn({}));

    expect(r.verdict).toBe("taxed");
    expect(r.flagTurnedOn).toBe(true);
    // A number here would be stored, shown as set in the console, and silently
    // never reach the adapter: projectConnectionBehaviour only projects booleans.
    const patch = JSON.parse(writes[0].args.find((a: any) => typeof a === "string" && a.includes("stripe_tax_from_source")));
    expect(patch.stripe_tax_from_source).toBe(true);
  });

  it("reads an Invoice's own tax shape too", async () => {
    stubStripe([], [{ total_taxes: [{ amount: 600 }] }]);
    const r = await probeConnectionTax(envWith([]), conn({}));
    expect(r.verdict).toBe("taxed");
  });

  it("leaves an exempt merchant completely alone", async () => {
    stubStripe([{ total_details: { amount_tax: 0 } }], []);
    const writes: any[] = [];

    const r = await probeConnectionTax(envWith(writes), conn({ exemption_reason: "M10" }));

    expect(r.verdict).toBe("exempt");
    expect(r.flagTurnedOn).toBe(false);
    expect(writes[0].sql).not.toContain("json_patch");
  });

  it("leaves a merchant who states a rate alone", async () => {
    stubStripe([{ total_details: { amount_tax: 0 } }], []);
    const r = await probeConnectionTax(envWith([]), conn({ force_tax_rate: 23 }));
    expect(r.verdict).toBe("rule_rate");
    expect((await probeConnectionTax(envWith([]), conn({ default_vat_rate: 6 }))).verdict).toBe("rule_rate");
  });

  it("names the one case nobody has decided", async () => {
    // No tax at source, no rate, no code: the document goes out at 0% under
    // whatever exemption the destination picks on its own. A question for the
    // onboarding call, not an alarm and never a merchant email.
    stubStripe([{ total_details: { amount_tax: 0 } }], []);
    const r = await probeConnectionTax(envWith([]), conn({}));
    expect(r.verdict).toBe("undeclared_zero");
    expect(r.flagTurnedOn).toBe(false);
  });

  it("says nothing about an account with no payments yet", async () => {
    stubStripe([], []);
    const r = await probeConnectionTax(envWith([]), conn({}));
    expect(r.verdict).toBe("no_data");
  });

  it("records an error instead of guessing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })) as any);
    const r = await probeConnectionTax(envWith([]), conn({ exemption_reason: "M10" }));
    expect(r.verdict).toBe("error");
    expect(r.flagTurnedOn).toBe(false);
  });
});
