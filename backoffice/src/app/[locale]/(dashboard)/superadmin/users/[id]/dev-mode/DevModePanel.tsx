"use client";

import { useEffect, useState } from "react";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import {
    Wrench, ArrowLeft, Loader2, AlertCircle, CheckCircle2, Mail, X,
    PlayCircle, RotateCw, FileCheck2, ScrollText, Calendar, Percent, Trash2, Receipt, Sparkles
} from "lucide-react";

type Target = {
    id: string;
    name: string;
    email: string;
    role: string;
    nif: string | null;
    company_name: string | null;
    shopify_domain: string | null;
    shopify_authorized: boolean;
    ix_authorized: boolean;
    shopify_error: string | null;
    ix_error: string | null;
};

type JobResult = {
    job_id?: string;
    total?: number;
    success?: number;
    skipped?: number;
    errors?: number;
    would_create?: number;
    would_finalize?: number;
    finalized?: number;
    results?: any[];
    error?: string;
    [k: string]: any;
};

export function DevModePanel({ target }: { target: Target }) {
    const t = useTranslations("devMode");
    const [notifyEmails, setNotifyEmails] = useState<string[]>([]);
    const [emailInput, setEmailInput] = useState("");
    const [savingEmails, setSavingEmails] = useState(false);

    useEffect(() => {
        fetch(`/api/admin/dev-mode/notify-emails?targetUserId=${target.id}`)
            .then(r => r.json())
            .then((d: any) => setNotifyEmails(d.emails ?? []))
            .catch(console.error);
    }, [target.id]);

    const saveEmails = async (next: string[]) => {
        setSavingEmails(true);
        try {
            const res = await fetch("/api/admin/dev-mode/notify-emails", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetUserId: target.id, emails: next }),
            });
            const data: any = await res.json();
            setNotifyEmails(data.emails ?? next);
        } catch (e) { console.error(e); }
        finally { setSavingEmails(false); }
    };

    const addEmail = () => {
        const e = emailInput.trim();
        if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return;
        if (notifyEmails.includes(e)) { setEmailInput(""); return; }
        const next = [...notifyEmails, e];
        setEmailInput("");
        saveEmails(next);
    };
    const removeEmail = (e: string) => saveEmails(notifyEmails.filter(x => x !== e));

    const noShop = !target.shopify_domain;

    return (
        <div className="space-y-10 animate-in fade-in duration-500">
            {/* Header */}
            <div className="flex flex-col gap-6">
                <Link href="/superadmin" className="flex items-center gap-2 text-fg-40 hover:text-fg text-[10px] font-black uppercase tracking-widest w-fit">
                    <ArrowLeft className="w-3 h-3" /> {t("back")}
                </Link>
                <div className="flex items-end justify-between flex-wrap gap-4">
                    <div className="flex items-center gap-4">
                        <div className="w-14 h-14 rounded-2xl bg-[rgba(2,141,196,0.10)] border border-[rgba(2,141,196,0.20)] flex items-center justify-center">
                            <Wrench className="w-7 h-7 text-accent" />
                        </div>
                        <div>
                            <h1 className="text-4xl font-black tracking-tight bg-gradient-to-r from-white to-slate-500 bg-clip-text text-transparent">
                                {t("title")}
                            </h1>
                            <p className="text-fg-60 font-semibold mt-1">
                                {target.name} · {target.email}
                                {target.shopify_domain && <span className="text-fg-40"> · {target.shopify_domain}</span>}
                            </p>
                        </div>
                    </div>
                </div>
                {noShop && (
                    <div className="glass rounded-2xl p-5 border border-[rgba(245,158,11,0.30)] bg-[rgba(245,158,11,0.05)] flex items-center gap-3 text-soon text-sm font-bold">
                        <AlertCircle className="w-5 h-5" />
                        {t("noShop")}
                    </div>
                )}
            </div>

            <SubscriptionAdminCard targetUserId={target.id} targetRole={target.role} />

            {!noShop && (
                <>
                    <TaxOverrideCard targetUserId={target.id} />
                    <PendingReverseChargeCard targetUserId={target.id} />
                    <NotifyEmailsCard emails={notifyEmails} input={emailInput} setInput={setEmailInput} onAdd={addEmail} onRemove={removeEmail} saving={savingEmails} />
                    <BackfillCard targetUserId={target.id} notifyEmails={notifyEmails} />
                    <ReemitCard targetUserId={target.id} notifyEmails={notifyEmails} />
                    <CancelInvoiceCard targetUserId={target.id} notifyEmails={notifyEmails} />
                    <FinalizeDraftsCard targetUserId={target.id} notifyEmails={notifyEmails} />
                    <LogsCard targetUserId={target.id} />
                </>
            )}
        </div>
    );
}

function Section({ icon, title, desc, children }: { icon: React.ReactNode; title: string; desc?: string; children: React.ReactNode }) {
    return (
        <section className="glass rounded-[2rem] p-5 sm:p-8 border-hairline space-y-6">
            <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-xl bg-surface-2 border border-hairline flex items-center justify-center shrink-0">
                    {icon}
                </div>
                <div>
                    <h2 className="text-lg font-black tracking-tight">{title}</h2>
                    {desc && <p className="text-fg-40 text-xs font-medium mt-1">{desc}</p>}
                </div>
            </div>
            {children}
        </section>
    );
}

