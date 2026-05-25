"use client";

export const runtime = "edge";

import { useState, useEffect, useMemo } from "react";
import { Loader2, Settings2, Check, X, Store, Webhook, FileText, ToggleLeft, ToggleRight, AlertTriangle, Search, ArrowUpDown, Clock } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslations } from "next-intl";

interface ClientRule {
    id: string;
    name: string;
    email: string;
    shopify_domain: string;
    ix_account_name: string;
    ix_environment: string;
    vat_included: number;
    auto_finalize: number;
    ix_exemption_reason: string;
    pos_mode: number;
    client_sync: number;
    webhooks_active: number;
    shopify_authorized: number;
    ix_authorized: number;
    shopify_forced_at?: string;
    webhooks_forced_at?: string;
    ix_forced_at?: string;
}

const Toggle = ({ value, onChange, label, description, warn }: {
    value: boolean;
    onChange: (v: boolean) => void;
    label: string;
    description: string;
    warn?: string;
}) => (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-hairline last:border-0">
        <div className="flex-1">
            <p className="text-sm font-bold text-fg">{label}</p>
            <p className="text-[11px] text-fg-40 mt-0.5">{description}</p>
            {warn && value && (
                <p className="text-[10px] text-soon mt-1 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" />{warn}
                </p>
            )}
        </div>
        <button onClick={() => onChange(!value)} className="shrink-0 mt-0.5">
            {value
                ? <ToggleRight className="w-8 h-8 text-accent-hot" />
                : <ToggleLeft className="w-8 h-8 text-fg-40" />
            }
        </button>
    </div>
);

