import { describe, it, expect, vi, afterEach } from "vitest";
import { incidentVerdict, resolveIncidentsOnEvidence, reportIncident, type SaleEvidence } from "./incidents";

/**
 * Why a false-alarm pill never cleared by itself.
 *
 * On 15/09/2026 WHM's `invoice.paid` retried finalize on two documents that were
 * already certified. Two critical `queue_retry_exhausted` and three
 * `destination_reject` stayed open, and the account row stayed red, although
 * both sales were invoiced and final. Nothing between the 08:00 runs asked the
 * records whether the thing an incident is about had since happened.
 */

const PI = "pi_3UFvliLXiybx6Vcz1667s22k";
const ok: SaleEvidence = { invoiced: true, held: false, finalized: true, expectsFinalize: true, creditIssuedSince: false, creditInFlight: false };
const ev = (o: Partial<SaleEvidence>) => new Map([[PI, { ...ok, ...o }]]);
const inc = (topic: string | null, kind = "queue_retry_exhausted", ids = [PI]) => ({ kind, topic, ids });

describe("incidentVerdict", () => {
  it("WHM: paid retries on a finalized invoice are settled", () => {
    expect(incidentVerdict(inc("paid"), ev({}))).toBe("settled");
  });

  it("a finalize failure that left a draft is not", () => {
    expect(incidentVerdict(inc("paid", "destination_reject"), ev({ finalized: false }))).toBe("unsettled");
  });

  it("a draft-only connection needs no finalize", () => {
    expect(incidentVerdict(inc("created"), ev({ finalized: false, expectsFinalize: false }))).toBe("settled");
  });

  it("a held or missing invoice stays open", () => {
    expect(incidentVerdict(inc("created"), ev({ held: true }))).toBe("unsettled");
    expect(incidentVerdict(inc("paid"), new Map())).toBe("unsettled");
  });

  it("a refund needs its credit note, not the sale's invoice", () => {
    expect(incidentVerdict(inc("refund"), ev({}))).toBe("unsettled");
    expect(incidentVerdict(inc("refunds/create"), ev({ creditIssuedSince: true }))).toBe("settled");
    expect(incidentVerdict(inc("refund"), ev({ creditIssuedSince: true, creditInFlight: true }))).toBe("unsettled");
  });

  it("uncheckable refs, empty lists and other kinds stay on the clock", () => {
    expect(incidentVerdict(inc("paid", undefined, ["evt_1UFvr0LXiybx6Vczzly0amVD"]), ev({}))).toBe("unverifiable");
    expect(incidentVerdict(inc(null, "destination_reject", ["18176557"]), ev({}))).toBe("unverifiable");
    expect(incidentVerdict(inc("paid", undefined, []), ev({}))).toBe("unverifiable");
    expect(incidentVerdict(inc(null, "document_drift"), ev({}))).toBe("unverifiable");
  });

  it("a mixed list is judged on its checkable ids, never sent to the clock", () => {
    // An evt_ or "unknown" id says nothing about the sale next to it; on the
    // clock, that sale would close after 24h still unbilled.
    expect(incidentVerdict(inc("paid", undefined, [PI, "evt_x1234567"]), ev({}))).toBe("settled");
    expect(incidentVerdict(inc("paid", undefined, [PI, "unknown"]), new Map())).toBe("unsettled");
  });

  it("every id must be settled", () => {
    expect(incidentVerdict(inc("paid", undefined, [PI, "pi_3UFwnHLXiybx6Vcz1xyyLQRY"]), ev({}))).toBe("unsettled");
  });
});

/**
 * The same rule against real SQL. The evidence query and the upsert union have
 * never run on D1 from code, so they run here on SQLite with the columns the
 * migrations define.
 */