function ResultBox({ result }: { result: JobResult | null }) {
    if (!result) return null;
    const errored = result.error && !result.job_id;
    return (
        <pre className={`mt-4 rounded-2xl p-5 text-[11px] font-mono whitespace-pre-wrap border ${errored ? "bg-[rgba(244,63,94,0.05)] border-[rgba(244,63,94,0.20)] text-destructive" : "bg-surface-2/70 border-hairline text-fg"}`}>
            {JSON.stringify(result, null, 2)}
        </pre>
    );
}

function SubscriptionAdminCard({ targetUserId, targetRole }: { targetUserId: string; targetRole: string }) {
    const t = useTranslations("devMode");
    const [sub, setSub] = useState<any>(null);
    const [earlyBird, setEarlyBird] = useState(false);
    const [trialEnd, setTrialEnd] = useState<string>("");
    const [loaded, setLoaded] = useState(false);
    const [saving, setSaving] = useState(false);
    const [savedAt, setSavedAt] = useState<number | null>(null);

    const isAdminTarget = targetRole === "superadmin" || targetRole === "hiperadmin";

    useEffect(() => {
        if (isAdminTarget) { setLoaded(true); return; }
        fetch(`/api/admin/subscription?user_id=${targetUserId}`)
            .then(r => r.json())
            .then((d: any) => {
                if (d.subscription) {
                    setSub(d.subscription);
                    setEarlyBird(d.subscription.early_bird === 1);
                    setTrialEnd(d.subscription.trial_end ? d.subscription.trial_end.split("T")[0] : "");
                } else {
                    setEarlyBird(false);
                    setTrialEnd("2026-08-01");
                }
                setLoaded(true);
            })
            .catch(console.error);
    }, [targetUserId, isAdminTarget]);

    const save = async () => {
        setSaving(true);
        try {
            const trialEndIso = trialEnd ? `${trialEnd}T00:00:00Z` : null;
            const res = await fetch("/api/admin/subscription", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user_id: targetUserId, early_bird: earlyBird, trial_end: trialEndIso }),
            });
            const d: any = await res.json();
            if (d.subscription) setSub(d.subscription);
            setSavedAt(Date.now());
        } catch (e) { console.error(e); }
        finally { setSaving(false); }
    };

    if (isAdminTarget) {
        return (
            <Section icon={<Sparkles className="w-5 h-5 text-accent" />} title={t("subscriptionTitle")} desc={t("subscriptionAdminDesc")}>
                <div className="px-4 py-3 rounded-xl bg-[rgba(2,141,196,0.05)] border border-[rgba(2,141,196,0.20)] text-accent text-xs font-bold">
                    {t("subscriptionAdminBadge", { role: targetRole })}
                </div>
            </Section>
        );
    }

    return (
        <Section icon={<Sparkles className="w-5 h-5 text-soon" />} title={t("subscriptionTitle")} desc={t("subscriptionDesc")}>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                <label className="flex items-center gap-3 cursor-pointer pb-2">
                    <input
                        type="checkbox"
                        checked={earlyBird}
                        onChange={e => {
                            const on = e.target.checked;
                            setEarlyBird(on);
                            // Early bird is cosmetic: real access is gated by trial_end. Turning it OFF
                            // must shorten the trial, otherwise the user keeps the early-bird date
                            // (e.g. 2026-08-01) and gets months of free access. Grace = today + 3 days.
                            if (!on) {
                                const grace = new Date(Date.now() + 3 * 86400000).toISOString().split("T")[0];
                                setTrialEnd(grace);
                            }
                        }}
                        disabled={!loaded}
                        className="accent-soon w-4 h-4"
                    />
                    <span className="text-xs font-bold text-fg">{t("earlyBird")}</span>
                </label>
                <label className="flex flex-col gap-1.5 text-[10px] font-black uppercase tracking-widest text-fg-40">
                    {t("trialEnds")}
                    <input
                        type="date"
                        value={trialEnd}
                        onChange={e => setTrialEnd(e.target.value)}
                        disabled={!loaded}
                        className="bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 text-sm font-medium text-white"
                    />
                </label>
                <button onClick={save} disabled={!loaded || saving}
                    className="bg-white text-black py-2.5 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-accent hover:text-fg transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                    {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : savedAt && Date.now() - savedAt < 2000 ? <CheckCircle2 className="w-3 h-3" /> : null}
                    {savedAt && Date.now() - savedAt < 2000 ? t("saved") : t("save")}
                </button>
            </div>
            {sub && (
                <div className="text-[10px] text-fg-40 font-medium space-y-1">
                    <p><strong className="text-fg-60">{t("statusNow")}</strong> {sub.status}{sub.stripe_subscription_id && <span className="text-fg-40"> · {sub.stripe_subscription_id}</span>}</p>
                    {sub.current_period_end && <p><strong className="text-fg-60">{t("nextCharge")}</strong> {new Date(sub.current_period_end).toLocaleDateString("pt-PT")}</p>}
                </div>
            )}
        </Section>
    );
}

