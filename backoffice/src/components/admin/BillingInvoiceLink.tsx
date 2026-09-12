"use client";

import { useCallback, useEffect, useState } from "react";
import {
    AlertTriangle, Check, ExternalLink, Link2, Loader2, RefreshCw,
} from "lucide-react";

/**
 * Which Kapta document each of an account's payments points at, and the way to
 * correct one.
 *
 * The merchant's Faturação page shows whatever the nightly matcher paired their
 * payment with. The matcher works by heuristic, so a document that was cancelled
 * and re-issued stays pinned to the payment and the merchant reads a cancelled
 * invoice as their own. This is where that gets fixed, by the number printed on
 * the replacement — the only handle a human has on a document.
 *
 * Portuguese in the strings, like the rest of /admin: the whole surface is pinned
 * to `ADMIN_LOCALE = "pt"`.
 */

type Ev = {
    id: string;
    type: string;
    stripe_object_id: string | null;
    payment_intent_id: string | null;
    amount_cents: number | null;
    currency: string | null;
    status: string | null;
    ix_invoice_id: string | null;
    ix_invoice_permalink: string | null;
    ix_match_method: string | null;
    ix_match_score: number | null;
    created_at: string;
    ix_doc_number: string | null;
    ix_doc_state: string | null;
    ix_shared_with_another_payment: boolean;
    stripe_invoice_number: string | null;
    /** The document whose reference IS this payment's Stripe invoice number, when
     * it is not the one currently linked. An exact answer, not a guess. */
    ix_by_reference: { number: string | null; state: string | null } | null;
};

type Feedback = { error?: string; ok?: string; needsForce?: boolean };

const METHOD_LABEL: Record<string, string> = {
    reference: "referência",
    heuristic: "heurística",
    manual: "manual",
};

function money(cents: number | null, currency: string | null) {
    if (cents == null) return "—";
    return new Intl.NumberFormat("pt-PT", {
        style: "currency", currency: (currency || "eur").toUpperCase(),
    }).format(cents / 100);
}

