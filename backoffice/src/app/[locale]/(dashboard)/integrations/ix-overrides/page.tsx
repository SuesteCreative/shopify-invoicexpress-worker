"use client";

export const runtime = "edge";

import { useState, useEffect, useMemo } from "react";
import { Loader2, AlertTriangle, Search, ArrowLeft, Trash2, Plus, Pencil, Save, X } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";

type SourceProduct = {
    source_reference: string;
    source_product_id: string | null;
    source_variant_id: string | null;
    source_sku: string | null;
    title: string;
    variant_title: string | null;
    price: number;
};

type Override = {
    id: string;
    source_kind: string;
    source_reference: string;
    tax_rate: number | null;
    vat_inclusion: string | null;
    exemption_reason: string | null;
    name_override: string | null;
    source_name: string | null;
};

const TAX_PRESETS = [0, 6, 13, 23];
const EXEMPTION_PRESETS = ["", "M01", "M07", "M11", "M16", "M40", "M99"];

export default function IxOverridesPage() {
    const t = useTranslations("ixOverrides");
    const searchParams = useSearchParams();
    const sourceKind = (searchParams?.get("source_kind") === "stripe" ? "stripe" : "shopify") as "shopify" | "stripe";

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [sourceProducts, setSourceProducts] = useState<SourceProduct[]>([]);
    const [overrides, setOverrides] = useState<Map<string, Override>>(new Map());
    const [filterText, setFilterText] = useState("");
    const [editingRef, setEditingRef] = useState<string | null>(null);
    const [draft, setDraft] = useState<{ tax_rate: string; vat_inclusion: string; exemption_reason: string; name_override: string }>({ tax_rate: "", vat_inclusion: "", exemption_reason: "", name_override: "" });
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true); setError("");
            try {
                const [srcRes, ovRes] = await Promise.all([
                    fetch(`/api/integrations/source-products?source_kind=${sourceKind}`),
                    fetch(`/api/integrations/ix-overrides?source_kind=${sourceKind}`),
                ]);
                if (cancelled) return;
                if (!srcRes.ok) throw new Error((await srcRes.json().catch(() => ({} as any))).error ?? "Source products failed");
                if (!ovRes.ok) throw new Error((await ovRes.json().catch(() => ({} as any))).error ?? "Overrides failed");
                const src = await srcRes.json() as { products: SourceProduct[] };
                const ov = await ovRes.json() as { overrides: Override[] };
                setSourceProducts(src.products);
                const m = new Map<string, Override>();
                for (const o of ov.overrides) m.set(o.source_reference, o);
                setOverrides(m);
            } catch (e: any) {
                if (!cancelled) setError(e.message ?? "Load failed");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [sourceKind]);

    const filtered = useMemo(() => {
        const q = filterText.trim().toLowerCase();
        if (!q) return sourceProducts;
        return sourceProducts.filter(p =>
            p.title.toLowerCase().includes(q)
            || (p.source_sku ?? "").toLowerCase().includes(q)
            || p.source_reference.toLowerCase().includes(q)
        );
    }, [sourceProducts, filterText]);

    function openEdit(src: SourceProduct) {
        const existing = overrides.get(src.source_reference);
        setEditingRef(src.source_reference);
        setDraft({
            tax_rate: existing?.tax_rate != null ? String(existing.tax_rate) : "",
            vat_inclusion: existing?.vat_inclusion ?? "",
            exemption_reason: existing?.exemption_reason ?? "",
            name_override: existing?.name_override ?? "",
        });
    }

    async function save(src: SourceProduct) {
        setSaving(true); setError("");
        try {
            const body: any = {
                source_kind: sourceKind,
                source_reference: src.source_reference,
                source_name: src.title,
            };
            if (draft.tax_rate.trim()) body.tax_rate = Number(draft.tax_rate);
            if (draft.vat_inclusion === "inc" || draft.vat_inclusion === "exc") body.vat_inclusion = draft.vat_inclusion;
            if (draft.exemption_reason.trim()) body.exemption_reason = draft.exemption_reason.trim();
            if (draft.name_override.trim()) body.name_override = draft.name_override.trim();

            const res = await fetch("/api/integrations/ix-overrides", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error((await res.json().catch(() => ({} as any))).error ?? `HTTP ${res.status}`);
            const next = new Map(overrides);
            next.set(src.source_reference, {
                id: overrides.get(src.source_reference)?.id ?? "",
                source_kind: sourceKind,
                source_reference: src.source_reference,
                tax_rate: body.tax_rate ?? null,
                vat_inclusion: body.vat_inclusion ?? null,
                exemption_reason: body.exemption_reason ?? null,
                name_override: body.name_override ?? null,
                source_name: src.title,
            });
            setOverrides(next);
            setEditingRef(null);
        } catch (e: any) { setError(e.message ?? "Save failed"); }
        finally { setSaving(false); }
    }

    async function remove(src: SourceProduct) {
        setSaving(true); setError("");
        try {
            const res = await fetch(`/api/integrations/ix-overrides?source_kind=${sourceKind}&source_reference=${encodeURIComponent(src.source_reference)}`, { method: "DELETE" });
            if (!res.ok) throw new Error((await res.json().catch(() => ({} as any))).error ?? `HTTP ${res.status}`);
            const next = new Map(overrides); next.delete(src.source_reference); setOverrides(next);
            setEditingRef(null);
        } catch (e: any) { setError(e.message ?? "Delete failed"); }
        finally { setSaving(false); }
    }

    if (loading) {
        return <div className="min-h-[60vh] flex items-center justify-center"><Loader2 className="w-12 h-12 text-accent animate-spin opacity-50" /></div>;
    }

    const backHref = sourceKind === "stripe" ? "/integrations/stripe-ix" : "/integrations/shopify-ix";
    const overrideCount = overrides.size;

    return (
        <div className="space-y-10 animate-in fade-in duration-700">
            <div className="space-y-2">
                <Link href={backHref} className="text-[10px] font-black text-accent uppercase tracking-widest hover:text-fg transition-colors flex items-center gap-2 mb-4">
                    <ArrowLeft className="w-3 h-3" /> {t("backToIntegration", { source: sourceKind === "stripe" ? "Stripe + InvoiceXpress" : "Shopify + InvoiceXpress" })}
                </Link>
                <h1 className="text-3xl sm:text-4xl font-black tracking-tight">{t("title")}</h1>
                <p className="text-fg-60 font-medium max-w-2xl">{t("subtitle")}</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
                <StatCard label={t("statTotal")} value={sourceProducts.length} />
                <StatCard label={t("statOverridden")} value={overrideCount} accent={overrideCount > 0 ? "hot" : undefined} />
            </div>

            <div className="relative">
                <Search className="w-4 h-4 text-fg-40 absolute left-4 top-1/2 -translate-y-1/2" />
                <input
                    type="text" value={filterText} onChange={(e) => setFilterText(e.target.value)}
                    placeholder={t("filterPlaceholder")}
                    className="w-full bg-surface-2 border border-hairline rounded-xl pl-11 pr-4 py-3 text-sm focus:outline-none focus:border-accent transition-colors"
                />
            </div>

            {error && (
                <div className="glass p-4 rounded-xl border border-[rgba(239,68,68,0.30)] bg-[rgba(239,68,68,0.05)] flex items-start gap-3">
                    <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-red-400">{error}</p>
                </div>
            )}

            <div className="space-y-3">
                {filtered.map((src) => {
                    const ov = overrides.get(src.source_reference);
                    const isEditing = editingRef === src.source_reference;
                    const hasOverride = !!ov;
                    return (
                        <div key={src.source_reference} className={`glass rounded-2xl p-5 transition-all ${isEditing ? "border-accent ring-2 ring-accent/20" : "border-hairline"}`}>
                            <div className="flex items-center gap-4">
                                <div className="flex-1 min-w-0">
                                    <p className="font-bold text-sm truncate">{src.title}{src.variant_title ? ` / ${src.variant_title}` : ""}</p>
                                    <p className="text-[10px] text-fg-40 font-mono uppercase tracking-wider mt-0.5">
                                        {src.source_sku ? `SKU: ${src.source_sku}` : src.source_reference} · €{src.price.toFixed(2)}
                                    </p>
                                </div>
                                {hasOverride && !isEditing && (
                                    <div className="flex items-center gap-2">
                                        {ov!.tax_rate != null && <Pill label={`${ov!.tax_rate}% IVA`} color="accent" />}
                                        {ov!.vat_inclusion && <Pill label={ov!.vat_inclusion === "inc" ? t("vatInc") : t("vatExc")} color="soon" />}
                                        {ov!.exemption_reason && <Pill label={ov!.exemption_reason} color="hot" />}
                                        {ov!.name_override && <Pill label={t("renamed")} color="accent" />}
                                    </div>
                                )}
                                {!isEditing && (
                                    <button onClick={() => openEdit(src)} className="px-4 py-2 rounded-xl border border-hairline hover:border-rule text-[10px] font-black uppercase tracking-widest transition-colors flex items-center gap-2">
                                        {hasOverride ? <><Pencil className="w-3 h-3" /> {t("edit")}</> : <><Plus className="w-3 h-3" /> {t("addOverride")}</>}
                                    </button>
                                )}
                            </div>

                            {isEditing && (
                                <div className="mt-5 pt-5 border-t border-hairline space-y-4">
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        <Field label={t("taxRate")}>
                                            <div className="flex flex-wrap gap-2">
                                                {TAX_PRESETS.map(rate => (
                                                    <button key={rate} type="button" onClick={() => setDraft({ ...draft, tax_rate: String(rate) })}
                                                        className={`px-3 py-1.5 rounded-lg text-xs font-mono uppercase tracking-wider border transition-colors ${draft.tax_rate === String(rate) ? "border-accent bg-accent/10 text-accent" : "border-hairline text-fg-60 hover:border-rule"}`}>
                                                        {rate}%
                                                    </button>
                                                ))}
                                                <input type="text" value={draft.tax_rate} onChange={(e) => setDraft({ ...draft, tax_rate: e.target.value })}
                                                    placeholder={t("custom")} className="px-3 py-1.5 rounded-lg text-xs font-mono uppercase tracking-wider border border-hairline bg-surface-2 w-24 focus:border-accent focus:outline-none" />
                                                {draft.tax_rate && (
                                                    <button type="button" onClick={() => setDraft({ ...draft, tax_rate: "" })} className="px-2 py-1.5 rounded-lg text-xs text-fg-40 hover:text-fg">
                                                        <X className="w-3 h-3" />
                                                    </button>
                                                )}
                                            </div>
                                        </Field>
                                        <Field label={t("vatInclusion")}>
                                            <div className="flex gap-2">
                                                {["", "inc", "exc"].map(v => (
                                                    <button key={v || "default"} type="button" onClick={() => setDraft({ ...draft, vat_inclusion: v })}
                                                        className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-mono uppercase tracking-wider border transition-colors ${draft.vat_inclusion === v ? "border-accent bg-accent/10 text-accent" : "border-hairline text-fg-60 hover:border-rule"}`}>
                                                        {v === "" ? t("vatDefault") : v === "inc" ? t("vatInc") : t("vatExc")}
                                                    </button>
                                                ))}
                                            </div>
                                        </Field>
                                        <Field label={t("exemptionReason")}>
                                            <select value={draft.exemption_reason} onChange={(e) => setDraft({ ...draft, exemption_reason: e.target.value })}
                                                className="w-full bg-surface-2 border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent font-mono">
                                                {EXEMPTION_PRESETS.map(code => (
                                                    <option key={code || "default"} value={code}>{code || t("noExemption")}</option>
                                                ))}
                                            </select>
                                        </Field>
                                        <Field label={t("nameOverride")}>
                                            <input type="text" value={draft.name_override} onChange={(e) => setDraft({ ...draft, name_override: e.target.value })}
                                                placeholder={src.title}
                                                className="w-full bg-surface-2 border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent" />
                                        </Field>
                                    </div>
                                    <div className="flex items-center justify-end gap-2 pt-2">
                                        {hasOverride && (
                                            <button onClick={() => remove(src)} disabled={saving} className="px-4 py-2 rounded-xl text-destructive hover:bg-destructive/10 text-[10px] font-black uppercase tracking-widest transition-colors flex items-center gap-2 disabled:opacity-50">
                                                <Trash2 className="w-3 h-3" /> {t("removeOverride")}
                                            </button>
                                        )}
                                        <button onClick={() => setEditingRef(null)} className="px-4 py-2 rounded-xl border border-hairline text-fg-60 hover:text-fg text-[10px] font-black uppercase tracking-widest">
                                            {t("cancel")}
                                        </button>
                                        <button onClick={() => save(src)} disabled={saving} className="px-5 py-2 rounded-xl bg-accent-hot text-surface text-[10px] font-black uppercase tracking-widest flex items-center gap-2 disabled:opacity-50">
                                            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} {t("save")}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
                {filtered.length === 0 && <p className="text-center text-fg-40 text-sm py-12">{filterText ? t("noSearchResults") : t("noSourceProducts")}</p>}
            </div>
        </div>
    );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent?: "hot" }) {
    return (
        <div className="glass p-5 rounded-2xl border-hairline">
            <p className="text-[10px] font-black text-fg-40 uppercase tracking-[0.2em]">{label}</p>
            <p className={`text-3xl font-black mt-1 ${accent === "hot" ? "text-accent-hot" : "text-fg"}`}>{value}</p>
        </div>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="space-y-1.5">
            <label className="text-[10px] font-black text-fg-40 uppercase tracking-[0.2em] block">{label}</label>
            {children}
        </div>
    );
}

function Pill({ label, color }: { label: string; color: "accent" | "soon" | "hot" }) {
    const cls = color === "accent" ? "bg-[rgba(2,141,196,0.10)] text-accent border-[rgba(2,141,196,0.30)]"
        : color === "soon" ? "bg-[rgba(245,158,11,0.10)] text-soon border-[rgba(245,158,11,0.30)]"
            : "bg-[rgba(94,234,212,0.10)] text-accent-hot border-[rgba(94,234,212,0.30)]";
    return <span className={`px-2 py-0.5 rounded-md text-[10px] font-mono uppercase tracking-wider border ${cls}`}>{label}</span>;
}