function TaxOverrideCard({ targetUserId }: { targetUserId: string }) {
    const t = useTranslations("devMode");
    const [rate, setRate] = useState<string>("");
    const [shippingRate, setShippingRate] = useState<string>("");
    const [oss, setOss] = useState(true);
    const [b2bReverseCharge, setB2bReverseCharge] = useState(false);
    const [b2bReason, setB2bReason] = useState<string>("M16");
    const [loaded, setLoaded] = useState(false);
    const [saving, setSaving] = useState(false);
    const [savedAt, setSavedAt] = useState<number | null>(null);

    useEffect(() => {
        fetch(`/api/admin/dev-mode/tax-override?targetUserId=${targetUserId}`)
            .then(r => r.json())
            .then((d: any) => {
                setRate(d.force_tax_rate != null ? String(d.force_tax_rate) : "");
                setShippingRate(d.force_shipping_tax_rate != null ? String(d.force_shipping_tax_rate) : "");
                setOss(d.oss_enabled !== 0);
                setB2bReverseCharge(d.b2b_reverse_charge === 1);
                setB2bReason(d.ix_b2b_exemption_reason ?? "M16");
                setLoaded(true);
            })
            .catch(console.error);
    }, [targetUserId]);

    const save = async () => {
        setSaving(true);
        try {
            const parsed = rate.trim() === "" ? null : Number(rate);
            const parsedShipping = shippingRate.trim() === "" ? null : Number(shippingRate);
            const res = await fetch("/api/admin/dev-mode/tax-override", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    targetUserId,
                    force_tax_rate: parsed,
                    force_shipping_tax_rate: parsedShipping,
                    oss_enabled: oss,
                    b2b_reverse_charge: b2bReverseCharge,
                    ix_b2b_exemption_reason: b2bReason || "M16",
                }),
            });
            await res.json();
            setSavedAt(Date.now());
        } catch (e) { console.error(e); }
        finally { setSaving(false); }
    };

    return (
        <Section icon={<Percent className="w-5 h-5 text-accent" />} title={t("taxOverrideTitle")} desc={t("taxOverrideDesc")}>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
                <label className="flex flex-col gap-1.5 text-[10px] font-black uppercase tracking-widest text-fg-40">
                    {t("forceTaxProducts")}
                    <input
                        type="number" min={0} max={100} step="0.01"
                        value={rate} onChange={e => setRate(e.target.value)}
                        placeholder={t("forceTaxProductsPlaceholder")}
                        disabled={!loaded}
                        className="bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 text-sm font-medium text-white"
                    />
                </label>
                <label className="flex flex-col gap-1.5 text-[10px] font-black uppercase tracking-widest text-fg-40">
                    {t("forceTaxShipping")}
                    <input
                        type="number" min={0} max={100} step="0.01"
                        value={shippingRate} onChange={e => setShippingRate(e.target.value)}
                        placeholder={t("forceTaxShippingPlaceholder")}
                        disabled={!loaded}
                        className="bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 text-sm font-medium text-white"
                    />
                </label>
                <label className="flex items-center gap-3 cursor-pointer pb-2">
                    <input type="checkbox" checked={oss} onChange={e => setOss(e.target.checked)} disabled={!loaded} className="accent-accent w-4 h-4" />
                    <span className="text-xs font-bold text-fg">
                        {t("ossActive")}
                    </span>
                </label>
                <button onClick={save} disabled={!loaded || saving}
                    className="bg-white text-black py-2.5 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-accent hover:text-fg transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                    {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : savedAt && Date.now() - savedAt < 2000 ? <CheckCircle2 className="w-3 h-3" /> : null}
                    {savedAt && Date.now() - savedAt < 2000 ? t("saved") : t("save")}
                </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end mt-2">
                <label className="flex items-center gap-3 cursor-pointer pb-2 md:col-span-2">
                    <input type="checkbox" checked={b2bReverseCharge} onChange={e => setB2bReverseCharge(e.target.checked)} disabled={!loaded} className="accent-accent w-4 h-4" />
                    <span className="text-xs font-bold text-fg">
                        {t("b2bReverseCharge")}
                    </span>
                </label>
                <label className="flex flex-col gap-1.5 text-[10px] font-black uppercase tracking-widest text-fg-40 md:col-span-2">
                    {t("b2bExemptionCode")}
                    <select
                        value={["M16", "M40"].includes(b2bReason) ? b2bReason : "custom"}
                        onChange={e => {
                            if (e.target.value === "custom") {
                                setB2bReason("");
                            } else {
                                setB2bReason(e.target.value);
                            }
                        }}
                        disabled={!loaded || !b2bReverseCharge}
                        className="bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                    >
                        <option value="M16">{t("b2bM16")}</option>
                        <option value="M40">{t("b2bM40")}</option>
                        <option value="custom">{t("b2bCustom")}</option>
                    </select>
                    {!["M16", "M40"].includes(b2bReason) && (
                        <input
                            type="text"
                            value={b2bReason}
                            onChange={e => setB2bReason(e.target.value.toUpperCase().slice(0, 16))}
                            placeholder={t("b2bCustomPlaceholder")}
                            disabled={!loaded || !b2bReverseCharge}
                            className="bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 text-sm font-medium text-white mt-1.5 disabled:opacity-50"
                        />
                    )}
                </label>
            </div>
            <p className="text-[10px] text-fg-40 font-medium leading-relaxed">
                <strong className="text-fg-40">{t("taxOverrideExplain1Title")}</strong> {t("taxOverrideExplain1")}<br />
                <strong className="text-fg-40">{t("taxOverrideExplain2Title")}</strong> {t("taxOverrideExplain2")}<br />
                <strong className="text-fg-40">{t("taxOverrideExplain3Title")}</strong> {t("taxOverrideExplain3")}<br />
                <strong className="text-fg-40">{t("taxOverrideExplain4Title")}</strong>{" "}
                {t.rich("taxOverrideExplain4", { code: (c) => <code>{c}</code> })}
            </p>
        </Section>
    );
}