async function withDb(fn: (env: any, db: any) => Promise<void>) {
  let DatabaseSync: any;
  try {
    const nodeSqlite = "node:sqlite";
    ({ DatabaseSync } = await import(nodeSqlite));
  } catch {
    console.warn("node:sqlite unavailable; skipping incident evidence SQL check");
    return;
  }
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE incidents (
      id TEXT PRIMARY KEY, user_id TEXT, connection_id TEXT, bucket_key TEXT NOT NULL UNIQUE,
      severity TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, detail_json TEXT,
      affected_ids_json TEXT, status TEXT NOT NULL DEFAULT 'open', first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL, occurrences INTEGER NOT NULL DEFAULT 1, notified_at TEXT, resolved_at TEXT
    );
    CREATE TABLE processed_orders (
      id TEXT PRIMARY KEY, invoice_id TEXT, shopify_domain TEXT, user_id TEXT, created_at TEXT,
      source_kind TEXT, destination_kind TEXT, hold_reason TEXT, routed_json TEXT
    );
    CREATE TABLE connections (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, source_kind TEXT NOT NULL, destination_kind TEXT NOT NULL, destination_config_json TEXT);
    CREATE TABLE integrations (shopify_domain TEXT, user_id TEXT, auto_finalize INTEGER);
    CREATE TABLE document_events (id TEXT PRIMARY KEY, external_id TEXT NOT NULL, invoice_id TEXT, event TEXT NOT NULL, detail_json TEXT, created_at TEXT);
    CREATE TABLE credit_notes (scope TEXT NOT NULL, refund_id TEXT NOT NULL, invoice_id TEXT NOT NULL, state TEXT NOT NULL, claimed_at TEXT NOT NULL, updated_at TEXT, PRIMARY KEY (scope, refund_id));
    CREATE TABLE reconciliation_match (order_id TEXT, invoice_id TEXT);
    CREATE TABLE reconciliation_decision (shopify_domain TEXT, order_id TEXT, decision TEXT);
    CREATE TABLE lodgify_partial_invoices (booking_id TEXT, invoice_id TEXT);
  `);
  const env = {
    DB: {
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        let bound: unknown[] = [];
        const api = {
          bind(...args: unknown[]) { bound = args; return api; },
          async run() { const r = stmt.run(...bound); return { meta: { changes: Number(r.changes) } }; },
          async first() { return stmt.get(...bound) ?? null; },
          async all() { return { results: stmt.all(...bound) }; },
        };
        return api;
      },
    },
    KAPTA_DEV_EMAILS: "",
  };
  await fn(env, db);
}

const status = (db: any, id: string) => db.prepare("SELECT status FROM incidents WHERE id = ?").get(id).status;

describe("resolveIncidentsOnEvidence — on SQLite", () => {
  afterEach(() => vi.useRealTimers());

  it("closes what the records settle and nothing else", async () => {
    await withDb(async (env, db) => {
      const seen = "2026-09-15T13:54:12.878Z";
      const incident = db.prepare(
        `INSERT INTO incidents (id, user_id, bucket_key, severity, kind, summary, detail_json, affected_ids_json, status, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, 'critical', ?, 's', ?, ?, ?, ?, ?)`);
      incident.run("whm", "u1", "b1", "queue_retry_exhausted", '{"topic":"paid"}', `["${PI}"]`, "open", seen, seen);
      incident.run("draft", "u1", "b2", "destination_reject", '{"topic":"paid"}', '["pi_3UFwnHLXiybx6Vcz1xyyLQRY"]', "acknowledged", seen, seen);
      incident.run("refund", "u1", "b3", "queue_retry_exhausted", '{"topic":"refund"}', '["pi_3TuYo1Bp3wyQk8MN1xRx0DbM"]', "open", seen, seen);
      incident.run("legacy", "u2", "b4", "destination_reject", null, '["7428630446300"]', "open", seen, seen);
      incident.run("lodgify", "u3", "b5", "destination_reject", null, '["18176557"]', "open", seen, seen);

      const order = db.prepare(`INSERT INTO processed_orders (id, invoice_id, shopify_domain, user_id, source_kind, destination_kind) VALUES (?, ?, ?, ?, ?, ?)`);
      order.run(PI, "270397721", null, "u1", "stripe_connect", "invoicexpress");
      order.run("pi_3UFwnHLXiybx6Vcz1xyyLQRY", "270406664", null, "u1", "stripe_connect", "invoicexpress");
      order.run("pi_3TuYo1Bp3wyQk8MN1xRx0DbM", "270000003", null, "u1", "stripe_connect", "invoicexpress");
      order.run("7428630446300", "269000001", "shop.myshopify.com", "u2", null, null);
      db.prepare(`INSERT INTO connections VALUES ('c1', 'u1', 'stripe_connect', 'invoicexpress', '{"auto_finalize":true}')`).run();
      db.prepare(`INSERT INTO integrations VALUES ('shop.myshopify.com', 'u2', 0)`).run();

      const event = db.prepare(`INSERT INTO document_events (id, external_id, invoice_id, event, detail_json) VALUES (?, ?, ?, ?, ?)`);
      event.run("e1", PI, "270397721", "finalized", null);
      event.run("e2", "pi_3UFwnHLXiybx6Vcz1xyyLQRY", "270406664", "built", null);
      event.run("e3", "pi_3TuYo1Bp3wyQk8MN1xRx0DbM", "270000003", "finalized", null);
      // A credit note from BEFORE the incident is some earlier refund, not this one.
      db.prepare(`INSERT INTO credit_notes VALUES ('u1', 'pyr_old', '270000003', 'issued', ?, ?)`).run("2026-09-01T10:00:00.000Z", "2026-09-01T10:00:00.000Z");

      expect(await resolveIncidentsOnEvidence(env)).toBe(2);
      expect(status(db, "whm")).toBe("resolved");     // invoiced and certified
      expect(status(db, "legacy")).toBe("resolved");  // the shop does not certify
      expect(status(db, "draft")).toBe("acknowledged"); // still a draft on a certifying connection
      expect(status(db, "refund")).toBe("open");      // no credit note since the incident
      expect(status(db, "lodgify")).toBe("open");     // the 24h clock owns it

      // The verify sweep read the draft back as final, and the refund's credit note landed.
      event.run("e4", "pi_3UFwnHLXiybx6Vcz1xyyLQRY", "270406664", "verified", '{"state":"finalized"}');
      db.prepare(`INSERT INTO credit_notes VALUES ('u1', 'pyr_new', '270000003', 'issued', ?, ?)`).run("2026-09-15T14:00:00.000Z", "2026-09-15T14:00:00.000Z");

      expect(await resolveIncidentsOnEvidence(env)).toBe(2);
      expect(status(db, "draft")).toBe("resolved");
      expect(status(db, "refund")).toBe("resolved");
    });
  });

  it("closes on a person's decision or the refund ledger, never on an earlier refund's note", async () => {
    await withDb(async (env, db) => {
      const incident = db.prepare(
        `INSERT INTO incidents (id, user_id, bucket_key, severity, kind, summary, detail_json, affected_ids_json, status, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, 'critical', ?, 's', ?, ?, 'open', ?, ?)`);
      incident.run("notneeded", "u1", "b1", "auto_heal_failed", null, '["pi_3UEruPLRr9ut1iRi0AseOQaa"]', "2026-09-15T04:04:48.118Z", "2026-09-15T04:04:48.118Z");
      incident.run("shopifyrefund", "u2", "b2", "queue_retry_exhausted", '{"topic":"refunds/create"}', '["1228793840001"]', "2026-09-14T14:01:27.902Z", "2026-09-14T14:01:27.902Z");
      incident.run("stillowed", "u2", "b3", "queue_retry_exhausted", '{"topic":"refunds/create"}', '["1228793840002"]', "2026-09-14T14:01:27.902Z", "2026-09-14T14:01:27.902Z");
      // A second refund of the same sale failed at 10:40, after the first refund's note at 10:11.
      incident.run("secondrefund", "u1", "b4", "queue_retry_exhausted", '{"topic":"refund"}', `["${PI}"]`, "2026-09-15T10:05:00.000Z", "2026-09-15T10:40:00.000Z");

      db.prepare(`INSERT INTO reconciliation_decision VALUES ('u:u1', 'pi_3UEruPLRr9ut1iRi0AseOQaa', 'not_needed')`).run();
      db.prepare(`INSERT INTO credit_notes VALUES ('u2', '1228793840001', '268938986', 'issued', ?, ?)`).run("2026-09-15T16:00:00.000Z", "2026-09-15T16:00:00.000Z");
      db.prepare(`INSERT INTO processed_orders (id, invoice_id, user_id, source_kind, destination_kind) VALUES (?, ?, ?, ?, ?)`).run(PI, "270397721", "u1", "stripe_connect", "invoicexpress");
      db.prepare(`INSERT INTO credit_notes VALUES ('u1', 're_first', '270397721', 'issued', ?, ?)`).run("2026-09-15T10:11:00.000Z", "2026-09-15T10:11:00.000Z");

      expect(await resolveIncidentsOnEvidence(env)).toBe(2);
      expect(status(db, "notneeded")).toBe("resolved");
      expect(status(db, "shopifyrefund")).toBe("resolved");
      expect(status(db, "stillowed")).toBe("open");
      expect(status(db, "secondrefund")).toBe("open");
    });
  });

  it("a merged bucket keeps every sale's id, so it cannot close on the first alone", async () => {
    await withDb(async (env, db) => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-15T13:05:00.000Z") });
      const base = { user_id: "u1", severity: "warning" as const, kind: "normalize_fail" as const, summary: "s" };
      await reportIncident(env, { ...base, affected_ids: [PI] });
      await reportIncident(env, { ...base, affected_ids: ["pi_3UFwnHLXiybx6Vcz1xyyLQRY"] });
      await reportIncident(env, { ...base, affected_ids: [PI] });
      await reportIncident(env, { ...base });

      const row = db.prepare("SELECT affected_ids_json, occurrences FROM incidents").get();
      expect(JSON.parse(row.affected_ids_json).sort()).toEqual([PI, "pi_3UFwnHLXiybx6Vcz1xyyLQRY"].sort());
      expect(row.occurrences).toBe(4);
    });
  });
});
