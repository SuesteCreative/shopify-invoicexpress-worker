import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isHiperadmin, isSuperAdmin } from "@/lib/admin";
import { redactConfigJson, FISCAL_CONFIG_KEYS } from "@/lib/redact";

export const runtime = "edge";

/**
 * The per-company fiscal console.
 *
 * GET  — every client, its input→output combinations, and the fiscal settings
 *        behind each one. Secrets never leave the server (see lib/redact).
 * PATCH— four shapes: a legacy boolean flag, the free-text notes, a field on the
 *        legacy `integrations` row, and a merge into a connection's
 *        `destination_config_json`.
 *
 * Every write that changes how documents are issued is recorded in
 * `config_audit`, because the settings this exposes used to require deliberate
 * SQL and some of them decide the VAT on every subsequent invoice.
 */

/** Fiscal columns on the legacy `integrations` row, readable in the console. */
const INTEGRATION_FISCAL_COLUMNS = [
  "vat_included", "auto_finalize", "only_invoice_when_paid", "invoice_zero_total",
  "ix_exemption_reason", "ix_b2b_exemption_reason", "ix_stamp_exemption_note",
  "ix_sequence_name", "ix_document_type", "ix_payment_term",
  "force_tax_rate", "force_shipping_tax_rate", "oss_enabled", "b2b_reverse_charge",
  "ix_retention_enabled", "ix_retention", "custom_invoice_note",
  "pos_mode", "client_sync", "is_paused",
  // Stripe→IX fiscal rework (migration 0037), all default 0.
  "ix_derive_exemption", "ix_adapter_safety_nets", "stripe_tax_from_source",
  "tag_route_by_country", "ix_require_series", "stripe_metadata_map",
  "ix_multicurrency", "stripe_routing_hints",
] as const;

/**
 * Settings that change the VAT or the fiscal identity of every future document.
 *
 * Editable — the operator is the only administrator and editing D1 by hand is
 * not safer than a guarded form — but never by accident: the client must send
 * `confirm: true`, having been told what the field does. `force_tax_rate` is the
 * field behind the Zoo de Lagos incident.
 */
const DANGEROUS_FIELDS = new Set([
  "force_tax_rate", "force_shipping_tax_rate",
  "ix_exemption_reason", "ix_b2b_exemption_reason",
  "oss_enabled", "b2b_reverse_charge", "vat_included",
  "exemption_reason", "default_vat_rate", "moloni_default_tax_id",
  // These three decide what a document declares, not merely how it is produced:
  // which legal exemption is named, what VAT the lines carry, and in which
  // currency the amounts are read.
  "ix_derive_exemption", "stripe_tax_from_source", "ix_multicurrency",
]);

/** Legacy boolean toggles, kept working exactly as before. */
const ALLOWED_FLAGS = [
  "pos_mode", "client_sync", "vat_included", "auto_finalize",
  "webhooks_active", "shopify_authorized", "ix_authorized",
];

const FORCE_FLAGS = ["shopify_authorized", "webhooks_active", "ix_authorized"];

const EDITABLE_INTEGRATION_FIELDS = new Set<string>(INTEGRATION_FISCAL_COLUMNS);
const EDITABLE_CONNECTION_KEYS = new Set<string>(FISCAL_CONFIG_KEYS);

const MAX_NOTES_CHARS = 1500;
/** IX truncates `observations` at 200 and the legal mentions are written first. */
const MAX_CUSTOM_NOTE_CHARS = 200;

