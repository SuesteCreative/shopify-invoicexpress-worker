"use client";

import { useState } from "react";
import {
    ExternalLink, CheckCircle2, AlertCircle, FileText, Loader2,
    Trash2, RotateCcw, FilePlus2, MinusCircle, ShoppingBag
} from "lucide-react";

export type Row = {
    order: {
        id: string;
        order_number: number;
        name: string;
        total: number;
        paid_at: string;
        customer_name: string | null;
        email: string | null;
        permalink: string;
    };
    match: {
        type: "exact" | "approved" | "heuristic" | "not_needed" | "none";
        confidence: number;
        reason?: string;
    };
    invoice: {
        id: string;
        reference: string | null;
        status: string | null;
        total: number | null;
        date: string | null;
        permalink: string | null;
        pdf_url: string | null;
        client_name: string | null;
    } | null;
    candidates: Array<{
        id: string;
        reference: string | null;
        total: number;
        date: string;
        client_name: string | null;
        confidence: number;
        reason: string;
    }>;
};

const BADGE: Record<Row["match"]["type"], { label: string; cls: string }> = {
    exact: { label: "Match exato", cls: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30" },
    approved: { label: "Aprovado", cls: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30" },
    heuristic: { label: "Heurístico", cls: "bg-amber-500/10 text-amber-300 border-amber-500/30" },
    not_needed: { label: "Não necessária", cls: "bg-slate-500/10 text-slate-300 border-slate-500/30" },
    none: { label: "Sem fatura", cls: "bg-red-500/10 text-red-300 border-red-500/30" },
};

const fmt = (n: number) => n.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
const fmtDate = (s: string | null | undefined) => {
    if (!s) return "—";
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
    const d = m ? new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00Z`) : new Date(s);
    return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("pt-PT");
};

export function ReconciliationRow({ row, onChanged }: { row: Row; onChanged: () => void }) {
    const [acting, setActing] = useState(false);
    const badge = BADGE[row.match.type];

    const approve = async (invoiceId: string) => {
        setActing(true);
        try {
            await fetch("/api/conciliacao/approve", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ order_id: row.order.id, invoice_id: invoiceId }),
            });
            onChanged();
        } finally { setActing(false); }
    };

    const revertApprove = async () => {
        setActing(true);
        try {
            await fetch(`/api/conciliacao/approve?order_id=${encodeURIComponent(row.order.id)}`, { method: "DELETE" });
            onChanged();
        } finally { setActing(false); }
    };

    const markNotNeeded = async () => {
        const reason = prompt("Motivo (opcional):") ?? undefined;
        setActing(true);
        try {
            await fetch("/api/conciliacao/decision", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ order_id: row.order.id, decision: "NOT_NEEDED", reason }),
            });
            onChanged();
        } finally { setActing(false); }
    };

    const clearDecision = async () => {
        setActing(true);
        try {
            await fetch("/api/conciliacao/decision", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ order_id: row.order.id, decision: null }),
            });
            onChanged();
        } finally { setActing(false); }
    };

    const issueInvoice = async () => {
        if (!confirm(`Emitir fatura para encomenda ${row.order.name}?`)) return;
        setActing(true);
        try {
            const res = await fetch("/api/conciliacao/issue-invoice", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ order_number: row.order.order_number }),
            });
            const j: any = await res.json();
            if (!res.ok) alert(`Erro: ${j.error ?? "desconhecido"}`);
            onChanged();
        } finally { setActing(false); }
    };

    return (
        <article className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-4 md:gap-6 items-stretch rounded-2xl border border-slate-800/60 bg-slate-900/30 p-4 md:p-5 hover:border-slate-700 transition-all">
            {/* Shopify side */}
            <div className="flex flex-col gap-2 min-w-0">
                <div className="flex items-center gap-2">
                    <span className="text-[9px] font-black uppercase tracking-widest text-slate-600 px-2 py-0.5 rounded bg-slate-800 border border-slate-700/50 flex items-center gap-1">
                        <ShoppingBag className="w-3 h-3" /> Shopify
                    </span>
                    <span className="text-xs font-bold text-emerald-300">Pago · {fmt(row.order.total)}</span>
                </div>
                <div className="flex flex-wrap items-baseline gap-2">
                    <a href={row.order.permalink} target="_blank" rel="noopener noreferrer"
                        className="text-lg font-black text-white hover:text-emerald-300 transition-colors inline-flex items-center gap-1">
                        {row.order.name} <ExternalLink className="w-3 h-3 opacity-50" />
                    </a>
                    <span className="text-[10px] font-bold text-slate-500">{fmtDate(row.order.paid_at)}</span>
                </div>
                <p className="text-xs font-medium text-slate-400 truncate">
                    {row.order.customer_name ?? "—"}
                    {row.order.email && <span className="text-slate-600"> · {row.order.email}</span>}
                </p>
            </div>

            {/* Middle: match badge */}
            <div className="flex md:flex-col items-center justify-center gap-2 px-2 md:px-4">
                <span className={`px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest border ${badge.cls}`}>
                    {badge.label}
                    {row.match.type === "heuristic" && ` ${row.match.confidence}%`}
                </span>
                {row.match.reason && (
                    <span className="text-[10px] text-slate-500 font-medium text-center max-w-[140px] truncate" title={row.match.reason}>
                        {row.match.reason}
                    </span>
                )}
            </div>

            {/* IX side */}
            <div className="flex flex-col gap-2 min-w-0">
                {row.invoice ? (
                    <>
                        <div className="flex items-center gap-2">
                            <span className="text-[9px] font-black uppercase tracking-widest text-slate-600 px-2 py-0.5 rounded bg-slate-800 border border-slate-700/50 flex items-center gap-1">
                                <FileText className="w-3 h-3" /> InvoiceXpress
                            </span>
                            {row.invoice.status && (
                                <span className={`text-[10px] font-bold ${row.invoice.status === "draft" ? "text-amber-300" : "text-emerald-300"}`}>
                                    {row.invoice.status}
                                </span>
                            )}
                        </div>
                        <div className="flex flex-wrap items-baseline gap-2">
                            {row.invoice.permalink ? (
                                <a href={row.invoice.permalink} target="_blank" rel="noopener noreferrer"
                                    className="text-base font-black text-white hover:text-emerald-300 transition-colors inline-flex items-center gap-1">
                                    {row.invoice.reference ?? `Fatura ${row.invoice.id}`} <ExternalLink className="w-3 h-3 opacity-50" />
                                </a>
                            ) : (
                                <span className="text-base font-black text-white">
                                    {row.invoice.reference ?? `Fatura ${row.invoice.id}`}
                                </span>
                            )}
                            {row.invoice.total != null && (
                                <span className="text-[11px] font-bold text-slate-400">{fmt(row.invoice.total)}</span>
                            )}
                            {row.invoice.date && (
                                <span className="text-[10px] font-bold text-slate-500">{fmtDate(row.invoice.date)}</span>
                            )}
                        </div>
                        <div className="flex flex-wrap gap-2 mt-1">
                            {row.invoice.pdf_url && (
                                <a href={row.invoice.pdf_url} target="_blank" rel="noopener noreferrer"
                                    className="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-white px-2.5 py-1 rounded-lg border border-slate-800 hover:border-slate-700 inline-flex items-center gap-1">
                                    PDF <ExternalLink className="w-3 h-3" />
                                </a>
                            )}
                            {row.match.type === "approved" && (
                                <button onClick={revertApprove} disabled={acting}
                                    className="text-[10px] font-black uppercase tracking-widest text-amber-400 hover:text-amber-300 px-2.5 py-1 rounded-lg border border-amber-500/20 hover:border-amber-500/40 inline-flex items-center gap-1 disabled:opacity-50">
                                    {acting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />} Reverter aprovação
                                </button>
                            )}
                        </div>
                    </>
                ) : row.match.type === "not_needed" ? (
                    <>
                        <p className="text-sm font-bold text-slate-400">Fatura não necessária</p>
                        {row.match.reason && <p className="text-xs text-slate-500">{row.match.reason}</p>}
                        <button onClick={clearDecision} disabled={acting}
                            className="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-white px-2.5 py-1 rounded-lg border border-slate-800 hover:border-slate-700 inline-flex items-center gap-1 mt-2 w-fit disabled:opacity-50">
                            {acting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />} Reverter
                        </button>
                    </>
                ) : (
                    <>
                        <p className="text-sm font-bold text-red-300 flex items-center gap-2">
                            <AlertCircle className="w-4 h-4" /> Sem fatura emitida
                        </p>
                        {row.candidates.length > 0 && (
                            <div className="space-y-2 mt-1">
                                <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">Candidatos heurísticos:</p>
                                {row.candidates.map(c => (
                                    <div key={c.id} className="flex items-center justify-between gap-2 bg-slate-950/60 border border-slate-800 rounded-lg p-2">
                                        <div className="min-w-0">
                                            <p className="text-xs font-bold text-white truncate">{c.reference ?? `Fatura ${c.id}`} <span className="text-[10px] text-amber-300">· {c.confidence}%</span></p>
                                            <p className="text-[10px] text-slate-500 truncate">{c.client_name} · {fmt(c.total)} · {fmtDate(c.date)}</p>
                                        </div>
                                        <button onClick={() => approve(c.id)} disabled={acting}
                                            className="text-[10px] font-black uppercase tracking-widest bg-emerald-500/20 text-emerald-200 border border-emerald-500/30 px-2.5 py-1 rounded-lg hover:bg-emerald-500/30 inline-flex items-center gap-1 disabled:opacity-50">
                                            {acting ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />} Aprovar
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                        <div className="flex flex-wrap gap-2 mt-2">
                            <button onClick={issueInvoice} disabled={acting}
                                className="text-[10px] font-black uppercase tracking-widest bg-white text-black px-3 py-1.5 rounded-lg hover:bg-emerald-500 hover:text-white inline-flex items-center gap-1 disabled:opacity-50">
                                {acting ? <Loader2 className="w-3 h-3 animate-spin" /> : <FilePlus2 className="w-3 h-3" />} Emitir fatura
                            </button>
                            <button onClick={markNotNeeded} disabled={acting}
                                className="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-white px-3 py-1.5 rounded-lg border border-slate-800 hover:border-slate-700 inline-flex items-center gap-1 disabled:opacity-50">
                                {acting ? <Loader2 className="w-3 h-3 animate-spin" /> : <MinusCircle className="w-3 h-3" />} Marcar não necessária
                            </button>
                        </div>
                    </>
                )}
            </div>
        </article>
    );
}
