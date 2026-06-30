"use client";

export const runtime = "edge";

import { useState, useEffect } from "react";
import { Loader2, AlertTriangle, ArrowLeft, Trash2, Plus, Save, X } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";

type Sequence = { id: number; serie: string };

type Rule = {
    id: string;
    source_kind: string;
    destination_kind: string;
    tag_name: string;
    document_type: string | null;
    series_name: string | null;
};

type DraftRule = {
    tag_name: string;
    document_type: string;
    series_name: string;
};

const EMPTY_DRAFT: DraftRule = { tag_name: "", document_type: "", series_name: "" };

export default function TagRoutingPage() {
    const t = useTranslations("tagRouting");
    const searchParams = useSearchParams();
    const sourceKind = (searchParams?.get("source_kind") === "stripe" ? "stripe" : "shopify") as "shopify" | "stripe";

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [rules, setRules] = useState<Rule[]>([]);
    const [sequences, setSequences] = useState<Sequence[]>([]);
    const [sequencesLoaded, setSequencesLoaded] = useState(false);

    // Inline add form
    const [adding, setAdding] = useState(false);
    const [draft, setDraft] = useState<DraftRule>(EMPTY_DRAFT);
    const [saving, setSaving] = useState(false);
    const [deletingId, setDeletingId] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true); setError("");
            try {
                const res = await fetch(`/api/integrations/tag-routing?source_kind=${sourceKind}&destination_kind=invoicexpress`);
                if (cancelled) return;
                if (!res.ok) throw new Error((await res.json().catch(() => ({} as any)) as any).error ?? "Load failed");
                const data = await res.json() as { rules: Rule[] };
                setRules(data.rules);
            } catch (e: any) {
                if (!cancelled) setError(e.message ?? "Load failed");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [sourceKind]);

    async function loadSequences() {
        if (sequencesLoaded) return;
        try {
            const res = await fetch("/api/integrations/sequences");
            if (!res.ok) return;
            const data = await res.json() as Sequence[];
            setSequences(data);
            setSequencesLoaded(true);
        } catch {
            // Non-critical: sequences dropdown stays empty
        }
    }

    function openAdd() {
        setDraft(EMPTY_DRAFT);
        setAdding(true);
        loadSequences();
    }

    async function saveRule() {
        if (!draft.tag_name.trim()) { setError(t("tagNameRequired")); return; }
        if (!draft.document_type && !draft.series_name.trim()) { setError(t("atLeastOne")); return; }
        setSaving(true); setError("");
        try {
            const body: any = {
                source_kind: sourceKind,
                destination_kind: "invoicexpress",
                tag_name: draft.tag_name.trim(),
            };
            if (draft.document_type) body.document_type = draft.document_type;
            if (draft.series_name.trim()) body.series_name = draft.series_name.trim();

            const res = await fetch("/api/integrations/tag-routing", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error((await res.json().catch(() => ({} as any)) as any).error ?? `HTTP ${res.status}`);

            // Reload rules to get the newly persisted id + created_at ordering
            const listRes = await fetch(`/api/integrations/tag-routing?source_kind=${sourceKind}&destination_kind=invoicexpress`);
            const listData = await listRes.json() as { rules: Rule[] };
            setRules(listData.rules);
            setAdding(false);
            setDraft(EMPTY_DRAFT);
        } catch (e: any) { setError(e.message ?? "Save failed"); }
        finally { setSaving(false); }
    }

    async function deleteRule(id: string) {
        setDeletingId(id); setError("");
        try {
            const res = await fetch(`/api/integrations/tag-routing?id=${encodeURIComponent(id)}`, { method: "DELETE" });
            if (!res.ok) throw new Error((await res.json().catch(() => ({} as any)) as any).error ?? `HTTP ${res.status}`);
            setRules(prev => prev.filter(r => r.id !== id));
        } catch (e: any) { setError(e.message ?? "Delete failed"); }
        finally { setDeletingId(null); }
    }

    if (loading) {
        return <div className="min-h-[60vh] flex items-center justify-center"><Loader2 className="w-12 h-12 text-accent animate-spin opacity-50" /></div>;
    }

    const backHref = sourceKind === "stripe" ? "/integrations/stripe-ix" : "/integrations/shopify-ix";

    return (
        <div className="space-y-10 animate-in fade-in duration-700">
            <div className="space-y-2">
                <Link href={backHref} className="text-[10px] font-black text-accent uppercase tracking-widest hover:text-fg transition-colors flex items-center gap-2 mb-4">
                    <ArrowLeft className="w-3 h-3" /> {t("back", { source: sourceKind === "stripe" ? "Stripe + InvoiceXpress" : "Shopify + InvoiceXpress" })}
                </Link>
                <h1 className="text-3xl sm:text-4xl font-black tracking-tight">{t("title")}</h1>
                <p className="text-fg-60 font-medium max-w-2xl">{t("subtitle")}</p>
            </div>

            {error && (
                <div className="glass p-4 rounded-xl border border-[rgba(239,68,68,0.30)] bg-[rgba(239,68,68,0.05)] flex items-start gap-3">
                    <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-red-400">{error}</p>
                </div>
            )}

            {/* Rules table */}
            <div className="space-y-3">
                {/* Header */}
                {rules.length > 0 && (
                    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-4 px-5 py-2">
                        <span className="text-[10px] font-black text-fg-40 uppercase tracking-[0.2em]">{t("colTag")}</span>
                        <span className="text-[10px] font-black text-fg-40 uppercase tracking-[0.2em] w-36 text-center">{t("colType")}</span>
                        <span className="text-[10px] font-black text-fg-40 uppercase tracking-[0.2em] w-24 text-center">{t("colSeries")}</span>
                        <span className="w-8" />
                    </div>
                )}

                {rules.map((rule) => (
                    <div key={rule.id} className="glass rounded-2xl p-5 border-hairline grid grid-cols-[1fr_auto_auto_auto] gap-4 items-center">
                        <span className="font-mono text-sm truncate">{rule.tag_name}</span>
                        <span className="w-36 text-center">
                            {rule.document_type
                                ? <Badge label={rule.document_type === "invoice_receipt" ? t("typeReceipt") : t("typeInvoice")} color="accent" />
                                : <span className="text-[10px] text-fg-40 uppercase tracking-wider">{t("typeDefault")}</span>
                            }
                        </span>
                        <span className="w-24 text-center">
                            {rule.series_name
                                ? <Badge label={rule.series_name} color="hot" />
                                : <span className="text-[10px] text-fg-40 uppercase tracking-wider">{t("seriesDefault")}</span>
                            }
                        </span>
                        <button
                            onClick={() => deleteRule(rule.id)}
                            disabled={deletingId === rule.id}
                            className="w-8 h-8 rounded-lg flex items-center justify-center text-fg-40 hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                        >
                            {deletingId === rule.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                        </button>
                    </div>
                ))}

                {rules.length === 0 && !adding && (
                    <p className="text-center text-fg-40 text-sm py-12">{t("empty")}</p>
                )}

                {/* Inline add form */}
                {adding && (
                    <div className="glass rounded-2xl p-5 border-accent ring-2 ring-accent/20 space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <div className="space-y-1.5">
                                <label className="text-[10px] font-black text-fg-40 uppercase tracking-[0.2em] block">{t("colTag")}</label>
                                <input
                                    type="text"
                                    value={draft.tag_name}
                                    onChange={(e) => setDraft({ ...draft, tag_name: e.target.value })}
                                    placeholder={t("tagPlaceholder")}
                                    className="w-full bg-surface-2 border border-hairline rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent"
                                />
                            </div>
                            <div className="space-y-1.5">
                                <label className="text-[10px] font-black text-fg-40 uppercase tracking-[0.2em] block">{t("colType")}</label>
                                <select
                                    value={draft.document_type}
                                    onChange={(e) => setDraft({ ...draft, document_type: e.target.value })}
                                    className="w-full bg-surface-2 border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent"
                                >
                                    <option value="">{t("typeDefault")}</option>
                                    <option value="invoice">{t("typeInvoice")}</option>
                                    <option value="invoice_receipt">{t("typeReceipt")}</option>
                                </select>
                            </div>
                            <div className="space-y-1.5">
                                <label className="text-[10px] font-black text-fg-40 uppercase tracking-[0.2em] block">{t("colSeries")}</label>
                                {sequences.length > 0 ? (
                                    <select
                                        value={draft.series_name}
                                        onChange={(e) => setDraft({ ...draft, series_name: e.target.value })}
                                        className="w-full bg-surface-2 border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent font-mono"
                                    >
                                        <option value="">{t("seriesDefault")}</option>
                                        {sequences.map(s => (
                                            <option key={s.id} value={s.serie}>{s.serie}</option>
                                        ))}
                                    </select>
                                ) : (
                                    <input
                                        type="text"
                                        value={draft.series_name}
                                        onChange={(e) => setDraft({ ...draft, series_name: e.target.value })}
                                        placeholder={t("seriesPlaceholder")}
                                        className="w-full bg-surface-2 border border-hairline rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent"
                                    />
                                )}
                            </div>
                        </div>
                        <div className="flex items-center justify-end gap-2 pt-1">
                            <button
                                onClick={() => { setAdding(false); setDraft(EMPTY_DRAFT); setError(""); }}
                                className="px-4 py-2 rounded-xl border border-hairline text-fg-60 hover:text-fg text-[10px] font-black uppercase tracking-widest flex items-center gap-2"
                            >
                                <X className="w-3 h-3" /> {t("cancel")}
                            </button>
                            <button
                                onClick={saveRule}
                                disabled={saving}
                                className="px-5 py-2 rounded-xl bg-accent-hot text-surface text-[10px] font-black uppercase tracking-widest flex items-center gap-2 disabled:opacity-50"
                            >
                                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} {t("save")}
                            </button>
                        </div>
                    </div>
                )}

                {/* Add button */}
                {!adding && (
                    <button
                        onClick={openAdd}
                        className="w-full py-4 rounded-2xl border border-dashed border-hairline hover:border-accent text-fg-40 hover:text-accent text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-colors"
                    >
                        <Plus className="w-3.5 h-3.5" /> {t("addRule")}
                    </button>
                )}
            </div>
        </div>
    );
}

function Badge({ label, color }: { label: string; color: "accent" | "hot" }) {
    const cls = color === "accent"
        ? "bg-[rgba(2,141,196,0.10)] text-accent border-[rgba(2,141,196,0.30)]"
        : "bg-[rgba(94,234,212,0.10)] text-accent-hot border-[rgba(94,234,212,0.30)]";
    return (
        <span className={`px-2 py-0.5 rounded-md text-[10px] font-mono uppercase tracking-wider border ${cls}`}>
            {label}
        </span>
    );
}
