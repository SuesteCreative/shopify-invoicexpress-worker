"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Loader2, Settings2, Store, FileText, ToggleLeft, ToggleRight, AlertTriangle,
  Search, ChevronDown, ChevronRight, Save, ShieldAlert, NotebookPen, Link2,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslations } from "next-intl";

/* ────────────────────────────── shapes ────────────────────────────── */

interface Connection {
  id: string;
  source_kind: string;
  destination_kind: string;
  status: string;
  invoice_cutoff: string | null;
  config: Record<string, unknown>;
  credentials_present: Record<string, boolean>;
}

interface Client {
  id: string;
  name: string;
  email: string;
  company_name: string | null;
  admin_label: string | null;
  role: string | null;
  shopify_domain: string | null;
  ix_account_name: string | null;
  has_legacy_integration: boolean;
  connections: Connection[];
  notes: string;
  notes_updated_at: string | null;
  [key: string]: unknown;
}

type FieldKind = "bool" | "text" | "number" | "select";

interface FieldDef {
  key: string;
  kind: FieldKind;
  /** i18n key suffix under clientRules.fields.* */
  i18n: string;
  options?: string[];
  dangerous?: boolean;
  maxLength?: number;
}

/* ──────────────────────────── field metadata ───────────────────────────
 *
 * Labels are deliberately literal about what each setting DOES, because the
 * same name means different things in the two config homes. `vat_included` on
 * the legacy row is only one of seven preconditions for B2B reverse charge — it
 * does NOT decide whether IX documents are issued VAT-inclusive; that comes from
 * Shopify's own `taxes_included` and the per-SKU overrides. On a Moloni or
 * Vendus connection the same key IS the tax-inclusion switch. A console that
 * blurred the two would be a faster way to make the exact mistake it exists to
 * prevent.
 */

/**
 * The migration-0037 switches, all default off. Listed once and rendered in
 * both scopes: a Stripe→IX client keeps its IX credentials on the legacy row
 * but has no `shopify_domain`, so the console hides the legacy section for it
 * and the connection blob is the only place it can be configured from.
 */
const STRIPE_IX_FISCAL_FIELDS: FieldDef[] = [
  { key: "ix_derive_exemption", kind: "bool", i18n: "ixDeriveExemption", dangerous: true },
  { key: "ix_adapter_safety_nets", kind: "bool", i18n: "ixAdapterSafetyNets" },
  { key: "stripe_tax_from_source", kind: "bool", i18n: "stripeTaxFromSource", dangerous: true },
  { key: "tag_route_by_country", kind: "bool", i18n: "tagRouteByCountry" },
  { key: "ix_require_series", kind: "bool", i18n: "ixRequireSeries" },
  { key: "stripe_routing_hints", kind: "bool", i18n: "stripeRoutingHints" },
  { key: "ix_multicurrency", kind: "bool", i18n: "ixMulticurrency", dangerous: true },
];

const LEGACY_FIELDS: FieldDef[] = [
  { key: "custom_invoice_note", kind: "text", i18n: "customInvoiceNote", maxLength: 200 },
  { key: "ix_sequence_name", kind: "text", i18n: "ixSequenceName" },
  { key: "ix_document_type", kind: "select", i18n: "ixDocumentType", options: ["invoice", "invoice_receipt"] },
  { key: "ix_exemption_reason", kind: "text", i18n: "ixExemptionReason", dangerous: true },
  { key: "ix_b2b_exemption_reason", kind: "text", i18n: "ixB2bExemptionReason", dangerous: true },
  { key: "ix_stamp_exemption_note", kind: "bool", i18n: "ixStampExemptionNote" },
  { key: "ix_payment_term", kind: "number", i18n: "ixPaymentTerm" },
  { key: "auto_finalize", kind: "bool", i18n: "autoFinalize" },
  { key: "only_invoice_when_paid", kind: "bool", i18n: "onlyInvoiceWhenPaid" },
  { key: "invoice_zero_total", kind: "bool", i18n: "invoiceZeroTotal" },
  { key: "pos_mode", kind: "bool", i18n: "posMode" },
  { key: "client_sync", kind: "bool", i18n: "clientSync" },
  { key: "ix_retention_enabled", kind: "bool", i18n: "ixRetentionEnabled" },
  { key: "ix_retention", kind: "number", i18n: "ixRetention" },
  { key: "vat_included", kind: "bool", i18n: "vatIncludedLegacy", dangerous: true },
  { key: "oss_enabled", kind: "bool", i18n: "ossEnabled", dangerous: true },
  { key: "b2b_reverse_charge", kind: "bool", i18n: "b2bReverseCharge", dangerous: true },
  { key: "force_tax_rate", kind: "number", i18n: "forceTaxRate", dangerous: true },
  { key: "force_shipping_tax_rate", kind: "number", i18n: "forceShippingTaxRate", dangerous: true },
  ...STRIPE_IX_FISCAL_FIELDS,
];