type PendingRcRow = {
    id: string;
    order_id: string;
    vat_id: string;
    country_code: string;
    attempts: number;
    status: string;
    next_retry_at: string;
    last_error: string | null;
    incident_id: string | null;
    created_at: string;
    updated_at: string;
};

function PendingReverseChargeCard({ targetUserId }: { targetUserId: string }) {
    const t = useTranslations("devMode");
    const [rows, setRows] = useState<PendingRcRow[] | null>(null);
    const [acting, setActing] = useState<string | null>(null);

    const reload = () => {
        fetch(`/api/admin/dev-mode/pending-reverse-charge?targetUserId=${targetUserId}`)
            .then(r => r.json())
            .then((d: any) => setRows(d.rows ?? []))
            .catch(console.error);
    };

    useEffect(reload, [targetUserId]);

    const decide = async (id: string, disposition: "approve" | "reject") => {
        setActing(id);
        try {
            await fetch(`/api/admin/dev-mode/pending-reverse-charge/${id}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ disposition }),
            });
            reload();
        } catch (e) { console.error(e); }
        finally { setActing(null); }
    };

    return (
        <Section
            icon={<AlertCircle className="w-5 h-5 text-soon" />}
            title={t("viesPendingTitle")}
            desc={t("viesPendingDesc")}
        >
            {rows === null && <p className="text-xs text-fg-40">{t("loadingShort")}</p>}
            {rows && rows.length === 0 && (
                <p className="text-xs text-fg-40">{t("noPendingOrders")}</p>
            )}
            {rows && rows.length > 0 && (
                <div className="space-y-3">
                    {rows.map(r => {
                        const vat = `${r.country_code}${r.vat_id}`;
                        const viesUrl = `https://viesvalidation.com/pt/?country=${encodeURIComponent(r.country_code)}&vat=${encodeURIComponent(r.vat_id)}`;
                        return (
                            <div key={r.id} className="rounded-2xl border border-hairline bg-surface-2/30 p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                                <div className="text-xs space-y-1">
                                    <p className="font-bold text-white">{t("orderHash", { n: r.order_id })}</p>
                                    <p className="text-fg-60">{t("viesAttempts", { vat, attempts: r.attempts, state: r.incident_id ? t("viesIncidentOpen") : t("viesTrying") })}</p>
                                    {r.last_error && <p className="text-fg-40">{t("viesLastError", { error: r.last_error })}</p>}
                                    <a href={viesUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline text-[10px] font-black uppercase tracking-widest">
                                        {t("validateOnVies")}
                                    </a>
                                </div>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => decide(r.id, "approve")}
                                        disabled={acting === r.id}
                                        className="px-3 py-2 rounded-xl bg-[rgba(94,234,212,0.18)] border border-[rgba(94,234,212,0.40)] text-accent-hot text-[10px] font-black uppercase tracking-widest hover:bg-[rgba(94,234,212,0.25)] disabled:opacity-50"
                                    >
                                        {acting === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : t("approveRc")}
                                    </button>
                                    <button
                                        onClick={() => decide(r.id, "reject")}
                                        disabled={acting === r.id}
                                        className="px-3 py-2 rounded-xl bg-[rgba(244,63,94,0.18)] border border-[rgba(244,63,94,0.40)] text-destructive text-[10px] font-black uppercase tracking-widest hover:bg-[rgba(244,63,94,0.25)] disabled:opacity-50"
                                    >
                                        {t("rejectRc")}
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </Section>
    );
}

function NotifyEmailsCard({ emails, input, setInput, onAdd, onRemove, saving }: {
    emails: string[]; input: string; setInput: (s: string) => void; onAdd: () => void; onRemove: (e: string) => void; saving: boolean;
}) {
    const t = useTranslations("devMode");
    return (
        <Section icon={<Mail className="w-5 h-5 text-destructive" />} title={t("notifyTitle")} desc={t("notifyDesc")}>
            <div className="flex flex-wrap gap-2">
                {emails.map(e => (
                    <span key={e} className="bg-surface-2 border border-hairline rounded-xl px-3 py-1.5 text-xs font-bold flex items-center gap-2">
                        {e}
                        <button onClick={() => onRemove(e)} className="text-fg-40 hover:text-destructive"><X className="w-3 h-3" /></button>
                    </span>
                ))}
                <div className="flex items-center gap-2">
                    <input
                        type="email" placeholder={t("notifyAddPlaceholder")} value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); onAdd(); } }}
                        className="bg-surface-2/50 border border-hairline rounded-xl px-3 py-1.5 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-[rgba(244,63,94,0.20)] focus:border-[rgba(244,63,94,0.40)] w-56"
                    />
                    <button onClick={onAdd} disabled={saving} className="bg-white text-black px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest disabled:opacity-50">
                        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : "+"}
                    </button>
                </div>
            </div>
        </Section>
    );
}