export default function ClientRulesPage() {
    const t = useTranslations("clientRules");
    const [clients, setClients] = useState<ClientRule[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");

    useEffect(() => { fetchClients(); }, []);

    const fetchClients = async () => {
        setLoading(true);
        try {
            const res = await fetch("/api/admin/client-rules");
            setClients(await res.json() as ClientRule[]);
        } finally {
            setLoading(false);
        }
    };

    const updateFlag = async (userId: string, flag: string, value: number) => {
        setSaving(`${userId}-${flag}`);
        try {
            await fetch("/api/admin/client-rules", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetUserId: userId, flag, value })
            });
            setClients((prev: ClientRule[]) => prev.map(c => c.id === userId ? { ...c, [flag]: value } : c));
        } finally {
            setSaving(null);
        }
    };

    const filtered = useMemo(() =>
        clients
            .filter((c: ClientRule) =>
                c.name.toLowerCase().includes(search.toLowerCase()) ||
                c.email.toLowerCase().includes(search.toLowerCase()) ||
                c.shopify_domain?.toLowerCase().includes(search.toLowerCase())
            )
            .sort((a: ClientRule, b: ClientRule) => {
                // Since we don't have created_at in ClientRule yet, we'll just sort by name for now or ID
                return sortOrder === "desc" ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name);
            }),
        [clients, search, sortOrder]);

    if (loading) return (
        <div className="min-h-[60vh] flex items-center justify-center">
            <Loader2 className="w-12 h-12 text-accent animate-spin opacity-50" />
        </div>
    );

    return (
        <div className="space-y-12 animate-in fade-in duration-1000 slide-in-from-bottom-4">
            <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-8">
                <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-3">
                        <Settings2 className="w-8 h-8 text-accent" />
                        <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black tracking-tight bg-gradient-to-r from-fg via-fg to-fg-40 bg-clip-text text-transparent">
                            {t("title")}
                        </h1>
                    </div>
                    <p className="text-fg-60 font-semibold tracking-wide">
                        {t("subtitle")}
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-4">
                    <div className="relative group">
                        <Search className="w-4 h-4 text-fg-40 absolute left-4 top-1/2 -translate-y-1/2 group-focus-within:text-accent transition-colors" />
                        <input
                            type="text" placeholder={t("searchPlaceholder")}
                            value={search} onChange={e => setSearch(e.target.value)}
                            className="bg-surface-2/50 border border-hairline rounded-2xl py-3 pl-12 pr-6 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-[rgba(2,141,196,0.20)] focus:border-[rgba(2,141,196,0.40)] w-full lg:w-80 transition-all"
                        />
                    </div>
                    <button
                        onClick={() => setSortOrder((p: string) => p === "desc" ? "asc" : "desc")}
                        className="bg-surface-2/50 border border-hairline rounded-2xl px-5 py-3 text-xs font-black uppercase tracking-widest flex items-center gap-3 hover:bg-surface-2/80 transition-all active:scale-95"
                    >
                        <ArrowUpDown className="w-4 h-4 text-accent" />
                        {sortOrder === "desc" ? t("sortDesc") : t("sortAsc")}
                    </button>
                </div>
            </div>

            <div className="grid gap-6">
                <AnimatePresence mode="popLayout">
                    {filtered.map((client: ClientRule) => (
                        <motion.div
                            key={client.id}
                            layout
                            initial={{ opacity: 0, scale: 0.98 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.98 }}
                            className="glass rounded-[2rem] p-5 sm:p-8 border-hairline hover:border-rule transition-all"
                        >
                            {/* Client header */}
                            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between mb-6 pb-6 border-b border-hairline">
                                <div className="min-w-0">
                                    <h2 className="text-xl font-bold break-words">{client.name}</h2>
                                    <p className="text-fg-40 text-sm break-words">{client.email}</p>
                                    <div className="flex items-center gap-4 mt-4 flex-wrap">
                                        {client.shopify_domain && (
                                            <span className="flex items-center gap-1.5 text-[10px] text-fg-40 font-bold uppercase tracking-widest">
                                                <Store className="w-3 h-3 text-accent-hot" />
                                                {client.shopify_domain}
                                            </span>
                                        )}
                                        {client.ix_account_name && (
                                            <span className="flex items-center gap-1.5 text-[10px] text-fg-40 font-bold uppercase tracking-widest">
                                                <FileText className="w-3 h-3 text-accent" />
                                                {client.ix_account_name}
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <div className="flex flex-col items-start md:items-end gap-2 md:text-right shrink-0">
                                    <div className="text-[10px] font-black text-fg-40 uppercase tracking-widest bg-surface-2/50 px-3 py-1 rounded-lg border border-hairline">
                                        {t("exemption", { code: client.ix_exemption_reason || "M01" })}
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        {client.shopify_authorized === 1 && (
                                            <div className="flex flex-col items-end">
                                                <div className="px-2 py-1 rounded-md bg-surface-2 border border-hairline text-[9px] font-medium text-fg-60 uppercase tracking-tighter flex items-center gap-1">
                                                    <Check className="w-2.5 h-2.5" /> {t("shopifyForce")}
                                                </div>
                                                {client.shopify_forced_at && (
                                                    <span className="text-[7px] text-fg-40 font-bold mt-0.5 uppercase tracking-tighter">
                                                        {t("activatedAt", { date: new Date(client.shopify_forced_at).toLocaleString("pt-PT") })}
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                        {client.webhooks_active === 1 && (
                                            <div className="flex flex-col items-end">
                                                <div className="px-2 py-1 rounded-md bg-surface-2 border border-hairline text-[9px] font-medium text-fg-60 uppercase tracking-tighter flex items-center gap-1">
                                                    <Webhook className="w-2.5 h-2.5" /> {t("webhookForce")}
                                                </div>
                                                {client.webhooks_forced_at && (
                                                    <span className="text-[7px] text-fg-40 font-bold mt-0.5 uppercase tracking-tighter">
                                                        {t("activatedAt", { date: new Date(client.webhooks_forced_at).toLocaleString("pt-PT") })}
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                        {client.ix_authorized === 1 && (
                                            <div className="flex flex-col items-end">
                                                <div className="px-2 py-1 rounded-md bg-surface-2 border border-hairline text-[9px] font-medium text-fg-60 uppercase tracking-tighter flex items-center gap-1">
                                                    <Check className="w-2.5 h-2.5" /> {t("ixForce")}
                                                </div>
                                                {client.ix_forced_at && (
                                                    <span className="text-[7px] text-fg-40 font-bold mt-0.5 uppercase tracking-tighter">
                                                        {t("activatedAt", { date: new Date(client.ix_forced_at).toLocaleString("pt-PT") })}
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Toggleable flags */}
                            <div className="space-y-0">
                                <Toggle
                                    value={client.pos_mode === 1}
                                    onChange={v => updateFlag(client.id, "pos_mode", v ? 1 : 0)}
                                    label={t("posModeLabel")}
                                    description={t("posModeDesc")}
                                    warn={t("posModeWarn")}
                                />
                                <Toggle
                                    value={client.vat_included === 1}
                                    onChange={v => updateFlag(client.id, "vat_included", v ? 1 : 0)}
                                    label={t("vatIncludedLabel")}
                                    description={t("vatIncludedDesc")}
                                />
                                <Toggle
                                    value={client.auto_finalize === 1}
                                    onChange={v => updateFlag(client.id, "auto_finalize", v ? 1 : 0)}
                                    label={t("autoFinalizeLabel")}
                                    description={t("autoFinalizeDesc")}
                                    warn={t("autoFinalizeWarn")}
                                />
                                <Toggle
                                    value={client.client_sync === 1}
                                    onChange={v => updateFlag(client.id, "client_sync", v ? 1 : 0)}
                                    label={t("clientSyncLabel")}
                                    description={t("clientSyncDesc")}
                                />
                            </div>

                            {saving && saving.startsWith(client.id) && (
                                <div className="mt-4 flex items-center gap-2 text-[10px] text-fg-40 font-bold">
                                    <Loader2 className="w-3 h-3 animate-spin" /> {t("saving")}
                                </div>
                            )}
                        </motion.div>
                    ))}
                </AnimatePresence>

                {clients.length === 0 && (
                    <div className="text-center py-20 text-fg-40 font-bold text-sm">
                        {t("emptyList")}
                    </div>
                )}
            </div>
        </div>
    );
}
