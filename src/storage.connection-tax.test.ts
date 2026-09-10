import { describe, it, expect } from "vitest";
import { AppStorage } from "./storage";

/**
 * Tax overrides belong to ONE integration.
 *
 * They used to live on the legacy `integrations` row, which is the account's
 * Shopify shop. A merchant running a shop and a Stripe connection had a single
 * set of rates between them: setting 23% for Stripe also set it for the shop,
 * and a shop at 0% silently issued the Stripe connection's sales at 0% too
 * (measured on a live document, 09/09/2026).
 *
 * A merchant may run every combination at once and each is a separate business
 * decision, so each connection carries its own.
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
    CREATE TABLE connections (
      id TEXT PRIMARY KEY, user_id TEXT, source_kind TEXT, destination_kind TEXT,
      source_config_json TEXT, destination_config_json TEXT,
      status TEXT, created_at TEXT, updated_at TEXT
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

const TWO_CONNECTIONS = (exec: (sql: string) => void) => {
  exec(`INSERT INTO connections (id, user_id, source_kind, destination_kind, destination_config_json, status)
        VALUES ('c1','user_X','stripe_connect','moloni','{"moloni_client_id":"dev1","moloni_refresh_token":"rt"}','active')`);
  exec(`INSERT INTO connections (id, user_id, source_kind, destination_kind, destination_config_json, status)
        VALUES ('c2','user_X','lodgify','moloni','{"moloni_client_id":"dev2"}','active')`);
};

describe("tax overrides are per connection", () => {
  it("starts neutral, never inheriting somebody else's rate", async () => {
    const h = await db(TWO_CONNECTIONS);
    if (!h) return;
    try {
      const s = new AppStorage(h.env);
      const o = await s.getConnectionTaxOverride("user_X", "stripe_connect", "moloni");
      expect(o.force_tax_rate).toBeNull();
      expect(o.force_shipping_tax_rate).toBeNull();
      expect(o.oss_enabled).toBe(0);
      expect(o.b2b_reverse_charge).toBe(0);
    } finally { h.close(); }
  });

  it("writes one connection without touching the other", async () => {
    // The whole point: 23% on Stripe must not become 23% on Lodgify.
    const h = await db(TWO_CONNECTIONS);
    if (!h) return;
    try {
      const s = new AppStorage(h.env);
      await s.setConnectionTaxOverride("user_X", "stripe_connect", "moloni", {
        force_tax_rate: 23,
        force_shipping_tax_rate: 6,
        oss_enabled: true,
        b2b_reverse_charge: true,
        ix_b2b_exemption_reason: "M40",
      });

      const mine = await s.getConnectionTaxOverride("user_X", "stripe_connect", "moloni");
      expect(mine.force_tax_rate).toBe(23);
      expect(mine.force_shipping_tax_rate).toBe(6);
      expect(mine.oss_enabled).toBe(1);
      expect(mine.b2b_reverse_charge).toBe(1);
      expect(mine.ix_b2b_exemption_reason).toBe("M40");

      const theirs = await s.getConnectionTaxOverride("user_X", "lodgify", "moloni");
      expect(theirs.force_tax_rate).toBeNull();
      expect(theirs.oss_enabled).toBe(0);
    } finally { h.close(); }
  });

  it("keeps the credentials sitting in the same blob", async () => {
    // A settings save that wiped the Moloni configuration is a bug this codebase
    // has already had once. json_patch merges; it does not replace.
    const h = await db(TWO_CONNECTIONS);
    if (!h) return;
    try {
      const s = new AppStorage(h.env);
      await s.setConnectionTaxOverride("user_X", "stripe_connect", "moloni", {
        force_tax_rate: 23, force_shipping_tax_rate: null,
        oss_enabled: false, b2b_reverse_charge: false, ix_b2b_exemption_reason: "M16",
      });
      const row: any = await h.env.DB
        .prepare("SELECT destination_config_json AS j FROM connections WHERE id = 'c1'")
        .bind().first();
      const cfg = JSON.parse(row.j);
      expect(cfg.moloni_client_id).toBe("dev1");
      expect(cfg.moloni_refresh_token).toBe("rt");
      expect(cfg.force_tax_rate).toBe(23);
    } finally { h.close(); }
  });

  it("reports when there is no such connection to write to", async () => {
    const h = await db(TWO_CONNECTIONS);
    if (!h) return;
    try {
      const s = new AppStorage(h.env);
      const written = await s.setConnectionTaxOverride("user_X", "eupago", "vendus", {
        force_tax_rate: 23, force_shipping_tax_rate: null,
        oss_enabled: false, b2b_reverse_charge: false, ix_b2b_exemption_reason: "M16",
      });
      expect(written).toBe(false);
    } finally { h.close(); }
  });

  it("treats a blank rate as exempt, not as zero-by-accident", async () => {
    const h = await db(TWO_CONNECTIONS);
    if (!h) return;
    try {
      const s = new AppStorage(h.env);
      await s.setConnectionTaxOverride("user_X", "stripe_connect", "moloni", {
        force_tax_rate: null, force_shipping_tax_rate: null,
        oss_enabled: false, b2b_reverse_charge: false, ix_b2b_exemption_reason: "M16",
      });
      const o = await s.getConnectionTaxOverride("user_X", "stripe_connect", "moloni");
      expect(o.force_tax_rate).toBeNull();
    } finally { h.close(); }
  });
});
