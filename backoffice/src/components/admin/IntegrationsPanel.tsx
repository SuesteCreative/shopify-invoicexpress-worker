"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
    Loader2, AlertTriangle, Search, Trash2, RotateCcw, Pause, Play,
    Wrench, X, CheckCircle2, CircleDashed, Ban, UserCog,
} from "lucide-react";
import { kindLabel } from "@/lib/connection-kinds";
import { merchantIntegrationHref } from "@/lib/merchant-routes";

/**
 * Every integration in the fleet, whether anyone finished setting it up.
 *
 * A merchant who starts an onboarding and walks away leaves a draft connection
 * behind. Their own integrations page shows it; no admin surface did, so they
 * were invisible in aggregate and an operator could only reach one by
 * impersonating its owner. This is the table that makes them addressable.
 */

interface Row {
    kind: "connection" | "legacy";
    id: string;
    user_id: string;
    account: string;
    email: string | null;
    account_inactive: boolean;
    account_role: string;
    orphan: boolean;
    source: string;
    destination: string;
    connection_key: string;
    status: string;
    label: string | null;
    identifier: string | null;
    has_source: boolean;
    has_destination: boolean;
    complete: boolean;
    error?: string | null;
    documents: number;
    invoice_cutoff?: string | null;
    created_at: string | null;
    updated_at: string | null;
    sub_state: string;
    can_delete: boolean;
}

type Pending = { row: Row; action: "delete" | "reset" };

/** What the server reports when a legacy delete would take too much with it. */
interface LegacyImpact {
    configured: boolean;
    shopify_domain: string | null;
    ix_account_name: string | null;
    documents: number;
}

/** The phrase the server demands. Identical for both row shapes, because the
 *  legacy pipe IS shopify:invoicexpress — named once so it cannot drift. */
const confirmPhrase = (row: Row) => `${row.source}:${row.destination}`;

/**
 * Where this integration lives in the merchant's own app.
 *
 * The route is kebab-cased and the kind is not, and InvoiceXpress is `ix` in a
 * path and `invoicexpress` everywhere else. Getting either wrong lands an
 * impersonated admin on a 404 wearing somebody else's session, which is the
 * worst place to discover a typo.
 */
const merchantHref = (row: Row) => merchantIntegrationHref(row.source, row.destination);

const n = (v: number) => new Intl.NumberFormat("pt-PT").format(v);

const dateOf = (s: string | null) => {
    if (!s) return "—";
    // Both timestamp shapes live in these columns; the date is the part that
    // agrees between them.
    const d = new Date(s.replace(" ", "T"));
    return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("pt-PT");
};

const STATUS_STYLE: Record<string, string> = {
    active: "text-accent-hot border-accent-hot/40",
    draft: "text-soon border-soon/40",
    paused: "text-fg-40 border-hairline",
    inactive: "text-fg-40 border-hairline",
};

const SUB_LABEL: Record<string, string> = {
    active: "a pagar",
    trialing: "em teste",
    trialing_earlybird: "early bird",
    blocked: "bloqueada",
    exempt: "isenta",
    none: "sem subscrição",
};

