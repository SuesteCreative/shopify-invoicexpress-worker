"use client";

export const runtime = "edge";

import { useState, useEffect, useMemo } from "react";
import { Loader2, Check, AlertTriangle, ChevronRight, Search, ArrowLeft, Link2, Unlink, Sparkles } from "lucide-react";
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

type MoloniProduct = {
    product_id: number;
    reference: string;
    name: string;
    price: number;
};

type Mapping = {
    id: string;
    source_kind: string;
    source_reference: string;
    destination_product_id: number;
    destination_reference: string | null;
    destination_name: string | null;
    source_name: string | null;
};

export default function MoloniMappingsPage() {
    const t = useTranslations("moloniMappings");
    const searchParams = useSearchParams();
    const sourceKind = (searchParams?.get("source_kind") === "stripe" ? "stripe" : "shopify") as "shopify" | "stripe";

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState<string | null>(null); // source_reference being saved
    const [error, setError] = useState("");

    const [sourceProducts, setSourceProducts] = useState<SourceProduct[]>([]);
    const [moloniProducts, setMoloniProducts] = useState<MoloniProduct[]>([]);
    const [mappings, setMappings] = useState<Map<string, Mapping>>(new Map());
    const [filterText, setFilterText] = useState("");

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError("");
            try {
                const [srcRes, molRes, mapRes] = await Promise.all([
                    fetch(`/api/integrations/source-products?source_kind=${sourceKind}`),
                    fetch(`/api/integrations/moloni-products?source_kind=${sourceKind}&limit=200`),
                    fetch(`/api/integrations/moloni-mappings?source_kind=${sourceKind}`),
                ]);
                if (cancelled) return;

                if (!srcRes.ok) {
                    const json: any = await srcRes.json().catch(() => ({}));
                    throw new Error(json.error ?? `Source products: HTTP ${srcRes.status}`);
                }
                if (!molRes.ok) {
                    const json: any = await molRes.json().catch(() => ({}));
                    throw new Error(json.error ?? `Moloni products: HTTP ${molRes.status}`);
                }
                if (!mapRes.ok) {
                    const json: any = await mapRes.json().catch(() => ({}));
                    throw new Error(json.error ?? `Mappings: HTTP ${mapRes.status}`);
                }

                const src = await srcRes.json() as { products: SourceProduct[] };
                const mol = await molRes.json() as { products: MoloniProduct[] };
                const map = await mapRes.json() as { mappings: Mapping[] };

                setSourceProducts(src.products);
                setMoloniProducts(mol.products);
                const m = new Map<string, Mapping>();
                for (const row of map.mappings) m.set(row.source_reference, row);
                setMappings(m);
            } catch (e: any) {
                if (!cancelled) setError(e.message ?? "Failed to load");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [sourceKind]);

    // Auto-suggest by exact SKU match: source_reference === moloni reference
    const moloniByReference = useMemo(() => {
        const m = new Map<string, MoloniProduct>();
        for (const p of moloniProducts) {
            if (p.reference) m.set(p.reference, p);
        }
        return m;
    }, [moloniProducts]);

    const filteredSourceProducts = useMemo(() => {
        const q = filterText.trim().toLowerCase();
        if (!q) return sourceProducts;
        return sourceProducts.filter(p =>
            p.title.toLowerCase().includes(q)
            || (p.source_sku ?? "").toLowerCase().includes(q)
            || p.source_reference.toLowerCase().includes(q)
        );
    }, [sourceProducts, filterText]);

    async function saveMapping(source: SourceProduct, dest: MoloniProduct) {
        setSaving(source.source_reference);
        setError("");
        try {
            const res = await fetch("/api/integrations/moloni-mappings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    source_kind: sourceKind,
                    source_reference: source.source_reference,
                    destination_product_id: dest.product_id,
                    destination_reference: dest.reference,
                    destination_name: dest.name,
                    source_name: source.title,
                }),
            });
            if (!res.ok) {
                const json: any = await res.json().catch(() => ({}));
                throw new Error(json.error ?? `HTTP ${res.status}`);
            }
            const next = new Map(mappings);
            next.set(source.source_reference, {
                id: "", source_kind: sourceKind,
                source_reference: source.source_reference,
                destination_product_id: dest.product_id,
                destination_reference: dest.reference,
                destination_name: dest.name,
                source_name: source.title,
            });
            setMappings(next);
        } catch (e: any) {
            setError(e.message ?? "Save failed");
        } finally {
            setSaving(null);
        }
    }

    async function unmapSource(source: SourceProduct) {
        setSaving(source.source_reference);
        setError("");
        try {
            const url = `/api/integrations/moloni-mappings?source_kind=${sourceKind}&source_reference=${encodeURIComponent(source.source_reference)}`;
            const res = await fetch(url, { method: "DELETE" });
            if (!res.ok) {
                const json: any = await res.json().catch(() => ({}));
                throw new Error(json.error ?? `HTTP ${res.status}`);
            }
            const next = new Map(mappings);
            next.delete(source.source_reference);
            setMappings(next);
        } catch (e: any) {
            setError(e.message ?? "Delete failed");
        } finally {
            setSaving(null);
        }
    }

    async function autoMapAll() {
        let mapped = 0;
        for (const src of sourceProducts) {
            if (mappings.has(src.source_reference)) continue;
            const suggestion = moloniByReference.get(src.source_reference);
            if (!suggestion) continue;
            await saveMapping(src, suggestion);
            mapped++;
        }
        if (mapped === 0) setError(t("noAutoMatches"));
    }

    if (loading) {
        return (
            <div className="min-h-[60vh] flex items-center justify-center">
                <Loader2 className="w-12 h-12 text-accent animate-spin opacity-50" />
            </div>
        );
    }

    const backHref = sourceKind === "stripe" ? "/integrations/stripe-moloni" : "/integrations/shopify-moloni";
    const mappedCount = mappings.size;
    const unmappedCount = sourceProducts.filter(p => !mappings.has(p.source_reference)).length;
    const autoMatchableCount = sourceProducts.filter(p =>
        !mappings.has(p.source_reference) && moloniByReference.has(p.source_reference)
    ).length;

    return (
        <div className="space-y-10 animate-in fade-in duration-700">
            <div className="space-y-2">
                <Link href={backHref} className="text-[10px] font-black text-accent uppercase tracking-widest hover:text-fg transition-colors flex items-center gap-2 mb-4">
                    <ArrowLeft className="w-3 h-3" /> {t("backToIntegration", { source: sourceKind === "stripe" ? "Stripe + Moloni" : "Shopify + Moloni" })}
                </Link>
                <h1 className="text-3xl sm:text-4xl font-black tracking-tight">{t("title")}</h1>
                <p className="text-fg-60 font-medium max-w-2xl">{t("subtitle", { source: sourceKind })}</p>
            </div>

            <div className="grid grid-cols-3 gap-4">
                <StatCard label={t("statTotal")} value={sourceProducts.length} />
                <StatCard label={t("statMapped")} value={mappedCount} accent="hot" />
                <StatCard label={t("statUnmapped")} value={unmappedCount} accent={unmappedCount > 0 ? "soon" : undefined} />
            </div>

            {autoMatchableCount > 0 && (
                <div className="glass p-5 rounded-2xl border border-[rgba(94,234,212,0.30)] bg-[rgba(94,234,212,0.04)] flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                        <Sparkles className="w-5 h-5 text-accent-hot" />
                        <p className="text-sm text-fg">{t("autoSuggestBanner", { count: autoMatchableCount })}</p>
                    </div>
                    <button onClick={autoMapAll} disabled={saving !== null} className="px-5 py-2.5 rounded-xl bg-accent-hot text-surface font-mono text-[10px] uppercase tracking-[0.18em] hover:bg-accent transition-colors disabled:opacity-50">
                        {t("autoMapAll")}
                    </button>
                </div>
            )}

            <div className="relative">
                <Search className="w-4 h-4 text-fg-40 absolute left-4 top-1/2 -translate-y-1/2" />
                <input
                    type="text"
                    value={filterText}
                    onChange={(e) => setFilterText(e.target.value)}
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
                {filteredSourceProducts.map((src) => {
                    const mapping = mappings.get(src.source_reference);
                    const suggestion = !mapping ? moloniByReference.get(src.source_reference) : undefined;
                    const isSaving = saving === src.source_reference;
                    return (
                        <div key={src.source_reference} className="glass rounded-2xl p-5 flex items-center gap-4 border-hairline">
                            <div className="flex-1 min-w-0">
                                <p className="font-bold text-sm truncate">{src.title}{src.variant_title ? ` / ${src.variant_title}` : ""}</p>
                                <p className="text-[10px] text-fg-40 font-mono uppercase tracking-wider mt-0.5">
                                    {src.source_sku ? `SKU: ${src.source_sku}` : src.source_reference} · €{src.price.toFixed(2)}
                                </p>
                            </div>

                            <ChevronRight className="w-4 h-4 text-fg-40 shrink-0" />

                            <div className="flex-1 min-w-0">
                                {mapping ? (
                                    <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[rgba(94,234,212,0.05)] border border-[rgba(94,234,212,0.30)]">
                                        <Link2 className="w-3.5 h-3.5 text-accent-hot shrink-0" />
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-bold text-fg truncate">{mapping.destination_name ?? `Moloni #${mapping.destination_product_id}`}</p>
                                            <p className="text-[10px] text-fg-40 font-mono uppercase tracking-wider truncate">{mapping.destination_reference} · ID {mapping.destination_product_id}</p>
                                        </div>
                                    </div>
                                ) : suggestion ? (
                                    <button
                                        onClick={() => saveMapping(src, suggestion)}
                                        disabled={isSaving}
                                        className="w-full flex items-center gap-2 px-3 py-2 rounded-xl border border-[rgba(245,158,11,0.30)] bg-[rgba(245,158,11,0.05)] hover:bg-[rgba(245,158,11,0.10)] transition-colors disabled:opacity-50"
                                    >
                                        <Sparkles className="w-3.5 h-3.5 text-soon shrink-0" />
                                        <div className="flex-1 min-w-0 text-left">
                                            <p className="text-sm font-bold text-fg truncate">{suggestion.name}</p>
                                            <p className="text-[10px] text-soon font-mono uppercase tracking-wider">{t("autoMatchLabel")} · {suggestion.reference}</p>
                                        </div>
                                    </button>
                                ) : (
                                    <MoloniPicker
                                        moloniProducts={moloniProducts}
                                        onPick={(dest) => saveMapping(src, dest)}
                                        disabled={isSaving}
                                        placeholder={t("pickMoloniProduct")}
                                    />
                                )}
                            </div>

                            {mapping && (
                                <button
                                    onClick={() => unmapSource(src)}
                                    disabled={isSaving}
                                    className="p-2 rounded-lg text-fg-40 hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                                    title={t("unmap")}
                                >
                                    {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unlink className="w-4 h-4" />}
                                </button>
                            )}
                        </div>
                    );
                })}

                {filteredSourceProducts.length === 0 && (
                    <p className="text-center text-fg-40 text-sm py-12">{filterText ? t("noSearchResults") : t("noSourceProducts")}</p>
                )}
            </div>
        </div>
    );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent?: "hot" | "soon" }) {
    const colorClass = accent === "hot"
        ? "text-accent-hot"
        : accent === "soon"
            ? "text-soon"
            : "text-fg";
    return (
        <div className="glass p-5 rounded-2xl border-hairline">
            <p className="text-[10px] font-black text-fg-40 uppercase tracking-[0.2em]">{label}</p>
            <p className={`text-3xl font-black mt-1 ${colorClass}`}>{value}</p>
        </div>
    );
}

