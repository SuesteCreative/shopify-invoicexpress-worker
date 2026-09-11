"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
    Loader2, AlertTriangle, Wallet, TrendingUp, Repeat, CreditCard,
    Search, Wrench, Clock, EyeOff,
} from "lucide-react";
import { kindLabel } from "@/lib/connection-kinds";

/**
 * What the fleet is worth, and what each client in it has paid.
 *
 * Two different kinds of number share this page and it is worth keeping them
 * apart while reading: revenue is history, taken from the payment ledger in D1;
 * MRR is a forecast, priced live from Stripe. When they disagree it is usually
 * because a backfilled payment was booked on the day it was linked rather than
 * the day it was made.
 */

interface Line {
    connection_key: string;
    status: string;
    state: string;
    plan: string | null;
    price_id: string | null;
    monthly_cents: number;
    current_period_end: string | null;
    trial_end: string | null;
    early_bird: boolean;
    cancel_at_period_end: boolean;
    has_stripe_sub: boolean;
}

interface Account {
    user_id: string;
    account: string;
    email: string | null;
    role: string;
    is_inactive: boolean;
    lines: Line[];
    mrr_cents: number;
    gross_cents: number;
    refunded_cents: number;
    seat_cents: number;
    seats: number;
    net_cents: number;
    payments: number;
    last_payment_at: string | null;
}

interface Finance {
    revenue: { ym: string; gross_cents: number; refunded_cents: number; net_cents: number }[];
    subscription_net_cents: number;
    seat_cents: number;
    lifetime_net_cents: number;
    mrr_cents: number;
    arr_cents: number;
    prices_missing: number;
    price_book_size: number;
    accounts: Account[];
    trials_ending: { user_id: string; account: string; connection_key: string; trial_end: string }[];
    failed_payments: { id: string; user_id: string; account: string; amount_cents: number; currency: string; created_at: string }[];
}

const eur = (cents: number) =>
    new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(cents / 100);
const n = (v: number) => new Intl.NumberFormat("pt-PT").format(v);

const dateOf = (s: string | null) => {
    if (!s) return "—";
    const d = new Date(s.replace(" ", "T"));
    return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("pt-PT");
};

const monthLabel = (ym: string) => {
    const [y, m] = ym.split("-");
    const names = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
    return `${names[Number(m) - 1] ?? m} ${y?.slice(2) ?? ""}`;
};

const STATE_LABEL: Record<string, string> = {
    active: "a pagar",
    trialing: "em teste",
    trialing_earlybird: "early bird",
    blocked: "bloqueada",
    exempt: "isenta",
    none: "sem subscrição",
};

const Card = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
    <section className="glass rounded-[2rem] p-5 sm:p-7 border-hairline space-y-5">
        <div>
            <h2 className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{title}</h2>
            {hint && <p className="mt-1 text-[11px] text-fg-40 leading-snug">{hint}</p>}
        </div>
        {children}
    </section>
);

const Kpi = ({ icon: Icon, label, value, sub }: {
    icon: React.ComponentType<{ className?: string }>;
    label: string; value: string; sub?: string;
}) => (
    <div className="glass rounded-3xl p-5 border-hairline">
        <div className="flex items-center gap-2 text-fg-40">
            <Icon className="w-4 h-4" />
            <span className="font-mono text-[10px] uppercase tracking-[0.18em]">{label}</span>
        </div>
        <div className="mt-3 text-3xl font-black text-fg tabular-nums">{value}</div>
        {sub && <div className="mt-1 text-[11px] text-fg-40">{sub}</div>}
    </div>
);