function day(iso: string) {
    const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
    return isNaN(d.getTime()) ? iso : d.toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function BillingInvoiceLink({ targetUserId }: { targetUserId: string }) {
    const [events, setEvents] = useState<Ev[]>([]);
    const [ixError, setIxError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [numbers, setNumbers] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState<string | null>(null);
    const [feedback, setFeedback] = useState<Record<string, Feedback>>({});

    const load = useCallback(async () => {
        setLoading(true); setLoadError(null);
        try {
            const res = await fetch(`/api/admin/dev-mode/link-ix?targetUserId=${encodeURIComponent(targetUserId)}`);
            const d: any = await res.json();
            if (!res.ok) { setLoadError(d.error || `HTTP ${res.status}`); setEvents([]); return; }
            setEvents(d.events ?? []);
            setIxError(d.ix_error ?? null);
        } catch (e: any) {
            setLoadError(String(e));
        } finally {
            setLoading(false);
        }
    }, [targetUserId]);

    useEffect(() => { load(); }, [load]);

    const submit = async (ev: Ev, force = false) => {
        const number = (numbers[ev.id] || "").trim();
        if (!number) return;
        setBusy(ev.id);
        setFeedback(f => ({ ...f, [ev.id]: {} }));
        try {
            const res = await fetch("/api/admin/dev-mode/link-ix", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetUserId, billing_event_id: ev.id, ix_number: number, force }),
            });
            const d: any = await res.json();
            if (!res.ok) {
                setFeedback(f => ({ ...f, [ev.id]: { error: d.error || `HTTP ${res.status}`, needsForce: !!d.needs_force } }));
                return;
            }
            setFeedback(f => ({
                ...f,
                [ev.id]: { ok: d.replaced ? `Substituída por ${d.ix_doc_number || d.ix_invoice_id}` : `Associada ${d.ix_doc_number || d.ix_invoice_id}` },
            }));
            setNumbers(n => ({ ...n, [ev.id]: "" }));
            await load();
        } catch (e: any) {
            setFeedback(f => ({ ...f, [ev.id]: { error: String(e) } }));
        } finally {
            setBusy(null);
        }
    };

    if (loading && events.length === 0) {
        return <p className="flex items-center gap-2 text-xs font-medium text-fg-40"><Loader2 className="w-4 h-4 animate-spin" /> A ler os pagamentos…</p>;
    }
    if (loadError) {
        return <p className="text-xs font-medium text-destructive">{loadError}</p>;
    }
    if (events.length === 0) {
        return <p className="text-xs font-medium text-fg-40">Esta conta não tem pagamentos registados.</p>;
    }

    return (
        <div className="space-y-4">
            {ixError && (
                <p className="flex items-start gap-2 rounded-xl bg-soon/5 border border-soon/20 px-3 py-2 text-[11px] font-medium text-fg">
                    <AlertTriangle className="w-3.5 h-3.5 text-soon shrink-0 mt-px" />
                    Não foi possível ler a conta da Kapta no InvoiceXpress, por isso os números e estados dos documentos não aparecem. Associar continua a funcionar.
                </p>
            )}

            {events.map(ev => {
                const fb = feedback[ev.id] || {};
                const cancelled = ev.ix_doc_state === "canceled";
                return (
                    <div key={ev.id} className="rounded-2xl border border-hairline bg-surface-2/40 p-4 space-y-3">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-[11px] text-fg-40">
                            <span className="text-fg font-medium">{day(ev.created_at)}</span>
                            <span>·</span>
                            <span className="text-fg font-medium">{money(ev.amount_cents, ev.currency)}</span>
                            <span>·</span>
                            <span>{ev.status || ev.type}</span>
                            <span className="truncate">{ev.payment_intent_id || ev.stripe_object_id}</span>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 text-[11px]">
                            {ev.ix_invoice_id ? (
                                <>
                                    <a
                                        href={ev.ix_invoice_permalink || undefined}
                                        target="_blank" rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1.5 font-mono font-medium text-accent-ink hover:text-accent-hot transition-colors"
                                    >
                                        {ev.ix_doc_number || ev.ix_invoice_id}
                                        <ExternalLink className="w-3 h-3" />
                                    </a>
                                    {ev.ix_match_method && (
                                        <span className="font-mono text-fg-40">
                                            {METHOD_LABEL[ev.ix_match_method] || ev.ix_match_method}
                                            {ev.ix_match_score != null && ` ${ev.ix_match_score}`}
                                        </span>
                                    )}
                                    {cancelled && (
                                        <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-destructive">
                                            <AlertTriangle className="w-3 h-3" /> anulado
                                        </span>
                                    )}
                                    {ev.ix_shared_with_another_payment && (
                                        <span className="inline-flex items-center gap-1 rounded-full bg-soon/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-soon">
                                            <AlertTriangle className="w-3 h-3" /> também noutro pagamento
                                        </span>
                                    )}
                                </>
                            ) : (
                                <span className="font-mono text-fg-40">sem documento associado</span>
                            )}
                        </div>

                        {ev.ix_by_reference?.number && (
                            <div className="flex flex-wrap items-center gap-2 rounded-xl bg-accent/5 border border-accent/20 px-3 py-2 text-[11px]">
                                <span className="font-mono text-fg-40">
                                    ref. {ev.stripe_invoice_number} →
                                </span>
                                <span className="font-mono font-medium text-accent-ink">{ev.ix_by_reference.number}</span>
                                <span className="text-fg-60">é o documento que a referência do Stripe aponta</span>
                                <button
                                    onClick={() => setNumbers(n => ({ ...n, [ev.id]: ev.ix_by_reference!.number! }))}
                                    className="ml-auto px-2.5 py-1 rounded-lg bg-accent/10 text-accent-ink font-mono text-[10px] uppercase tracking-[0.14em] hover:bg-accent/20 transition-colors"
                                >
                                    Usar
                                </button>
                            </div>
                        )}

                        <div className="flex flex-wrap items-center gap-2">
                            <input
                                value={numbers[ev.id] || ""}
                                onChange={e => setNumbers(n => ({ ...n, [ev.id]: e.target.value }))}
                                placeholder="KAPTA2026/673"
                                className="flex-1 min-w-[180px] bg-surface border border-hairline rounded-xl px-3 py-2 text-sm font-mono text-fg focus:outline-none focus:ring-2 focus:ring-accent/20"
                            />
                            <button
                                onClick={() => submit(ev)}
                                disabled={busy === ev.id || !(numbers[ev.id] || "").trim()}
                                className="px-4 py-2 rounded-xl bg-fg text-surface font-mono text-[10px] uppercase tracking-[0.18em] hover:bg-accent-hot transition-all disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
                            >
                                {busy === ev.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
                                {ev.ix_invoice_id ? "Substituir" : "Associar"}
                            </button>
                        </div>

                        {fb.error && (
                            <div className="rounded-xl bg-destructive/5 border border-destructive/20 px-3 py-2 space-y-2">
                                <p className="text-[11px] font-medium text-destructive">{fb.error}</p>
                                {fb.needsForce && (
                                    <button
                                        onClick={() => submit(ev, true)}
                                        disabled={busy === ev.id}
                                        className="px-3 py-1.5 rounded-lg bg-destructive/10 text-destructive font-mono text-[10px] uppercase tracking-[0.14em] hover:bg-destructive/20 transition-colors disabled:opacity-40"
                                    >
                                        Associar mesmo assim
                                    </button>
                                )}
                            </div>
                        )}
                        {fb.ok && (
                            <p className="inline-flex items-center gap-1.5 text-[11px] font-medium text-accent-hot">
                                <Check className="w-3.5 h-3.5" /> {fb.ok}
                            </p>
                        )}
                    </div>
                );
            })}

            <button
                onClick={load}
                disabled={loading}
                className="inline-flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.18em] text-fg-40 hover:text-fg transition-colors disabled:opacity-40"
            >
                {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                Recarregar
            </button>
        </div>
    );
}
