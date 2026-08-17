import { describe, it, expect, vi, afterEach } from "vitest";
import { MoloniDestination, moloniSeriesMinDate, type MoloniFinalizeBatch } from "./moloni-destination";
import type { AdapterCtx } from "../types";

/**
 * Moloni's series-chronology rule, at CLOSE time.
 *
 * The adapter used to close drafts with a bare status flip, on the belief that
 * Moloni only ever complains at insert. It complains at close too — closing is
 * when the document takes its number — and a bulk run therefore produced one
 * certified invoice and 21 rejections reading `12 date >= 2026-08-12`.
 */

const CTX = {
  destinationConfig: {
    moloni_client_id: "cid",
    moloni_client_secret: "secret",
    moloni_username: "user",
    moloni_password: "pass",
    moloni_company_id: 381863,
    moloni_document_set_id: 42,
    moloni_document_type: "invoice",
  },
  config: {},
} as unknown as AdapterCtx;

type Call = { path: string; body: Record<string, string> };

/**
 * A Moloni good enough to answer a finalize: OAuth, one draft, and a series
 * floor it enforces on close exactly the way the live API does.
 */
function mockMoloni(o: {
  doc: Record<string, unknown>;
  /** Closes dated before this are refused, as Moloni refuses them. */
  seriesFloor?: string | null;
}) {
  const calls: Call[] = [];
  const doc = { ...o.doc };

  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const path = url.replace(/^https:\/\/api\.moloni\.pt\/v1/, "").replace(/\?.*$/, "");
    const body: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(String(init?.body ?? ""))) body[k] = v;
    calls.push({ path, body });

    const json = (data: unknown) => new Response(JSON.stringify(data), {
      status: 200, headers: { "Content-Type": "application/json" },
    });

    if (path === "/grant/") return json({ access_token: "tok", expires_in: 3600 });
    if (path === "/invoices/getOne/") return json(doc);
    if (path === "/invoices/update/") {
      // Closing (status=1) is where the date is judged.
      if (body.status === "1") {
        const floor = o.seriesFloor;
        if (floor && String(doc.date).slice(0, 10) < floor) {
          return json([`12 date >= ${floor}`]);
        }
        doc.status = 1;
        return json({ valid: 1 });
      }
      if (body.date) { doc.date = body.date; doc.notes = body.notes ?? doc.notes; }
      return json({ valid: 1 });
    }
    throw new Error(`unexpected Moloni call: ${path}`);
  }));

  return { calls, doc };
}

const draft = (over: Record<string, unknown> = {}) => ({
  document_id: 1010429054,
  status: 0,
  date: "2026-07-30 00:00:00",
  net_value: 0,
  gross_value: 61.5,
  ...over,
});

const batch = (): MoloniFinalizeBatch => ({ kind: "moloni", seriesMinDate: null });

afterEach(() => vi.unstubAllGlobals());

describe("moloniSeriesMinDate", () => {
  it("reads the minimum date out of Moloni's validation error", () => {
    expect(moloniSeriesMinDate(new Error(`Moloni finalize failed: validation errors ["12 date >= 2026-08-12"]`)))
      .toBe("2026-08-12");
  });

  it("is null for any other failure, so nothing re-dates a document over an unrelated error", () => {
    expect(moloniSeriesMinDate(new Error("Moloni finalize failed: 500 — upstream"))).toBeNull();
    expect(moloniSeriesMinDate(null)).toBeNull();
  });
});

