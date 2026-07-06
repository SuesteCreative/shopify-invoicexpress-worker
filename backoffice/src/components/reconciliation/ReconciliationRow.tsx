"use client";

import { useState } from "react";
import {
    ExternalLink, CheckCircle2, AlertCircle, Loader2,
    RotateCcw, FilePlus2, MinusCircle, Clock
} from "lucide-react";
import { sourceLabel, destLabel, sourceIcon, destIcon } from "./platform";

export type InvoiceInfo = {
    id: string;
    reference: string | null;
    /** Moloni doc number (finalized) or "#<id>" (draft). Preferred over
     * reference for the destination-side label. Null for InvoiceXpress. */
    number?: string | null;
    status: string | null;
    total: number | null;
    date: string | null;
    permalink: string | null;
    pdf_url: string | null;
    client_name: string | null;
    /** Invoice is known to exist (we hold its id) but its details couldn't be
     * loaded this round — show "detalhe indisponível", never a false alarm. */
    meta_unavailable?: boolean;
};

/** A credit note (nota de crédito) issued against the order's invoice. */
export type CreditInfo = {
    id: string;
    number: string | null;
    reference: string | null;
    status: string | null;
    total: number | null;
    date: string | null;
    permalink: string | null;
    pdf_url: string | null;
};

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
        financial_status: string | null;
        /** OTA / sales channel the booking came through (Lodgify `source`). */
        channel?: string | null;
        /** Normalized refund/cancel state (source-agnostic). */
        refund_state?: "partial" | "full" | "cancelled" | null;
        cancelled_at?: string | null;
    };
    match: {
        type: "exact" | "approved" | "heuristic" | "not_needed" | "none" | "pending";
        confidence: number;
        reason?: string;
    };
    invoice: InvoiceInfo | null;
    /** All invoices for this booking. >1 when billed in instalments (50/50). */
    invoices?: InvoiceInfo[];
    /** Credit notes found for this order's invoice(s). Empty on a refunded order
     * that has an invoice ⇒ "nota de crédito não emitida" alarm. */
    credit_notes?: CreditInfo[];
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
    exact: { label: "Match exato", cls: "bg-[rgba(94,234,212,0.10)] text-accent-hot border-[rgba(94,234,212,0.30)]" },
    approved: { label: "Aprovado", cls: "bg-[rgba(94,234,212,0.10)] text-accent-hot border-[rgba(94,234,212,0.30)]" },
    heuristic: { label: "Heurístico", cls: "bg-[rgba(2,141,196,0.10)] text-accent border-[rgba(2,141,196,0.30)]" },
    not_needed: { label: "Não necessária", cls: "bg-[rgba(245,158,11,0.10)] text-soon border-[rgba(245,158,11,0.30)]" },
    none: { label: "Sem fatura", cls: "bg-[rgba(244,63,94,0.10)] text-destructive border-[rgba(244,63,94,0.30)]" },
    pending: { label: "Aguarda pagamento", cls: "bg-[rgba(148,163,184,0.10)] text-fg-60 border-[rgba(148,163,184,0.30)]" },
};

// Source-side chip for refunded / cancelled orders. Full refund + cancellation
// read as destructive (red); a partial refund is a softer amber.
const REFUND_CHIP: Record<NonNullable<Row["order"]["refund_state"]>, { label: string; cls: string }> = {
    full: { label: "Reembolsado", cls: "bg-[rgba(244,63,94,0.10)] text-destructive border-[rgba(244,63,94,0.30)]" },
    partial: { label: "Reembolso parcial", cls: "bg-[rgba(245,158,11,0.10)] text-soon border-[rgba(245,158,11,0.30)]" },
    cancelled: { label: "Cancelado", cls: "bg-[rgba(244,63,94,0.10)] text-destructive border-[rgba(244,63,94,0.30)]" },
};