const CONNECTION_FIELDS: Record<string, FieldDef[]> = {
  common: [
    { key: "custom_invoice_note", kind: "text", i18n: "customInvoiceNote", maxLength: 200 },
    { key: "vat_included", kind: "bool", i18n: "vatIncludedConnection", dangerous: true },
    { key: "auto_finalize", kind: "bool", i18n: "autoFinalize" },
    { key: "send_email", kind: "bool", i18n: "sendEmail" },
    { key: "exemption_reason", kind: "text", i18n: "exemptionReason", dangerous: true },
    { key: "default_vat_rate", kind: "number", i18n: "defaultVatRate", dangerous: true },
  ],
  // Scoped to the destination that produces the documents these switches
  // change, rather than to `common`, so a Moloni or Vendus connection is not
  // offered settings that mean nothing to it.
  invoicexpress: STRIPE_IX_FISCAL_FIELDS,
  moloni: [
    { key: "moloni_document_set_name", kind: "text", i18n: "moloniDocumentSet" },
    { key: "moloni_document_type", kind: "select", i18n: "moloniDocumentType", options: ["invoice", "invoice_receipt", "simplified_invoice"] },
    { key: "moloni_default_tax_id", kind: "number", i18n: "moloniDefaultTaxId", dangerous: true },
    { key: "moloni_category_id", kind: "number", i18n: "moloniCategoryId" },
    { key: "moloni_maturity_date_id", kind: "number", i18n: "moloniMaturityDateId" },
    { key: "moloni_payment_method", kind: "text", i18n: "moloniPaymentMethod" },
    { key: "moloni_partial_invoicing", kind: "bool", i18n: "moloniPartialInvoicing" },
    { key: "moloni_partial_mode", kind: "select", i18n: "moloniPartialMode", options: ["off", "instalment_invoices", "invoice_plus_receipts"] },
    { key: "moloni_receipt_document_set_name", kind: "text", i18n: "moloniReceiptDocumentSet" },
    { key: "moloni_receipt_series_map", kind: "text", i18n: "moloniReceiptSeriesMap" },
  ],
  vendus: [
    { key: "vendus_register_id", kind: "number", i18n: "vendusRegisterId" },
    { key: "vendus_series_id", kind: "number", i18n: "vendusSeriesId" },
  ],
  lodgify: [
    { key: "lodgify_extras_vat_rate", kind: "number", i18n: "lodgifyExtrasVatRate" },
    { key: "lodgify_ota_invoice_on", kind: "select", i18n: "lodgifyOtaInvoiceOn", options: ["arrival", "departure"] },
  ],
};

/* ───────────────────────────── primitives ───────────────────────────── */

