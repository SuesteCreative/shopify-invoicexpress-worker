"use client";

import { useEffect, useState } from "react";
import {
    Users, TrendingUp, Wallet, Ban, AlertTriangle, Loader2, EyeOff,
} from "lucide-react";

/**
 * The overview: what the fleet did, out of D1 only.
 *
 * Hand-rolled bars rather than a charting library. Two bar charts and a funnel
 * do not justify half a megabyte of Recharts on a page three people open, and
 * a div with a percentage height renders identically in both skins without a
 * theme adapter. If this ever grows past four distinct chart types, that is the
 * moment to reconsider — not before.
 */

type Series = { ym: string; n: number }[];
type Revenue = { ym: string; gross_cents: number; refunded_cents: number; net_cents: number }[];

interface Stats {
    signups: Series;
    funnel: { accounts: number; registered: number; connected: number; paying: number; mid_setup: number };
    revenue: Revenue;
    subscription_net_cents: number;
    lifetime_net_cents: number;
    /** Wired up, and the subscription gate is refusing to invoice for them. */
    blocked: number;
    other_currencies: { currency: string; n: number; cents: number }[];
    subscriptions: { status: string; connection_key: string; n: number }[];
    documents: Series;
    channels: { source: string; n: number }[];
    attribution: { total: number; captured: number };
    seats: { n: number; cents: number };
}

const eur = (cents: number) =>
    new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(cents / 100);

/** Counts get the thousands separator too — "2375" is not how pt-PT reads. */
const n = (v: number) => new Intl.NumberFormat("pt-PT").format(v);

/** "2026-09" → "set 26". The series is dense enough that full labels collide. */
const monthLabel = (ym: string) => {
    const [y, m] = ym.split("-");
    const names = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
    return `${names[Number(m) - 1] ?? m} ${y?.slice(2) ?? ""}`;
};

/** Keep the tail of a series — a chart of every month since the beginning is
 *  unreadable long before it is interesting. */
const lastN = <T,>(xs: T[], keep: number) => (xs.length > keep ? xs.slice(-keep) : xs);

const Card = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
    <section className="glass rounded-[2rem] p-5 sm:p-7 border-hairline space-y-5">
        <div>
            <h2 className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{title}</h2>
            {hint && <p className="mt-1 text-[11px] text-fg-40 leading-snug">{hint}</p>}
        </div>
        {children}
    </section>
);

const Kpi = ({ icon: Icon, label, value, sub, tone }: {
    icon: React.ComponentType<{ className?: string }>;
    label: string; value: string; sub?: string; tone?: "warn";
}) => (
    <div className={`glass rounded-3xl p-5 ${tone === "warn" ? "border border-soon/40" : "border-hairline"}`}>
        <div className={`flex items-center gap-2 ${tone === "warn" ? "text-soon" : "text-fg-40"}`}>
            <Icon className="w-4 h-4" />
            <span className="font-mono text-[10px] uppercase tracking-[0.18em]">{label}</span>
        </div>
        <div className={`mt-3 text-3xl font-black tabular-nums ${tone === "warn" ? "text-soon" : "text-fg"}`}>{value}</div>
        {sub && <div className="mt-1 text-[11px] text-fg-40">{sub}</div>}
    </div>
);