function MoloniPicker({ moloniProducts, onPick, disabled, placeholder }: {
    moloniProducts: MoloniProduct[];
    onPick: (p: MoloniProduct) => void;
    disabled?: boolean;
    placeholder: string;
}) {
    const [open, setOpen] = useState(false);
    const [filter, setFilter] = useState("");
    const filtered = useMemo(() => {
        const q = filter.trim().toLowerCase();
        if (!q) return moloniProducts.slice(0, 50);
        return moloniProducts.filter(p =>
            p.name.toLowerCase().includes(q) || p.reference.toLowerCase().includes(q)
        ).slice(0, 50);
    }, [moloniProducts, filter]);

    if (!open) {
        return (
            <button
                onClick={() => setOpen(true)}
                disabled={disabled}
                className="w-full px-3 py-2 rounded-xl border border-hairline hover:border-rule text-sm text-fg-60 hover:text-fg transition-colors disabled:opacity-50 text-left"
            >
                {placeholder}
            </button>
        );
    }
    return (
        <div className="relative">
            <input
                type="text"
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onBlur={() => setTimeout(() => setOpen(false), 200)}
                placeholder={placeholder}
                className="w-full px-3 py-2 rounded-xl bg-surface-2 border border-accent text-sm focus:outline-none"
            />
            <div className="absolute top-full left-0 right-0 mt-1 max-h-64 overflow-auto bg-surface-2 border border-hairline rounded-xl shadow-xl z-50">
                {filtered.length === 0 && (
                    <p className="text-xs text-fg-40 p-3 text-center">No matches</p>
                )}
                {filtered.map((p) => (
                    <button
                        key={p.product_id}
                        onMouseDown={(e) => { e.preventDefault(); onPick(p); setOpen(false); }}
                        className="w-full text-left px-3 py-2 hover:bg-surface transition-colors border-b border-hairline last:border-b-0"
                    >
                        <p className="text-sm font-bold truncate">{p.name}</p>
                        <p className="text-[10px] text-fg-40 font-mono uppercase tracking-wider truncate">{p.reference || `ID ${p.product_id}`} · €{p.price.toFixed(2)}</p>
                    </button>
                ))}
            </div>
        </div>
    );
}