/** Gross above the line, refunded below it, so a bad month looks like one. */
function RevenueBars({ data }: { data: Finance["revenue"] }) {
    if (data.length === 0) return <p className="text-[11px] text-fg-40">Sem dados.</p>;
    const max = Math.max(...data.map((d) => Math.max(d.gross_cents, d.refunded_cents)), 1);

    return (
        <div className="overflow-x-auto">
            <div className="flex items-stretch gap-1.5 h-44 min-w-fit">
                {data.map((d) => (
                    <div key={d.ym} className="flex-1 flex flex-col items-center gap-2 group min-w-[30px]">
                        <div className="flex-1 flex flex-col justify-end w-full gap-px">
                            <div
                                className="w-full rounded-t-md bg-accent-hot/70"
                                style={{ height: `${Math.max((d.gross_cents / max) * 100, d.gross_cents > 0 ? 3 : 0)}%` }}
                                title={`${monthLabel(d.ym)}: ${eur(d.gross_cents)} bruto`}
                            />
                            {d.refunded_cents > 0 && (
                                <div
                                    className="w-full rounded-b-md bg-destructive/60"
                                    style={{ height: `${Math.max((d.refunded_cents / max) * 100, 3)}%` }}
                                    title={`${monthLabel(d.ym)}: −${eur(d.refunded_cents)} reembolsado`}
                                />
                            )}
                        </div>
                        <span className="font-mono text-[9px] text-fg-40 whitespace-nowrap">{monthLabel(d.ym)}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

export function FinancePanel() {
    const [data, setData] = useState<Finance | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [onlyPaying, setOnlyPaying] = useState(false);

    useEffect(() => {
        fetch("/api/admin/finance")
            .then(async (r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json() as Promise<Finance>;
            })
            .then(setData)
            .catch((e) => setError(String(e?.message ?? e)));
    }, []);

    const accounts = useMemo(() => {
        const q = search.trim().toLowerCase();
        return (data?.accounts ?? []).filter((a) => {
            if (onlyPaying && a.mrr_cents === 0) return false;
            if (!q) return true;
            return [a.account, a.email, a.user_id].filter(Boolean)
                .some((v) => String(v).toLowerCase().includes(q));
        });
    }, [data, search, onlyPaying]);

    if (error) {
        return (
            <div className="glass rounded-3xl p-6 border border-destructive/40 flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
                <div>
                    <p className="text-sm text-fg">Não foi possível carregar o financeiro.</p>
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

    const thisMonth = new Date().toISOString().slice(0, 7);
    const monthNet = data.revenue.find((r) => r.ym === thisMonth)?.net_cents ?? 0;
    const payingCount = data.accounts.filter((a) => a.mrr_cents > 0).length;

    return (
        <div className="space-y-8 max-w-[1400px]">
            <header>
                <h1 className="text-3xl font-black text-fg">Financeiro</h1>
                <p className="mt-2 text-sm text-fg-40">
                    A receita é histórico, lido do livro de pagamentos. O MRR é previsão, calculado
                    aos preços que o Stripe tem agora. Quando divergem, é quase sempre um pagamento
                    reposto à mão que ficou datado do dia em que foi ligado.
                </p>
            </header>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <Kpi icon={Repeat} label="MRR" value={eur(data.mrr_cents)}
                     sub={`${n(payingCount)} ${payingCount === 1 ? "conta a pagar" : "contas a pagar"}`} />
                <Kpi icon={TrendingUp} label="ARR" value={eur(data.arr_cents)} sub="MRR × 12" />
                <Kpi icon={Wallet} label="Recebido" value={eur(data.lifetime_net_cents)}
                     sub="subscrições e lugares, líquido" />
                <Kpi icon={CreditCard} label="Este mês" value={eur(monthNet)} sub={monthLabel(thisMonth)} />
            </div>

            {data.prices_missing > 0 && (
                <div className="glass rounded-2xl p-4 border border-soon/40 flex items-start gap-3">
                    <EyeOff className="w-4 h-4 text-soon shrink-0 mt-0.5" />
                    <p className="text-[12px] text-fg">
                        {n(data.prices_missing)} {data.prices_missing === 1 ? "subscrição activa" : "subscrições activas"} com
                        um preço que o Stripe não devolveu. O MRR acima está curto por esse valor.
                    </p>
                </div>
            )}

            <Card
                title="Receita por mês"
                hint="Bruto com IVA incluído, a barra vermelha por baixo é o reembolsado. O IVA não está na base de dados."
            >
                <RevenueBars data={data.revenue.slice(-18)} />
                <p className="text-[11px] text-fg-40">
                    Subscrições {eur(data.subscription_net_cents)}
                    {data.seat_cents > 0 && <> · lugares extra {eur(data.seat_cents)}, que não passam pelo livro de pagamentos</>}
                </p>
            </Card>

            <div className="grid lg:grid-cols-2 gap-6">
                <Card title="Testes a acabar" hint="Early birds sem subscrição no Stripe, nos próximos 30 dias.">
                    {data.trials_ending.length === 0 ? (
                        <p className="text-[11px] text-fg-40">Nenhum nos próximos 30 dias.</p>
                    ) : (
                        <div className="space-y-2">
                            {data.trials_ending.map((t) => (
                                <div key={`${t.user_id}:${t.connection_key}`} className="flex items-baseline justify-between gap-3">
                                    <Link href={`/admin/users/${t.user_id}/dev-mode`} className="text-sm text-fg hover:text-accent-ink truncate">
                                        {t.account}
                                    </Link>
                                    <span className="font-mono text-[11px] text-soon shrink-0 flex items-center gap-1">
                                        <Clock className="w-3 h-3" /> {dateOf(t.trial_end)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </Card>

                <Card title="Cobranças falhadas" hint="O Stripe tentou e não conseguiu. Só o cliente resolve.">
                    {data.failed_payments.length === 0 ? (
                        <p className="text-[11px] text-fg-40">Nenhuma registada.</p>
                    ) : (
                        <div className="space-y-2">
                            {data.failed_payments.map((f) => (
                                <div key={f.id} className="flex items-baseline justify-between gap-3">
                                    <Link href={`/admin/users/${f.user_id}/dev-mode`} className="text-sm text-fg hover:text-accent-ink truncate">
                                        {f.account}
                                    </Link>
                                    <span className="font-mono text-[11px] text-destructive shrink-0">
                                        {eur(f.amount_cents)} · {dateOf(f.created_at)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </Card>
            </div>

            <div className="space-y-4">
                <div className="flex flex-wrap gap-3 items-center">
                    <div className="relative flex-1 min-w-[220px]">
                        <Search className="w-4 h-4 text-fg-40 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Cliente ou email…"
                            className="bg-surface-2/50 border border-hairline rounded-xl pl-9 pr-3 py-2 text-sm font-medium w-full focus:outline-none focus:ring-2 focus:ring-accent/20"
                        />
                    </div>
                    <label className="flex items-center gap-2 text-sm text-fg-60 cursor-pointer select-none">
                        <input type="checkbox" checked={onlyPaying} onChange={(e) => setOnlyPaying(e.target.checked)} />
                        Só quem paga
                    </label>
                </div>

                <div className="glass rounded-[2rem] border-hairline overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm min-w-[900px]">
                            <thead>
                                <tr className="border-b border-hairline">
                                    {["Cliente", "Subscrições", "MRR", "Recebido", "Reembolsado", "Pagamentos", "Último", ""].map((h) => (
                                        <th key={h} className="text-left font-mono text-[9px] text-fg-40 uppercase tracking-[0.18em] px-4 py-3 whitespace-nowrap">
                                            {h}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {accounts.length === 0 && (
                                    <tr><td colSpan={8} className="px-4 py-10 text-center text-[11px] text-fg-40">Nada corresponde.</td></tr>
                                )}
                                {accounts.map((a) => (
                                    <tr key={a.user_id} className="border-b border-hairline/50 hover:bg-fg/[0.02] transition-colors">
                                        <td className="px-4 py-3 max-w-[240px]">
                                            <div className="font-medium text-fg truncate">{a.account}</div>
                                            <div className="font-mono text-[10px] text-fg-40 truncate">{a.email ?? a.user_id}</div>
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="flex flex-col gap-0.5">
                                                {a.lines.map((l) => (
                                                    <span key={l.connection_key} className="font-mono text-[10px] text-fg-40 whitespace-nowrap">
                                                        {l.connection_key.split(":").map(kindLabel).join(" → ")}
                                                        <span className="ml-2 text-fg-60">{STATE_LABEL[l.state] ?? l.state}</span>
                                                        {l.cancel_at_period_end && <span className="ml-2 text-destructive">cancela</span>}
                                                    </span>
                                                ))}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 font-mono text-[12px] text-fg tabular-nums whitespace-nowrap">
                                            {a.mrr_cents > 0 ? eur(a.mrr_cents) : "—"}
                                        </td>
                                        <td className="px-4 py-3 font-mono text-[12px] text-fg tabular-nums whitespace-nowrap">
                                            {eur(a.net_cents)}
                                            {a.seats > 0 && (
                                                <span className="ml-2 text-[10px] text-fg-40">
                                                    inclui {n(a.seats)} {a.seats === 1 ? "lugar" : "lugares"}
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 font-mono text-[12px] tabular-nums whitespace-nowrap">
                                            {a.refunded_cents > 0
                                                ? <span className="text-destructive">−{eur(a.refunded_cents)}</span>
                                                : <span className="text-fg-40">—</span>}
                                        </td>
                                        <td className="px-4 py-3 font-mono text-[12px] text-fg-60 tabular-nums">{n(a.payments)}</td>
                                        <td className="px-4 py-3 font-mono text-[11px] text-fg-40 whitespace-nowrap">{dateOf(a.last_payment_at)}</td>
                                        <td className="px-4 py-3 text-right">
                                            <Link
                                                href={`/admin/users/${a.user_id}/dev-mode`}
                                                title="Abrir a ficha do cliente"
                                                className="inline-block p-2 rounded-lg text-fg-40 hover:text-fg hover:bg-fg/5 transition-colors"
                                            >
                                                <Wrench className="w-4 h-4" />
                                            </Link>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    );
}