const Badge = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border font-mono text-[9px] uppercase tracking-[0.14em] whitespace-nowrap ${className}`}>
        {children}
    </span>
);

export function IntegrationsPanel() {
    const [data, setData] = useState<Row[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const [search, setSearch] = useState("");
    const [status, setStatus] = useState<"all" | "active" | "draft" | "paused">("all");
    const [completeness, setCompleteness] = useState<"all" | "complete" | "incomplete">("all");
    const [source, setSource] = useState("all");
    const [destination, setDestination] = useState("all");

    const [pending, setPending] = useState<Pending | null>(null);
    const [typed, setTyped] = useState("");
    const [forceImpact, setForceImpact] = useState<LegacyImpact | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await fetch("/api/admin/integrations");
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json() as { integrations: Row[] };
            setData(body.integrations ?? []);
            setError(null);
        } catch (e) {
            setError(String((e as Error).message ?? e));
        }
    }, []);

    useEffect(() => { void load(); }, [load]);

    const act = async (row: Row, action: "delete" | "reset" | "pause" | "resume", force = false) => {
        setBusy(row.id);
        try {
            const res = await fetch("/api/admin/integrations", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action,
                    kind: row.kind,
                    targetUserId: row.user_id,
                    source_kind: row.source,
                    destination_kind: row.destination,
                    confirm: confirmPhrase(row),
                    force,
                }),
            });
            const body = await res.json() as any;

            // 409: deleting this legacy row would take the account's fiscal
            // settings with it and it has issued documents. Show what is
            // attached and let the operator decide against real numbers.
            if (res.status === 409 && body?.requires_force) {
                setForceImpact(body.impact ?? null);
                return;
            }
            if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);

            setPending(null);
            setTyped("");
            setForceImpact(null);
            await load();

            // The server answers `already_gone` when it found nothing to act on.
            // For a destructive action an operator explicitly asked for, that is
            // not success — it means the list they clicked was out of date, and
            // it looked exactly like a delete that silently did nothing. Said
            // AFTER the reload, because load() clears the error on its way out.
            if (body?.already_gone) {
                setError("Não havia nada sobre que agir — a lista estava desactualizada. Foi recarregada.");
            }
        } catch (e) {
            setError(String((e as Error).message ?? e));
        } finally {
            setBusy(null);
        }
    };

    /**
     * Become this client, and land on this integration.
     *
     * A full navigation, not a router push: the cookie is set server-side and a
     * client-side transition would keep rendering the admin's own identity. The
     * banner in the merchant shell is what says whose account this is, and the
     * way back out.
     */
    const impersonate = async (row: Row) => {
        setBusy(row.id);
        try {
            const res = await fetch("/api/admin/impersonate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetId: row.user_id }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            window.location.href = merchantHref(row);
        } catch (e) {
            setError(String((e as Error).message ?? e));
            setBusy(null);
        }
    };

    const sources = useMemo(
        () => Array.from(new Set((data ?? []).map((r) => r.source))).sort(),
        [data]
    );
    const destinations = useMemo(
        () => Array.from(new Set((data ?? []).map((r) => r.destination))).sort(),
        [data]
    );

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return (data ?? []).filter((r) => {
            if (status !== "all" && r.status !== status) return false;
            if (completeness === "complete" && !r.complete) return false;
            if (completeness === "incomplete" && r.complete) return false;
            if (source !== "all" && r.source !== source) return false;
            if (destination !== "all" && r.destination !== destination) return false;
            if (!q) return true;
            return [r.account, r.email, r.identifier, r.label, r.user_id, r.connection_key]
                .filter(Boolean)
                .some((v) => String(v).toLowerCase().includes(q));
        });
    }, [data, search, status, completeness, source, destination]);

    const counts = useMemo(() => {
        const all = data ?? [];
        return {
            total: all.length,
            incomplete: all.filter((r) => !r.complete).length,
            drafts: all.filter((r) => r.status === "draft").length,
        };
    }, [data]);

    if (error && !data) {
        return (
            <div className="glass rounded-3xl p-6 border border-destructive/40 flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
                <div>
                    <p className="text-sm text-fg">Não foi possível carregar as integrações.</p>
                    <p className="mt-1 font-mono text-[11px] text-fg-40">{error}</p>
                </div>
            </div>
        );
    }

    if (!data) {
        return (
            <div className="flex items-center gap-3 text-fg-40">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="font-mono text-[10px] uppercase tracking-[0.18em]">A carregar</span>
            </div>
        );
    }

    const selectCls = "bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-accent/20";

    return (
        <div className="space-y-6 max-w-[1400px]">
            <header>
                <h1 className="text-3xl font-black text-fg">Integrações</h1>
                <p className="mt-2 text-sm text-fg-40">
                    {n(counts.total)} no total, {n(counts.incomplete)} por terminar
                    {counts.drafts > 0 && ` (${n(counts.drafts)} em rascunho)`}. Uma integração que
                    ninguém acabou de configurar não aparece em mais lado nenhum.
                </p>
            </header>

            {error && (
                <div className="glass rounded-2xl p-4 border border-destructive/40 flex items-start gap-3">
                    <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                    <p className="font-mono text-[11px] text-destructive">{error}</p>
                    <button onClick={() => setError(null)} className="ml-auto text-fg-40 hover:text-fg">
                        <X className="w-4 h-4" />
                    </button>
                </div>
            )}

            <div className="flex flex-wrap gap-3 items-center">
                <div className="relative flex-1 min-w-[220px]">
                    <Search className="w-4 h-4 text-fg-40 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Cliente, email, domínio, conta Stripe…"
                        className={`${selectCls} w-full pl-9`}
                    />
                </div>
                <select value={status} onChange={(e) => setStatus(e.target.value as any)} className={selectCls}>
                    <option value="all">Todos os estados</option>
                    <option value="active">Activa</option>
                    <option value="draft">Rascunho</option>
                    <option value="paused">Pausada</option>
                </select>
                <select value={completeness} onChange={(e) => setCompleteness(e.target.value as any)} className={selectCls}>
                    <option value="all">Completas e incompletas</option>
                    <option value="complete">Só completas</option>
                    <option value="incomplete">Só incompletas</option>
                </select>
                <select value={source} onChange={(e) => setSource(e.target.value)} className={selectCls}>
                    <option value="all">Qualquer origem</option>
                    {sources.map((s) => <option key={s} value={s}>{kindLabel(s)}</option>)}
                </select>
                <select value={destination} onChange={(e) => setDestination(e.target.value)} className={selectCls}>
                    <option value="all">Qualquer destino</option>
                    {destinations.map((d) => <option key={d} value={d}>{kindLabel(d)}</option>)}
                </select>
            </div>

            <div className="glass rounded-[2rem] border-hairline overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[1000px]">
                        <thead>
                            <tr className="border-b border-hairline">
                                {["Cliente", "Integração", "Estado", "Identificador", "Documentos", "Subscrição", "Criada", ""].map((h) => (
                                    <th key={h} className="text-left font-mono text-[9px] text-fg-40 uppercase tracking-[0.18em] px-4 py-3 whitespace-nowrap">
                                        {h}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.length === 0 && (
                                <tr>
                                    <td colSpan={8} className="px-4 py-10 text-center text-[11px] text-fg-40">
                                        Nada corresponde a estes filtros.
                                    </td>
                                </tr>
                            )}
                            {filtered.map((r) => (
                                <tr key={r.id} className="border-b border-hairline/50 hover:bg-fg/[0.02] transition-colors">
                                    <td className="px-4 py-3 max-w-[240px]">
                                        <div className="font-medium text-fg truncate">{r.label || r.account}</div>
                                        <div className="font-mono text-[10px] text-fg-40 truncate">{r.email ?? r.user_id}</div>
                                        <div className="flex gap-1 mt-1">
                                            {r.orphan && <Badge className="text-destructive border-destructive/40">sem conta</Badge>}
                                            {r.account_inactive && <Badge className="text-fg-40 border-hairline">dormente</Badge>}
                                            {r.account_role !== "user" && <Badge className="text-accent-ink border-accent/40">{r.account_role}</Badge>}
                                        </div>
                                    </td>

                                    <td className="px-4 py-3 whitespace-nowrap">
                                        <div className="text-fg">{kindLabel(r.source)} → {kindLabel(r.destination)}</div>
                                        {r.kind === "legacy" && (
                                            <div className="font-mono text-[9px] text-fg-40 uppercase tracking-[0.14em]">legada</div>
                                        )}
                                    </td>

                                    <td className="px-4 py-3">
                                        <div className="flex flex-col gap-1 items-start">
                                            <Badge className={STATUS_STYLE[r.status] ?? "text-fg-40 border-hairline"}>
                                                {r.status}
                                            </Badge>
                                            {r.complete ? (
                                                <Badge className="text-accent-hot border-accent-hot/40">
                                                    <CheckCircle2 className="w-3 h-3" /> completa
                                                </Badge>
                                            ) : (
                                                <Badge className="text-soon border-soon/40">
                                                    <CircleDashed className="w-3 h-3" />
                                                    {/* Say which half is missing: "incomplete" alone
                                                        does not tell an operator what to do next. */}
                                                    {!r.has_source && !r.has_destination ? "nada configurado"
                                                        : !r.has_source ? `falta ${kindLabel(r.source)}`
                                                        : !r.has_destination ? `falta ${kindLabel(r.destination)}`
                                                        : "por activar"}
                                                </Badge>
                                            )}
                                            {r.error && (
                                                <span className="font-mono text-[9px] text-destructive truncate max-w-[160px]" title={r.error}>
                                                    {r.error}
                                                </span>
                                            )}
                                        </div>
                                    </td>

                                    <td className="px-4 py-3 font-mono text-[11px] text-fg-60 max-w-[200px] truncate" title={r.identifier ?? ""}>
                                        {r.identifier ?? "—"}
                                    </td>

                                    <td className="px-4 py-3 font-mono text-[11px] text-fg tabular-nums">
                                        {n(r.documents)}
                                    </td>

                                    <td className="px-4 py-3">
                                        <Badge className={r.sub_state === "blocked" ? "text-destructive border-destructive/40" : "text-fg-40 border-hairline"}>
                                            {r.sub_state === "blocked" && <Ban className="w-3 h-3" />}
                                            {SUB_LABEL[r.sub_state] ?? r.sub_state}
                                        </Badge>
                                    </td>

                                    <td className="px-4 py-3 font-mono text-[11px] text-fg-40 whitespace-nowrap">
                                        {dateOf(r.created_at)}
                                    </td>

                                    <td className="px-4 py-3">
                                        <div className="flex items-center gap-1 justify-end">
                                            {/* An orphan has no account left to
                                                become — impersonating a deleted
                                                user resolves to nothing. */}
                                            {!r.orphan && (
                                                <button
                                                    onClick={() => impersonate(r)}
                                                    disabled={busy === r.id}
                                                    title="Entrar como este cliente, nesta integração"
                                                    className="p-2 rounded-lg text-fg-40 hover:text-soon hover:bg-soon/10 transition-colors disabled:opacity-40"
                                                >
                                                    {busy === r.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserCog className="w-4 h-4" />}
                                                </button>
                                            )}

                                            <Link
                                                href={`/admin/users/${r.user_id}/dev-mode`}
                                                title="Abrir a ficha do cliente"
                                                className="p-2 rounded-lg text-fg-40 hover:text-fg hover:bg-fg/5 transition-colors"
                                            >
                                                <Wrench className="w-4 h-4" />
                                            </Link>

                                            {r.status !== "draft" && (
                                                <button
                                                    onClick={() => act(r, r.status === "paused" ? "resume" : "pause")}
                                                    disabled={busy === r.id}
                                                    title={r.status === "paused" ? "Retomar" : "Pausar"}
                                                    className="p-2 rounded-lg text-fg-40 hover:text-fg hover:bg-fg/5 transition-colors disabled:opacity-40"
                                                >
                                                    {busy === r.id ? <Loader2 className="w-4 h-4 animate-spin" />
                                                        : r.status === "paused" ? <Play className="w-4 h-4" />
                                                        : <Pause className="w-4 h-4" />}
                                                </button>
                                            )}

                                            {r.can_delete && (
                                                <>
                                                    <button
                                                        onClick={() => { setPending({ row: r, action: "reset" }); setTyped(""); }}
                                                        title="Repor: limpa as credenciais e volta a rascunho"
                                                        className="p-2 rounded-lg text-fg-40 hover:text-soon hover:bg-soon/10 transition-colors"
                                                    >
                                                        <RotateCcw className="w-4 h-4" />
                                                    </button>
                                                    <button
                                                        onClick={() => { setPending({ row: r, action: "delete" }); setTyped(""); }}
                                                        title="Apagar a integração"
                                                        className="p-2 rounded-lg text-fg-40 hover:text-destructive hover:bg-destructive/10 transition-colors"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            <p className="text-[11px] text-fg-40 leading-relaxed">
                Apagar e repor tocam apenas na integração: credenciais, definições e a autorização
                do Stripe. As facturas já emitidas e os registos que as guardam ficam intactos — é
                o que impede uma nova configuração de refacturar um ano de vendas. Na linha legada
                Shopify → InvoiceXpress os dois verbos pesam mais: repor limpa as credenciais e deixa
                as definições fiscais da conta intactas, apagar remove a linha inteira e leva-as com
                ela — e recusa enquanto o cano tiver documentos emitidos.
            </p>

            {pending && (
                <ConfirmDialog
                    pending={pending}
                    typed={typed}
                    setTyped={setTyped}
                    busy={busy === pending.row.id}
                    forceImpact={forceImpact}
                    onCancel={() => { setPending(null); setTyped(""); setForceImpact(null); }}
                    onConfirm={() => act(pending.row, pending.action, !!forceImpact)}
                />
            )}
        </div>
    );
}

/**
 * The typed confirmation. Same phrase the merchant route requires, because the
 * server checks it either way — this is the part that makes a human read which
 * connection they are about to act on before it happens.
 */
function ConfirmDialog({ pending, typed, setTyped, busy, forceImpact, onCancel, onConfirm }: {
    pending: Pending;
    typed: string;
    setTyped: (v: string) => void;
    busy: boolean;
    forceImpact: LegacyImpact | null;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    const { row, action } = pending;
    const phrase = confirmPhrase(row);
    const destructive = action === "delete";
    const legacy = row.kind === "legacy";

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-scrim backdrop-blur-sm" role="dialog" aria-modal="true">
            <div className="glass rounded-[2rem] border-hairline p-7 max-w-lg w-full space-y-5">
                <div className="flex items-start gap-3">
                    <div className={`p-2 rounded-xl ${destructive ? "bg-destructive/10 text-destructive" : "bg-soon/10 text-soon"}`}>
                        {destructive ? <Trash2 className="w-5 h-5" /> : <RotateCcw className="w-5 h-5" />}
                    </div>
                    <div>
                        <h2 className="text-lg font-black text-fg">
                            {destructive ? "Apagar esta integração?" : "Repor esta integração?"}
                        </h2>
                        <p className="mt-1 text-sm text-fg-40">
                            {row.label || row.account} · {kindLabel(row.source)} → {kindLabel(row.destination)}
                        </p>
                    </div>
                </div>

                <div className={`rounded-2xl p-4 text-[13px] leading-relaxed ${destructive ? "bg-destructive/5 border border-destructive/20 text-fg" : "bg-soon/5 border border-soon/20 text-fg"}`}>
                    {destructive ? (
                        legacy ? (
                            <>A integração legada desaparece, <strong>e com ela as definições fiscais da
                            conta</strong> — IVA incluído, motivos de isenção, retenção, finalização
                            automática. Só é o que queres numa entrada que ninguém chegou a configurar.</>
                        ) : (
                            <>A ligação desaparece, com as regras de tag e os mapeamentos de produto dela.</>
                        )
                    ) : (
                        legacy ? (
                            <>As credenciais Shopify e InvoiceXpress são limpas. A linha fica, e com ela
                            todas as definições fiscais da conta.</>
                        ) : (
                            <>As credenciais e as definições são limpas e a ligação volta a rascunho, mantendo a linha e o histórico.</>
                        )
                    )}
                    {row.source === "stripe_connect" && " A autorização no Stripe do cliente é revogada."}
                    {row.documents > 0 && (
                        <> As <strong>{n(row.documents)}</strong> facturas já emitidas ficam onde estão.</>
                    )}
                </div>

                {forceImpact && (
                    <div className="rounded-2xl p-4 bg-destructive/10 border border-destructive/40 text-[13px] text-fg space-y-1">
                        <p className="font-medium text-destructive">Esta integração já emitiu documentos.</p>
                        <p>
                            {n(forceImpact.documents)} {forceImpact.documents === 1 ? "factura emitida" : "facturas emitidas"}
                            {forceImpact.shopify_domain && <> · {forceImpact.shopify_domain}</>}
                            {forceImpact.ix_account_name && <> · {forceImpact.ix_account_name}</>}
                        </p>
                        <p className="text-fg-40">
                            As facturas ficam onde estão. O que desaparece é a configuração.
                            Confirma outra vez para avançar mesmo assim.
                        </p>
                    </div>
                )}

                <div className="space-y-2">
                    <label className="block font-mono text-[10px] text-fg-40 uppercase tracking-[0.18em]">
                        Escreve <span className="text-fg">{phrase}</span> para confirmar
                    </label>
                    <input
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                        autoFocus
                        className="bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 text-sm font-mono w-full focus:outline-none focus:ring-2 focus:ring-accent/20"
                    />
                </div>

                <div className="flex gap-2 justify-end">
                    <button onClick={onCancel} className="px-4 py-2 rounded-xl text-sm text-fg-60 hover:text-fg transition-colors">
                        Cancelar
                    </button>
                    <button
                        onClick={onConfirm}
                        disabled={typed.trim() !== phrase || busy}
                        className={`px-4 py-2 rounded-xl text-sm font-medium text-on-accent transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 ${destructive ? "bg-destructive" : "bg-soon"}`}
                    >
                        {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                        {destructive ? (forceImpact ? "Apagar mesmo assim" : "Apagar") : "Repor"}
                    </button>
                </div>
            </div>
        </div>
    );
}