function BackfillCard({ targetUserId, notifyEmails }: { targetUserId: string; notifyEmails: string[] }) {
    const t = useTranslations("devMode");
    const [mode, setMode] = useState<"date_range" | "since_last">("date_range");
    const [from, setFrom] = useState("");
    const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
    const [type, setType] = useState<"create_orders" | "finalize_orders">("create_orders");
    const [dryRun, setDryRun] = useState(true);
    const [reason, setReason] = useState("");
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<JobResult | null>(null);

    const run = async () => {
        setLoading(true); setResult(null);
        try {
            const res = await fetch("/api/admin/dev-mode/backfill", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    targetUserId, type, dry_run: dryRun, reason,
                    notify_emails: notifyEmails,
                    ...(mode === "since_last"
                        ? { since_last_processed: true, to: new Date(to + "T23:59:59Z").toISOString() }
                        : { from: from ? new Date(from + "T00:00:00Z").toISOString() : undefined, to: to ? new Date(to + "T23:59:59Z").toISOString() : undefined }),
                }),
            });
            setResult(await res.json());
        } catch (e: any) { setResult({ error: String(e) }); }
        finally { setLoading(false); }
    };

    return (
        <Section icon={<PlayCircle className="w-5 h-5 text-accent-hot" />} title={t("backfillTitle")} desc={t("backfillDesc")}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex gap-2">
                    {(["date_range", "since_last"] as const).map(m => (
                        <button key={m} onClick={() => setMode(m)}
                            className={`flex-1 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all ${mode === m ? "bg-[rgba(2,141,196,0.18)] text-accent border-[rgba(2,141,196,0.40)]" : "bg-surface-2/50 text-fg-40 border-hairline hover:text-fg"}`}>
                            {m === "date_range" ? t("modeDateRange") : t("modeSinceLast")}
                        </button>
                    ))}
                </div>
                <div className="flex gap-2">
                    {(["create_orders", "finalize_orders"] as const).map(tk => (
                        <button key={tk} onClick={() => setType(tk)}
                            className={`flex-1 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all ${type === tk ? "bg-[rgba(244,63,94,0.18)] text-destructive border-[rgba(244,63,94,0.40)]" : "bg-surface-2/50 text-fg-40 border-hairline hover:text-fg"}`}>
                            {tk === "create_orders" ? t("typeCreateOrders") : t("typeFinalizeOrders")}
                        </button>
                    ))}
                </div>

                {mode === "date_range" && (
                    <label className="flex flex-col gap-1.5 text-[10px] font-black uppercase tracking-widest text-fg-40">
                        {t("from")} <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 text-sm font-medium text-white" />
                    </label>
                )}
                <label className="flex flex-col gap-1.5 text-[10px] font-black uppercase tracking-widest text-fg-40">
                    {t("to")} <input type="date" value={to} onChange={e => setTo(e.target.value)} className="bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 text-sm font-medium text-white" />
                </label>

                <label className="md:col-span-2 flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} className="accent-soon w-4 h-4" />
                    <span className="text-xs font-bold text-fg">
                        {t("dryRunDesc")}
                    </span>
                </label>

                <textarea
                    placeholder={t("reasonPlaceholder")}
                    value={reason} onChange={e => setReason(e.target.value)}
                    rows={2}
                    className="md:col-span-2 bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 text-sm font-medium text-white resize-none"
                />
            </div>

            <button onClick={run} disabled={loading}
                className="w-full bg-white text-black py-3 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-accent-hot hover:text-surface transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
                {dryRun ? t("simulateBackfill") : t("runBackfill")}
            </button>
            <ResultBox result={result} />
        </Section>
    );
}

