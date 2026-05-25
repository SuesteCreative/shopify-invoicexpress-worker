"use client";

export const runtime = "edge";

import { useState, useEffect } from "react";
import { Activity, ClipboardList, Settings2, BookOpen, Plus, Store, Zap, ArrowRight, ExternalLink, FileText, ScrollText, Inbox } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useUser } from "@clerk/nextjs";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

import { RegistrationForm } from "@/components/RegistrationForm";

export default function WelcomeDashboard() {
  const t = useTranslations("dashboardHome");
  const { user: clerkUser } = useUser();
  const [dbUserName, setDbUserName] = useState("");
  const firstName = (dbUserName || clerkUser?.firstName || clerkUser?.fullName || "").split(" ")[0];
  const [loading, setLoading] = useState(true);
  const [integrationStatus, setIntegrationStatus] = useState<any>(null);
  const [isRegistered, setIsRegistered] = useState<boolean | null>(null);
  const [recentInvoices, setRecentInvoices] = useState<any[] | null>(null);
  const [recentLogs, setRecentLogs] = useState<any[] | null>(null);

  useEffect(() => {
    fetch("/api/integrations")
      .then(res => res.json())
      .then((data: any) => {
        setIsRegistered(data._registration_completed);
        if (data._user_name) setDbUserName(data._user_name);
        if (data.shopify_domain && data.ix_account_name) {
          setIntegrationStatus({
            id: "shopify-ix",
            shopifyAuthorized: data.shopify_authorized === 1,
            ixAuthorized: data.ix_authorized === 1,
            webhooksActive: data.webhooks_active === 1,
            isPaused: data.is_paused === 1,
            isAllComplete: data.shopify_authorized === 1 && data.ix_authorized === 1 && data.webhooks_active === 1
          });
        }
      })
      .finally(() => setLoading(false));

    fetch("/api/dashboard/recent-invoices")
      .then(r => r.ok ? r.json() : { invoices: [] })
      .then((d: any) => setRecentInvoices(d.invoices || []))
      .catch(() => setRecentInvoices([]));
    fetch("/api/dashboard/recent-logs")
      .then(r => r.ok ? r.json() : { logs: [] })
      .then((d: any) => setRecentLogs(d.logs || []))
      .catch(() => setRecentLogs([]));
  }, []);

  const logTone = (status: number): "ok" | "warn" | "err" | "info" => {
    if (status >= 500) return "err";
    if (status === 402 || status === 401) return "warn";
    if (status >= 400) return "warn";
    if (status >= 200 && status < 300) return "ok";
    return "info";
  };

  const fmtRelative = (iso: string | null) => {
    if (!iso) return "";
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "";
    const diff = Math.max(0, Date.now() - then) / 1000;
    if (diff < 60) return t("now");
    if (diff < 3600) return t("minAgo", { n: Math.floor(diff / 60) });
    if (diff < 86400) return t("hourAgo", { n: Math.floor(diff / 3600) });
    return t("dayAgo", { n: Math.floor(diff / 86400) });
  };

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="w-12 h-12 border-4 border-[rgba(2,141,196,0.20)] border-t-accent rounded-full animate-spin" />
      </div>
    );
  }

  if (isRegistered === false) {
    return (
      <div className="py-6 sm:py-12">
        <RegistrationForm
          onComplete={() => setIsRegistered(true)}
          initialEmail={clerkUser?.primaryEmailAddress?.emailAddress}
          initialName={clerkUser?.fullName || ""}
        />
      </div>
    );
  }

  return (
    <div className="space-y-12 animate-in fade-in duration-1000 slide-in-from-bottom-4">
      {/* Welcome Message */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-8">
        <div className="space-y-2">
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-medium tracking-tight bg-gradient-to-r from-fg via-fg to-fg-40 bg-clip-text text-transparent">
            {firstName ? t("welcomeNamed", { name: firstName }) : t("welcome")}
          </h1>
          <p className="text-fg-60 font-medium tracking-wide flex items-center gap-2">
            {t("subtitle1")} <span className="w-1 h-1 rounded-full bg-fg-40" /> {t("subtitle2")}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Link
            href="/integrations"
            className="px-6 py-3 rounded-2xl bg-fg text-surface font-mono text-xs uppercase tracking-[0.18em] hover:bg-accent-hot transition-all transform active:scale-95 flex items-center gap-3 shadow-[0_8px_30px_-12px_rgba(2,141,196,0.45)]"
          >
            {t("newIntegration")} <Plus className="w-4 h-4" />
          </Link>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-8">
        {/* Activity feeds */}
        <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Issued documents */}
          <div className="glass p-6 rounded-[2.5rem] flex flex-col overflow-hidden relative min-h-[280px]">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-[rgba(94,234,212,0.10)] rounded-xl border border-[rgba(94,234,212,0.20)]">
                  <FileText className="w-4 h-4 text-accent-hot" />
                </div>
                <h3 className="font-mono text-[11px] font-medium text-fg uppercase tracking-[0.18em]">{t("recentDocs")}</h3>
              </div>
              <span className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{t("last5")}</span>
            </div>

            {recentInvoices === null ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="w-6 h-6 border-2 border-hairline border-t-accent-hot rounded-full animate-spin" />
              </div>
            ) : recentInvoices.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center gap-2 py-4">
                <Inbox className="w-8 h-8 text-fg-40" />
                <p className="font-mono text-xs text-fg-60 uppercase tracking-[0.22em]">{t("noDocs")}</p>
                <p className="text-[10px] text-fg-40 max-w-[200px]">{t("noDocsBody")}</p>
              </div>
            ) : (
              <ul className="space-y-1.5 -mx-2">
                {recentInvoices.map((inv) => (
                  <li key={inv.order_id}>
                    {inv.ix_url ? (
                      <a
                        href={inv.ix_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl hover:bg-white/5 transition-all group"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-1 h-1 rounded-full bg-accent-hot shrink-0" />
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-fg truncate">#{inv.order_id}</p>
                            <p className="text-[10px] text-fg-40 font-mono">IX {inv.invoice_id}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[10px] text-fg-40 font-mono">{fmtRelative(inv.created_at)}</span>
                          <ExternalLink className="w-3 h-3 text-fg-40 group-hover:text-accent-hot transition-colors" />
                        </div>
                      </a>
                    ) : (
                      <div className="flex items-center justify-between gap-3 px-3 py-2">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-1 h-1 rounded-full bg-fg-40 shrink-0" />
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-fg truncate">#{inv.order_id}</p>
                            <p className="text-[10px] text-fg-40 font-mono">IX {inv.invoice_id}</p>
                          </div>
                        </div>
                        <span className="text-[10px] text-fg-40 font-mono">{fmtRelative(inv.created_at)}</span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Logs */}
          <div className="glass p-6 rounded-[2.5rem] flex flex-col overflow-hidden relative min-h-[280px]">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-[rgba(2,141,196,0.10)] rounded-xl border border-[rgba(2,141,196,0.20)]">
                  <ScrollText className="w-4 h-4 text-accent" />
                </div>
                <h3 className="font-mono text-[11px] font-medium text-fg uppercase tracking-[0.18em]">{t("logs")}</h3>
              </div>
              <span className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{t("last10")}</span>
            </div>

            {recentLogs === null ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="w-6 h-6 border-2 border-hairline border-t-accent rounded-full animate-spin" />
              </div>
            ) : recentLogs.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center gap-2 py-4">
                <Inbox className="w-8 h-8 text-fg-40" />
                <p className="font-mono text-xs text-fg-60 uppercase tracking-[0.22em]">{t("noLogs")}</p>
                <p className="text-[10px] text-fg-40 max-w-[200px]">{t("noLogsBody")}</p>
              </div>
            ) : (
              <ul className="space-y-1 -mx-2 max-h-[420px] overflow-y-auto scrollbar-hide">
                {recentLogs.map((log) => {
                  const tone = logTone(log.status);
                  const dot = tone === "ok" ? "bg-accent-hot"
                          : tone === "warn" ? "bg-soon"
                          : tone === "err" ? "bg-destructive"
                          : "bg-fg-40";
                  return (
                    <li key={log.id} className="px-3 py-1.5 rounded-lg hover:bg-white/5 transition-colors">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={cn("w-1 h-1 rounded-full shrink-0", dot)} />
                          <span className="text-[10px] font-mono text-fg-60 truncate">{log.topic}</span>
                        </div>
                        <span className="text-[10px] font-mono text-fg-40 shrink-0">{fmtRelative(log.created_at)}</span>
                      </div>
                      {log.message && (
                        <p className="text-[10px] text-fg-40 truncate pl-3 mt-0.5" title={log.message}>{log.message}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Status Area */}
        <div className="glass p-5 sm:p-8 rounded-[2.5rem] space-y-8 flex flex-col justify-between">
          <div className="space-y-4">
            <h3 className="font-mono text-[10px] font-medium text-fg-40 uppercase tracking-[0.22em] flex items-center gap-2">
              <Activity className="w-3 h-3" /> {t("systemStatus")}
            </h3>
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-accent-hot animate-pulse" />
              <span className="text-sm font-medium text-fg">{t("engineOnline")}</span>
            </div>
          </div>

          <div className="pt-8 border-t border-hairline space-y-4">
            <p className="font-mono text-[10px] font-medium text-fg-40 uppercase tracking-[0.22em]">{t("resources")}</p>
            <div className="grid gap-2">
              <Link href="/help" className="flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 transition-all group">
                <BookOpen className="w-4 h-4 text-fg-60" />
                <span className="text-xs font-medium text-fg-60 group-hover:text-fg transition-colors">{t("helpCenter")}</span>
                <ArrowRight className="w-3 h-3 ml-auto opacity-0 group-hover:opacity-100 transition-all translate-x-[-10px] group-hover:translate-x-0 text-fg-60" />
              </Link>
              <a href="mailto:pedro@kapta.pt" className="flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 transition-all group">
                <Zap className="w-4 h-4 text-fg-60" />
                <span className="text-xs font-medium text-fg-60 group-hover:text-fg transition-colors">{t("supportTeam")}</span>
                <ArrowRight className="w-3 h-3 ml-auto opacity-0 group-hover:opacity-100 transition-all translate-x-[-10px] group-hover:translate-x-0 text-fg-60" />
              </a>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-6">
        <h2 className="font-mono text-[10px] font-medium text-fg-40 uppercase tracking-[0.22em] ml-2">{t("yourIntegrations")}</h2>

        {integrationStatus ? (
          <div className="grid gap-6">
            <Link
              href="/integrations/shopify-ix"
              className="glass p-5 sm:p-8 rounded-[2.5rem] hover:border-[rgba(94,234,212,0.30)] transition-all flex flex-col md:flex-row items-center justify-between gap-8 group relative overflow-hidden"
            >
              <div className="absolute top-0 right-0 p-5 sm:p-8 opacity-0 group-hover:opacity-5 transition-all">
                <Settings2 className="w-32 h-32 text-accent-hot" />
              </div>
              <div className="flex items-center gap-8 relative z-10 w-full md:w-auto">
                <div className="w-20 h-20 rounded-[1.8rem] bg-[rgba(94,234,212,0.10)] flex items-center justify-center border border-[rgba(94,234,212,0.20)] shrink-0">
                  <Store className="w-10 h-10 text-accent-hot" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-2xl font-medium tracking-tight group-hover:text-accent-hot transition-colors">Shopify + InvoiceXpress</h3>
                  <div className="flex items-center gap-3">
                    <span className={cn(
                      "px-2 py-0.5 rounded-lg font-mono text-[10px] font-medium uppercase tracking-[0.22em] border",
                      integrationStatus.isAllComplete
                        ? "bg-[rgba(94,234,212,0.10)] text-accent-hot border-[rgba(94,234,212,0.20)]"
                        : "bg-[rgba(245,158,11,0.10)] text-soon border-[rgba(245,158,11,0.20)]"
                    )}>
                      {integrationStatus.isAllComplete ? t("activeAuthorized") : t("configPending")}
                    </span>
                    <span className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em] hidden sm:inline">{t("since", { date: "2026-03-02" })}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-6 relative z-10 ml-auto md:ml-0">
                <div className="hidden xl:flex items-center -space-x-2">
                  <div className={cn("w-8 h-8 rounded-full border-4 border-surface flex items-center justify-center", integrationStatus.shopifyAuthorized ? "bg-[rgba(94,234,212,0.18)] text-accent-hot" : "bg-surface-2 text-fg-40")}><Store className="w-3 h-3" /></div>
                  <div className={cn("w-8 h-8 rounded-full border-4 border-surface flex items-center justify-center", integrationStatus.ixAuthorized ? "bg-[rgba(94,234,212,0.18)] text-accent-hot" : "bg-surface-2 text-fg-40")}><ClipboardList className="w-3 h-3" /></div>
                </div>
                <ArrowRight className="w-6 h-6 text-fg-40 group-hover:text-accent-hot group-hover:translate-x-2 transition-all" />
              </div>
            </Link>
          </div>
        ) : (
          <div className="glass p-6 sm:p-12 rounded-[3rem] border-dashed flex flex-col items-center gap-6 text-center">
            <div className="w-16 h-16 rounded-2xl bg-surface-2 flex items-center justify-center text-fg-40 border border-hairline">
              <Plus className="w-8 h-8" />
            </div>
            <div className="space-y-2">
              <h3 className="text-xl font-medium">{t("emptyTitle")}</h3>
              <p className="text-fg-60 text-sm max-w-xs mx-auto">
                {t("emptyBody")}
              </p>
            </div>
            <Link
              href="/integrations"
              className="px-5 sm:px-8 py-3 rounded-2xl bg-fg text-surface font-mono text-xs uppercase tracking-[0.18em] hover:bg-accent-hot transition-all transform active:scale-95 shadow-[0_8px_30px_-12px_rgba(2,141,196,0.45)]"
            >
              {t("explorePlatforms")}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