describe("MoloniDestination.finalizeWithDate", () => {
  const moloni = new MoloniDestination();

  it("keeps the transaction's own date when the series allows it", async () => {
    const { calls } = mockMoloni({ doc: draft(), seriesFloor: "2026-07-01" });
    const out = await moloni.finalizeWithDate("1010429054", CTX, {
      strategy: "closest_available", batch: batch(),
    });
    expect(out.status).toBe("finalized");
    expect(out).toMatchObject({ date: "2026-07-30", originalDate: "2026-07-30" });
    // No re-date: the only update sent was the close itself.
    expect(calls.filter((c) => c.path === "/invoices/update/" && c.body.date)).toHaveLength(0);
  });

  it("re-dates to the floor Moloni names, then closes", async () => {
    const { calls, doc } = mockMoloni({ doc: draft(), seriesFloor: "2026-08-12" });
    const state = batch();
    const out = await moloni.finalizeWithDate("1010429054", CTX, {
      strategy: "closest_available",
      batch: state,
      dateMovedNote: (original) => `Fatura referente ao pagamento Stripe pi_x de ${original}`,
    });

    expect(out).toMatchObject({ status: "finalized", date: "2026-08-12", originalDate: "2026-07-30" });
    expect(doc.status).toBe(1);
    const redate = calls.find((c) => c.path === "/invoices/update/" && c.body.date);
    expect(redate?.body.date).toBe("2026-08-12");
    // The due date travels with the issue date, and the real transaction date is
    // written into the document rather than lost.
    expect(redate?.body.expiration_date).toBe("2026-08-12");
    expect(redate?.body.notes).toContain("2026-07-30");
    // The floor is remembered, so the next row of the batch starts there instead
    // of paying for the same rejection again.
    expect(state.seriesMinDate).toBe("2026-08-12");
  });

  it("uses the floor the batch already learned, without a wasted rejection", async () => {
    const { calls } = mockMoloni({ doc: draft({ date: "2026-08-04 00:00:00" }), seriesFloor: "2026-08-12" });
    const state: MoloniFinalizeBatch = { kind: "moloni", seriesMinDate: "2026-08-12" };
    const out = await moloni.finalizeWithDate("1010429054", CTX, { strategy: "closest_available", batch: state });

    expect(out).toMatchObject({ status: "finalized", date: "2026-08-12" });
    // One close attempt, not two: the batch knew the floor before trying.
    expect(calls.filter((c) => c.path === "/invoices/update/" && c.body.status === "1")).toHaveLength(1);
  });

  it("stamps today when asked for today", async () => {
    // The `today` strategy did nothing at all before: the draft was closed on
    // whatever date it already carried, so a run an operator moved to today
    // failed on exactly the same series rule.
    const { calls } = mockMoloni({ doc: draft(), seriesFloor: "2026-08-12" });
    const out = await moloni.finalizeWithDate("1010429054", CTX, { strategy: "today", batch: batch() });

    const today = new Date().toISOString().slice(0, 10);
    expect(out).toMatchObject({ status: "finalized", date: today, originalDate: "2026-07-30" });
    expect(calls.find((c) => c.path === "/invoices/update/" && c.body.date)?.body.date).toBe(today);
  });

  it("writes nothing in a dry run, and predicts the date the real run would use", async () => {
    const { calls } = mockMoloni({ doc: draft(), seriesFloor: "2026-08-12" });
    const state: MoloniFinalizeBatch = { kind: "moloni", seriesMinDate: "2026-08-12" };
    const out = await moloni.finalizeWithDate("1010429054", CTX, {
      strategy: "closest_available", batch: state, dryRun: true,
    });

    expect(out).toMatchObject({ status: "dry_run", date: "2026-08-12", originalDate: "2026-07-30" });
    expect(calls.filter((c) => c.path === "/invoices/update/")).toHaveLength(0);
  });

  it("never certifies a draft whose total is not what the buyer paid", async () => {
    const { calls } = mockMoloni({ doc: draft({ gross_value: 54.72 }) });
    const out = await moloni.finalizeWithDate("1010429054", CTX, {
      strategy: "closest_available", batch: batch(), paidTotal: 58,
    });

    expect(out.status).toBe("error");
    expect(out.message).toContain("não é o valor pago");
    expect(calls.filter((c) => c.path === "/invoices/update/")).toHaveLength(0);
  });

  it("skips a document that is already closed", async () => {
    const { calls } = mockMoloni({ doc: draft({ status: 1 }) });
    const out = await moloni.finalizeWithDate("1010429054", CTX, { strategy: "closest_available", batch: batch() });
    expect(out).toMatchObject({ status: "skipped" });
    expect(calls.filter((c) => c.path === "/invoices/update/")).toHaveLength(0);
  });

  it("leaves the draft alone when the refusal is not about the date", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
      const path = String(input).replace(/^https:\/\/api\.moloni\.pt\/v1/, "").replace(/\?.*$/, "");
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 });
      if (path === "/grant/") return json({ access_token: "tok", expires_in: 3600 });
      if (path === "/invoices/getOne/") return json(draft());
      return json(["2 customer_id 1 0"]);
    }));

    const out = await moloni.finalizeWithDate("1010429054", CTX, { strategy: "closest_available", batch: batch() });
    expect(out.status).toBe("error");
    expect(out.message).toContain("customer_id");
  });
});
