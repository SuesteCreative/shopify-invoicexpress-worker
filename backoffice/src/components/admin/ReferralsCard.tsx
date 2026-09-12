"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Gift, AlertTriangle } from "lucide-react";

/**
 * The referral campaign, from the money side.
 *
 * The number worth looking at is "a pagar": a referral whose invitee has paid
 * and whose inviter has not been credited. The webhook tries twice on its own,
 * so anything sitting here has a reason, and the reason is in the note.
 */

interface Row {
    invitee_user_id: string;
    inviter_user_id: string;
    code: string;
    state: "pending" | "paid" | "credited";
    credit_cents: number | null;
    claimed_at: string;
    credited_at: string | null;
    note: string | null;
    inviter_label: string | null;
    invitee_label: string | null;
}

const euro = (cents: number) =>
    new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(cents / 100);
const n = (v: number) => new Intl.NumberFormat("pt-PT").format(v);

const STATE_PT: Record<Row["state"], string> = {
    pending: "inscreveu-se",
    paid: "a pagar",
    credited: "creditado",
};

export function ReferralsCard() {
    const [rows, setRows] = useState<Row[]>([]);
    const [total, setTotal] = useState(0);
    const [owed, setOwed] = useState(0);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await fetch("/api/admin/referrals");
            const body = await res.json() as any;
            if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
            setRows(body.referrals ?? []);
            setTotal(body.total_credited_cents ?? 0);
            setOwed(body.owed ?? 0);
        } catch (e) {
            setError(String((e as Error).message ?? e));
        }
    }, []);

    useEffect(() => { void load(); }, [load]);

    const drain = async (inviter: string) => {
        setBusy(inviter); setError(null);
        try {
            const res = await fetch("/api/admin/referrals", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ inviter_user_id: inviter }),
            });
            const body = await res.json() as any;
            if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
            await load();
        } catch (e) {
            setError(String((e as Error).message ?? e));
        } finally {
            setBusy(null);
        }
    };

    return (
        <section className="glass rounded-[2rem] p-5 sm:p-7 border-hairline space-y-5">
            <div>
                <h2 className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">
                    Convites
                </h2>
                <p className="mt-1 text-[11px] text-fg-40 leading-snug">
                    2 meses a quem convida, creditados no saldo Stripe quando o convidado paga a
                    primeira factura. {n(owed)} por creditar · {euro(total)} já dados.
                </p>
            </div>

            {error && (
                <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-destructive/5 border border-destructive/20 text-destructive text-xs font-medium">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                    <span>{error}</span>
                </div>
            )}

            {rows.length === 0 ? (
                <p className="text-[11px] text-fg-40">Ainda ninguém convidou ninguém.</p>
            ) : (
                <div className="space-y-1">
                    {rows.map((r) => (
                        <div key={r.invitee_user_id} className="flex items-baseline justify-between gap-3">
                            <span className="text-sm text-fg truncate">
                                {r.inviter_label || r.inviter_user_id}
                                <span className="text-fg-40"> convidou </span>
                                {r.invitee_label || r.invitee_user_id}
                            </span>
                            <span className="font-mono text-[11px] shrink-0 flex items-center gap-2">
                                <span className={r.state === "paid" ? "text-soon" : "text-fg-40"}>
                                    {STATE_PT[r.state]}
                                    {r.credit_cents ? ` · ${euro(r.credit_cents)}` : ""}
                                </span>
                                {r.note && <span className="text-destructive">{r.note}</span>}
                                {r.state === "paid" && (
                                    <button
                                        onClick={() => drain(r.inviter_user_id)}
                                        disabled={busy !== null}
                                        className="px-2 py-1 rounded-lg border border-hairline text-fg hover:bg-fg/5 transition-all disabled:opacity-40 flex items-center gap-1"
                                    >
                                        {busy === r.inviter_user_id
                                            ? <Loader2 className="w-3 h-3 animate-spin" />
                                            : <Gift className="w-3 h-3" />}
                                        Creditar
                                    </button>
                                )}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
}
