"use client";

import { useState } from "react";
import { Loader2, Mail, AlertTriangle } from "lucide-react";

/**
 * "Your invoicing is stopped — here is where to subscribe."
 *
 * The worker has owned this email since it was written; what it never had was a
 * way to run it. The last batch went out on 08/09 by curl, which is how a job
 * ends up sent at the wrong moment or not at all.
 *
 * Two things this card refuses to let happen quietly. It will not send without
 * a dry run first, because the email states a verified count of unbilled orders
 * and that count is the whole message. And it does not touch the seven-day
 * resend guard: a merchant nudged three days after the last nudge is being
 * nagged, and shortening that has to be typed, not clicked.
 */

interface Candidate {
    user_id: string;
    email: string | null;
    name: string | null;
    status: string | null;
    pending: number;
    since: string | null;
    would_email: string[];
    marker_stored: boolean;
}

interface Result {
    checked: number;
    sent: number;
    failed: number;
    skipped_no_pending: number;
    skipped_recent_notice: number;
    skipped_paused_shops: number;
    dry_run: boolean;
    candidates: Candidate[];
}

const n = (v: number) => new Intl.NumberFormat("pt-PT").format(v);

export function DunningCard() {
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<Result | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [resendDays, setResendDays] = useState("");

    const run = async (confirm: boolean) => {
        setBusy(true);
        setError(null);
        try {
            const days = Number(resendDays);
            const res = await fetch("/api/admin/dunning", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    confirm,
                    ...(resendDays.trim() && Number.isFinite(days) && days > 0
                        ? { resend_after_days: days }
                        : {}),
                }),
            });
            const body = await res.json() as Result & { error?: string };
            if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
            setResult(body);
        } catch (e) {
            setError(String((e as Error).message ?? e));
        } finally {
            setBusy(false);
        }
    };

    /** Who would actually receive something. The rest are reported as skips. */
    const receiving = (result?.candidates ?? []).filter((c) => c.would_email.length > 0);

    return (
        <section className="glass rounded-[2rem] p-5 sm:p-7 border-hairline space-y-5">
            <div>
                <h2 className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">
                    Avisar quem está parado
                </h2>
                <p className="mt-1 text-[11px] text-fg-40 leading-snug">
                    Email a dizer que a facturação está parada e onde subscrever. Só chega a quem
                    tem encomendas pagas por facturar — zero pendentes é um incómodo, não um aviso —
                    e não repete antes de sete dias.
                </p>
            </div>

            {error && (
                <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-destructive/5 border border-destructive/20 text-destructive text-xs font-medium">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                    <span>{error}</span>
                </div>
            )}

            {result && (
                <div className="rounded-2xl p-4 bg-surface-2 border border-hairline space-y-3">
                    <p className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.18em]">
                        {result.dry_run ? "Simulação — nada foi enviado" : `Enviado · ${n(result.sent)}`}
                    </p>

                    {receiving.length === 0 ? (
                        <p className="text-[11px] text-fg-40">Ninguém a avisar neste momento.</p>
                    ) : (
                        <div className="space-y-1">
                            {receiving.map((c) => (
                                <div key={c.user_id} className="flex items-baseline justify-between gap-3">
                                    <span className="text-sm text-fg truncate">
                                        {c.name || c.email || c.user_id}
                                        <span className="ml-2 font-mono text-[10px] text-fg-40">
                                            {c.would_email.join(", ")}
                                        </span>
                                    </span>
                                    <span className="font-mono text-[11px] text-soon shrink-0">
                                        {n(c.pending)} {c.pending === 1 ? "factura" : "facturas"}
                                        {/* No subscription row means nothing can carry the
                                            "already notified" marker, so a re-run would email
                                            them again. Worth seeing before it happens. */}
                                        {!c.marker_stored && <span className="ml-2 text-destructive">sem marcador</span>}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}

                    <p className="font-mono text-[10px] text-fg-40 pt-2 border-t border-hairline">
                        {n(result.checked)} bloqueados ·{" "}
                        {n(result.skipped_no_pending)} sem nada por facturar ·{" "}
                        {n(result.skipped_recent_notice)} avisados há pouco ·{" "}
                        {n(result.skipped_paused_shops)} em pausa deliberada
                        {result.failed > 0 && <span className="text-destructive"> · {n(result.failed)} falharam</span>}
                    </p>
                </div>
            )}

            <div className="flex flex-wrap gap-2 items-center">
                <button
                    onClick={() => run(false)}
                    disabled={busy}
                    className="px-4 py-2 rounded-xl text-sm font-medium border border-hairline text-fg hover:bg-fg/5 transition-all disabled:opacity-40 flex items-center gap-2"
                >
                    {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                    Simular
                </button>
                <button
                    onClick={() => run(true)}
                    disabled={busy || !result?.dry_run || receiving.length === 0}
                    title={!result?.dry_run ? "Simula primeiro" : receiving.length === 0 ? "Ninguém a avisar" : undefined}
                    className="px-4 py-2 rounded-xl text-sm font-medium bg-fg text-surface hover:bg-accent hover:text-on-accent transition-all disabled:opacity-40 flex items-center gap-2"
                >
                    <Mail className="w-4 h-4" />
                    Enviar a {n(receiving.length)}
                </button>

                <label className="ml-auto flex items-center gap-2 text-[11px] text-fg-40">
                    Repetir ao fim de
                    <input
                        value={resendDays}
                        onChange={(e) => setResendDays(e.target.value.replace(/\D/g, ""))}
                        placeholder="7"
                        inputMode="numeric"
                        className="w-14 bg-surface-2/50 border border-hairline rounded-lg px-2 py-1 text-center font-mono text-[11px] text-fg focus:outline-none focus:ring-2 focus:ring-accent/20"
                    />
                    dias
                </label>
            </div>
        </section>
    );
}
