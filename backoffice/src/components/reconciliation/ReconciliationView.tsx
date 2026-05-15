"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCcw, Search, ScrollText, FileDown } from "lucide-react";
import { ReconciliationRow, type Row } from "./ReconciliationRow";
import { DateRangePicker } from "./DateRangePicker";
import { Filters, type FilterKey } from "./Filters";
import { exportReconciliationToExcel } from "./exportToExcel";

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

export function ReconciliationView({ shop }: { shop: string }) {
    const [from, setFrom] = useState(daysAgoISO(30));
    const [to, setTo] = useState(todayISO());
    const [loading, setLoading] = useState(false);
    const [data, setData] = useState<Response | null>(null);
    const [filter, setFilter] = useState<FilterKey>("all");
    const [search, setSearch] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [exporting, setExporting] = useState(false);

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

    useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

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
                    <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                        <ScrollText className="w-6 h-6 text-emerald-400" />
                    </div>
                    <div>
                        <h1 className="text-3xl md:text-4xl font-black tracking-tight">Conciliação Shopify ↔ InvoiceXpress</h1>
                        <p className="text-slate-400 text-sm">{shop}</p>
                    </div>
                </div>
            </header>

            <div className="flex flex-col lg:flex-row gap-4 items-stretch lg:items-end">
                <DateRangePicker from={from} to={to} setFrom={setFrom} setTo={setTo} />
                <button onClick={load} disabled={loading}
                    className="bg-white text-black px-6 py-2.5 rounded-xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2 hover:bg-emerald-500 hover:text-white transition-all disabled:opacity-50">
                    {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCcw className="w-3 h-3" />}
                    Atualizar
                </button>
                <button
                    onClick={async () => {
                        if (!data) return;
                        setExporting(true);
                        try { await exportReconciliationToExcel(filtered, shop, from, to); }
                        catch (e: any) { setError(String(e)); }
                        finally { setExporting(false); }
                    }}
                    disabled={loading || exporting || !data || filtered.length === 0}
                    className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 px-6 py-2.5 rounded-xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2 hover:bg-emerald-500/20 transition-all disabled:opacity-50">
                    {exporting ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileDown className="w-3 h-3" />}
                    Excel
                </button>
                <div className="relative flex-1">
                    <Search className="w-4 h-4 text-slate-500 absolute left-4 top-1/2 -translate-y-1/2" />
                    <input placeholder="Pesquisar #order, cliente, email, ref. fatura..."
                        value={search} onChange={e => setSearch(e.target.value)}
                        className="w-full bg-slate-900/50 border border-slate-800 rounded-xl py-2.5 pl-11 pr-4 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500/20" />
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
                    }}
                />
            )}

            {error && (
                <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-5 text-sm text-red-300">{error}</div>
            )}

            {loading && !data && (
                <div className="flex items-center justify-center py-20">
                    <Loader2 className="w-8 h-8 text-emerald-400 animate-spin opacity-60" />
                </div>
            )}

            {data && filtered.length === 0 && (
                <p className="text-center text-slate-500 italic py-20">Sem resultados neste filtro.</p>
            )}

            <div className="space-y-3">
                {filtered.map(row => (
                    <ReconciliationRow key={row.order.id} row={row} onChanged={load} />
                ))}
            </div>
        </div>
    );
}
