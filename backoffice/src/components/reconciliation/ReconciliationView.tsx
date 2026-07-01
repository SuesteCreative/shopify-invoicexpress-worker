"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCcw, Search, ScrollText, FileDown, PauseCircle, Play } from "lucide-react";
import { ReconciliationRow, type Row } from "./ReconciliationRow";
import { DateRangePicker } from "./DateRangePicker";
import { Filters, type FilterKey } from "./Filters";
import { exportReconciliationToExcel } from "./exportToExcel";
import { sourceLabel, destLabel, recordNoun } from "./platform";

type Response = {
    from: string;
    to: string;
    total_orders: number;
    summary: Record<string, number>;
    rows: Row[];
};

const todayISO = () => new Date().toISOString().slice(0, 10);
const daysAgoISO = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
};

export function ReconciliationView({ identifier, source, destination }: { identifier: string; source: string; destination: string }) {
    const srcLabel = sourceLabel(source);
    const dstLabel = destLabel(destination);
    const noun = recordNoun(source);
    const [from, setFrom] = useState(daysAgoISO(30));
    const [to, setTo] = useState(todayISO());
    const [loading, setLoading] = useState(false);
    const [data, setData] = useState<Response | null>(null);
    const [filter, setFilter] = useState<FilterKey>("all");
    const [search, setSearch] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [exporting, setExporting] = useState(false);
    const [isPaused, setIsPaused] = useState<boolean | null>(null);
    const [resuming, setResuming] = useState(false);

    const loadPauseState = async () => {
        try {
            const res = await fetch("/api/integrations");
            if (!res.ok) return;
            const j: any = await res.json();
            setIsPaused(j.is_paused === 1);
        } catch { /* silent — banner just won't appear */ }
    };

    const resume = async () => {
        setResuming(true);
        try {
            const res = await fetch("/api/integrations/toggle", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ paused: false }),
            });
            if (res.ok) setIsPaused(false);
            else alert("Falha ao retomar integração. Tenta novamente.");
        } catch (e: any) {
            alert(`Erro de rede: ${e.message}`);
        } finally {
            setResuming(false);
        }
    };

    const load = async () => {
        setLoading(true);
        setError(null);
        try {
            const fromIso = new Date(from + "T00:00:00Z").toISOString();
            const toIso = new Date(to + "T23:59:59Z").toISOString();
            const res = await fetch(`/api/conciliacao?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`);
            const j: any = await res.json();
            if (!res.ok) { setError(j.error ?? "Erro"); setData(null); }
            else setData(j);
        } catch (e: any) { setError(String(e)); }
        finally { setLoading(false); }
    };

    useEffect(() => { load(); loadPauseState(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

    const filtered = useMemo(() => {
        if (!data) return [];
        return data.rows.filter(r => {
            if (filter !== "all" && r.match.type !== filter) return false;
            if (search) {
                const s = search.toLowerCase();
                return (
                    r.order.name.toLowerCase().includes(s) ||
                    r.order.customer_name?.toLowerCase().includes(s) ||
                    r.order.email?.toLowerCase().includes(s) ||
                    r.invoice?.reference?.toLowerCase().includes(s) ||
                    String(r.order.order_number).includes(s)
                );
            }
            return true;
        });
    }, [data, filter, search]);

    return (
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-10 space-y-8">
            <header className="flex flex-col gap-4">
                <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-[rgba(94,234,212,0.10)] border border-[rgba(94,234,212,0.20)] flex items-center justify-center">
                        <ScrollText className="w-6 h-6 text-accent-hot" />
                    </div>
                    <div>
                        <h1 className="text-3xl md:text-4xl font-medium tracking-tight">Conciliação {srcLabel} ↔ {dstLabel}</h1>
                        <p className="text-fg-60 text-sm">{identifier}</p>
                    </div>
                </div>
            </header>

            {isPaused && (
                <div className="rounded-2xl border border-[rgba(245,158,11,0.35)] bg-[rgba(245,158,11,0.08)] p-5 flex flex-col md:flex-row gap-4 md:items-center md:justify-between">
                    <div className="flex gap-3 items-start">
                        <PauseCircle className="w-6 h-6 text-amber-400 shrink-0 mt-0.5" />
                        <div className="space-y-1">
                            <p className="text-sm font-semibold text-amber-300">
                                Integração pausada — nenhuma fatura está a ser emitida automaticamente
                            </p>
                            <p className="text-xs text-fg-60">
                                A tua integração {srcLabel} ↔ {dstLabel} está em pausa. As {noun.plural} continuam a chegar,
                                mas nenhuma vai gerar fatura até retomares. {noun.plural.charAt(0).toUpperCase() + noun.plural.slice(1)} paradas aparecem em <strong>Sem fatura</strong> abaixo.
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={resume}
                        disabled={resuming}
                        className="bg-amber-500 hover:bg-amber-400 text-surface px-5 py-2.5 rounded-xl font-mono text-[10px] uppercase tracking-[0.18em] flex items-center gap-2 transition-all disabled:opacity-50 shrink-0"
                    >
                        {resuming ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                        Retomar agora
                    </button>
                </div>
            )}

            <div className="flex flex-col lg:flex-row gap-4 items-stretch lg:items-end">
                <DateRangePicker from={from} to={to} setFrom={setFrom} setTo={setTo} />
                <button onClick={load} disabled={loading}
                    className="bg-fg text-surface px-6 py-2.5 rounded-xl font-mono text-[10px] uppercase tracking-[0.18em] flex items-center gap-2 hover:bg-accent-hot transition-all disabled:opacity-50">
                    {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCcw className="w-3 h-3" />}
                    Atualizar
                </button>
                <button
                    onClick={async () => {
                        if (!data) return;
                        setExporting(true);
                        try { await exportReconciliationToExcel(filtered, identifier, from, to, source, destination); }
                        catch (e: any) { setError(String(e)); }
                        finally { setExporting(false); }
                    }}
                    disabled={loading || exporting || !data || filtered.length === 0}
                    className="bg-[rgba(94,234,212,0.10)] border border-[rgba(94,234,212,0.30)] text-accent-hot px-6 py-2.5 rounded-xl font-mono text-[10px] uppercase tracking-[0.18em] flex items-center gap-2 hover:bg-[rgba(94,234,212,0.18)] transition-all disabled:opacity-50">
                    {exporting ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileDown className="w-3 h-3" />}
                    Excel
                </button>
                <div className="relative flex-1">
                    <Search className="w-4 h-4 text-fg-40 absolute left-4 top-1/2 -translate-y-1/2" />
                    <input placeholder={`Pesquisar ${noun.singular}, cliente, email, ref. fatura...`}
                        value={search} onChange={e => setSearch(e.target.value)}
                        className="w-full bg-surface-2 border border-hairline rounded-xl py-2.5 pl-11 pr-4 text-sm font-medium text-fg focus:outline-none focus:ring-2 focus:ring-[rgba(2,141,196,0.20)]" />
                </div>
            </div>

            {data && (
                <Filters
                    current={filter}
                    setCurrent={setFilter}
                    counts={{
                        all: data.total_orders,
                        exact: data.summary.exact ?? 0,
                        approved: data.summary.approved ?? 0,
                        heuristic: data.summary.heuristic ?? 0,
                        none: data.summary.none ?? 0,
                        not_needed: data.summary.not_needed ?? 0,
                        pending: data.summary.pending ?? 0,
                    }}
                />
            )}

            {error && (
                <div className="rounded-2xl border border-[rgba(244,63,94,0.30)] bg-[rgba(244,63,94,0.05)] p-5 text-sm text-destructive">{error}</div>
            )}

            {loading && !data && (
                <div className="flex items-center justify-center py-20">
                    <Loader2 className="w-8 h-8 text-accent animate-spin opacity-60" />
                </div>
            )}

            {data && filtered.length === 0 && (
                <p className="text-center text-fg-40 italic py-20">Sem resultados neste filtro.</p>
            )}

            <div className="space-y-3">
                {filtered.map(row => (
                    <ReconciliationRow key={row.order.id} row={row} onChanged={load} source={source} destination={destination} />
                ))}
            </div>
        </div>
    );
}
