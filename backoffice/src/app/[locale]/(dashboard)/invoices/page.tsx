"use client";

import { useState, useEffect } from "react";
import {
    ClipboardList, Search, Download, ExternalLink, ChevronDown,
    FileText, Loader2,
    Box, ShoppingBag, Receipt, Split, Zap
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslations } from "next-intl";

const cn = (...inputs: any[]) => inputs.filter(Boolean).join(" ");

export default function InvoicesPage() {
    const t = useTranslations("invoices");
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
        <div className="min-h-screen bg-surface text-fg">
            {/* Header */}
            <header className="md:sticky md:top-0 z-30 bg-surface/80 backdrop-blur-xl border-b border-hairline px-4 py-4 sm:px-6 sm:py-6 lg:px-12">
                <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-6">
                    <div>
                        <div className="flex items-center gap-3 mb-1">
                            <div className="p-2 bg-surface-2 rounded-xl border border-hairline">
                                <ClipboardList className="w-5 h-5 text-accent" />
                            </div>
                            <h1 className="text-2xl font-medium tracking-tight text-fg">{t("title")}</h1>
                        </div>
                        <p className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em] ml-11">{t("subtitle")}</p>
                    </div>

                    <div className="flex flex-wrap items-center gap-4">
                        <div className="relative group">
                            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40 group-focus-within:text-accent transition-colors" />
                            <input
                                type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                                placeholder={t("searchPlaceholder")}
                                className="bg-surface-2 border border-hairline rounded-2xl pl-12 pr-4 py-3 text-sm font-medium text-fg focus:ring-2 focus:ring-[rgba(2,141,196,0.20)] focus:border-[rgba(2,141,196,0.50)] outline-none w-full md:w-80 transition-all placeholder:text-fg-40"
                            />
                        </div>
                        <div className="flex bg-surface-2/80 p-1 rounded-xl border border-hairline">
                            <button onClick={() => setFilter("all")} className={cn("px-4 py-2 rounded-lg font-mono text-[10px] uppercase tracking-[0.18em] transition-all", filter === "all" ? "bg-fg text-surface" : "text-fg-40 hover:text-fg")}>{t("filterAll")}</button>
                            <button onClick={() => setFilter("unpaid")} className={cn("px-4 py-2 rounded-lg font-mono text-[10px] uppercase tracking-[0.18em] transition-all", filter === "unpaid" ? "bg-fg text-surface" : "text-fg-40 hover:text-fg")}>{t("filterUnpaid")}</button>
                            <button onClick={() => setFilter("credit")} className={cn("px-4 py-2 rounded-lg font-mono text-[10px] uppercase tracking-[0.18em] transition-all", filter === "credit" ? "bg-fg text-surface" : "text-fg-40 hover:text-fg")}>{t("filterCredit")}</button>
                        </div>
                    </div>
                </div>
            </header>

            <main className="max-w-7xl mx-auto px-6 py-6 sm:py-12 lg:px-12">
                {loading ? (
                    <div className="flex flex-col items-center justify-center py-32 space-y-4">
                        <div className="relative">
                            <Loader2 className="w-12 h-12 text-accent animate-spin" />
                            <div className="absolute inset-0 bg-[rgba(2,141,196,0.20)] blur-2xl animate-pulse" />
                        </div>
                        <p className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em] animate-pulse">{t("syncing")}</p>
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="py-32 flex flex-col items-center text-center space-y-6 glass rounded-[3rem]">
                        <div className="bg-surface-2 p-6 rounded-3xl border border-hairline">
                            <Box className="w-12 h-12 text-fg-40" />
                        </div>
                        <div className="space-y-2">
                            <h2 className="text-xl font-medium text-fg">{t("emptyTitle")}</h2>
                            <p className="text-fg-40 text-sm max-w-sm">{t("emptyBody")}</p>
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
    const t = useTranslations("invoices");
    const [expanded, setExpanded] = useState(false);

    const isFinalized = ["finalized", "settled", "sent"].includes(invoice.status);
    const isCredit = invoice.type === "credit_note";
    const shopifyOrderUrl = `https://admin.shopify.com/store/${shopDomain.split(".")[0]}/orders/${invoice.order_id}`;

    const typeLabel = {
        invoice_receipt: t("typeInvoiceReceipt"),
        invoice: t("typeInvoice"),
        credit_note: t("typeCreditNote")
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
                "glass group rounded-[2.5rem] transition-all duration-500 overflow-hidden",
                expanded ? "ring-2 ring-[rgba(2,141,196,0.20)] border-[rgba(2,141,196,0.30)]" : "hover:bg-white/[0.01]"
            )}
        >
            <div
                className="p-6 md:p-8 flex flex-col md:flex-row md:items-center justify-between gap-6 cursor-pointer select-none"
                onClick={() => setExpanded(!expanded)}
            >
                <div className="flex items-center gap-6">
                    <div className={cn(
                        "w-16 h-16 rounded-[1.5rem] flex items-center justify-center transition-all duration-500 relative",
                        isCredit ? "bg-[rgba(244,63,94,0.10)] text-destructive group-hover:bg-[rgba(244,63,94,0.18)]" : "bg-[rgba(2,141,196,0.10)] text-accent group-hover:bg-[rgba(2,141,196,0.18)]"
                    )}>
                        {isCredit ? <Split className="w-8 h-8" /> : <Receipt className="w-8 h-8" />}
                    </div>

                    <div className="space-y-1.5 text-left">
                        <div className="flex items-center gap-2">
                            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40">{typeLabel}</span>
                            {isFinalized ? (
                                <div className="flex items-center gap-1.5 bg-[rgba(94,234,212,0.10)] px-2 py-0.5 rounded-full border border-[rgba(94,234,212,0.20)]">
                                    <div className="w-1 h-1 rounded-full bg-accent-hot animate-pulse" />
                                    <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-accent-hot">{t("issued")}</span>
                                </div>
                            ) : (
                                <div className="flex items-center gap-1.5 bg-[rgba(245,158,11,0.10)] px-2 py-0.5 rounded-full border border-[rgba(245,158,11,0.20)]">
                                    <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-soon">{invoice.status}</span>
                                </div>
                            )}
                        </div>
                        <h3 className="text-lg font-medium text-fg tracking-tight">{invoice.number}</h3>
                        <p className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em] flex items-center gap-1.5">
                            {invoice.reference} • {new Date(invoice.date).toLocaleDateString('pt-PT')}
                        </p>
                    </div>
                </div>

                <div className="flex items-center justify-between md:justify-end gap-10">
                    <div className="text-right">
                        <span className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em] block mb-1">{t("transactionTotal")}</span>
                        <p className="text-xl font-medium text-fg tabular-nums">{invoice.total}€</p>
                    </div>

                    <div className="flex items-center gap-2">
                        <a
                            href={pdfUrl} target="_blank" rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="p-4 bg-surface-2 hover:bg-surface-2/70 text-fg-60 hover:text-fg rounded-[1.25rem] border border-hairline transition-all active:scale-90"
                            title={t("viewPdf")}
                        >
                            <FileText className="w-5 h-5" />
                        </a>
                        <a
                            href={shopifyOrderUrl} target="_blank" rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="p-4 bg-surface-2 hover:bg-[rgba(94,234,212,0.10)] text-fg-60 hover:text-accent-hot rounded-[1.25rem] border border-hairline hover:border-[rgba(94,234,212,0.30)] transition-all active:scale-90"
                            title={t("openInShopify")}
                        >
                            <ShoppingBag className="w-5 h-5" />
                        </a>
                        <div className={cn("p-2 transition-transform duration-500", expanded && "rotate-180")}>
                            <ChevronDown className="w-5 h-5 text-fg-40" />
                        </div>
                    </div>
                </div>
            </div>

            <motion.div
                animate={{ height: expanded ? "auto" : 0 }}
                className="overflow-hidden bg-surface-2/50 border-t border-hairline"
            >
                <div className="p-5 sm:p-8 grid lg:grid-cols-2 gap-8">
                    <div className="space-y-6">
                        <div className="flex items-center gap-3">
                            <Zap className="w-4 h-4 text-accent" />
                            <h4 className="font-mono text-[10px] uppercase text-fg-40 tracking-[0.25em]">{t("transactionPath")}</h4>
                        </div>

                        <div className="relative pl-6 space-y-6 before:absolute before:left-1 before:top-2 before:bottom-0 before:w-px before:bg-gradient-to-b before:from-[rgba(2,141,196,0.50)] before:to-transparent">
                            {invoice.logs?.length > 0 ? (
                                invoice.logs.map((log: any) => (
                                    <div key={log.id} className="relative group">
                                        <div className="absolute -left-[24px] top-1.5 w-2 h-2 rounded-full bg-surface ring-2 ring-accent shadow-[0_0_10px_rgba(2,141,196,0.50)] z-10" />
                                        <div className="space-y-1">
                                            <p className="text-[11px] font-medium text-fg flex items-center gap-2">
                                                {log.topic === "orders/paid" ? t("shopifyPayment") : (log.topic === "refunds/create" ? t("refundRequested") : log.topic)}
                                                <span className="font-mono text-[10px] text-fg-40">#{log.status}</span>
                                            </p>
                                            <p className="text-[10px] text-fg-60 leading-relaxed font-medium">
                                                {log.topic === "orders/paid" ? t("ixInvoiceGenerated", { value: log.response || t("ixPendingValue") }) : (log.topic === "refunds/create" ? t("creditNoteProcessing") : t("operationSuccess"))}
                                            </p>
                                            <p className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{new Date(log.created_at).toLocaleString()}</p>
                                        </div>
                                    </div>
                                ))
                            ) : (
                                <p className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em] py-2">{t("noLogs")}</p>
                            )}
                        </div>
                    </div>

                    <div className="p-5 sm:p-8 rounded-[2rem] border border-hairline flex flex-col justify-center items-center text-center space-y-6 relative overflow-hidden group/pdf">
                        <div className="absolute inset-0 bg-[rgba(2,141,196,0.05)] opacity-0 group-hover/pdf:opacity-100 transition-opacity" />
                        <div className="bg-surface-2 p-6 rounded-3xl border border-hairline relative z-10">
                            <FileText className="w-12 h-12 text-accent" />
                        </div>
                        <div className="space-y-1 z-10">
                            <h5 className="font-medium text-fg">{t("documentPreview")}</h5>
                            <p className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{t("documentCertified")}</p>
                        </div>
                        <div className="flex gap-3 z-10">
                            <a
                                href={pdfUrl}
                                className="px-6 py-3 bg-fg text-surface hover:bg-accent-hot rounded-xl font-mono text-[10px] uppercase tracking-[0.18em] transition-all shadow-[0_8px_30px_-12px_rgba(2,141,196,0.45)] active:scale-95 flex items-center gap-2"
                            >
                                <Download className="w-3.5 h-3.5" /> {t("downloadPdf")}
                            </a>
                            <a
                                href={`https://${shopDomain}/admin/orders/${invoice.order_id}`}
                                target="_blank"
                                className="px-6 py-3 bg-surface-2 text-fg hover:bg-surface-2/70 rounded-xl font-mono text-[10px] uppercase tracking-[0.18em] transition-all active:scale-95 flex items-center gap-2 border border-hairline"
                            >
                                <ExternalLink className="w-3.5 h-3.5" /> {t("viewShopify")}
                            </a>
                        </div>
                    </div>
                </div>
            </motion.div>
        </motion.div>
    );
}