// Lodgify `source` codes → friendly channel labels shown as a chip on the row.
const CHANNEL_LABELS: Record<string, string> = {
    bookingcom: "Booking.com", booking: "Booking.com",
    airbnb: "Airbnb", airbnbintegration: "Airbnb",
    expedia: "Expedia", vrbo: "Vrbo", homeaway: "HomeAway",
    manual: "Manual", direct: "Direto", website: "Website",
};
const channelLabel = (c: string | null | undefined): string | null => {
    if (!c) return null;
    return CHANNEL_LABELS[c.toLowerCase()] ?? c;
};

const fmt = (n: number) => n.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
const fmtDate = (s: string | null | undefined) => {
    if (!s) return "—";
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
    const d = m ? new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00Z`) : new Date(s);
    return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("pt-PT");
};

export function ReconciliationRow({ row, onChanged, source, destination }: { row: Row; onChanged: () => void; source: string; destination: string }) {
    const [acting, setActing] = useState(false);
    const badge = BADGE[row.match.type];
    const srcLabel = sourceLabel(source);
    const dstLabel = destLabel(destination);
    const SourceIcon = sourceIcon(source);
    const DestIcon = destIcon(destination);
    const isShopify = source === "shopify";

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
            const j: any = await res.json().catch(() => ({}));
            // Worker may return 200 OK with {status: "error"|"skipped"} payload,
            // or a non-OK HTTP status. Detect both and surface the real message.
            const innerStatus = j?.status ?? j?.result?.status;
            const innerMessage = j?.message ?? j?.result?.message ?? j?.error;
            if (!res.ok) {
                alert(`Erro ao emitir fatura: ${innerMessage ?? `HTTP ${res.status}`}`);
            } else if (innerStatus === "error") {
                alert(`Não foi possível emitir a fatura.\n\n${innerMessage ?? "Erro desconhecido."}`);
            } else if (innerStatus === "skipped") {
                alert(`Sem fatura a emitir.\n\n${innerMessage ?? ""}`);
            } else if (innerStatus === "created") {
                // success — no alert needed, UI will refresh
            }
            onChanged();
        } finally { setActing(false); }
    };

    return (
        <article className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-4 md:gap-6 items-stretch rounded-2xl border border-hairline bg-surface-2/30 p-4 md:p-5 hover:border-rule transition-all">
            {/* Source side */}
            <div className="flex flex-col gap-2 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[9px] font-black uppercase tracking-widest text-fg-40 px-2 py-0.5 rounded bg-surface-2 border border-hairline flex items-center gap-1">
                        <SourceIcon className="w-3 h-3" /> {srcLabel}
                    </span>
                    {channelLabel(row.order.channel) && (
                        <span className="text-[9px] font-black uppercase tracking-widest text-accent px-2 py-0.5 rounded bg-[rgba(2,141,196,0.10)] border border-[rgba(2,141,196,0.30)]">
                            {channelLabel(row.order.channel)}
                        </span>
                    )}
                    {row.order.financial_status === "paid" ? (
                        <span className="text-xs font-bold text-accent-hot">Pago · {fmt(row.order.total)}</span>
                    ) : (
                        <span className="text-xs font-bold text-soon">Pendente · {fmt(row.order.total)}</span>
                    )}
                    {row.order.refund_state && (
                        <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded border ${REFUND_CHIP[row.order.refund_state].cls}`}>
                            {REFUND_CHIP[row.order.refund_state].label}
                        </span>
                    )}
                </div>
                <div className="flex flex-wrap items-baseline gap-2">
                    <a href={row.order.permalink} target="_blank" rel="noopener noreferrer"
                        className="text-lg font-black text-fg hover:text-accent-hot transition-colors inline-flex items-center gap-1">
                        {row.order.name} <ExternalLink className="w-3 h-3 opacity-50" />
                    </a>
                    <span className="text-[10px] font-bold text-fg-40">{fmtDate(row.order.paid_at)}</span>
                </div>
                <p className="text-xs font-medium text-fg-60 truncate">
                    {row.order.customer_name ?? "—"}
                    {row.order.email && <span className="text-fg-40"> · {row.order.email}</span>}
                </p>
            </div>

            {/* Middle: match badge */}
            <div className="flex md:flex-col items-center justify-center gap-2 px-2 md:px-4">
                <span className={`px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest border ${badge.cls}`}>
                    {badge.label}
                    {row.match.type === "heuristic" && ` ${row.match.confidence}%`}
                </span>
                {row.match.reason && (
                    <span className="text-[10px] text-fg-40 font-medium text-center max-w-[140px] truncate" title={row.match.reason}>
                        {row.match.reason}
                    </span>
                )}
            </div>

            {/* Destination side */}
            <div className="flex flex-col gap-2 min-w-0">
                {row.invoices && row.invoices.length > 1 ? (
                    <>
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[9px] font-black uppercase tracking-widest text-fg-40 px-2 py-0.5 rounded bg-surface-2 border border-hairline flex items-center gap-1">
                                <DestIcon className="w-3 h-3" /> {dstLabel}
                            </span>
                            <span className="text-[10px] font-bold text-accent-hot">
                                {row.invoices.length} faturas · Σ {fmt(row.invoices.reduce((s, iv) => s + (iv.total ?? 0), 0))}
                            </span>
                        </div>
                        {row.invoices.map((iv, i) => (
                            <div key={iv.id} className="flex flex-wrap items-baseline gap-2 border-l-2 border-hairline pl-2 py-0.5">
                                <span className="text-[9px] font-black text-fg-40">parcela {i + 1}</span>
                                {iv.status && (
                                    <span className={`text-[10px] font-bold ${iv.status === "draft" ? "text-soon" : "text-accent-hot"}`}>{iv.status}</span>
                                )}
                                {iv.permalink ? (
                                    <a href={iv.permalink} target="_blank" rel="noopener noreferrer"
                                        className="text-sm font-black text-fg hover:text-accent-hot transition-colors inline-flex items-center gap-1">
                                        {iv.number ?? iv.reference ?? `Fatura ${iv.id}`} <ExternalLink className="w-3 h-3 opacity-50" />
                                    </a>
                                ) : (
                                    <span className="text-sm font-black text-fg" title={iv.status === "draft" ? "Rascunho — o link abre quando a fatura for finalizada no Moloni" : undefined}>
                                        {iv.number ?? iv.reference ?? `Fatura ${iv.id}`}
                                    </span>
                                )}
                                {iv.total != null && (
                                    <span className="text-[11px] font-bold text-fg-60">{fmt(iv.total)}</span>
                                )}
                                {iv.pdf_url && (
                                    <a href={iv.pdf_url} target="_blank" rel="noopener noreferrer"
                                        className="text-[9px] font-black uppercase tracking-widest text-fg-60 hover:text-fg inline-flex items-center gap-0.5">
                                        PDF <ExternalLink className="w-3 h-3" />
                                    </a>
                                )}
                            </div>
                        ))}
                    </>
                ) : row.invoice ? (
                    <>
                        <div className="flex items-center gap-2">
                            <span className="text-[9px] font-black uppercase tracking-widest text-fg-40 px-2 py-0.5 rounded bg-surface-2 border border-hairline flex items-center gap-1">
                                <DestIcon className="w-3 h-3" /> {dstLabel}
                            </span>
                            {row.invoice.status && (
                                <span className={`text-[10px] font-bold ${row.invoice.status === "draft" ? "text-soon" : "text-accent-hot"}`}>
                                    {row.invoice.status}
                                </span>
                            )}
                        </div>
                        <div className="flex flex-wrap items-baseline gap-2">
                            {row.invoice.permalink ? (
                                <a href={row.invoice.permalink} target="_blank" rel="noopener noreferrer"
                                    className="text-base font-black text-fg hover:text-accent-hot transition-colors inline-flex items-center gap-1">
                                    {row.invoice.number ?? row.invoice.reference ?? `Fatura ${row.invoice.id}`} <ExternalLink className="w-3 h-3 opacity-50" />
                                </a>
                            ) : (
                                <span className="text-base font-black text-fg" title={row.invoice.status === "draft" ? "Rascunho — o link abre quando a fatura for finalizada no Moloni" : undefined}>
                                    {row.invoice.number ?? row.invoice.reference ?? `Fatura ${row.invoice.id}`}
                                </span>
                            )}
                            {row.invoice.total != null && (
                                <span className="text-[11px] font-bold text-fg-60">{fmt(row.invoice.total)}</span>
                            )}
                            {row.invoice.date && (
                                <span className="text-[10px] font-bold text-fg-40">{fmtDate(row.invoice.date)}</span>
                            )}
                        </div>
                        {row.invoice.meta_unavailable && (
                            <p className="text-[10px] font-medium text-soon flex items-center gap-1 mt-0.5">
                                <AlertCircle className="w-3 h-3 shrink-0" />
                                Fatura emitida (id {row.invoice.id}) — detalhe do {dstLabel} indisponível de momento. Atualiza daqui a pouco.
                            </p>
                        )}
                        <div className="flex flex-wrap gap-2 mt-1">
                            {row.invoice.pdf_url && (
                                <a href={row.invoice.pdf_url} target="_blank" rel="noopener noreferrer"
                                    className="text-[10px] font-black uppercase tracking-widest text-fg-60 hover:text-fg px-2.5 py-1 rounded-lg border border-hairline hover:border-rule inline-flex items-center gap-1">
                                    PDF <ExternalLink className="w-3 h-3" />
                                </a>
                            )}
                            {row.match.type === "approved" && (
                                <button onClick={revertApprove} disabled={acting}
                                    className="text-[10px] font-black uppercase tracking-widest text-soon hover:text-soon/85 px-2.5 py-1 rounded-lg border border-[rgba(245,158,11,0.20)] hover:border-[rgba(245,158,11,0.40)] inline-flex items-center gap-1 disabled:opacity-50">
                                    {acting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />} Reverter aprovação
                                </button>
                            )}
                        </div>
                    </>
                ) : row.match.type === "not_needed" ? (
                    <>
                        <p className="text-sm font-bold text-fg-60">Fatura não necessária</p>
                        {row.match.reason && <p className="text-xs text-fg-40">{row.match.reason}</p>}
                        <button onClick={clearDecision} disabled={acting}
                            className="text-[10px] font-black uppercase tracking-widest text-fg-60 hover:text-fg px-2.5 py-1 rounded-lg border border-hairline hover:border-rule inline-flex items-center gap-1 mt-2 w-fit disabled:opacity-50">
                            {acting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />} Reverter
                        </button>
                    </>
                ) : row.match.type === "pending" ? (
                    <>
                        <p className="text-sm font-bold text-soon flex items-center gap-2">
                            <Clock className="w-4 h-4" /> Faturação em espera
                        </p>
                        <p className="text-xs text-fg-40">
                            {row.match.reason
                                ?? `A fatura é emitida automaticamente quando o pagamento for confirmado no ${srcLabel}. Até lá fica em espera.`}
                        </p>
                    </>
                ) : (
                    <>
                        <p className="text-sm font-bold text-destructive flex items-center gap-2">
                            <AlertCircle className="w-4 h-4" /> Sem fatura emitida
                        </p>
                        {row.candidates.length > 0 && (
                            <div className="space-y-2 mt-1">
                                <p className="text-[9px] font-black uppercase tracking-widest text-fg-40">Candidatos heurísticos:</p>
                                {row.candidates.map(c => (
                                    <div key={c.id} className="flex items-center justify-between gap-2 bg-surface border border-hairline rounded-lg p-2">
                                        <div className="min-w-0">
                                            <p className="text-xs font-bold text-fg truncate">{c.reference ?? `Fatura ${c.id}`} <span className="text-[10px] text-soon">· {c.confidence}%</span></p>
                                            <p className="text-[10px] text-fg-40 truncate">{c.client_name} · {fmt(c.total)} · {fmtDate(c.date)}</p>
                                        </div>
                                        <button onClick={() => approve(c.id)} disabled={acting}
                                            className="text-[10px] font-black uppercase tracking-widest bg-[rgba(94,234,212,0.18)] text-accent-hot border border-[rgba(94,234,212,0.30)] px-2.5 py-1 rounded-lg hover:bg-[rgba(94,234,212,0.25)] inline-flex items-center gap-1 disabled:opacity-50">
                                            {acting ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />} Aprovar
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                        <div className="flex flex-wrap gap-2 mt-2">
                            {isShopify && (
                                <button onClick={issueInvoice} disabled={acting}
                                    className="text-[10px] font-black uppercase tracking-widest bg-fg text-surface px-3 py-1.5 rounded-lg hover:bg-accent-hot inline-flex items-center gap-1 disabled:opacity-50">
                                    {acting ? <Loader2 className="w-3 h-3 animate-spin" /> : <FilePlus2 className="w-3 h-3" />} Emitir fatura
                                </button>
                            )}
                            <button onClick={markNotNeeded} disabled={acting}
                                className="text-[10px] font-black uppercase tracking-widest text-fg-60 hover:text-fg px-3 py-1.5 rounded-lg border border-hairline hover:border-rule inline-flex items-center gap-1 disabled:opacity-50">
                                {acting ? <Loader2 className="w-3 h-3 animate-spin" /> : <MinusCircle className="w-3 h-3" />} Marcar não necessária
                            </button>
                        </div>
                    </>
                )}

                {/* Credit notes (notas de crédito) for refunded/cancelled orders.
                    Shown when the order carries a refund_state and has an invoice:
                    either the NC(s) with a hyperlink, or — the alarm — a warning
                    that no credit note was found for a refunded/cancelled invoice. */}
                {row.order.refund_state && (row.invoice || (row.invoices?.length ?? 0) > 0) && (
                    <div className="mt-1 border-t border-hairline pt-2 flex flex-col gap-1.5">
                        {row.credit_notes && row.credit_notes.length > 0 ? (
                            row.credit_notes.map(cn => (
                                <div key={cn.id} className="flex flex-wrap items-baseline gap-2">
                                    <span className="text-[9px] font-black uppercase tracking-widest text-destructive px-2 py-0.5 rounded bg-[rgba(244,63,94,0.10)] border border-[rgba(244,63,94,0.30)] inline-flex items-center gap-1">
                                        <RotateCcw className="w-3 h-3" /> Nota de crédito
                                    </span>
                                    {cn.permalink ? (
                                        <a href={cn.permalink} target="_blank" rel="noopener noreferrer"
                                            className="text-sm font-black text-fg hover:text-accent-hot transition-colors inline-flex items-center gap-1">
                                            {cn.number ?? cn.reference ?? `NC ${cn.id}`} <ExternalLink className="w-3 h-3 opacity-50" />
                                        </a>
                                    ) : (
                                        <span className="text-sm font-black text-fg" title={cn.status === "draft" ? "Rascunho — o link abre quando a nota de crédito for finalizada" : undefined}>
                                            {cn.number ?? cn.reference ?? `NC ${cn.id}`}
                                        </span>
                                    )}
                                    {cn.total != null && (
                                        <span className="text-[11px] font-bold text-destructive">−{fmt(Math.abs(cn.total))}</span>
                                    )}
                                    {cn.date && <span className="text-[10px] font-bold text-fg-40">{fmtDate(cn.date)}</span>}
                                    {row.invoice && (
                                        <span className="text-[10px] font-medium text-fg-40">
                                            assoc. {row.invoice.number ?? row.invoice.reference ?? `fatura ${row.invoice.id}`}
                                        </span>
                                    )}
                                </div>
                            ))
                        ) : !row.invoice?.meta_unavailable ? (
                            <p className="text-[11px] font-bold text-soon flex items-center gap-1.5">
                                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                                {row.order.refund_state === "cancelled" ? "Cancelado" : "Reembolsado"} — nota de crédito não emitida
                            </p>
                        ) : null}
                    </div>
                )}
            </div>
        </article>
    );
}
