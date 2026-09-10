import { describe, it, expect } from "vitest";
import { resolveConnectionContext, projectConnectionBehaviour, synthLegacyConfig } from "./connection-context";
import { AppStorage } from "../storage";

/**
 * One account, two integrations: Shopify→InvoiceXpress on the legacy handlers
 * and Stripe→InvoiceXpress on the adapter pipeline.
 *
 * The model assumes one connection per account in places that decide documents
 * and money, and the assumption is never checked. These tests pin what the code
 * ACTUALLY does for such an account, so the behaviour is written down rather
 * than rediscovered, and so the day someone widens the model the tests that must
 * change say so out loud.
 *
 * Where a test pins a defect it says so, and says which assertion to invert when
 * it is fixed.
 */

async function db(seed: (exec: (sql: string) => void) => void) {
  let DatabaseSync: any;
  try {
    const nodeSqlite = "node:sqlite";
    ({ DatabaseSync } = await import(nodeSqlite));
  } catch {
    return null;
  }
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE integrations (
      id TEXT PRIMARY KEY, user_id TEXT, shopify_domain TEXT,
      ix_account_name TEXT, ix_sequence_name TEXT, ix_exemption_reason TEXT,
      ix_document_type TEXT, auto_finalize INTEGER DEFAULT 0, is_paused INTEGER DEFAULT 0,
      force_tax_rate REAL, ix_send_email INTEGER DEFAULT 0
    );
    CREATE TABLE connections (
      id TEXT PRIMARY KEY, user_id TEXT, source_kind TEXT, destination_kind TEXT,
      source_config_json TEXT, destination_config_json TEXT, behavior_json TEXT,
      status TEXT, invoice_cutoff TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE processed_orders (
      id TEXT PRIMARY KEY, invoice_id TEXT, created_at TEXT, shopify_domain TEXT,
      user_id TEXT, source_kind TEXT, destination_kind TEXT, hold_reason TEXT, routed_json TEXT
    );
  `);
  seed((sql: string) => sqlite.exec(sql));

  const env: any = {
    DB: {
      prepare(sql: string) {
        const stmt = sqlite.prepare(sql);
        let args: any[] = [];
        const api = {
          bind(...a: any[]) { args = a; return api; },
          async all() { return { results: stmt.all(...args) }; },
          async run() { return { meta: { changes: stmt.run(...args).changes } }; },
          async first() { return stmt.get(...args) ?? null; },
        };
        return api;
      },
    },
    INVOICE_KV: {},
  };
  return { env, close: () => sqlite.close() };
}

/** The account under audit: a live Shopify shop plus a live Stripe connection. */
const DUAL = (exec: (sql: string) => void) => {
  exec(`INSERT INTO integrations (id, user_id, shopify_domain, ix_account_name,
          ix_sequence_name, ix_exemption_reason, ix_document_type, auto_finalize)
        VALUES ('i1','user_X','loja.myshopify.com','contaix','LOJA','M01','invoice_receipt',1)`);
  exec(`INSERT INTO connections (id, user_id, source_kind, destination_kind, status,
          destination_config_json, created_at, updated_at)
        VALUES ('c1','user_X','stripe','invoicexpress','active', NULL,
                '2026-09-01T00:00:00Z','2026-09-01T00:00:00Z')`);
};

describe("resolving which connection an operation acts on", () => {
  it("resolves the Stripe connection when the caller names no source", async () => {
    const h = await db(DUAL);
    if (!h) return;
    try {
      const r = await resolveConnectionContext(h.env, { userId: "user_X", onAmbiguous: "pick_latest" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.ctx.source).toBe("stripe");
      // This is what empties Conciliação of the shop's orders: the page asks by
      // user and is handed the Stripe connection, every time.
      expect(r.ctx.scope).toBe("u:user_X");
    } finally { h.close(); }
  });

  it("reaches the Shopify half when the caller names it", async () => {
    // The load-bearing fact for fixing Conciliação: filtering by source finds no
    // `connections` row, falls through to the legacy `integrations` lookup, and
    // returns a proper Shopify context scoped to the shop domain. So the worker
    // can already serve either half of this account — what is missing is only a
    // caller that passes the discriminator. The page and its API send user_id
    // alone, which is why the shop's orders vanish from the view.
    const h = await db(DUAL);
    if (!h) return;
    try {
      const r = await resolveConnectionContext(h.env, { userId: "user_X", source: "shopify" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.ctx.source).toBe("shopify");
      expect(r.ctx.destination).toBe("invoicexpress");
      expect(r.ctx.scope).toBe("loja.myshopify.com");
    } finally { h.close(); }
  });

  it("never reports the account as ambiguous, so the refuse-to-guess guard cannot fire", async () => {
    // DEFECT (audit A-01 / T-03). `onAmbiguous: "error"` exists so a WRITE never
    // guesses which connection an operator meant. It counts `connections` rows
    // only, and this account has exactly one — so a re-emit, a backfill or a
    // credit note silently targets Stripe on an account that also invoices
    // Shopify. Invert to expect error "ambiguous" once Shopify→IX is a row.
    const h = await db(DUAL);
    if (!h) return;
    try {
      const r = await resolveConnectionContext(h.env, { userId: "user_X" }); // default: "error"
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.ctx.source).toBe("stripe");
    } finally { h.close(); }
  });

  it("does not hand a Stripe connection the shop's fiscal settings", async () => {
    // The account here runs a Shopify shop AND a Stripe connection. They are two
    // different integrations, and a merchant may run every combination at once —
    // so the shop's exemption code and forced rates are the SHOP's, not the
    // account's, and must not decide what the Stripe connection issues.
    //
    // Measured before this was true: a shop with force_tax_rate = 0 issued a
    // different business's Stripe sales at 0% with an exemption code, ignoring
    // the 23% that connection had been configured with. Nothing about the
    // resulting invoice looked wrong.
    const h = await db(DUAL);
    if (!h) return;
    try {
      const r = await resolveConnectionContext(h.env, { userId: "user_X", source: "stripe" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      // Isolated: the connection states neither, so it gets neither.
      expect(r.ctx.config.ix_exemption_reason).toBeNull();
      expect(r.ctx.config.force_tax_rate).toBeNull();
      expect(r.ctx.config.oss_enabled).toBe(0);

      // The series too, now. Two integrations of one account may file into the
      // SAME InvoiceXpress account and must still use different series — Wim Hof
      // Method files Shopify orders into WH-25-1 and Stripe sales into FR-ROW.
      // A connection that states none gets none, and the destination applies its
      // own default, rather than silently filing into the shop's AT-communicated
      // series.
      expect(r.ctx.config.ix_sequence_name).toBeNull();
      expect(r.ctx.config.ix_document_type).toBeNull();

      // Still inherited, deliberately: auto_finalize is behaviour the connection
      // projects when it states one, not fiscal identity.
      expect(r.ctx.config.auto_finalize).toBe(1);
    } finally { h.close(); }
  });

  it("gives a connection the series IT states, over the shop's", async () => {
    // The WHM shape: one InvoiceXpress account, two integrations, two series.
    const h = await db((exec) => {
      DUAL(exec);
      exec(`UPDATE connections SET destination_config_json = '{"ix_sequence_name":"FR-ROW","ix_document_type":"invoice"}' WHERE id = 'c1'`);
    });
    if (!h) return;
    try {
      const r = await resolveConnectionContext(h.env, { userId: "user_X", source: "stripe" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.ctx.config.ix_sequence_name).toBe("FR-ROW");
      expect(r.ctx.config.ix_document_type).toBe("invoice");
    } finally { h.close(); }
  });

  it("still hands a Shopify connection its own row, untouched", async () => {
    // The legacy row belongs to the shop. Nothing here changes for it.
    const h = await db(DUAL);
    if (!h) return;
    try {
      const r = await resolveConnectionContext(h.env, { userId: "user_X", shop: "loja.myshopify.com" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.ctx.config.ix_exemption_reason).toBe("M01");
      expect(r.ctx.config.ix_sequence_name).toBe("LOJA");
    } finally { h.close(); }
  });
});

describe("what a connection may hold of its own", () => {
  const base = () => synthLegacyConfig("user_X");

  it("carries the behaviour settings a connection is allowed to state", () => {
    const c: any = base();
    projectConnectionBehaviour(c as any, {
      auto_finalize: true, send_email: true, custom_invoice_note: "Obrigado",
      ix_derive_exemption: true, stripe_routing_hints: true,
    });
    expect(c.auto_finalize).toBe(1);
    expect(c.ix_send_email).toBe(1);
    expect(c.custom_invoice_note).toBe("Obrigado");
    expect(c.ix_derive_exemption).toBe(1);
    expect(c.stripe_routing_hints).toBe(1);
  });

  it("carries the fiscal identity, so two connections can differ on it", () => {
    // Was audit F-01, fixed 08/09/2026: series, exemption code and document type
    // are the whole reason an account cannot run two connections into one
    // InvoiceXpress account, and they were read straight off the shared row.
    const c: any = { ...base(), ix_sequence_name: "LOJA", ix_exemption_reason: "M01",
                     ix_document_type: "invoice_receipt", force_tax_rate: 23, is_paused: 0 };
    projectConnectionBehaviour(c as any, {
      ix_sequence_name: "CONSULTAS", ix_exemption_reason: "M07",
      ix_document_type: "invoice", force_tax_rate: 0, is_paused: 1,
    });
    expect(c.ix_sequence_name).toBe("CONSULTAS");
    expect(c.ix_exemption_reason).toBe("M07");
    expect(c.ix_document_type).toBe("invoice");
    // Still shared, deliberately: the pause toggle writes the legacy row, so a
    // connection that never stated `is_paused` would otherwise resume a paused
    // account the moment anything projected a 0 over it. They move together or
    // not at all.
    expect(c.force_tax_rate).toBe(23);
    expect(c.is_paused).toBe(0);
  });

  it("inherits the shared row for anything the connection leaves blank", () => {
    // Blank is how the wizard says "no opinion" — and the only way back to
    // inheriting once a connection has stated a series.
    const c: any = { ...base(), ix_sequence_name: "LOJA", ix_exemption_reason: "M01",
                     ix_document_type: "invoice_receipt" };
    projectConnectionBehaviour(c as any, { ix_sequence_name: "  ", ix_exemption_reason: "" });
    expect(c.ix_sequence_name).toBe("LOJA");
    expect(c.ix_exemption_reason).toBe("M01");
    expect(c.ix_document_type).toBe("invoice_receipt");
  });

  it("trims what the merchant typed, so a stray space is not a different series", () => {
    const c: any = { ...base(), ix_sequence_name: "LOJA" };
    projectConnectionBehaviour(c as any, { ix_sequence_name: " FR-ROW " });
    expect(c.ix_sequence_name).toBe("FR-ROW");
  });
});

describe("which rows a shop-scoped query owns", () => {
  const withRows = (exec: (sql: string) => void) => {
    DUAL(exec);
    // The pipeline stamps `config.shopify_domain` on every row it writes, and on
    // this account that column is not null — so the Stripe payment lands under
    // the shop's domain alongside the shop's own orders.
    exec(`INSERT INTO processed_orders (id, invoice_id, created_at, shopify_domain, user_id, source_kind)
          VALUES ('6123456789012','111','2026-09-01T10:00:00Z','loja.myshopify.com','user_X','shopify')`);
    exec(`INSERT INTO processed_orders (id, invoice_id, created_at, shopify_domain, user_id, source_kind)
          VALUES ('pi_3TxAbcDefGhiJkl','222','2026-09-04T10:00:00Z','loja.myshopify.com','user_X','stripe')`);
  };

  it("returns the Stripe payment to a Shopify-scoped draft listing", async () => {
    // FIXED. This listing feeds Dev Mode's "finalize drafts" for the Shopify
    // connection, and a Stripe draft in it would be certified under the shop's
    // settings, irreversibly, with the paid-total guard inert because the id is
    // not a Shopify order number. Wim Hof Method had 15 such rows in production.
    // The query now filters by source; NULL counts as Shopify because it
    // predates the column.
    const h = await db(withRows);
    if (!h) return;
    try {
      const rows = await new AppStorage(h.env, "loja.myshopify.com", "user_X").listProcessedInvoices(100);
      expect(rows.map((r) => r.id)).not.toContain("pi_3TxAbcDefGhiJkl");
    } finally { h.close(); }
  });

  it("dates the shop's last activity from a Stripe payment", async () => {
    // FIXED. `since_last_processed` starts its window here, so a dead Shopify
    // webhook was hidden by live Stripe traffic and the catch-up run reported
    // zero to create. It now reads the shop's own last row.
    const h = await db(withRows);
    if (!h) return;
    try {
      const storage = new AppStorage(h.env, "loja.myshopify.com", "user_X");
      expect(await storage.getLastProcessedDate()).toBe("2026-09-01T10:00:00Z");
      // The source-aware lookup already exists and gives the right answer; the
      // Shopify caller simply does not use it.
      expect(await storage.getLastProcessedDateByUser("user_X", "shopify")).toBe("2026-09-01T10:00:00Z");
    } finally { h.close(); }
  });
});
