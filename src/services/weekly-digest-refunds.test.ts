import { describe, it, expect } from "vitest";
import { runWeeklyMerchantDigest } from "./incidents";
import { tplWeeklyUnprocessed } from "./email-templates";

/**
 * A refund whose credit note failed is NOT a sale without an invoice, and the
 * weekly merchant digest must stop treating it as one. Two live failures drove
 * this: MY VAN's refund incident carried the Stripe *event* id (`evt_…`), which
 * exists in no invoice table, so it could never be verified and nagged every
 * Friday for weeks — while the credit note had in fact been issued.
 *
 * Both halves are pinned here: the refund must never be counted as an unbilled
 * sale, and it must never be auto-closed just because the sale has an invoice.
 */

const RECENT = new Date(Date.now() - 2 * 864e5).toISOString();

function fakeEnv(incidents: any[], invoicedIds: string[] = []) {
  const closed: string[] = [];
  const sent: Array<{ subject: string; html: string }> = [];
  const db = {
    prepare(sql: string) {
      const api: any = {
        _args: [] as any[],
        bind(...a: any[]) { api._args = a; return api; },
        async all() {
          if (sql.includes("FROM incidents")) return { results: incidents };
          if (sql.includes("FROM integrations")) {
            return { results: [...new Set(incidents.map((i) => i.user_id))].map((user_id) => ({ user_id, is_paused: 0 })) };
          }
          // processed_orders / reconciliation_match / lodgify_partial_invoices
          const ids = api._args.filter((a: any) => invoicedIds.includes(a));
          if (sql.includes("processed_orders")) return { results: ids.map((id: string) => ({ id, invoice_id: "999" })) };
          return { results: [] };
        },
        async first() {
          if (sql.includes("u.email")) return { user_email: "merchant@example.com", dev_notify_emails: null };
          if (sql.includes("SELECT name FROM users")) return { name: "Loja Teste" };
          return null;
        },
        async run() {
          if (sql.includes("UPDATE incidents")) closed.push(...api._args.slice(1));
          return { meta: { changes: 1 } };
        },
      };
      return api;
    },
  };
  return {
    env: { DB: db, KAPTA_DEV_EMAILS: "", RESEND_API_KEY: "", INVOICE_KV: { get: async () => null, put: async () => {} } } as any,
    closed,
    sent,
  };
}

const salesIncident = {
  id: "inc-sale",
  user_id: "u1",
  kind: "destination_reject",
  summary: "created pi_AAA: Moloni create failed",
  occurrences: 1,
  last_seen_at: RECENT,
  severity: "error",
  affected_ids_json: JSON.stringify(["pi_AAA"]),
  detail_json: JSON.stringify({ topic: "created" }),
};

const refundIncident = {
  id: "inc-refund",
  user_id: "u1",
  kind: "queue_retry_exhausted",
  summary: "refund pi_BBB: Moloni credit create failed",
  occurrences: 1,
  last_seen_at: RECENT,
  severity: "critical",
  affected_ids_json: JSON.stringify(["pi_BBB"]),
  detail_json: JSON.stringify({ topic: "refund" }),
};

describe("weekly digest — refunds are not unbilled sales", () => {
  it("counts only the sale in totalMissing, and the refund apart", async () => {
    const { env } = fakeEnv([salesIncident, refundIncident]);
    const res = await runWeeklyMerchantDigest(env, { dryRun: true });
    expect(res.totalMissing).toBe(1);          // pi_AAA only
    expect(res.totalCreditMissing).toBe(1);    // pi_BBB, counted separately
    expect(res.preview?.[0].subject).toBe("[Rioko 2.0] 1 fatura por emitir");
  });

  it("does not auto-close a refund incident just because the sale is invoiced", async () => {
    // pi_BBB HAS an invoice — that is normal for a refund and must not be read
    // as "the credit note got issued".
    const { env, closed } = fakeEnv([refundIncident], ["pi_BBB"]);
    const res = await runWeeklyMerchantDigest(env, { dryRun: true });
    expect(closed).not.toContain("inc-refund");
    expect(res.totalCreditMissing).toBe(1);
  });

  it("titles the email after credit notes when there is no unbilled sale", async () => {
    const { env } = fakeEnv([refundIncident]);
    const res = await runWeeklyMerchantDigest(env, { dryRun: true });
    expect(res.totalMissing).toBe(0);
    expect(res.preview?.[0].subject).toBe("[Rioko 2.0] 1 nota de crédito por emitir");
  });

  it("still closes an ordinary sale incident once the order is invoiced", async () => {
    const { env, closed } = fakeEnv([salesIncident], ["pi_AAA"]);
    const res = await runWeeklyMerchantDigest(env, { dryRun: false });
    expect(closed).toContain("inc-sale");
    expect(res.totalMissing).toBe(0);
  });
});

describe("weekly digest template — credit-note section", () => {
  const item = { kind: "queue_retry_exhausted", summary: "refund pi_BBB falhou", lastSeenAt: RECENT, missingIds: ["pi_BBB"] };

  it("never calls a refund a sale waiting to be invoiced", () => {
    const { html, subject } = tplWeeklyUnprocessed({ items: [], totalMissing: 0, creditItems: [item], totalCreditMissing: 1 });
    expect(subject).toContain("nota de crédito por emitir");
    expect(html).toContain("não geraram nota de crédito");
    expect(html).not.toContain("venda por faturar");
    expect(html).toContain("pi_BBB");
  });

  it("keeps both sections when the merchant has each kind", () => {
    const sale = { kind: "destination_reject", summary: "created pi_AAA falhou", lastSeenAt: RECENT, missingIds: ["pi_AAA"] };
    const { html, subject } = tplWeeklyUnprocessed({ items: [sale], totalMissing: 1, creditItems: [item], totalCreditMissing: 1 });
    expect(subject).toBe("[Rioko 2.0] 1 fatura por emitir");
    expect(html).toContain("venda por faturar");
    expect(html).toContain("não geraram nota de crédito");
  });

  it("leaves the sales-only email exactly as it was", () => {
    const sale = { kind: "destination_reject", summary: "created pi_AAA falhou", lastSeenAt: RECENT, missingIds: ["pi_AAA"] };
    const { html, subject } = tplWeeklyUnprocessed({ items: [sale], totalMissing: 2 });
    expect(subject).toBe("[Rioko 2.0] 2 faturas por emitir");
    expect(html).toContain("Faturas por emitir");
    expect(html).not.toContain("nota de crédito");
  });
});
