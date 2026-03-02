"use client";

import { useState, useEffect } from "react";
import {
    ClipboardList, Search, Download, ExternalLink, ChevronDown,
    FileText, CheckCircle2, AlertCircle, Clock, Loader2, ArrowLeft,
    Box, ShoppingBag, CreditCard, Receipt, Split, Zap, Filter
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";

const cn = (...inputs: any[]) => inputs.filter(Boolean).join(" ");

export default function InvoicesPage() {
    const [invoices, setInvoices] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState("all");
    const [shopDomain, setShopDomain] = useState("");

    useEffect(() => {
        fetch("/api/invoices")
            .then(res => res.json())
            .then((data: any) => {
                setInvoices(data.invoices || []);
                setShopDomain(data.shop || "");
            })
            .catch(console.error)
            .finally(() => setLoading(false));
    }, []);

    const filtered = invoices.filter(inv => {
        const matchesSearch = inv.reference?.toLowerCase().includes(search.toLowerCase()) ||
            inv.number?.toLowerCase().includes(search.toLowerCase());
        if (filter === "credit") return matchesSearch && inv.type === "credit_note";
        if (filter === "unpaid") return matchesSearch && (inv.status === "draft" || inv.status === "pending");
        return matchesSearch;
    });

    return (
        <div className="min-h-screen bg-[#020617] text-slate-200 selection:bg-indigo-500/30">
            {/* Header */}
            <header className="sticky top-0 z-30 bg-[#020617]/80 backdrop-blur-xl border-b border-slate-800/40 px-6 py-6 lg:px-12">
                <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-6">
                    <div>
                        <div className="flex items-center gap-3 mb-1">
                            <div className="p-2 bg-indigo-500/10 rounded-xl ring-1 ring-indigo-500/20">
                                <ClipboardList className="w-5 h-5 text-indigo-400" />
                            </div>
                            <h1 className="text-2xl font-black tracking-tight text-white uppercase italic">Faturas</h1>
                        </div>
                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.3em] ml-11">Histórico de Transações • Rioko v5.0 Engine</p>
                    </div>

                    <div className="flex flex-wrap items-center gap-4">
                        <div className="relative group">
                            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 group-focus-within:text-indigo-400 transition-colors" />
                            <input
                                type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                                placeholder="Procurar Order # ou Fatura..."
                                className="bg-slate-900/50 border border-slate-800/80 rounded-2xl pl-12 pr-4 py-3 text-sm font-medium focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500/50 outline-none w-full md:w-80 transition-all placeholder:text-slate-600"
                            />
                        </div>
                        <div className="flex bg-slate-900/80 p-1 rounded-xl border border-slate-800">
                            <button onClick={() => setFilter("all")} className={cn("px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all", filter === "all" ? "bg-white text-black shadow-lg" : "text-slate-500 hover:text-white")}>Tudo</button>
                            <button onClick={() => setFilter("unpaid")} className={cn("px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all", filter === "unpaid" ? "bg-white text-black shadow-lg" : "text-slate-500 hover:text-white")}>Pendentes</button>
                            <button onClick={() => setFilter("credit")} className={cn("px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all", filter === "credit" ? "bg-white text-black shadow-lg" : "text-slate-500 hover:text-white")}>Créditos</button>
                        </div>
                    </div>
                </div>
            </header>

            <main className="max-w-7xl mx-auto px-6 py-12 lg:px-12">
                {loading ? (
                    <div className="flex flex-col items-center justify-center py-32 space-y-4">
                        <div className="relative">
                            <Loader2 className="w-12 h-12 text-indigo-500 animate-spin" />
                            <div className="absolute inset-0 bg-indigo-500/20 blur-2xl animate-pulse" />
                        </div>
                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest animate-pulse">Sincronizando com InvoiceXpress...</p>
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="py-32 flex flex-col items-center text-center space-y-6 glass rounded-[3rem] border-slate-800/50">
                        <div className="bg-slate-900/50 p-6 rounded-3xl border border-slate-800 ring-4 ring-slate-800/20">
                            <Box className="w-12 h-12 text-slate-700" />
                        </div>
                        <div className="space-y-2">
                            <h2 className="text-xl font-bold text-white">Nenhuma fatura encontrada</h2>
                            <p className="text-slate-500 text-sm max-w-sm">Não encontramos transações para o critério selecionado ou o InvoiceXpress não retornou dados.</p>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-4">
                        <AnimatePresence mode="popLayout">
                            {filtered.map((inv) => (
                                <InvoiceCard key={inv.id} invoice={inv} shopDomain={shopDomain} />
                            ))}
                        </AnimatePresence>
                    </div>
                )}
            </main>
        </div>
    );
}

