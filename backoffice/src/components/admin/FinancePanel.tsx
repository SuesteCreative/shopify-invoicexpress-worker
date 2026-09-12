"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
    Loader2, AlertTriangle, Wallet, TrendingUp, Repeat, CreditCard,
    Search, Wrench, Clock, EyeOff,
} from "lucide-react";
import { kindLabel } from "@/lib/connection-kinds";
import { DunningCard } from "@/components/admin/DunningCard";
import { ReferralsCard } from "@/components/admin/ReferralsCard";

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
    price_legacy: boolean;
    price_legacy_source: string;
    price_amount_cents: number | null;
    price_interval: string | null;
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
    unresolved_prices: { price_id: string; n: number }[];
    price_book_size: number;
    subscription_per_connection?: boolean;
    accounts: Account[];
    tiers: Record<"legacy" | "current" | "unknown", { mrr_cents: number; lines: number }>;
    sunsets: {
        user_id: string; account: string; connection_key: string;
        plan: string | null; interval: string | null;
        unit_amount_cents: number | null; next_price_cents: number | null;
        sunset_at: string; cancel_at_period_end: boolean; marked: boolean;
    }[];
    trials_ending: { user_id: string; account: string; connection_key: string; trial_end: string }[];
    outstanding_payments: {
        id: string; invoice_id: string; user_id: string; account: string;
        amount_cents: number; currency: string; created_at: string; attempts: number;
        reason: string | null; description: string | null;
    }[];
    settled_after_failure: number;
    price_catalogue: {
        source: string; product_name: string; plan: string; lookup: string | null;
        status: "ok" | "archived" | "missing" | "no_key" | "wrong_amount";
        amount_cents: number | null; expected_cents: number;
    }[];
    seat_price?: {
        lookup: string;
        status: "ok" | "archived" | "missing" | "wrong_amount" | "recurring";
        amount_cents: number | null; expected_cents: number;
    };
}