function ReemitCard({ targetUserId, notifyEmails }: { targetUserId: string; notifyEmails: string[] }) {
    const t = useTranslations("devMode");
    const [orderNumber, setOrderNumber] = useState("");
    const [force, setForce] = useState(false);
    const [reason, setReason] = useState("");
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<JobResult | null>(null);

    const run = async () => {
        if (!orderNumber) return;
        setLoading(true); setResult(null);
        try {
            const res = await fetch("/api/admin/dev-mode/reemit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetUserId, order_number: Number(orderNumber), force, reason, notify_emails: notifyEmails }),
            });
            setResult(await res.json());
        } catch (e: any) { setResult({ error: String(e) }); }
        finally { setLoading(false); }
    };

    return (
        <Section icon={<RotateCw className="w-5 h-5 text-soon" />} title={t("reemitTitle")} desc={t("reemitDesc")}>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <label className="flex flex-col gap-1.5 text-[10px] font-black uppercase tracking-widest text-fg-40 md:col-span-1">
                    {t("orderNumberShort")}
                    <input type="number" value={orderNumber} onChange={e => setOrderNumber(e.target.value)} placeholder="1234"
                        className="bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 text-sm font-medium text-white" />
                </label>
                <label className="md:col-span-2 flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} className="accent-destructive w-4 h-4" />
                    <span className="text-xs font-bold text-fg">
                        {t("forceLabel")}
                    </span>
                </label>
                <textarea placeholder={t("reasonShort")} value={reason} onChange={e => setReason(e.target.value)} rows={2}
                    className="md:col-span-3 bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 text-sm font-medium text-white resize-none" />
            </div>
            <button onClick={run} disabled={loading || !orderNumber}
                className="w-full bg-white text-black py-3 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-accent hover:text-fg transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCw className="w-4 h-4" />}
                {t("reemit")}
            </button>
            <ResultBox result={result} />
        </Section>
    );
}