const Toggle = ({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) => (
  <button onClick={() => !disabled && onChange(!value)} disabled={disabled} className="shrink-0 disabled:opacity-40">
    {value ? <ToggleRight className="w-8 h-8 text-accent-hot" /> : <ToggleLeft className="w-8 h-8 text-fg-40" />}
  </button>
);

const inputCls =
  "bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 text-sm font-medium w-full "
  + "focus:outline-none focus:ring-2 focus:ring-[rgba(2,141,196,0.20)] focus:border-[rgba(2,141,196,0.40)] transition-all";

/* ────────────────────────────── the panel ────────────────────────────── */

export function ClientRulesPanel() {
  const t = useTranslations("clientRules");
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/client-rules");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setClients(await res.json() as Client[]);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const label = (c: Client) => c.admin_label || c.company_name || c.name || c.email;

  /**
   * One PATCH for every shape. A 409 means the server refused a fiscally
   * dangerous edit without an explicit confirmation — so ask, then repeat the
   * request. The confirmation text names the blast radius rather than asking
   * "are you sure?", which nobody reads.
   */
  const patch = async (savingKey: string, payload: Record<string, unknown>, confirmText?: string) => {
    setSaving(savingKey);
    setError(null);
    try {
      let res = await fetch("/api/admin/client-rules", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.status === 409) {
        if (!window.confirm(confirmText ?? t("dangerousConfirmGeneric"))) return false;
        res = await fetch("/api/admin/client-rules", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, confirm: true }),
        });
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return true;
    } catch (e) {
      setError(String((e as Error).message ?? e));
      return false;
    } finally {
      setSaving(null);
    }
  };

  const draftKey = (clientId: string, scope: string, key: string) => `${clientId}|${scope}|${key}`;

  const saveLegacyField = async (client: Client, def: FieldDef, value: unknown) => {
    const ok = await patch(
      draftKey(client.id, "legacy", def.key),
      { targetUserId: client.id, field: def.key, fieldValue: value },
      def.dangerous ? t("dangerousConfirm", { field: t(`fields.${def.i18n}.label`), client: label(client) }) : undefined,
    );
    if (ok) setClients((prev) => prev.map((c) => c.id === client.id ? { ...c, [def.key]: value } : c));
  };

  const saveConnectionField = async (client: Client, conn: Connection, def: FieldDef, value: unknown) => {
    const ok = await patch(
      draftKey(client.id, `${conn.source_kind}-${conn.destination_kind}`, def.key),
      {
        targetUserId: client.id,
        connection: { source_kind: conn.source_kind, destination_kind: conn.destination_kind },
        patch: { [def.key]: value },
      },
      def.dangerous ? t("dangerousConfirm", { field: t(`fields.${def.i18n}.label`), client: label(client) }) : undefined,
    );
    if (ok) {
      setClients((prev) => prev.map((c) => c.id !== client.id ? c : {
        ...c,
        connections: c.connections.map((k) => k.id === conn.id ? { ...k, config: { ...k.config, [def.key]: value } } : k),
      }));
    }
  };

  const saveNotes = async (client: Client, notes: string) => {
    const ok = await patch(draftKey(client.id, "notes", "notes"), { targetUserId: client.id, notes });
    if (ok) setClients((prev) => prev.map((c) => c.id === client.id ? { ...c, notes } : c));
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter((c) =>
      [label(c), c.email, c.shopify_domain, c.ix_account_name,
        ...c.connections.map((k) => `${k.source_kind} ${k.destination_kind}`)]
        .filter(Boolean).some((s) => String(s).toLowerCase().includes(q)));
  }, [clients, search]);

  /* ─────────────────────────── field renderer ─────────────────────────── */

  const renderField = (
    client: Client, def: FieldDef, current: unknown, scope: string,
    onSave: (value: unknown) => void,
  ) => {
    const dk = draftKey(client.id, scope, def.key);
    const busy = saving === dk;
    const help = t(`fields.${def.i18n}.help`);

    return (
      <div key={dk} className="py-3 border-b border-hairline last:border-0">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-fg flex items-center gap-2 flex-wrap">
              {t(`fields.${def.i18n}.label`)}
              {def.dangerous && (
                <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-soon border border-hairline rounded px-1.5 py-0.5">
                  <ShieldAlert className="w-2.5 h-2.5" />{t("dangerousBadge")}
                </span>
              )}
            </p>
            <p className="text-[11px] text-fg-40 mt-0.5">{help}</p>
          </div>

          {def.kind === "bool" && (
            <div className="flex items-center gap-2">
              {busy && <Loader2 className="w-3 h-3 animate-spin text-fg-40" />}
              {/* The two config homes disagree on how a boolean is stored: the
                  legacy row holds SQLite 0/1 integers, a connection's JSON blob
                  holds real booleans. Writing the wrong one reads back as unset. */}
              <Toggle value={current === 1 || current === true} disabled={busy}
                onChange={(v) => onSave(scope === "legacy" ? (v ? 1 : 0) : v)} />
            </div>
          )}
        </div>

        {def.kind !== "bool" && (
          <div className="flex items-center gap-2 mt-2">
            {def.kind === "select" ? (
              <select
                className={inputCls} disabled={busy}
                value={String(current ?? "")}
                onChange={(e) => onSave(e.target.value || null)}
              >
                <option value="">{t("notSet")}</option>
                {def.options?.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <>
                <input
                  className={inputCls}
                  type={def.kind === "number" ? "number" : "text"}
                  maxLength={def.maxLength}
                  disabled={busy}
                  value={String(drafts[dk] ?? current ?? "")}
                  onChange={(e) => setDrafts((d) => ({ ...d, [dk]: e.target.value }))}
                  placeholder={t("notSet")}
                />
                <button
                  onClick={() => {
                    const raw = drafts[dk];
                    if (raw === undefined) return;
                    const value = def.kind === "number"
                      ? (String(raw).trim() === "" ? null : Number(raw))
                      : raw;
                    onSave(value);
                    setDrafts((d) => { const n = { ...d }; delete n[dk]; return n; });
                  }}
                  disabled={busy || drafts[dk] === undefined}
                  className="shrink-0 rounded-xl border border-hairline px-3 py-2 text-xs font-black uppercase tracking-widest disabled:opacity-30 hover:bg-surface-2/80 transition-all"
                >
                  {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                </button>
              </>
            )}
            {def.maxLength && (
              <span className="shrink-0 text-[10px] text-fg-40 font-bold tabular-nums">
                {String(drafts[dk] ?? current ?? "").length}/{def.maxLength}
              </span>
            )}
          </div>
        )}
      </div>
    );
  };

  /* ────────────────────────────── render ────────────────────────────── */

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-12 h-12 text-accent animate-spin opacity-50" />
      </div>
    );
  }

  return (
    <div className="space-y-10 animate-in fade-in duration-1000 slide-in-from-bottom-4">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-8">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <Settings2 className="w-8 h-8 text-accent" />
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black tracking-tight bg-gradient-to-r from-fg via-fg to-fg-40 bg-clip-text text-transparent">
              {t("title")}
            </h1>
          </div>
          <p className="text-fg-60 font-semibold tracking-wide">{t("subtitle")}</p>
        </div>
        <div className="relative group">
          <Search className="w-4 h-4 text-fg-40 absolute left-4 top-1/2 -translate-y-1/2 group-focus-within:text-accent transition-colors" />
          <input
            type="text" placeholder={t("searchPlaceholder")}
            value={search} onChange={(e) => setSearch(e.target.value)}
            className="bg-surface-2/50 border border-hairline rounded-2xl py-3 pl-12 pr-6 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-[rgba(2,141,196,0.20)] focus:border-[rgba(2,141,196,0.40)] w-full lg:w-80 transition-all"
          />
        </div>
      </div>

      {error && (
        <div className="glass rounded-2xl border border-destructive/40 p-4 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
          <p className="text-sm text-fg break-words">{error}</p>
        </div>
      )}

      <div className="grid gap-6">
        <AnimatePresence mode="popLayout">
          {filtered.map((client) => {
            const open = expanded.has(client.id);
            return (
              <motion.div
                key={client.id} layout
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                className="glass rounded-[2rem] p-5 sm:p-8 border-hairline hover:border-rule transition-all"
              >
                <button
                  onClick={() => setExpanded((prev) => {
                    const n = new Set(prev);
                    if (n.has(client.id)) n.delete(client.id); else n.add(client.id);
                    return n;
                  })}
                  className="w-full flex flex-col gap-4 md:flex-row md:items-start md:justify-between text-left"
                >
                  <div className="min-w-0">
                    <h2 className="text-xl font-bold break-words flex items-center gap-2">
                      {open ? <ChevronDown className="w-4 h-4 text-accent shrink-0" /> : <ChevronRight className="w-4 h-4 text-fg-40 shrink-0" />}
                      {label(client)}
                    </h2>
                    <p className="text-fg-40 text-sm break-words pl-6">{client.email}</p>
                    <div className="flex items-center gap-2 mt-3 flex-wrap pl-6">
                      {client.has_legacy_integration && (
                        <span className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest bg-surface-2/50 px-2 py-1 rounded-lg border border-hairline">
                          <Store className="w-3 h-3 text-accent-hot" /> shopify → invoicexpress
                        </span>
                      )}
                      {client.connections.map((k) => (
                        <span key={k.id} className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest bg-surface-2/50 px-2 py-1 rounded-lg border border-hairline">
                          <Link2 className="w-3 h-3 text-accent" /> {k.source_kind} → {k.destination_kind}
                          {k.status !== "active" && <span className="text-soon">({k.status})</span>}
                        </span>
                      ))}
                      {!client.has_legacy_integration && client.connections.length === 0 && (
                        <span className="text-[10px] font-bold uppercase tracking-widest text-fg-40">{t("noIntegrations")}</span>
                      )}
                    </div>
                  </div>
                  {client.notes && (
                    <span className="shrink-0 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-accent">
                      <NotebookPen className="w-3 h-3" /> {t("hasNotes")}
                    </span>
                  )}
                </button>

                {open && (
                  <div className="mt-8 space-y-8">
                    {/* Operator notes — context for diagnosis, never enforced. */}
                    <section>
                      <h3 className="text-xs font-black uppercase tracking-widest text-fg-40 mb-2 flex items-center gap-2">
                        <NotebookPen className="w-3 h-3 text-accent" /> {t("notesTitle")}
                      </h3>
                      <p className="text-[11px] text-fg-40 mb-3">{t("notesHelp")}</p>
                      <textarea
                        className={`${inputCls} min-h-[120px] font-normal`}
                        maxLength={1500}
                        defaultValue={client.notes}
                        onBlur={(e) => { if (e.target.value !== client.notes) void saveNotes(client, e.target.value); }}
                        placeholder={t("notesPlaceholder")}
                      />
                      <p className="text-[10px] text-fg-40 mt-1">{t("notesPrivacy")}</p>
                    </section>

                    {/* Legacy Shopify→IX settings */}
                    {client.has_legacy_integration && (
                      <section>
                        <h3 className="text-xs font-black uppercase tracking-widest text-fg-40 mb-1 flex items-center gap-2">
                          <FileText className="w-3 h-3 text-accent-hot" /> shopify → invoicexpress
                          {client.ix_account_name && <span className="text-fg-40 normal-case tracking-normal font-medium">({String(client.ix_account_name)})</span>}
                        </h3>
                        <p className="text-[11px] text-fg-40 mb-3">{t("legacyTaxInclusionNote")}</p>
                        <div>
                          {LEGACY_FIELDS.map((def) =>
                            renderField(client, def, client[def.key], "legacy",
                              (value) => void saveLegacyField(client, def, value)))}
                        </div>
                      </section>
                    )}

                    {/* One section per connection */}
                    {client.connections.map((conn) => {
                      const defs = [
                        ...CONNECTION_FIELDS.common,
                        ...(CONNECTION_FIELDS[conn.destination_kind] ?? []),
                        ...(conn.source_kind === "lodgify" ? CONNECTION_FIELDS.lodgify : []),
                      ];
                      return (
                        <section key={conn.id}>
                          <h3 className="text-xs font-black uppercase tracking-widest text-fg-40 mb-3 flex items-center gap-2">
                            <Link2 className="w-3 h-3 text-accent" /> {conn.source_kind} → {conn.destination_kind}
                          </h3>
                          <div>
                            {defs.map((def) =>
                              renderField(client, def, conn.config[def.key], `${conn.source_kind}-${conn.destination_kind}`,
                                (value) => void saveConnectionField(client, conn, def, value)))}
                          </div>
                        </section>
                      );
                    })}
                  </div>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>

        {filtered.length === 0 && (
          <div className="text-center py-10 sm:py-20 text-fg-40 font-bold text-sm">{t("emptyList")}</div>
        )}
      </div>
    </div>
  );
}