interface CreateResult {
    dry_run: boolean;
    prices: {
        action?: "create" | "replace" | "product" | "default";
        default_moved?: boolean;
        lookup: string; product_name: string; amount_cents: number; interval: string;
        product_id?: string | null; product_created?: boolean; product_filled?: string[];
        replaces_price_id?: string; replaces_amount_cents?: number; replaces_subscriptions?: number | null;
        replaced_archived?: boolean;
        price_id?: string; created?: boolean; error?: string;
    }[];
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

/** Stripe's own word for why an invoice exists, when the line has no name. */
const REASON_LABEL: Record<string, string> = {
    subscription_cycle: "renovação",
    subscription_create: "início da subscrição",
    subscription_update: "alteração da subscrição",
    manual: "factura avulsa",
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
    const [creating, setCreating] = useState(false);
    const [createResult, setCreateResult] = useState<CreateResult | null>(null);

    /** Dry run first, always: a Stripe price cannot be deleted once created,
     *  only archived, so what would be written is shown before it is. */
    const createPrices = async (confirm: boolean) => {
        setCreating(true);
        try {
            const res = await fetch("/api/admin/finance/prices", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ confirm }),
            });
            const body = await res.json() as CreateResult & { error?: string };
            if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
            setCreateResult(body);
            if (confirm) {
                // The catalogue above is stale by construction once we write.
                const fresh = await fetch("/api/admin/finance").then((r) => r.json()) as Finance;
                setData(fresh);
            }
        } catch (e) {
            setError(String((e as Error).message ?? e));
        } finally {
            setCreating(false);
        }
    };
    const [marking, setMarking] = useState<string | null>(null);

    const load = () =>
        fetch("/api/admin/finance")
            .then(async (r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json() as Promise<Finance>;
            })
            .then(setData)
            .catch((e) => setError(String(e?.message ?? e)));

    useEffect(() => { load(); }, []);

    /** Tell Stripe when this one ends, and tell the client. */
    const markSunset = async (user_id: string, connection_key: string) => {
        const key = `${user_id}:${connection_key}`;
        setMarking(key);
        try {
            const res = await fetch("/api/admin/legacy-sunset", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user_id, connection_key }),
            });
            const json: any = await res.json().catch(() => ({}));
            if (!res.ok) setError(json.error ?? `HTTP ${res.status}`);
            await load();
        } catch (e: any) {
            setError(String(e?.message ?? e));
        } finally {
            setMarking(null);
        }
    };

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
                    A receita é histórico, lida do livro de pagamentos, e vem <strong>com IVA</strong>,
                    porque é o que foi cobrado. O MRR é previsão, calculado aos preços do Stripe, que
                    são <strong>sem IVA</strong> — os 92,25 € que um cliente anual paga são 75 € de
                    preço. As duas colunas não se comparam directamente.
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
                    <div className="text-[12px] text-fg space-y-1">
                        <p>
                            {n(data.prices_missing)} {data.prices_missing === 1 ? "subscrição activa" : "subscrições activas"} com
                            um preço que o Stripe não devolveu. O MRR acima está curto por esse valor.
                        </p>
                        <p className="font-mono text-[11px] text-fg-40">
                            {data.unresolved_prices.map((u) => `${u.price_id}${u.n > 1 ? ` ×${u.n}` : ""}`).join(" · ")}
                        </p>
                    </div>
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
                <Card
                    title="Preço antigo e preço actual"
                    hint="Quem assinou a 5 €/50 € ficou nesse preço. Acaba no fim da subscrição; as mensais a 01/01/2027."
                >
                    <div className="space-y-2 text-[12px]">
                        <div className="flex items-baseline justify-between gap-3">
                            <span className="text-fg-60">Preço actual · {n(data.tiers.current.lines)} {data.tiers.current.lines === 1 ? "subscrição" : "subscrições"}</span>
                            <span className="font-mono text-fg">{eur(data.tiers.current.mrr_cents)}/mês</span>
                        </div>
                        <div className="flex items-baseline justify-between gap-3">
                            <span className="text-fg-60">Preço antigo · {n(data.tiers.legacy.lines)} {data.tiers.legacy.lines === 1 ? "subscrição" : "subscrições"}</span>
                            <span className="font-mono text-soon">{eur(data.tiers.legacy.mrr_cents)}/mês</span>
                        </div>
                        {data.tiers.unknown.mrr_cents > 0 && (
                            <div className="flex items-baseline justify-between gap-3">
                                <span className="text-fg-60">Preço por identificar</span>
                                <span className="font-mono text-fg-40">{eur(data.tiers.unknown.mrr_cents)}/mês</span>
                            </div>
                        )}
                    </div>
                </Card>

                <Card
                    title="Subscrições a terminar no preço antigo"
                    hint="Por ordem de data. No fim, cancela-se e pede-se a subscrição ao preço actual."
                >
                    {data.sunsets.length === 0 ? (
                        <p className="text-[11px] text-fg-40">Nenhuma no preço antigo.</p>
                    ) : (
                        <div className="space-y-2">
                            {data.sunsets.map((s) => (
                                <div key={`${s.user_id}:${s.connection_key}`} className="flex items-baseline justify-between gap-3">
                                    <Link href={`/admin/users/${s.user_id}/dev-mode`} className="text-sm text-fg hover:text-accent-ink truncate">
                                        {s.account}
                                    </Link>
                                    <span className="flex items-baseline gap-2 shrink-0">
                                        <span className="font-mono text-[11px] text-fg-40">
                                            {s.unit_amount_cents != null && <>{eur(s.unit_amount_cents)}</>}
                                            {s.next_price_cents != null && <> → {eur(s.next_price_cents)}</>}
                                            {" · "}
                                            <span className={s.marked ? "text-accent-hot" : "text-soon"}>{dateOf(s.sunset_at)}</span>
                                        </span>
                                        {/* Marking it tells Stripe the date and emails the
                                            client. Nothing happens on its own until then. */}
                                        {!s.marked && (
                                            <button
                                                type="button"
                                                onClick={() => markSunset(s.user_id, s.connection_key)}
                                                disabled={marking === `${s.user_id}:${s.connection_key}`}
                                                className="rounded-lg border border-hairline px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-60 hover:text-fg hover:border-accent/40 transition-colors disabled:opacity-30"
                                            >
                                                {marking === `${s.user_id}:${s.connection_key}` ? "…" : "marcar fim"}
                                            </button>
                                        )}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </Card>
            </div>

            <Card
                title="Catálogo de preços"
                hint={`Cada par que um comerciante pode escolher precisa de um preço no Stripe. Sem ele, o checkout falha no momento de pagar e nada antes disso avisa. Gate: ${
                    data.subscription_per_connection === undefined ? "—"
                        : data.subscription_per_connection ? "uma subscrição por ligação" : "ao nível da conta"
                } (o worker tem a sua própria cópia da variável; se discordarem, esta página diz que está tudo bem enquanto o worker recusa faturar).`}
            >
                <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[560px]">
                        <tbody>
                            {(data.price_catalogue ?? []).map((p) => (
                                <tr key={`${p.source}:${p.plan}`} className="border-b border-hairline/40 last:border-0">
                                    <td className="py-2 pr-4 text-fg whitespace-nowrap">{p.product_name}</td>
                                    <td className="py-2 pr-4 font-mono text-[11px] text-fg-40 whitespace-nowrap">
                                        {p.plan === "annual" ? "anual" : "mensal"}
                                    </td>
                                    <td className="py-2 pr-4 font-mono text-[10px] text-fg-40 truncate max-w-[260px]">
                                        {p.lookup ?? "—"}
                                    </td>
                                    <td className="py-2 pr-4 font-mono text-[11px] text-fg tabular-nums whitespace-nowrap">
                                        {p.amount_cents == null ? <span className="text-fg-40">{eur(p.expected_cents)}</span>
                                            : p.status === "wrong_amount" ? (
                                                // Both figures, because the whole point is the gap between them.
                                                <span className="text-destructive">
                                                    {eur(p.amount_cents)} <span className="text-fg-40">≠ {eur(p.expected_cents)}</span>
                                                </span>
                                            ) : eur(p.amount_cents)}
                                    </td>
                                    <td className="py-2 text-right whitespace-nowrap">
                                        {p.status === "no_key" ? <span className="font-mono text-[10px] text-fg-40">sem chave</span>
                                            : p.status === "missing" ? <span className="font-mono text-[10px] text-destructive">POR CRIAR</span>
                                            : p.status === "wrong_amount" ? <span className="font-mono text-[10px] text-destructive">VALOR ERRADO</span>
                                            : p.status === "archived" ? <span className="font-mono text-[10px] text-soon">arquivado</span>
                                            : <span className="font-mono text-[10px] text-accent-hot">ok</span>}
                                    </td>
                                </tr>
                            ))}
                            {data.seat_price && (
                                <tr className="border-t border-hairline/40">
                                    <td className="py-2 pr-4 text-fg whitespace-nowrap">Rioko 2.0 || Extra User</td>
                                    <td className="py-2 pr-4 font-mono text-[11px] text-fg-40 whitespace-nowrap">avulso</td>
                                    <td className="py-2 pr-4 font-mono text-[10px] text-fg-40 truncate max-w-[260px]">
                                        {data.seat_price.lookup}
                                    </td>
                                    <td className="py-2 pr-4 font-mono text-[11px] text-fg tabular-nums whitespace-nowrap">
                                        {data.seat_price.amount_cents == null
                                            ? <span className="text-fg-40">{eur(data.seat_price.expected_cents)}</span>
                                            : data.seat_price.status === "wrong_amount"
                                                ? <span className="text-destructive">{eur(data.seat_price.amount_cents)} <span className="text-fg-40">≠ {eur(data.seat_price.expected_cents)}</span></span>
                                                : eur(data.seat_price.amount_cents)}
                                    </td>
                                    <td className="py-2 text-right whitespace-nowrap">
                                        <span className={`font-mono text-[10px] ${data.seat_price.status === "ok" ? "text-accent-hot" : "text-destructive"}`}>
                                            {data.seat_price.status === "ok" ? "ok"
                                                : data.seat_price.status === "missing" ? "POR CRIAR"
                                                : data.seat_price.status === "recurring" ? "RECORRENTE"
                                                : data.seat_price.status === "archived" ? "ARQUIVADO"
                                                : "VALOR ERRADO"}
                                        </span>
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
                {data.seat_price && data.seat_price.status !== "ok" && (
                    <p className="text-[11px] text-destructive pt-1">
                        O lugar extra não é criado por este botão: é um preço avulso, sem par. Um
                        preço recorrente aqui rebenta dentro do Checkout, que corre em modo de
                        pagamento único. Corrigir no Stripe.
                    </p>
                )}
                {/* Sempre disponível, mesmo com a tabela toda a verde: a simulação
                    também diz se algum produto está sem descrição, sem código de
                    imposto ou sem imagem, o que a tabela não mostra. */}
                {(
                    <div className="space-y-3 pt-1">
                        {(data.price_catalogue ?? []).some((p) => p.status === "missing" || p.status === "wrong_amount") && (
                            <p className="text-[11px] text-destructive">
                                Os marcados POR CRIAR não existem no Stripe, e o checkout desse par falha
                                no momento de pagar. São criados com a lookup key da terceira coluna, em
                                euros e sem IVA incluído — a taxa é o checkout que a junta.
                                Os marcados VALOR ERRADO existem e estão a vender pelo preço errado: são
                                substituídos por um preço novo que fica com a mesma chave, e o antigo é
                                arquivado. Quem já lá está continua a pagar o que pagava.
                            </p>
                        )}
                        {createResult && (
                            <div className="rounded-2xl p-4 bg-surface-2 border border-hairline space-y-1">
                                <p className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.18em]">
                                    {createResult.dry_run ? "Simulação — nada foi escrito" : "Criado no Stripe"}
                                </p>
                                {createResult.prices.length === 0 && (
                                    <p className="text-[11px] text-fg-40">Nada em falta.</p>
                                )}
                                {createResult.prices.map((cp) => (
                                    <p key={`${cp.action ?? "create"}:${cp.lookup}`} className="font-mono text-[11px] text-fg">
                                        {cp.error
                                            ? <span className="text-destructive">{cp.lookup}: {cp.error}</span>
                                            : cp.action === "product"
                                            ? <>{cp.product_name} · só o produto<span className="text-soon"> · preenche {cp.product_filled?.join(", ")}</span></>
                                            : cp.action === "default"
                                            ? <>{cp.product_name} · preço por defeito → {eur(cp.amount_cents)}
                                                <span className="text-destructive">
                                                    {" "}· arquiva {cp.replaces_price_id} ({eur(cp.replaces_amount_cents ?? 0)}
                                                    {cp.replaces_subscriptions != null && `, ${cp.replaces_subscriptions} subs`})
                                                </span></>
                                            : <>{cp.lookup} · {cp.product_name} · {eur(cp.amount_cents)}/{cp.interval === "year" ? "ano" : "mês"}
                                                {cp.action === "replace" && (
                                                    <span className="text-destructive">
                                                        {" "}· substitui {cp.replaces_price_id} ({eur(cp.replaces_amount_cents ?? 0)}
                                                        {cp.replaces_subscriptions != null && `, ${cp.replaces_subscriptions} subs`})
                                                    </span>
                                                )}
                                                {cp.product_created && <span className="text-soon"> · produto novo</span>}
                                                {cp.product_filled?.length ? <span className="text-soon"> · preenche {cp.product_filled.join(", ")}</span> : null}
                                                {cp.price_id && <span className="text-accent-hot"> · {cp.price_id}</span>}</>}
                                    </p>
                                ))}
                            </div>
                        )}
                        <div className="flex gap-2">
                            <button
                                onClick={() => createPrices(false)}
                                disabled={creating}
                                className="px-4 py-2 rounded-xl text-sm font-medium border border-hairline text-fg hover:bg-fg/5 transition-all disabled:opacity-40"
                            >
                                {creating ? "A verificar…" : "Simular"}
                            </button>
                            <button
                                onClick={() => createPrices(true)}
                                disabled={creating || !createResult?.dry_run}
                                title={!createResult?.dry_run ? "Simula primeiro" : undefined}
                                className="px-4 py-2 rounded-xl text-sm font-medium bg-fg text-surface hover:bg-accent hover:text-on-accent transition-all disabled:opacity-40"
                            >
                                Criar no Stripe
                            </button>
                        </div>
                    </div>
                )}
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

                <Card
                    title="Por cobrar"
                    hint="Facturas que falharam e nunca chegaram a ser pagas. Uma primeira tentativa falhar e a seguinte passar é banal, e essas não estão aqui."
                >
                    {data.outstanding_payments.length === 0 ? (
                        <p className="text-[11px] text-fg-40">Nada por cobrar.</p>
                    ) : (
                        <div className="space-y-2">
                            {data.outstanding_payments.map((f) => (
                                <div key={f.id} className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <Link href={`/admin/users/${f.user_id}/dev-mode`} className="text-sm text-fg hover:text-accent-ink truncate block">
                                            {f.account}
                                        </Link>
                                        <div className="font-mono text-[10px] text-fg-40 truncate">
                                            {f.description ?? REASON_LABEL[f.reason ?? ""] ?? "factura"}
                                            {f.attempts > 1 && <> · {n(f.attempts)} tentativas</>}
                                        </div>
                                    </div>
                                    <span className="font-mono text-[11px] text-destructive shrink-0">
                                        {eur(f.amount_cents)} · {dateOf(f.created_at)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                    {data.settled_after_failure > 0 && (
                        <p className="pt-2 border-t border-hairline text-[11px] text-fg-40">
                            Outras {n(data.settled_after_failure)} facturas falharam à primeira e foram
                            cobradas a seguir. Não são dívida e por isso não aparecem.
                        </p>
                    )}
                </Card>
            </div>

            <DunningCard />

            <ReferralsCard />

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
                                                        {l.price_legacy && (
                                                            <span
                                                                className="ml-2 text-soon"
                                                                title={`Plano antigo${l.price_amount_cents != null ? `: ${eur(l.price_amount_cents)}${l.price_interval ? `/${l.price_interval === "year" ? "ano" : "mês"}` : ""}` : ""}${l.price_legacy_source === "override" ? " — definido à mão" : ""}`}
                                                            >
                                                                preço legado
                                                            </span>
                                                        )}
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