function CancelInvoiceCard({ targetUserId, notifyEmails }: { targetUserId: string; notifyEmails: string[] }) {
    const t = useTranslations("devMode");
    const [orderNumber, setOrderNumber] = useState("");
    const [mode, setMode] = useState<"delete_draft" | "credit_note">("delete_draft");
    const [reason, setReason] = useState("");
    const [loading, setLoading] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const [result, setResult] = useState<JobResult | null>(null);

    const run = async () => {
        if (!orderNumber) return;
        setLoading(true); setResult(null); setConfirm(false);
        try {
            const path = mode === "delete_draft" ? "delete-draft" : "issue-credit-note";
            const res = await fetch(`/api/admin/dev-mode/${path}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetUserId, order_number: Number(orderNumber), reason, notify_emails: notifyEmails }),
            });
            setResult(await res.json());
        } catch (e: any) { setResult({ error: String(e) }); }
        finally { setLoading(false); }
    };

    const isDelete = mode === "delete_draft";
    return (
        <Section
            icon={isDelete ? <Trash2 className="w-5 h-5 text-destructive" /> : <Receipt className="w-5 h-5 text-soon" />}
            title={t("cancelInvoiceTitle")}
            desc={t("cancelInvoiceDesc")}
        >
            <div className="flex gap-2">
                {(["delete_draft", "credit_note"] as const).map(m => (
                    <button key={m} onClick={() => setMode(m)}
                        className={`flex-1 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all ${mode === m ? (m === "delete_draft" ? "bg-[rgba(244,63,94,0.18)] text-destructive border-[rgba(244,63,94,0.40)]" : "bg-[rgba(245,158,11,0.18)] text-soon border-[rgba(245,158,11,0.40)]") : "bg-surface-2/50 text-fg-40 border-hairline hover:text-fg"}`}>
                        {m === "delete_draft" ? t("modeDeleteDraft") : t("modeCreditNote")}
                    </button>
                ))}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <label className="flex flex-col gap-1.5 text-[10px] font-black uppercase tracking-widest text-fg-40 md:col-span-1">
                    {t("orderNumberShort")}
                    <input type="number" value={orderNumber} onChange={e => setOrderNumber(e.target.value)} placeholder="1137"
                        className="bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 text-sm font-medium text-white" />
                </label>
                <textarea placeholder={t("reasonRecommended")} value={reason} onChange={e => setReason(e.target.value)} rows={2}
                    className="md:col-span-2 bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 text-sm font-medium text-white resize-none" />
            </div>
            {confirm ? (
                <div className="flex items-center gap-3 bg-[rgba(244,63,94,0.05)] border border-[rgba(244,63,94,0.20)] rounded-2xl p-4">
                    <AlertCircle className="w-4 h-4 text-destructive" />
                    <span className="text-xs font-bold text-destructive flex-1">
                        {isDelete ? t("confirmDeleteDraft", { n: orderNumber }) : t("confirmCreditNote", { n: orderNumber })}
                    </span>
                    <button onClick={run} disabled={loading}
                        className={`px-5 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest ${isDelete ? "bg-destructive hover:bg-destructive/85" : "bg-soon hover:bg-soon/85"} text-white disabled:opacity-50 flex items-center gap-2`}>
                        {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                        {t("confirm")}
                    </button>
                    <button onClick={() => setConfirm(false)} className="px-3 py-2 rounded-xl bg-surface-2 text-fg-60 text-[10px] font-black uppercase">{t("back")}</button>
                </div>
            ) : (
                <button onClick={() => setConfirm(true)} disabled={loading || !orderNumber}
                    className={`w-full py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50 flex items-center justify-center gap-2 ${isDelete ? "bg-white text-black hover:bg-destructive hover:text-fg" : "bg-white text-black hover:bg-soon hover:text-fg"}`}>
                    {isDelete ? <Trash2 className="w-4 h-4" /> : <Receipt className="w-4 h-4" />}
                    {isDelete ? t("modeDeleteDraft") : t("modeCreditNote")}
                </button>
            )}
            <ResultBox result={result} />
        </Section>
    );
}

function FinalizeDraftsCard({ targetUserId, notifyEmails }: { targetUserId: string; notifyEmails: string[] }) {
    const t = useTranslations("devMode");
    const [limit, setLimit] = useState("100");
    const [dryRun, setDryRun] = useState(true);
    const [reason, setReason] = useState("");
    const [dateStrategy, setDateStrategy] = useState<"today" | "closest_available">("closest_available");
    const [filterMode, setFilterMode] = useState<"all" | "order_range" | "date_range">("all");
    const [fromOrder, setFromOrder] = useState("");
    const [toOrder, setToOrder] = useState("");
    const [fromDate, setFromDate] = useState("");
    const [toDate, setToDate] = useState("");
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<JobResult | null>(null);

    const run = async () => {
        setLoading(true); setResult(null);
        try {
            const payload: Record<string, unknown> = {
                targetUserId, limit: Number(limit), dry_run: dryRun, reason,
                notify_emails: notifyEmails, date_strategy: dateStrategy,
            };
            if (filterMode === "order_range") {
                if (fromOrder) payload.from_order_number = Number(fromOrder);
                if (toOrder) payload.to_order_number = Number(toOrder);
            } else if (filterMode === "date_range") {
                if (fromDate) payload.from_date = new Date(fromDate + "T00:00:00Z").toISOString();
                if (toDate) payload.to_date = new Date(toDate + "T23:59:59Z").toISOString();
            }
            const res = await fetch("/api/admin/dev-mode/finalize-drafts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            setResult(await res.json());
        } catch (e: any) { setResult({ error: String(e) }); }
        finally { setLoading(false); }
    };

    return (
        <Section icon={<FileCheck2 className="w-5 h-5 text-accent" />} title={t("finalizeTitle")} desc={t("finalizeDesc")}>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="md:col-span-3 flex flex-col gap-2">
                    <span className="text-[10px] font-black uppercase tracking-widest text-fg-40">{t("dateStrategy")}</span>
                    <div className="flex gap-2">
                        {([
                            { id: "closest_available", label: t("stratClosest"), desc: t("stratClosestDesc") },
                            { id: "today", label: t("stratToday"), desc: t("stratTodayDesc") },
                        ] as const).map(opt => (
                            <button key={opt.id} type="button" onClick={() => setDateStrategy(opt.id)}
                                title={opt.desc}
                                className={`flex-1 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all ${dateStrategy === opt.id ? "bg-[rgba(2,141,196,0.18)] text-accent border-[rgba(2,141,196,0.40)]" : "bg-surface-2/50 text-fg-40 border-hairline hover:text-fg"}`}>
                                {opt.label}
                            </button>
                        ))}
                    </div>
                    <p className="text-[10px] text-fg-40 leading-relaxed">
                        {t.rich("stratNote", { code: (c) => <code className="text-fg">{c}</code> })}
                    </p>
                </div>
                <div className="md:col-span-3 flex flex-col gap-2">
                    <span className="text-[10px] font-black uppercase tracking-widest text-fg-40">{t("filter")}</span>
                    <div className="flex gap-2">
                        {([
                            { id: "all", label: t("filterAll") },
                            { id: "order_range", label: t("filterOrderRange") },
                            { id: "date_range", label: t("filterDateRange") },
                        ] as const).map(opt => (
                            <button key={opt.id} type="button" onClick={() => setFilterMode(opt.id)}
                                className={`flex-1 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all ${filterMode === opt.id ? "bg-[rgba(2,141,196,0.18)] text-accent border-[rgba(2,141,196,0.40)]" : "bg-surface-2/50 text-fg-40 border-hairline hover:text-fg"}`}>
                                {opt.label}
                            </button>
                        ))}
                    </div>
                    {filterMode === "order_range" && (
                        <div className="grid grid-cols-2 gap-3 mt-1">
                            <label className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-widest text-fg-40">
                                {t("from")} # <input type="number" value={fromOrder} onChange={e => setFromOrder(e.target.value)} placeholder="1260" className="bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 text-sm font-medium text-white" />
                            </label>
                            <label className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-widest text-fg-40">
                                {t("to")} # <input type="number" value={toOrder} onChange={e => setToOrder(e.target.value)} placeholder="1280" className="bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 text-sm font-medium text-white" />
                            </label>
                        </div>
                    )}
                    {filterMode === "date_range" && (
                        <div className="grid grid-cols-2 gap-3 mt-1">
                            <label className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-widest text-fg-40">
                                {t("from")} <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 text-sm font-medium text-white" />
                            </label>
                            <label className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-widest text-fg-40">
                                {t("to")} <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 text-sm font-medium text-white" />
                            </label>
                        </div>
                    )}
                </div>
                <label className="flex flex-col gap-1.5 text-[10px] font-black uppercase tracking-widest text-fg-40">
                    {t("limit")}
                    <input type="number" value={limit} onChange={e => setLimit(e.target.value)} min={1} max={500}
                        className="bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 text-sm font-medium text-white" />
                </label>
                <label className="md:col-span-2 flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} className="accent-soon w-4 h-4" />
                    <span className="text-xs font-bold text-fg">{t("dryRun")}</span>
                </label>
                <textarea placeholder={t("reasonShort")} value={reason} onChange={e => setReason(e.target.value)} rows={2}
                    className="md:col-span-3 bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 text-sm font-medium text-white resize-none" />
            </div>
            <button onClick={run} disabled={loading}
                className="w-full bg-white text-black py-3 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-accent hover:text-surface transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileCheck2 className="w-4 h-4" />}
                {dryRun ? t("simulateFinalize") : t("runFinalize")}
            </button>
            <ResultBox result={result} />
        </Section>
    );
}

function LogsCard({ targetUserId }: { targetUserId: string }) {
    const t = useTranslations("devMode");
    const [tab, setTab] = useState<"jobs" | "errors" | "webhooks">("jobs");
    const [entries, setEntries] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [jobDetail, setJobDetail] = useState<any>(null);

    const load = async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/admin/dev-mode/logs?targetUserId=${targetUserId}&type=${tab}&limit=100`);
            const data: any = await res.json();
            setEntries(data.entries ?? []);
        } catch (e) { console.error(e); }
        finally { setLoading(false); }
    };

    useEffect(() => { load(); }, [tab, targetUserId]);

    const openJob = async (id: string) => {
        if (expanded === id) { setExpanded(null); setJobDetail(null); return; }
        setExpanded(id);
        setJobDetail(null);
        const res = await fetch(`/api/admin/dev-mode/jobs/${id}?targetUserId=${targetUserId}`);
        setJobDetail(await res.json());
    };

    return (
        <Section icon={<ScrollText className="w-5 h-5 text-fg-60" />} title={t("logsTitle")} desc={t("logsDesc")}>
            <div className="flex gap-2 border-b border-hairline pb-3">
                {(["jobs", "errors", "webhooks"] as const).map(tabId => (
                    <button key={tabId} onClick={() => setTab(tabId)}
                        className={`px-4 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${tab === tabId ? "bg-white text-black" : "text-fg-40 hover:text-fg"}`}>
                        {tabId}
                    </button>
                ))}
                <button onClick={load} disabled={loading} className="ml-auto px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest text-fg-40 hover:text-fg">
                    {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : "↻"}
                </button>
            </div>

            {entries.length === 0 ? (
                <p className="text-fg-40 text-xs font-medium italic text-center py-5 sm:py-8">{t("noEntries")}</p>
            ) : (
                <div className="space-y-2 max-h-[500px] overflow-y-auto">
                    {entries.map((e, i) => {
                        const id = e.id ?? e.webhook_id ?? String(i);
                        const isJob = tab === "jobs";
                        const ok = isJob ? e.status === "success" : (e.status ? e.status < 400 : e.state === "success");
                        return (
                            <div key={id} className="bg-surface-2/40 border border-hairline rounded-xl p-3">
                                <button onClick={() => isJob && openJob(e.id)}
                                    className="w-full flex items-center justify-between text-left">
                                    <div className="flex items-center gap-3 min-w-0">
                                        {ok ? <CheckCircle2 className="w-4 h-4 text-accent-hot shrink-0" /> : <AlertCircle className="w-4 h-4 text-soon shrink-0" />}
                                        <div className="min-w-0">
                                            <p className="text-xs font-bold text-fg truncate">{e.type ?? e.topic} {isJob && e.summary && <span className="text-fg-40">· {t("ordersSuffix", { n: e.summary.total ?? 0 })}</span>}</p>
                                            <p className="text-[10px] text-fg-40 font-medium flex items-center gap-2">
                                                <Calendar className="w-3 h-3" /> {e.started_at ?? e.created_at}
                                                {isJob && e.triggered_by && <span>· {e.triggered_by}</span>}
                                            </p>
                                        </div>
                                    </div>
                                    <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded ${ok ? "bg-[rgba(94,234,212,0.10)] text-accent-hot" : "bg-[rgba(245,158,11,0.10)] text-soon"}`}>
                                        {e.status ?? e.state ?? "-"}
                                    </span>
                                </button>
                                {isJob && expanded === e.id && (
                                    <pre className="mt-3 bg-surface rounded-lg p-3 text-[10px] font-mono whitespace-pre-wrap text-fg-60 max-h-80 overflow-y-auto">
                                        {jobDetail ? JSON.stringify(jobDetail, null, 2) : t("loadingDots")}
                                    </pre>
                                )}
                                {!isJob && e.payload && (
                                    <pre className="mt-2 text-[10px] font-mono text-fg-40 truncate">{typeof e.payload === "string" ? e.payload.slice(0, 200) : JSON.stringify(e.payload).slice(0, 200)}</pre>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </Section>
    );
}
