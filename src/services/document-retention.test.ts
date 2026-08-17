import { describe, it, expect } from "vitest";
import {
  RETENTION_TIER,
  ROUTINE_RETENTION_DAYS,
  EVIDENCE_RETENTION_DAYS,
  documentEventPurgeSql,
  isEventExpired,
  type DocumentEventKind,
} from "./document-log";

/**
 * The purge deletes rows, so the rule that decides which ones had better be
 * right. It is written twice — once as SQL for the cron, once in TypeScript —
 * and two expressions of one rule drift apart; the way you normally find out is
 * in production, with the rows already gone.
 *
 * So the SQL is run for real here, against the same fixtures the TypeScript rule
 * judges, and the two are held to the same answer.
 */

const ymd = (daysAgo: number) => {
  const d = new Date("2026-08-15T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString();
};

// Both timestamp shapes the column actually holds: the schema default writes
// "2026-08-14 12:00:00", the code writes ISO. They sort differently at position
// 11 (`T` > space), which is why the SQL compares dates only.
const spaceForm = (iso: string) => iso.replace("T", " ").replace(/\.\d+Z$/, "");

const FIXTURES: Array<{ id: string; event: DocumentEventKind; created_at: string }> = [
  { id: "verified_fresh", event: "verified", created_at: ymd(10) },
  { id: "verified_old", event: "verified", created_at: ymd(120) },
  { id: "verified_boundary_in", event: "verified", created_at: ymd(89) },
  { id: "verified_boundary_out", event: "verified", created_at: ymd(91) },
  // The space-separated form on an expired row must be deleted too.
  { id: "skipped_old_spaceform", event: "skipped", created_at: spaceForm(ymd(200)) },
  { id: "created_old", event: "created", created_at: ymd(100) },
  // Evidence survives far longer than routine.
  { id: "drift_at_120d", event: "drift", created_at: ymd(120) },
  { id: "drift_ancient", event: "drift", created_at: ymd(400) },
  { id: "create_failed_at_200d", event: "create_failed", created_at: ymd(200) },
  { id: "held_ancient", event: "held", created_at: ymd(400) },
];

describe("retention tiers", () => {
  it("classifies every event kind — an unclassified one could never be purged", () => {
    // The Record is exhaustive by type, but assert it at runtime too: a kind
    // added with a `// @ts-expect-error` or through a cast would otherwise grow
    // the table for ever.
    const kinds: DocumentEventKind[] = [
      "built", "create_failed", "created", "held", "finalized", "emailed",
      "verified", "drift", "drift_lead", "verify_failed", "credit_issued", "reissued", "skipped",
    ];
    for (const k of kinds) expect(RETENTION_TIER[k]).toBeDefined();
  });

  it("keeps evidence far longer than routine", () => {
    expect(EVIDENCE_RETENTION_DAYS).toBeGreaterThan(ROUTINE_RETENTION_DAYS);
    expect(RETENTION_TIER.drift).toBe("evidence");
    expect(RETENTION_TIER.create_failed).toBe("evidence");
    expect(RETENTION_TIER.verified).toBe("routine");
    // An unconfirmed lead does not enjoy the evidence window: it is confirmed
    // into a `drift` or it ages out with the routine tier.
    expect(RETENTION_TIER.drift_lead).toBe("routine");
  });

  it("does not expire a drift at an age that expires a verified", () => {
    expect(isEventExpired("verified", ymd(120), "2026-08-15")).toBe(true);
    expect(isEventExpired("drift", ymd(120), "2026-08-15")).toBe(false);
  });

  it("treats both timestamp formats the same", () => {
    const iso = ymd(200);
    expect(isEventExpired("skipped", iso, "2026-08-15"))
      .toBe(isEventExpired("skipped", spaceForm(iso), "2026-08-15"));
  });
});

describe("the purge SQL agrees with the TypeScript rule", () => {
  async function withDb(fn: (deleteAndList: (tier: "routine" | "evidence") => string[]) => void) {
    let DatabaseSync: any;
    try {
      // Specifier in a variable: this project typechecks against
      // @cloudflare/workers-types, which has no node:sqlite declarations, so a
      // literal import fails tsc even though the test runs under Node.
      const nodeSqlite = "node:sqlite";
      ({ DatabaseSync } = await import(nodeSqlite));
    } catch {
      console.warn("node:sqlite unavailable; skipping SQL/TS agreement check");
      return;
    }
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE document_events (
      id TEXT PRIMARY KEY, external_id TEXT, event TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
    const ins = db.prepare("INSERT INTO document_events (id, external_id, event, created_at) VALUES (?,?,?,?)");
    for (const f of FIXTURES) ins.run(f.id, "sale-1", f.event, f.created_at);

    fn((tier) => {
      db.exec(documentEventPurgeSql(tier));
      return (db.prepare("SELECT id FROM document_events ORDER BY id").all() as Array<{ id: string }>)
        .map((r) => r.id);
    });
    db.close();
  }

  it("deletes exactly the rows the TypeScript rule calls expired", async () => {
    await withDb((deleteAndList) => {
      deleteAndList("routine");
      const survivors = deleteAndList("evidence");
      // `date('now')` inside the SQL means the test must ask the TS side about
      // today too, rather than freezing a date the SQL does not share.
      const today = new Date().toISOString().slice(0, 10);
      const expected = FIXTURES
        .filter((f) => !isEventExpired(f.event, f.created_at, today))
        .map((f) => f.id)
        .sort();
      expect(survivors).toEqual(expected);
    });
  });

  it("never deletes anything still inside its window", async () => {
    await withDb((deleteAndList) => {
      deleteAndList("routine");
      const survivors = deleteAndList("evidence");
      expect(survivors).toContain("verified_fresh");
      expect(survivors).toContain("drift_at_120d");
      expect(survivors).not.toContain("verified_old");
      // The one that would survive a naive `datetime()` comparison.
      expect(survivors).not.toContain("skipped_old_spaceform");
    });
  });
});
