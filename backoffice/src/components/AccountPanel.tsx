"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import {
    IdCard, Copy, Check, Loader2, Lock, Save, Send, X, Receipt, Zap, AlertCircle,
} from "lucide-react";

/**
 * The merchant's own record.
 *
 * Reads and writes the same `/api/user/profile` the onboarding wizards use —
 * there is one statement that owns this row and adding a second would be a
 * second place for the fiscal guard to be forgotten.
 *
 * The NIF and the legal company name are shown locked. Not because the input is
 * disabled (it is, but that is cosmetic): the route refuses to move them once
 * the account is registered, whatever the request says. What a merchant gets
 * instead is a way to ask, which reaches an operator and is recorded.
 */

interface Profile {
    id: string;
    email: string | null;
    name: string | null;
    nif: string | null;
    company_name: string | null;
    fiscal_address: string | null;
    phone: string | null;
    website: string | null;
    registration_completed: number;
    privacy_policy_accepted: number;
    privacy_policy_accepted_at: string | null;
    client_code: string | null;
}

type RequestField = "nif" | "company_name";

export default function AccountPanel() {
    const t = useTranslations("conta");

    const [profile, setProfile] = useState<Profile | null>(null);
    const [form, setForm] = useState({ name: "", phone: "", website: "", fiscal_address: "" });
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [asking, setAsking] = useState<RequestField | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch("/api/user/profile");
            if (!res.ok) { setError(t("loadError")); return; }
            const p: Profile = await res.json();
            setProfile(p);
            setForm({
                name: p.name ?? "",
                phone: p.phone ?? "",
                website: p.website ?? "",
                fiscal_address: p.fiscal_address ?? "",
            });
        } catch {
            setError(t("loadError"));
        } finally {
            setLoading(false);
        }
    }, [t]);

    useEffect(() => { load(); }, [load]);

    const save = async () => {
        if (!profile) return;
        setSaving(true); setError(null); setSaved(false);
        try {
            const res = await fetch("/api/user/profile", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    // The whole profile, as every other caller of this route
                    // sends it. The two fiscal fields go back unchanged and the
                    // statement ignores them anyway.
                    nif: profile.nif ?? "",
                    company_name: profile.company_name ?? "",
                    name: form.name,
                    fiscal_address: form.fiscal_address,
                    phone: form.phone,
                    website: form.website,
                    privacy_policy_accepted: profile.privacy_policy_accepted === 1,
                }),
            });
            if (!res.ok) { setError(t("saveError")); return; }
            setSaved(true);
            setTimeout(() => setSaved(false), 2500);
            load();
        } catch {
            setError(t("saveError"));
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center gap-3 text-fg-40 text-sm font-bold">
                <Loader2 className="w-4 h-4 animate-spin" /> {t("loading")}
            </div>
        );
    }

    if (!profile) {
        return <p className="text-sm text-destructive font-medium">{error ?? t("loadError")}</p>;
    }

    const pending = profile.registration_completed !== 1;

    return (
        <div className="space-y-8 animate-in fade-in duration-500">
            <header className="space-y-3">
                <h1 className="text-3xl sm:text-4xl font-black tracking-tight">{t("title")}</h1>
                <p className="text-fg-40 text-sm font-medium max-w-2xl">{t("subtitle")}</p>
            </header>

            {/* The customer number */}
            <section className="glass rounded-[2rem] p-6 sm:p-8 border-hairline space-y-4">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-surface-2 border border-hairline flex items-center justify-center shrink-0">
                        <IdCard className="w-5 h-5 text-accent-ink" />
                    </div>
                    <div>
                        <h2 className="text-lg font-black tracking-tight">{t("codeLabel")}</h2>
                        <p className="text-fg-40 text-xs font-medium mt-1">{t("codeHelp")}</p>
                    </div>
                </div>
                {profile.client_code ? (
                    <button
                        type="button"
                        onClick={() => {
                            navigator.clipboard?.writeText(profile.client_code!)
                                .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
                                .catch(() => { /* no clipboard: the code is still readable */ });
                        }}
                        className="inline-flex items-center gap-3 px-4 py-2.5 rounded-2xl bg-surface-2 border border-hairline font-mono text-sm tracking-[0.22em] text-fg hover:bg-fg/5 transition-colors"
                    >
                        {copied ? <Check className="w-4 h-4 text-accent-ink" /> : <Copy className="w-4 h-4 text-fg-40" />}
                        {profile.client_code}
                    </button>
                ) : (
                    <p className="text-sm text-fg-40 font-medium">{t("codeMissing")}</p>
                )}
            </section>

            {pending && (
                <div className="glass rounded-2xl border border-soon/30 bg-soon/5 p-4 flex items-start gap-3">
                    <AlertCircle className="w-4 h-4 text-soon shrink-0 mt-0.5" />
                    <p className="text-xs font-medium text-fg-40">{t("registrationPending")}</p>
                </div>
            )}

            {/* Fiscal identity — read only */}
            <section className="glass rounded-[2rem] p-6 sm:p-8 border-hairline space-y-6">
                <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-xl bg-surface-2 border border-hairline flex items-center justify-center shrink-0">
                        <Lock className="w-5 h-5 text-fg-40" />
                    </div>
                    <div>
                        <h2 className="text-lg font-black tracking-tight">{t("fiscalTitle")}</h2>
                        <p className="text-fg-40 text-xs font-medium mt-1">{t("fiscalHelp")}</p>
                    </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                    {(["nif", "company_name"] as RequestField[]).map((field) => (
                        <div key={field} className="space-y-2">
                            <span className="text-[10px] font-black uppercase tracking-widest text-fg-40">
                                {field === "nif" ? t("nif") : t("companyName")}
                            </span>
                            <div className="flex items-center gap-2 flex-wrap">
                                <span className={`text-sm font-bold text-fg ${field === "nif" ? "font-mono" : ""}`}>
                                    {profile[field] || "—"}
                                </span>
                                {!pending && (
                                    <button type="button" onClick={() => setAsking(field)}
                                        className="text-[10px] font-black uppercase tracking-widest text-accent-ink hover:underline">
                                        {t("requestChange")}
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            {asking && (
                <ChangeRequest field={asking} current={profile[asking] ?? ""} onClose={() => setAsking(null)} />
            )}

            {/* What they can change */}
            <section className="glass rounded-[2rem] p-6 sm:p-8 border-hairline space-y-6">
                <div>
                    <h2 className="text-lg font-black tracking-tight">{t("dataTitle")}</h2>
                    <p className="text-fg-40 text-xs font-medium mt-1">{t("dataHelp")}</p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                    <Input label={t("name")} value={form.name} onChange={(v) => setForm(f => ({ ...f, name: v }))} />
                    <Input label={t("phone")} value={form.phone} onChange={(v) => setForm(f => ({ ...f, phone: v }))} />
                    <Input label={t("website")} value={form.website} onChange={(v) => setForm(f => ({ ...f, website: v }))} />
                    <Input label={t("address")} value={form.fiscal_address} onChange={(v) => setForm(f => ({ ...f, fiscal_address: v }))} />
                    <div className="space-y-2">
                        <span className="text-[10px] font-black uppercase tracking-widest text-fg-40">{t("email")}</span>
                        <p className="text-sm font-bold text-fg">{profile.email || "—"}</p>
                        <p className="text-[10px] text-fg-40 font-medium">{t("emailHelp")}</p>
                    </div>
                </div>

                <p className="text-[11px] text-fg-40 font-medium max-w-2xl">{t("invoiceNote")}</p>

                <div className="flex items-center gap-3 flex-wrap">
                    <button type="button" onClick={save} disabled={saving}
                        className="bg-fg text-surface px-5 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2 hover:opacity-90 transition-all disabled:opacity-30">
                        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                        {saving ? t("saving") : t("save")}
                    </button>
                    {saved && <span className="text-[10px] font-black uppercase tracking-widest text-accent-ink">{t("saved")}</span>}
                    {error && <span className="text-[10px] font-black uppercase tracking-widest text-destructive">{error}</span>}
                </div>
            </section>

            {/* Where the rest lives */}
            <section className="flex flex-wrap gap-3">
                <Link href="/faturacao"
                    className="glass rounded-2xl border-hairline px-5 py-4 flex items-center gap-3 hover:bg-fg/5 transition-colors">
                    <Receipt className="w-4 h-4 text-accent-ink" />
                    <span className="text-xs font-black uppercase tracking-widest">{t("linkBilling")}</span>
                </Link>
                <Link href="/integrations"
                    className="glass rounded-2xl border-hairline px-5 py-4 flex items-center gap-3 hover:bg-fg/5 transition-colors">
                    <Zap className="w-4 h-4 text-accent-ink" />
                    <span className="text-xs font-black uppercase tracking-widest">{t("linkIntegrations")}</span>
                </Link>
            </section>
        </div>
    );
}

function Input({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
    return (
        <label className="space-y-2 block">
            <span className="text-[10px] font-black uppercase tracking-widest text-fg-40">{label}</span>
            <input
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="w-full bg-surface-2 border border-hairline rounded-xl px-4 py-3 text-sm font-medium text-fg focus:outline-none focus:border-accent/40 transition-colors"
            />
        </label>
    );
}

function ChangeRequest({ field, current, onClose }: { field: RequestField; current: string; onClose: () => void }) {
    const t = useTranslations("conta");
    const [requested, setRequested] = useState("");
    const [note, setNote] = useState("");
    const [sending, setSending] = useState(false);
    const [done, setDone] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const send = async () => {
        setSending(true); setError(null);
        try {
            const res = await fetch("/api/user/identity-request", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ field, requested, note }),
            });
            const body: any = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(body?.error === "already_that_value" ? t("requestSame") : t("requestError"));
                return;
            }
            setDone(true);
        } catch {
            setError(t("requestError"));
        } finally {
            setSending(false);
        }
    };

    return (
        <section className="glass rounded-[2rem] p-6 sm:p-8 border border-accent/30 space-y-5">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h2 className="text-lg font-black tracking-tight">
                        {t("requestTitle", { field: field === "nif" ? t("nif") : t("companyName") })}
                    </h2>
                    <p className="text-fg-40 text-xs font-medium mt-1">{t("requestHelp")}</p>
                </div>
                <button type="button" onClick={onClose} aria-label={t("requestCancel")}
                    className="p-2 rounded-xl hover:bg-surface-2 transition-colors">
                    <X className="w-4 h-4 text-fg-40" />
                </button>
            </div>

            {done ? (
                <p className="text-sm font-bold text-accent-ink">{t("requestSent")}</p>
            ) : (
                <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                        <div className="space-y-2">
                            <span className="text-[10px] font-black uppercase tracking-widest text-fg-40">{t("requestCurrent")}</span>
                            <p className="text-sm font-bold text-fg">{current || "—"}</p>
                        </div>
                        <Input label={t("requestNew")} value={requested} onChange={setRequested} />
                    </div>
                    <Input label={t("requestNote")} value={note} onChange={setNote} />
                    <div className="flex items-center gap-3 flex-wrap">
                        <button type="button" onClick={send} disabled={sending || !requested.trim()}
                            className="bg-fg text-surface px-5 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2 hover:opacity-90 transition-all disabled:opacity-30">
                            {sending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                            {t("requestSend")}
                        </button>
                        {error && <span className="text-[10px] font-black uppercase tracking-widest text-destructive">{error}</span>}
                    </div>
                </>
            )}
        </section>
    );
}
