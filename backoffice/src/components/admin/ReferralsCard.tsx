"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RotateCcw, Ban, AlertTriangle } from "lucide-react";

/**
 * The referral campaign, from the money side.
 *
 * A reward is two months pushed onto the inviter's subscription the moment the
 * invitee's subscription is created — before any money has come in. That was a
 * deliberate decision, and this card is where its cost stays visible: the
 * column worth reading is whether the invitee has EVER paid. A row rewarded
 * weeks ago whose invitee never paid is the shape abuse takes.
 *
 * Rows the webhook could not pay sit in `subscribed`, with the reason in the
 * note. Retry puts the row back through the one function that pays a reward;
 * there is no second path for admins. Only a hiperadmin may do either, so the
 * buttons follow the route's `can_act` instead of greeting a superadmin with 401.
 */

type State = "pending" | "subscribed" | "rewarded" | "void";

interface Row {
    invitee_user_id: string;
    inviter_user_id: string;
    inviter_client_code: string | null;
    invitee_client_code: string | null;
    state: State;
    claimed_at: string;
    invitee_subscribed_at: string | null;
    reward_months: number | null;
    reward_until: string | null;
    rewarded_at: string | null;
    void_reason: string | null;
    note: string | null;
    inviter_label: string | null;
    invitee_label: string | null;
    invitee_paid: boolean;
}

interface Payload {
    referrals: Row[];
    rewarded: number;
    months_given: number;
    owed: number;
    max_rewards: number;
    reward_months: number;
    can_act: boolean;
}

const STATE_PT: Record<State, string> = {
    pending: "inscreveu-se",
    subscribed: "subscreveu, por pagar",
    rewarded: "creditado",
    void: "anulado",
};

const n = (v: number) => new Intl.NumberFormat("pt-PT").format(v);
const ptDate = (iso: string | null) => {
    if (!iso) return "";
    const [y, m, d] = String(iso).slice(0, 10).split("-");
    return d && m && y ? `${d}/${m}/${y}` : String(iso).slice(0, 10);
};

export function ReferralsCard() {
    const [data, setData] = useState<Payload | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await fetch("/api/admin/referrals");
            const body = await res.json() as any;
            if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
            setData(body as Payload);
        } catch (e) {
            setError(String((e as Error).message ?? e));
        }
    }, []);

    useEffect(() => { void load(); }, [load]);

    const act = async (invitee: string, action: "retry" | "void") => {
        if (action === "void" && !confirm("Anular esta recompensa? Fica registada e não é paga.")) return;
        setBusy(invitee + action); setError(null);
        try {
            const res = await fetch("/api/admin/referrals", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // The route reads the INVITEE: a referral is keyed on who was invited.
                body: JSON.stringify({ invitee_user_id: invitee, action }),
            });
            const body = await res.json() as any;
            if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
            if (action === "retry" && body?.rewarded === false && body?.reason) {
                setError(`Não foi pago: ${body.reason}`);
            }
            await load();
        } catch (e) {
            setError(String((e as Error).message ?? e));
        } finally {
            setBusy(null);
        }
    };

    const rows = data?.referrals ?? [];
    // Rewarded before the invitee ever paid — the one number worth a look.
    const unpaidRewards = rows.filter((r) => r.state === "rewarded" && !r.invitee_paid).length;

    return (
        <section className="glass rounded-[2rem] p-5 sm:p-7 border-hairline space-y-5">
            <div>
                <h2 className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">
                    Convites
                </h2>
                <p className="mt-1 text-[11px] text-fg-40 leading-snug">
                    {data?.reward_months ?? 2} meses a quem convida, empurrados na subscrição quando a do
                    convidado é criada. Máximo {data?.max_rewards ?? 3} por conta.
                    {data && (
                        <>
                            {" "}{n(data.rewarded)} creditados · {n(data.months_given)} meses dados ·{" "}
                            {n(data.owed)} por pagar
                            {unpaidRewards > 0 && (
                                <span className="text-soon"> · {n(unpaidRewards)} creditados a quem nunca pagou</span>
                            )}
                        </>
                    )}
                </p>
            </div>

            {error && (
                <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-destructive/5 border border-destructive/20 text-destructive text-xs font-medium">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                    <span>{error}</span>
                </div>
            )}

            {!data ? (
                <div className="flex items-center gap-2 text-[11px] text-fg-40">
                    <Loader2 className="w-3 h-3 animate-spin" /> A carregar...
                </div>
            ) : rows.length === 0 ? (
                <p className="text-[11px] text-fg-40">Ainda ninguém convidou ninguém.</p>
            ) : (
                <div className="space-y-2">
                    {rows.map((r) => (
                        <div key={r.invitee_user_id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                            <span className="text-sm text-fg min-w-0 truncate">
                                {r.inviter_label || r.inviter_user_id}
                                {r.inviter_client_code && (
                                    <span className="ml-1 font-mono text-[10px] text-fg-40">{r.inviter_client_code}</span>
                                )}
                                <span className="text-fg-40"> convidou </span>
                                {r.invitee_label || r.invitee_user_id}
                                {r.invitee_client_code && (
                                    <span className="ml-1 font-mono text-[10px] text-fg-40">{r.invitee_client_code}</span>
                                )}
                            </span>
                            <span className="font-mono text-[11px] shrink-0 flex flex-wrap items-center gap-2">
                                <span className={
                                    r.state === "subscribed" ? "text-soon"
                                        : r.state === "void" ? "text-fg-40 line-through"
                                        : "text-fg-60"
                                }>
                                    {STATE_PT[r.state] ?? r.state}
                                    {r.reward_until ? ` · até ${ptDate(r.reward_until)}` : ""}
                                </span>
                                {r.state === "rewarded" && !r.invitee_paid && (
                                    <span className="text-soon">convidado ainda não pagou</span>
                                )}
                                {(r.note || r.void_reason) && (
                                    <span className="text-destructive">{r.void_reason || r.note}</span>
                                )}
                                {r.state === "subscribed" && data.can_act && (
                                    <>
                                        <button
                                            onClick={() => act(r.invitee_user_id, "retry")}
                                            disabled={busy !== null}
                                            className="px-2 py-1 rounded-lg border border-hairline text-fg hover:bg-fg/5 transition-all disabled:opacity-40 flex items-center gap-1"
                                        >
                                            {busy === r.invitee_user_id + "retry"
                                                ? <Loader2 className="w-3 h-3 animate-spin" />
                                                : <RotateCcw className="w-3 h-3" />}
                                            Tentar de novo
                                        </button>
                                        <button
                                            onClick={() => act(r.invitee_user_id, "void")}
                                            disabled={busy !== null}
                                            className="px-2 py-1 rounded-lg border border-hairline text-fg-60 hover:bg-fg/5 transition-all disabled:opacity-40 flex items-center gap-1"
                                        >
                                            <Ban className="w-3 h-3" />
                                            Anular
                                        </button>
                                    </>
                                )}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
}