async function auditConfigChange(
  db: any,
  entry: { userId: string; actor: string | null; scope: string; field: string; oldValue: unknown; newValue: unknown },
) {
  const str = (v: unknown) => (v == null ? null : String(v).slice(0, 500));
  try {
    await db.prepare(
      `INSERT INTO config_audit (id, user_id, actor, scope, field, old_value, new_value)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), entry.userId, entry.actor, entry.scope, entry.field,
      str(entry.oldValue), str(entry.newValue),
    ).run();
  } catch (e) {
    // The audit must never be the reason a legitimate change fails to save.
    console.warn("[client-rules] audit write failed:", e);
  }
}

export async function GET() {
  const { userId } = await auth();
  if (!userId || !(await isSuperAdmin(userId))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { env } = getRequestContext();
  const db = (env as any).DB;
  if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

  // LEFT JOIN, not INNER: a Moloni- or Stripe-only client has no `integrations`
  // row at all, and the inner join silently hid every one of them from the very
  // console meant to show the whole fleet.
  const usersRows = await db.prepare(`
      SELECT u.id, u.name, u.email, u.company_name, u.admin_label, u.role,
             i.shopify_domain, i.ix_account_name, i.ix_environment,
             i.webhooks_active, i.shopify_authorized, i.ix_authorized,
             i.shopify_forced_at, i.webhooks_forced_at, i.ix_forced_at,
             ${INTEGRATION_FISCAL_COLUMNS.map((c) => `i.${c}`).join(", ")}
        FROM users u
        LEFT JOIN integrations i ON u.id = i.user_id
       ORDER BY COALESCE(NULLIF(u.admin_label, ''), NULLIF(u.company_name, ''), u.name) ASC
  `).all();

  const [connRows, notesRows] = await Promise.all([
    db.prepare(
      `SELECT id, user_id, source_kind, destination_kind, status, destination_config_json, invoice_cutoff
         FROM connections ORDER BY user_id, source_kind`,
    ).all(),
    db.prepare("SELECT user_id, notes, updated_at, updated_by FROM company_rules").all(),
  ]);

  const connectionsByUser = new Map<string, any[]>();
  for (const row of (connRows.results ?? []) as any[]) {
    const { fiscal, present } = redactConfigJson(row.destination_config_json);
    const list = connectionsByUser.get(row.user_id) ?? [];
    list.push({
      id: row.id,
      source_kind: row.source_kind,
      destination_kind: row.destination_kind,
      status: row.status,
      invoice_cutoff: row.invoice_cutoff,
      config: fiscal,
      credentials_present: present,
    });
    connectionsByUser.set(row.user_id, list);
  }

  const notesByUser = new Map<string, any>();
  for (const row of (notesRows.results ?? []) as any[]) notesByUser.set(row.user_id, row);

  const clients = ((usersRows.results ?? []) as any[]).map((u) => {
    const note = notesByUser.get(u.id);
    return {
      ...u,
      // The legacy Shopify→IX pair has no `connections` row; it is implied by
      // the integrations row, so name it explicitly or the console shows a
      // client with credentials and no visible combination.
      has_legacy_integration: !!(u.shopify_domain && u.ix_account_name),
      connections: connectionsByUser.get(u.id) ?? [],
      notes: note?.notes ?? "",
      notes_updated_at: note?.updated_at ?? null,
      notes_updated_by: note?.updated_by ?? null,
    };
  });

  return NextResponse.json(clients);
}

export async function PATCH(request: NextRequest) {
  const { userId } = await auth();
  // Reading is superadmin; changing how a company invoices is hiperadmin.
  if (!userId || !(await isHiperadmin(userId))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json() as {
    targetUserId?: string;
    flag?: string;
    value?: number;
    notes?: string;
    field?: string;
    fieldValue?: unknown;
    connection?: { source_kind?: string; destination_kind?: string };
    patch?: Record<string, unknown>;
    confirm?: boolean;
  };

  const targetUserId = body.targetUserId;
  if (!targetUserId) return NextResponse.json({ error: "targetUserId required" }, { status: 400 });

  const { env } = getRequestContext();
  const db = (env as any).DB;
  if (!db) return NextResponse.json({ error: "Database binding missing" }, { status: 500 });

  // ── Shape 1: the free-text notes ───────────────────────────────────────────
  if (typeof body.notes === "string") {
    const notes = body.notes.slice(0, MAX_NOTES_CHARS);
    await db.prepare(
      `INSERT INTO company_rules (user_id, notes, updated_at, updated_by)
       VALUES (?, ?, CURRENT_TIMESTAMP, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         notes = excluded.notes,
         updated_at = CURRENT_TIMESTAMP,
         updated_by = excluded.updated_by`,
    ).bind(targetUserId, notes, userId).run();
    return NextResponse.json({ success: true });
  }

  // ── Shape 2: a key inside a connection's destination_config_json ───────────
  if (body.connection && body.patch) {
    const { source_kind, destination_kind } = body.connection;
    if (!source_kind || !destination_kind) {
      return NextResponse.json({ error: "connection requires source_kind and destination_kind" }, { status: 400 });
    }

    const keys = Object.keys(body.patch);
    const rejected = keys.filter((k) => !EDITABLE_CONNECTION_KEYS.has(k));
    if (rejected.length > 0) {
      return NextResponse.json({ error: `Not editable: ${rejected.join(", ")}` }, { status: 400 });
    }
    const dangerous = keys.filter((k) => DANGEROUS_FIELDS.has(k));
    if (dangerous.length > 0 && body.confirm !== true) {
      return NextResponse.json(
        { error: "Confirmation required", requires_confirmation: dangerous },
        { status: 409 },
      );
    }

    const row: any = await db.prepare(
      `SELECT destination_config_json FROM connections
        WHERE user_id = ? AND source_kind = ? AND destination_kind = ? LIMIT 1`,
    ).bind(targetUserId, source_kind, destination_kind).first();
    if (!row) return NextResponse.json({ error: "Connection not found" }, { status: 404 });

    // Merge, never replace: the blob holds credentials and keys no UI
    // round-trips, and a partial save must not erase what it cannot see.
    let existing: Record<string, unknown> = {};
    try { existing = row.destination_config_json ? JSON.parse(row.destination_config_json) : {}; } catch { existing = {}; }

    const merged = { ...existing };
    for (const [key, value] of Object.entries(body.patch)) {
      const next = key === "custom_invoice_note" && typeof value === "string"
        ? value.slice(0, MAX_CUSTOM_NOTE_CHARS)
        : value;
      if (next === existing[key]) continue;
      merged[key] = next;
      await auditConfigChange(db, {
        userId: targetUserId, actor: userId,
        scope: `connection:${source_kind}->${destination_kind}`,
        field: key, oldValue: existing[key], newValue: next,
      });
    }

    await db.prepare(
      `UPDATE connections SET destination_config_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND source_kind = ? AND destination_kind = ?`,
    ).bind(JSON.stringify(merged), targetUserId, source_kind, destination_kind).run();

    return NextResponse.json({ success: true });
  }

  // ── Shape 3: a fiscal column on the legacy integrations row ────────────────
  if (typeof body.field === "string") {
    const field = body.field;
    if (!EDITABLE_INTEGRATION_FIELDS.has(field)) {
      return NextResponse.json({ error: "Field not allowed" }, { status: 400 });
    }
    if (DANGEROUS_FIELDS.has(field) && body.confirm !== true) {
      return NextResponse.json(
        { error: "Confirmation required", requires_confirmation: [field] },
        { status: 409 },
      );
    }

    const before: any = await db.prepare(
      `SELECT ${field} AS value FROM integrations WHERE user_id = ?`,
    ).bind(targetUserId).first();
    if (!before) return NextResponse.json({ error: "No integration row for this client" }, { status: 404 });

    let value = body.fieldValue ?? null;
    if (field === "custom_invoice_note" && typeof value === "string") {
      value = value.slice(0, MAX_CUSTOM_NOTE_CHARS);
    }
    // An empty text field means "unset", not the empty string — the builder and
    // the worker both read null as "not configured".
    if (typeof value === "string" && value.trim() === "") value = null;

    await db.prepare(`UPDATE integrations SET ${field} = ? WHERE user_id = ?`)
      .bind(value, targetUserId).run();

    await auditConfigChange(db, {
      userId: targetUserId, actor: userId, scope: "integrations",
      field, oldValue: before.value, newValue: value,
    });

    return NextResponse.json({ success: true });
  }

  // ── Shape 4: the original boolean flags ────────────────────────────────────
  const { flag, value } = body;
  if (!flag || !ALLOWED_FLAGS.includes(flag)) {
    return NextResponse.json({ error: "Flag not allowed" }, { status: 400 });
  }
  if (DANGEROUS_FIELDS.has(flag) && body.confirm !== true) {
    return NextResponse.json(
      { error: "Confirmation required", requires_confirmation: [flag] },
      { status: 409 },
    );
  }

  const before: any = await db.prepare(
    `SELECT ${flag} AS value FROM integrations WHERE user_id = ?`,
  ).bind(targetUserId).first();

  if (FORCE_FLAGS.includes(flag)) {
    const dateFlag = flag.replace("_authorized", "_forced_at").replace("webhooks_active", "webhooks_forced_at");
    if (value === 1) {
      await db.prepare(`UPDATE integrations SET ${flag} = ?, ${dateFlag} = CURRENT_TIMESTAMP WHERE user_id = ?`).bind(value, targetUserId).run();
    } else {
      await db.prepare(`UPDATE integrations SET ${flag} = ?, ${dateFlag} = NULL WHERE user_id = ?`).bind(value, targetUserId).run();
    }
  } else {
    await db.prepare(`UPDATE integrations SET ${flag} = ? WHERE user_id = ?`).bind(value, targetUserId).run();
  }

  await auditConfigChange(db, {
    userId: targetUserId, actor: userId, scope: "integrations",
    field: flag, oldValue: before?.value, newValue: value,
  });

  return NextResponse.json({ success: true });
}