/** A column chart. `tone` picks the bar colour; heights are relative to the max. */
function Bars({ data, tone = "accent", format }: {
    data: { label: string; value: number }[];
    tone?: "accent" | "hot";
    format?: (v: number) => string;
}) {
    if (data.length === 0) {
        return <p className="text-[11px] text-fg-40">Sem dados.</p>;
    }
    const max = Math.max(...data.map((d) => d.value), 1);
    const fill = tone === "hot" ? "bg-accent-hot/70" : "bg-accent/60";

    return (
        <div className="overflow-x-auto">
            {/* items-stretch, NOT items-end. With items-end each column is sized
                to its own content, so the flex-1 track below collapses to zero
                height and every bar's percentage resolves against nothing: the
                month labels render and the bars are invisible. */}
            <div className="flex items-stretch gap-1.5 h-40 min-w-fit">
                {data.map((d) => (
                    <div key={d.label} className="flex-1 flex flex-col items-center gap-2 group min-w-[26px]">
                        <div className="flex-1 flex items-end w-full">
                            <div
                                className={`w-full rounded-t-md ${fill} transition-all group-hover:opacity-100 opacity-80`}
                                style={{ height: `${Math.max((d.value / max) * 100, d.value > 0 ? 3 : 0)}%` }}
                                title={`${d.label}: ${format ? format(d.value) : d.value}`}
                            />
                        </div>
                        <span className="font-mono text-[9px] text-fg-40 whitespace-nowrap">{d.label}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

/** The funnel, as nested horizontal bars — each stage a subset of the one above. */
function Funnel({ funnel }: { funnel: Stats["funnel"] }) {
    const stages = [
        { label: "Conta criada", n: funnel.accounts },
        { label: "Dados preenchidos", n: funnel.registered },
        { label: "Integração ligada", n: funnel.connected },
        { label: "A pagar", n: funnel.paying },
    ];
    const top = Math.max(funnel.accounts, 1);

    return (
        <div className="space-y-3">
            {stages.map((s, i) => {
                const prev = i === 0 ? null : stages[i - 1].n;
                const drop = prev !== null && prev > 0 ? prev - s.n : null;
                return (
                    <div key={s.label} className="space-y-1">
                        <div className="flex items-baseline justify-between gap-3">
                            <span className="text-sm text-fg">{s.label}</span>
                            <span className="font-mono text-sm text-fg tabular-nums">
                                {n(s.n)}
                                {drop !== null && drop > 0 && (
                                    <span className="ml-2 text-[11px] text-fg-40">−{n(drop)}</span>
                                )}
                            </span>
                        </div>
                        <div className="h-2.5 rounded-full bg-surface-2 overflow-hidden">
                            <div
                                className="h-full rounded-full bg-accent/60"
                                style={{ width: `${(s.n / top) * 100}%` }}
                            />
                        </div>
                    </div>
                );
            })}
            {funnel.mid_setup > 0 && (
                <p className="pt-1 text-[11px] text-soon">
                    {n(funnel.mid_setup)} {funnel.mid_setup === 1 ? "conta parou" : "contas pararam"} a meio de um wizard
                    (ligação em rascunho).
                </p>
            )}
        </div>
    );
}

export function StatsPanel() {
    const [stats, setStats] = useState<Stats | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetch("/api/admin/stats")
            .then(async (r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json() as Promise<Stats>;
            })
            .then(setStats)
            .catch((e) => setError(String(e?.message ?? e)));
    }, []);

    if (error) {
        return (
            <div className="glass rounded-3xl p-6 border border-destructive/40 flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
                <div>
                    <p className="text-sm text-fg">Não foi possível carregar as estatísticas.</p>
                    <p className="mt-1 font-mono text-[11px] text-fg-40">{error}</p>
                </div>
            </div>
        );
    }

    if (!stats) {
        return (
            <div className="flex items-center gap-3 text-fg-40">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="font-mono text-[10px] uppercase tracking-[0.18em]">A carregar</span>
            </div>
        );
    }

    const thisMonth = new Date().toISOString().slice(0, 7);
    const docsThisMonth = stats.documents.find((d) => d.ym === thisMonth)?.n ?? 0;
    const revenueThisMonth = stats.revenue.find((r) => r.ym === thisMonth)?.net_cents ?? 0;
    const blind = stats.attribution.total - stats.attribution.captured;

    return (
        <div className="space-y-8 max-w-6xl">
            <header>
                <h1 className="text-3xl font-black text-fg">Visão geral</h1>
                <p className="mt-2 text-sm text-fg-40">
                    Contas de cliente apenas: administradores e utilizadores extra convidados ficam de fora.
                </p>
            </header>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <Kpi icon={Users} label="Contas" value={n(stats.funnel.accounts)}
                     sub={`${n(stats.funnel.paying)} a pagar`} />
                <Kpi icon={Wallet} label="Receita total" value={eur(stats.lifetime_net_cents)}
                     sub="subscrições e lugares, líquido" />
                <Kpi icon={TrendingUp} label="Este mês" value={eur(revenueThisMonth)}
                     sub={monthLabel(thisMonth)} />
                {/* The actionable one. An account can be fully wired and still
                    have every document refused at the subscription gate, and
                    nothing else on this page would say so. */}
                <Kpi icon={Ban} label="Bloqueadas" value={n(stats.blocked)}
                     sub="ligadas, sem facturar" tone={stats.blocked > 0 ? "warn" : undefined} />
            </div>

            <div className="grid lg:grid-cols-2 gap-6">
                <Card title="Funil" hint="Cada fase é um subconjunto da anterior.">
                    <Funnel funnel={stats.funnel} />
                </Card>

                <Card title="Registos por mês">
                    <Bars data={lastN(stats.signups, 18).map((s) => ({ label: monthLabel(s.ym), value: s.n }))} />
                </Card>
            </div>

            <Card
                title="Receita por mês"
                hint="Valores brutos, com IVA incluído, líquidos de reembolsos. O IVA não está na base de dados."
            >
                <Bars
                    tone="hot"
                    data={lastN(stats.revenue, 18).map((r) => ({ label: monthLabel(r.ym), value: r.net_cents }))}
                    format={eur}
                />
                <div className="flex flex-wrap gap-x-6 gap-y-1 pt-1 text-[11px] text-fg-40">
                    <span>Subscrições {eur(stats.subscription_net_cents)}</span>
                    {stats.seats.n > 0 && (
                        <span>{n(stats.seats.n)} lugares extra, {eur(stats.seats.cents)} (fora do gráfico, dentro do total)</span>
                    )}
                    {stats.other_currencies.map((c) => (
                        <span key={c.currency} className="text-soon">
                            Fora do gráfico: {c.n} pagamentos em {c.currency.toUpperCase()}
                        </span>
                    ))}
                </div>
            </Card>

            <div className="grid lg:grid-cols-2 gap-6">
                <Card title="Subscrições" hint="Por estado e por ligação.">
                    <div className="space-y-2">
                        {stats.subscriptions.length === 0 && <p className="text-[11px] text-fg-40">Sem dados.</p>}
                        {stats.subscriptions.map((s) => (
                            <div key={`${s.status}:${s.connection_key}`} className="flex items-baseline justify-between gap-3">
                                <div className="flex items-baseline gap-2 min-w-0">
                                    <span className="text-sm text-fg">{s.status}</span>
                                    <span className="font-mono text-[10px] text-fg-40 truncate">{s.connection_key}</span>
                                </div>
                                <span className="font-mono text-sm text-fg tabular-nums shrink-0">{n(s.n)}</span>
                            </div>
                        ))}
                    </div>
                </Card>

                <Card title="Aquisição" hint="Só de quem chegou a criar conta.">
                    <div className="space-y-2">
                        {stats.channels.length === 0 && <p className="text-[11px] text-fg-40">Sem dados.</p>}
                        {stats.channels.map((c) => (
                            <div key={c.source} className="flex items-baseline justify-between gap-3">
                                <span className="text-sm text-fg truncate">{c.source}</span>
                                <span className="font-mono text-sm text-fg tabular-nums shrink-0">{n(c.n)}</span>
                            </div>
                        ))}
                    </div>
                    {blind > 0 && (
                        <div className="pt-2 flex items-start gap-2 text-[11px] text-fg-40 border-t border-hairline">
                            <EyeOff className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                            <span>
                                {blind} de {stats.attribution.total} contas sem atribuição. Quem visita e não se
                                regista não deixa rasto: a atribuição só chega à base de dados depois de autenticar.
                            </span>
                        </div>
                    )}
                </Card>
            </div>

            <Card
                title="Documentos emitidos por mês"
                hint={`${n(docsThisMonth)} em ${monthLabel(thisMonth)}. Uma reemissão de admin reescreve a data do registo, portanto os meses antigos derivam ligeiramente para baixo.`}
            >
                <Bars data={lastN(stats.documents, 18).map((d) => ({ label: monthLabel(d.ym), value: d.n }))} />
            </Card>
        </div>
    );
}
