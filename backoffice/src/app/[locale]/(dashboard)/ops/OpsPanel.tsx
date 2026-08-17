"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Loader2, AlertTriangle, CheckCircle2, Clock, ChevronDown, ChevronRight,
  Activity, ListFilter, RefreshCw, FileSearch, Wrench,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslations } from "next-intl";

/* ────────────────────────────── shapes ────────────────────────────── */

interface Incident {
  id: string;
  user_id: string | null;
  merchant_label: string | null;
  severity: "info" | "warning" | "error" | "critical";
  kind: string;
  summary: string;
  detail_json: string | null;
  affected_ids_json: string | null;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
  occurrences: number;
}

interface DocumentEvent {
  id: string;
  external_id: string;
  invoice_id: string | null;
  event: string;
  label: string;
  severity: string;
  summary: string;
  detail: unknown;
  created_at: string;
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, error: 1, warning: 2, info: 3 };

const severityStyles: Record<string, string> = {
  critical: "text-destructive border-destructive/40",
  error: "text-accent-hot border-hairline",
  warning: "text-soon border-hairline",
  info: "text-fg-40 border-hairline",
};

/* ────────────────────────────── the panel ────────────────────────────── */

export function OpsPanel() {
  const t = useTranslations("ops");

  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [drifts, setDrifts] = useState<DocumentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"open" | "acknowledged" | "all">("open");
  const [kindFilter, setKindFilter] = useState<string>("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [timelines, setTimelines] = useState<Record<string, DocumentEvent[] | "loading" | "error">>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [incRes, driftRes] = await Promise.all([
        fetch(`/api/admin/incidents?status=${statusFilter}&limit=200`),
        fetch("/api/admin/document-drifts?days=7"),
      ]);
      if (!incRes.ok) throw new Error(`incidents: HTTP ${incRes.status}`);
      const incBody = await incRes.json() as { incidents: Incident[] };
      setIncidents(incBody.incidents ?? []);

      // The drift feed is secondary: if the worker is unreachable the incident
      // triage must still render, so this failure is shown but not thrown.
      if (driftRes.ok) {
        const driftBody = await driftRes.json() as { events?: DocumentEvent[] };
        setDrifts(driftBody.events ?? []);
      } else {
        setDrifts([]);
      }
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { void load(); }, [load]);

  const setStatus = async (incident: Incident, status: string) => {
    setBusy(incident.id);
    try {
      const res = await fetch("/api/admin/incidents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: incident.id, status }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setIncidents((prev) => statusFilter === "all"
        ? prev.map((i) => i.id === incident.id ? { ...i, status } : i)
        : prev.filter((i) => i.id !== incident.id));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(null);
    }
  };

  /** A sale's whole story, fetched on demand — one row is rarely the question. */
  const loadTimeline = async (externalId: string) => {
    if (timelines[externalId]) return;
    setTimelines((prev) => ({ ...prev, [externalId]: "loading" }));
    try {
      const res = await fetch(`/api/admin/document-log?external_id=${encodeURIComponent(externalId)}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json() as { events?: DocumentEvent[] };
      setTimelines((prev) => ({ ...prev, [externalId]: body.events ?? [] }));
    } catch {
      setTimelines((prev) => ({ ...prev, [externalId]: "error" }));
    }
  };

  const kinds = useMemo(
    () => Array.from(new Set(incidents.map((i) => i.kind))).sort(),
    [incidents],
  );

  const visible = useMemo(() => {
    const list = kindFilter ? incidents.filter((i) => i.kind === kindFilter) : incidents;
    // Worst first, then most recent: the list is read top-down under time
    // pressure, so ordering is the whole triage.
    return [...list].sort((a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)
      || b.last_seen_at.localeCompare(a.last_seen_at));
  }, [incidents, kindFilter]);

  const parseDetail = (json: string | null): Record<string, unknown> | null => {
    if (!json) return null;
    try { return JSON.parse(json) as Record<string, unknown>; } catch { return null; }
  };

  const affectedOf = (incident: Incident): string[] => {
    try { return JSON.parse(incident.affected_ids_json ?? "[]") as string[]; } catch { return []; }
  };

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-12 h-12 text-accent animate-spin opacity-50" />
      </div>
    );
  }

  const criticalCount = visible.filter((i) => i.severity === "critical").length;

  return (
    <div className="space-y-10 animate-in fade-in duration-1000 slide-in-from-bottom-4">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-8">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <Activity className="w-8 h-8 text-accent" />
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black tracking-tight bg-gradient-to-r from-fg via-fg to-fg-40 bg-clip-text text-transparent">
              {t("title")}
            </h1>
          </div>
          <p className="text-fg-60 font-semibold tracking-wide">
            {criticalCount > 0 ? t("subtitleCritical", { count: criticalCount }) : t("subtitle")}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className="bg-surface-2/50 border border-hairline rounded-2xl px-4 py-3 text-xs font-black uppercase tracking-widest focus:outline-none"
          >
            <option value="open">{t("statusOpen")}</option>
            <option value="acknowledged">{t("statusAcknowledged")}</option>
            <option value="all">{t("statusAll")}</option>
          </select>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
            className="bg-surface-2/50 border border-hairline rounded-2xl px-4 py-3 text-xs font-black uppercase tracking-widest focus:outline-none"
          >
            <option value="">{t("allKinds")}</option>
            {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <button
            onClick={() => void load()}
            className="bg-surface-2/50 border border-hairline rounded-2xl px-5 py-3 text-xs font-black uppercase tracking-widest flex items-center gap-2 hover:bg-surface-2/80 transition-all active:scale-95"
          >
            <RefreshCw className="w-4 h-4 text-accent" /> {t("refresh")}
          </button>
        </div>
      </div>

      {error && (
        <div className="glass rounded-2xl border border-destructive/40 p-4 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
          <p className="text-sm text-fg break-words">{error}</p>
        </div>
      )}

      {/* ── Incident triage ─────────────────────────────────────────────── */}
      <section className="space-y-4">
        <h2 className="text-xs font-black uppercase tracking-widest text-fg-40 flex items-center gap-2">
          <ListFilter className="w-3 h-3 text-accent" /> {t("incidentsTitle", { count: visible.length })}
        </h2>

        <AnimatePresence mode="popLayout">
          {visible.map((incident) => {
            const open = expanded.has(incident.id);
            const detail = parseDetail(incident.detail_json);
            const affected = affectedOf(incident);
            return (
              <motion.div
                key={incident.id} layout
                initial={{ opacity: 0, scale: 0.99 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.99 }}
                className="glass rounded-3xl p-5 sm:p-6 border-hairline"
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <button
                    onClick={() => setExpanded((prev) => {
                      const n = new Set(prev);
                      if (n.has(incident.id)) n.delete(incident.id); else n.add(incident.id);
                      return n;
                    })}
                    className="flex-1 min-w-0 text-left"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      {open ? <ChevronDown className="w-4 h-4 text-accent shrink-0" /> : <ChevronRight className="w-4 h-4 text-fg-40 shrink-0" />}
                      <span className={`text-[10px] font-black uppercase tracking-widest border rounded px-2 py-0.5 ${severityStyles[incident.severity] ?? severityStyles.info}`}>
                        {incident.severity}
                      </span>
                      <span className="text-[10px] font-black uppercase tracking-widest text-fg-40">{incident.kind}</span>
                      {incident.merchant_label && (
                        <span className="text-[10px] font-black uppercase tracking-widest text-accent">{incident.merchant_label}</span>
                      )}
                      {incident.occurrences > 1 && (
                        <span className="text-[10px] font-bold text-fg-40">×{incident.occurrences}</span>
                      )}
                    </div>
                    <p className="text-sm font-semibold mt-2 break-words pl-6">{incident.summary}</p>
                    <p className="text-[10px] text-fg-40 mt-1 pl-6 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {new Date(incident.last_seen_at).toLocaleString("pt-PT")}
                    </p>
                  </button>

                  <div className="flex items-center gap-2 shrink-0">
                    {busy === incident.id && <Loader2 className="w-4 h-4 animate-spin text-fg-40" />}
                    {incident.status === "open" && (
                      <button
                        onClick={() => void setStatus(incident, "acknowledged")}
                        className="rounded-xl border border-hairline px-3 py-2 text-[10px] font-black uppercase tracking-widest hover:bg-surface-2/80 transition-all"
                      >
                        {t("acknowledge")}
                      </button>
                    )}
                    <button
                      onClick={() => void setStatus(incident, "resolved")}
                      className="rounded-xl border border-hairline px-3 py-2 text-[10px] font-black uppercase tracking-widest hover:bg-surface-2/80 transition-all flex items-center gap-1"
                    >
                      <CheckCircle2 className="w-3 h-3 text-accent" /> {t("resolve")}
                    </button>
                  </div>
                </div>

                {open && (
                  <div className="mt-5 space-y-4 pl-6">
                    {/* What the destination actually said. */}
                    {Boolean(detail?.message || detail?.http_status) && (
                      <div className="rounded-2xl border border-hairline bg-surface-2/30 p-4">
                        <p className="text-[10px] font-black uppercase tracking-widest text-fg-40 mb-2">
                          {t("destinationSaid")}
                          {typeof detail?.http_status === "number" && (
                            <span className="ml-2 text-accent-hot">HTTP {detail.http_status}</span>
                          )}
                        </p>
                        <pre className="text-[11px] text-fg whitespace-pre-wrap break-words font-mono">
                          {String(detail?.message ?? "")}
                        </pre>
                      </div>
                    )}

                    {detail && (
                      <details className="rounded-2xl border border-hairline bg-surface-2/30 p-4">
                        <summary className="text-[10px] font-black uppercase tracking-widest text-fg-40 cursor-pointer">
                          {t("technicalDetail")}
                        </summary>
                        <pre className="text-[10px] text-fg-60 whitespace-pre-wrap break-words font-mono mt-3 max-h-72 overflow-auto">
                          {JSON.stringify(detail, null, 2)}
                        </pre>
                      </details>
                    )}

                    {affected.length > 0 && (
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-fg-40 mb-2">
                          {t("affected", { count: affected.length })}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {affected.slice(0, 25).map((id) => (
                            <button
                              key={id}
                              onClick={() => void loadTimeline(id)}
                              className="rounded-lg border border-hairline bg-surface-2/50 px-2 py-1 text-[10px] font-bold hover:bg-surface-2/80 transition-all flex items-center gap-1"
                            >
                              <FileSearch className="w-3 h-3 text-accent" /> {id}
                            </button>
                          ))}
                          {affected.length > 25 && (
                            <span className="text-[10px] text-fg-40 font-bold self-center">
                              {t("andMore", { count: affected.length - 25 })}
                            </span>
                          )}
                        </div>

                        {affected.slice(0, 25).map((id) => {
                          const tl = timelines[id];
                          if (!tl) return null;
                          return (
                            <div key={`tl-${id}`} className="mt-3 rounded-2xl border border-hairline bg-surface-2/30 p-4">
                              <p className="text-[10px] font-black uppercase tracking-widest text-fg-40 mb-2">
                                {t("timelineFor", { id })}
                              </p>
                              {tl === "loading" && <Loader2 className="w-3 h-3 animate-spin text-fg-40" />}
                              {tl === "error" && <p className="text-[11px] text-destructive">{t("timelineError")}</p>}
                              {Array.isArray(tl) && tl.length === 0 && (
                                <p className="text-[11px] text-fg-40">{t("timelineEmpty")}</p>
                              )}
                              {Array.isArray(tl) && tl.map((ev) => (
                                <div key={ev.id} className="py-2 border-b border-hairline last:border-0">
                                  <p className="text-[10px] font-black uppercase tracking-widest text-fg-40">
                                    {ev.label} · {new Date(ev.created_at).toLocaleString("pt-PT")}
                                  </p>
                                  <p className="text-[11px] text-fg mt-0.5 break-words">{ev.summary}</p>
                                </div>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {incident.user_id && (
                      <a
                        href={`/superadmin/users/${incident.user_id}/dev-mode`}
                        className="inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-accent hover:underline"
                      >
                        <Wrench className="w-3 h-3" /> {t("openDevMode")}
                      </a>
                    )}
                  </div>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>

        {visible.length === 0 && (
          <div className="text-center py-14 text-fg-40 font-bold text-sm flex flex-col items-center gap-2">
            <CheckCircle2 className="w-8 h-8 text-accent opacity-60" />
            {t("noIncidents")}
          </div>
        )}
      </section>

      {/* ── Drifts and refusals ─────────────────────────────────────────── */}
      <section className="space-y-4">
        <h2 className="text-xs font-black uppercase tracking-widest text-fg-40 flex items-center gap-2">
          <FileSearch className="w-3 h-3 text-accent-hot" /> {t("driftsTitle", { count: drifts.length })}
        </h2>
        <p className="text-[11px] text-fg-40">{t("driftsHelp")}</p>

        <div className="glass rounded-3xl border-hairline divide-y divide-hairline">
          {drifts.slice(0, 100).map((ev) => (
            <div key={ev.id} className="p-4">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-[10px] font-black uppercase tracking-widest border rounded px-2 py-0.5 ${severityStyles[ev.severity] ?? severityStyles.info}`}>
                  {ev.label}
                </span>
                <button
                  onClick={() => void loadTimeline(ev.external_id)}
                  className="text-[10px] font-black uppercase tracking-widest text-accent hover:underline"
                >
                  {ev.external_id}
                </button>
                <span className="text-[10px] text-fg-40 font-bold">
                  {new Date(ev.created_at).toLocaleString("pt-PT")}
                </span>
              </div>
              <p className="text-[11px] text-fg mt-1 break-words">{ev.summary}</p>
              {(() => {
                const tl = timelines[ev.external_id];
                if (!Array.isArray(tl)) return null;
                return (
                  <div className="mt-2 pl-3 border-l border-hairline">
                    {tl.map((e) => (
                      <p key={e.id} className="text-[10px] text-fg-40 py-0.5">
                        <span className="font-black uppercase tracking-widest">{e.label}</span> · {e.summary}
                      </p>
                    ))}
                  </div>
                );
              })()}
            </div>
          ))}
          {drifts.length === 0 && (
            <div className="p-10 text-center text-fg-40 font-bold text-sm">{t("noDrifts")}</div>
          )}
        </div>
      </section>
    </div>
  );
}