function InvoiceCard({ invoice, shopDomain }: { invoice: any; shopDomain: string }) {
    const [expanded, setExpanded] = useState(false);

    // Status Logic
    const isFinalized = ["finalized", "settled", "sent"].includes(invoice.status);
    const isCredit = invoice.type === "credit_note";
    const shopifyOrderUrl = `https://admin.shopify.com/store/${shopDomain.split(".")[0]}/orders/${invoice.order_id}`;

    // Format doc type name
    const typeLabel = {
        invoice_receipt: "Fatura-Recibo",
        invoice: "Fatura",
        credit_note: "Nota de Crédito"
    }[invoice.type as string] || invoice.type;

    const ixDocType = invoice.type === 'invoice_receipt' ? 'invoice_receipts' : (invoice.type === 'credit_note' ? 'credit_notes' : 'invoices');
    const pdfUrl = `/api/invoices/${invoice.id}/pdf?type=${ixDocType}`;

    return (
        <motion.div
            layout
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className={cn(
                "glass group rounded-[2.5rem] border transition-all duration-500 overflow-hidden",
                expanded ? "ring-2 ring-indigo-500/20 border-indigo-500/30 bg-indigo-500/[0.02]" : "border-slate-800/50 hover:border-slate-700/80 hover:bg-white/[0.01]"
            )}
        >
            {/* Main Row */}
            <div
                className="p-6 md:p-8 flex flex-col md:flex-row md:items-center justify-between gap-6 cursor-pointer select-none"
                onClick={() => setExpanded(!expanded)}
            >
                <div className="flex items-center gap-6">
                    <div className={cn(
                        "w-16 h-16 rounded-[1.5rem] flex items-center justify-center transition-all duration-500 relative",
                        isCredit ? "bg-rose-500/10 text-rose-400 group-hover:bg-rose-500/20" : "bg-indigo-500/10 text-indigo-400 group-hover:bg-indigo-500/20"
                    )}>
                        {isCredit ? <Split className="w-8 h-8" /> : <Receipt className="w-8 h-8" />}
                    </div>

                    <div className="space-y-1.5 text-left">
                        <div className="flex items-center gap-2">
                            <span className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-500">{typeLabel}</span>
                            {isFinalized ? (
                                <div className="flex items-center gap-1.5 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                                    <div className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse" />
                                    <span className="text-[8px] font-black uppercase tracking-widest text-emerald-500">Emitida</span>
                                </div>
                            ) : (
                                <div className="flex items-center gap-1.5 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20">
                                    <span className="text-[8px] font-black uppercase tracking-widest text-amber-500">{invoice.status}</span>
                                </div>
                            )}
                        </div>
                        <h3 className="text-lg font-bold text-white tracking-tight">{invoice.number}</h3>
                        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-1.5">
                            {invoice.reference} • {new Date(invoice.date).toLocaleDateString('pt-PT')}
                        </p>
                    </div>
                </div>

                <div className="flex items-center justify-between md:justify-end gap-10">
                    <div className="text-right">
                        <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-1">Total Transação</span>
                        <p className="text-xl font-black text-white">{invoice.total}€</p>
                    </div>

                    <div className="flex items-center gap-2">
                        <a
                            href={pdfUrl} target="_blank" rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="p-4 bg-slate-900/50 hover:bg-slate-800 text-slate-400 hover:text-white rounded-[1.25rem] border border-slate-800 transition-all active:scale-90"
                            title="Ver PDF"
                        >
                            <FileText className="w-5 h-5" />
                        </a>
                        <a
                            href={shopifyOrderUrl} target="_blank" rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="p-4 bg-slate-900/50 hover:bg-emerald-500/10 text-slate-400 hover:text-emerald-400 rounded-[1.25rem] border border-slate-800 hover:border-emerald-500/30 transition-all active:scale-90"
                            title="Abrir no Shopify"
                        >
                            <ShoppingBag className="w-5 h-5" />
                        </a>
                        <div className={cn("p-2 transition-transform duration-500", expanded && "rotate-180")}>
                            <ChevronDown className="w-5 h-5 text-slate-600" />
                        </div>
                    </div>
                </div>
            </div>

            {/* Expanded Section */}
            <motion.div
                animate={{ height: expanded ? "auto" : 0 }}
                className="overflow-hidden bg-[#03081a]/50 border-t border-slate-800/30"
            >
                <div className="p-8 grid lg:grid-cols-2 gap-8">
                    {/* Logs Flow */}
                    <div className="space-y-6">
                        <div className="flex items-center gap-3">
                            <Zap className="w-4 h-4 text-indigo-400" />
                            <h4 className="text-[10px] font-black uppercase text-slate-500 tracking-[0.25em]">Caminho da Transação</h4>
                        </div>

                        <div className="relative pl-6 space-y-6 before:absolute before:left-1 before:top-2 before:bottom-0 before:w-px before:bg-gradient-to-b before:from-indigo-500/50 before:to-transparent">
                            {invoice.logs?.length > 0 ? (
                                invoice.logs.map((log: any, i: number) => (
                                    <div key={log.id} className="relative group">
                                        <div className="absolute -left-[24px] top-1.5 w-2 h-2 rounded-full bg-[#020617] ring-2 ring-indigo-500 shadow-[0_0_10px_rgba(99,102,241,0.5)] z-10" />
                                        <div className="space-y-1">
                                            <p className="text-[11px] font-bold text-white flex items-center gap-2">
                                                {log.topic === "orders/paid" ? "💳 Pagamento Shopify" : (log.topic === "refunds/create" ? "💸 Reembolso Solicitado" : log.topic)}
                                                <span className="text-[9px] text-slate-600 font-medium">#{log.status}</span>
                                            </p>
                                            <p className="text-[10px] text-slate-500 leading-relaxed font-medium">
                                                {log.topic === "orders/paid" ? `Fatura InvoiceXpress gerada: ${log.response || '(Pendante)'}` : (log.topic === "refunds/create" ? "Processando Nota de Crédito automática..." : "Operação concluída com sucesso.")}
                                            </p>
                                            <p className="text-[8px] text-slate-700 font-black uppercase tracking-widest">{new Date(log.created_at).toLocaleString()}</p>
                                        </div>
                                    </div>
                                ))
                            ) : (
                                <p className="text-[10px] text-slate-600 font-bold uppercase tracking-widest py-2">Sem logs históricos carregados.</p>
                            )}
                        </div>
                    </div>

                    {/* PDF Preview / Actions */}
                    <div className="glass-white p-8 rounded-[2rem] border-white/5 flex flex-col justify-center items-center text-center space-y-6 relative overflow-hidden group/pdf">
                        <div className="absolute inset-0 bg-indigo-500/5 opacity-0 group-hover/pdf:opacity-100 transition-opacity" />
                        <div className="bg-slate-900/50 p-6 rounded-3xl border border-white/5 relative z-10">
                            <FileText className="w-12 h-12 text-indigo-400" />
                        </div>
                        <div className="space-y-1 z-10">
                            <h5 className="font-bold text-white">Pré-visualização do Documento</h5>
                            <p className="text-[10px] text-slate-500 uppercase tracking-widest">Documento certificado e assinado digitalmente</p>
                        </div>
                        <div className="flex gap-3 z-10">
                            <a
                                href={pdfUrl}
                                className="px-6 py-3 bg-white text-black hover:bg-indigo-500 hover:text-white rounded-xl text-[10px] font-black uppercase tracking-widest transition-all shadow-xl active:scale-95 flex items-center gap-2"
                            >
                                <Download className="w-3.5 h-3.5" /> Descarregar PDF
                            </a>
                            <a
                                href={`https://${shopDomain}/admin/orders/${invoice.order_id}`}
                                target="_blank"
                                className="px-6 py-3 bg-slate-800 text-white hover:bg-slate-700 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-95 flex items-center gap-2"
                            >
                                <ExternalLink className="w-3.5 h-3.5" /> Ver Shopify
                            </a>
                        </div>
                    </div>
                </div>
            </motion.div>
        </motion.div>
    );
}
