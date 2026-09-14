"use client";

import { useCallback, useEffect, useState } from "react";
// next/link, not the i18n one: every href here points inside /admin, which is
// deliberately not locale-prefixed.
import Link from "next/link";
import {
    IdCard, Copy, Check, X, Loader2, AlertTriangle, ExternalLink, Wrench, UserCog,
    Building2, CreditCard, Zap, Scale, Receipt, ScrollText, Moon, Users, Gift, NotebookPen,
} from "lucide-react";

import { Section } from "@/components/admin/Section";
import { MAX_NOTES_CHARS } from "@/lib/company-notes";
import { BillingInvoiceLink } from "@/components/admin/BillingInvoiceLink";
import { connectionLabel } from "@/lib/connection-kinds";
import { connectionKeyForScope, attributeDocumentEvent, groupByConnection } from "@/lib/client-record-sql";

/**
 * One customer, whole.
 *
 * What an operator had to assemble by hand across /admin/clientes,
 * /admin/integracoes, /admin/client-rules and /admin/users/<id>/dev-mode. The
 * record does not replace the toolbox — dev mode still owns the actions — it
 * answers "who is this and what is their state" in one place.
 *
 * Portuguese in the strings, like IntegrationsPanel and BillingInvoiceLink: the
 * whole /admin surface is pinned to ADMIN_LOCALE = "pt", and a namespace nobody
 * reads in English is two files to keep in step for no reader.
 */

type Tab = "identidade" | "subscricoes" | "integracoes" | "fiscal" | "stripe" | "faturas" | "registos";

const TABS: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: "identidade", label: "Identidade", icon: Building2 },
    { id: "subscricoes", label: "Subscrições", icon: CreditCard },
    { id: "integracoes", label: "Integrações", icon: Zap },
    { id: "fiscal", label: "Regras fiscais", icon: Scale },
    { id: "stripe", label: "Stripe", icon: CreditCard },
    { id: "faturas", label: "Faturas Kapta", icon: Receipt },
    { id: "registos", label: "Registos", icon: ScrollText },
];

/** Keyed by what subscriptionUIState returns — a key it never returns is a badge drawn in the wrong colour. */
const SUB_STATE_STYLE: Record<string, string> = {
    active: "bg-accent/12 text-accent-ink border-accent/28",
    trialing: "bg-accent/12 text-accent-ink border-accent/28",
    trialing_earlybird: "bg-soon/12 text-soon border-soon/28",
    exempt: "bg-fg/8 text-fg-40 border-hairline",
    blocked: "bg-destructive/12 text-destructive border-destructive/28",
    none: "bg-destructive/12 text-destructive border-destructive/28",
};

function money(cents: number | null | undefined, currency: string | null | undefined) {
    if (cents == null) return "—";
    return new Intl.NumberFormat("pt-PT", { style: "currency", currency: (currency || "eur").toUpperCase() })
        .format(cents / 100);
}

function day(iso: string | null | undefined) {
    if (!iso) return "—";
    const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function moment(iso: string | null | undefined) {
    if (!iso) return "—";
    const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleString("pt-PT", {
        day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
}

const Field = ({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) => (
    <div className="space-y-1">
        <span className="text-[10px] font-black uppercase tracking-widest text-fg-40">{label}</span>
        <div className={`text-sm font-bold text-fg break-words ${mono ? "font-mono text-xs" : ""}`}>
            {value === null || value === undefined || value === "" ? <span className="text-fg-40 font-medium">—</span> : value}
        </div>
    </div>
);

const Pill = ({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "good" | "warn" | "bad" }) => {
    const styles = {
        neutral: "bg-surface-2 text-fg-40 border-hairline",
        good: "bg-accent/12 text-accent-ink border-accent/28",
        warn: "bg-soon/12 text-soon border-soon/28",
        bad: "bg-destructive/12 text-destructive border-destructive/28",
    } as const;
    return (
        <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-widest border ${styles[tone]}`}>
            {children}
        </span>
    );
};

/** The number, copyable — it exists to be quoted. */
function CodeChip({ code }: { code: string | null }) {
    const [copied, setCopied] = useState(false);
    if (!code) return null;
    return (
        <button
            type="button"
            title={copied ? "Código copiado" : "Copiar o código do cliente"}
            onClick={() => {
                navigator.clipboard?.writeText(code)
                    .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })
                    .catch(() => { /* sem permissão de clipboard: o código continua legível */ });
            }}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-surface-2 border border-hairline font-mono text-xs tracking-[0.18em] text-fg hover:bg-fg/5 transition-colors"
        >
            {copied ? <Check className="w-3 h-3 text-accent-ink" /> : <Copy className="w-3 h-3 text-fg-40" />}
            {code}
        </button>
    );
}

type StripeKind = "customers" | "subscriptions" | "invoices" | "payments";

/**
 * The dashboard section an id opens in, read from its own prefix.
 *
 * `billing_events.stripe_object_id` holds whatever object the event carried —
 * an invoice, but also a refund or a charge — and linking every one of them to
 * /invoices/ answered "not found" for objects that are perfectly fine, which
 * reads as data loss. An id whose section is not known is shown, not linked.
 */
function kindOfStripeId(id: string | null): StripeKind | null {
    if (!id) return null;
    if (id.startsWith("in_")) return "invoices";
    if (id.startsWith("sub_")) return "subscriptions";
    if (id.startsWith("cus_")) return "customers";
    if (id.startsWith("pi_") || id.startsWith("ch_") || id.startsWith("py_")) return "payments";
    return null;
}

const StripeLink = ({ base, kind, id }: { base: string; kind?: StripeKind; id: string | null }) => {
    if (!id) return <span className="text-fg-40">—</span>;
    const section = kind ?? kindOfStripeId(id);
    // Never elided: a truncated pi_ is unusable, and the ellipsis has swapped one
    // payment for another before.
    if (!section) return <span className="font-mono text-[11px] text-fg break-all">{id}</span>;
    return (
        <a href={`${base}/${section}/${id}`} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-mono text-[11px] text-accent-ink hover:underline break-all">
            {id} <ExternalLink className="w-3 h-3 shrink-0" />
        </a>
    );
};

export function CustomerRecordPanel({ code, askedForMember = null }: { code: string; askedForMember?: string | null }) {
    const [data, setData] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [retired, setRetired] = useState<any>(null);
    const [tab, setTab] = useState<Tab>("identidade");

    const load = useCallback(async () => {
        setLoading(true); setError(null); setRetired(null);
        try {
            const res = await fetch(`/api/admin/clientes/${encodeURIComponent(code)}`);
            const body: any = await res.json();
            if (!res.ok) {
                setRetired(body?.retired ?? null);
                setError(body?.error === "not_found" ? "not_found" : (body?.error || `HTTP ${res.status}`));
                setData(null);
                return;
            }
            setData(body);
        } catch (e: any) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    }, [code]);

    useEffect(() => { load(); }, [load]);

    if (loading) {
        return <div className="flex items-center gap-3 text-fg-40 text-sm font-bold"><Loader2 className="w-4 h-4 animate-spin" /> A carregar a ficha…</div>;
    }

    if (error) {
        return (
            <Section icon={<AlertTriangle className="w-5 h-5 text-destructive" />} title="Ficha indisponível">
                {retired ? (
                    <p className="text-sm text-fg-40 font-medium">
                        O código <span className="font-mono text-fg">{retired.code}</span> foi emitido a uma conta
                        que já não existe (<span className="font-mono">{retired.user_id ?? "—"}</span>, {day(retired.created_at)}).
                        Continua reservado: um número nunca é reatribuído, porque os documentos dessa conta
                        continuam arquivados debaixo dele.
                    </p>
                ) : error === "not_found" ? (
                    <p className="text-sm text-fg-40 font-medium">Não há nenhum cliente com o código <span className="font-mono text-fg">{code}</span>.</p>
                ) : (
                    <p className="text-sm text-destructive font-medium">{error}</p>
                )}
                <Link href="/admin/clientes" className="text-[10px] font-black uppercase tracking-widest text-fg-40 hover:text-fg">
                    ← Voltar aos clientes
                </Link>
            </Section>
        );
    }

    const c = data.customer;
    const base: string = data.stripe?.dashboard_base ?? "https://dashboard.stripe.com";

    return (
        <div className="space-y-8 animate-in fade-in duration-500">
            {/* Header */}
            <div className="space-y-4">
                <Link href="/admin/clientes" className="flex items-center gap-2 text-fg-40 hover:text-fg text-[10px] font-black uppercase tracking-widest w-fit">
                    ← Clientes
                </Link>

                {/* The page redirects a member's number to the owner's record and
                    passes the number that was asked for; without it the URL would
                    silently change under the operator. */}
                {(askedForMember || data.asked_for_member) && (
                    <div className="glass rounded-2xl border border-soon/30 bg-soon/5 p-4 text-xs font-medium text-fg-40">
                        O código <span className="font-mono text-fg">{askedForMember ?? data.asked_for_member}</span> é de um utilizador convidado.
                        Um membro trabalha dentro da conta de outra pessoa e não tem dados próprios — esta é a ficha dessa conta.
                    </div>
                )}

                <div className="flex flex-wrap items-end justify-between gap-4">
                    <div className="flex items-center gap-4 min-w-0">
                        <div className="w-14 h-14 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
                            <IdCard className="w-7 h-7 text-accent-ink" />
                        </div>
                        <div className="min-w-0 space-y-2">
                            <h1 className="text-3xl sm:text-4xl font-black tracking-tight truncate">{c.label}</h1>
                            <div className="flex flex-wrap items-center gap-2">
                                <CodeChip code={c.client_code} />
                                {c.role !== "user" && <Pill tone="warn">{c.role}</Pill>}
                                {c.is_inactive && <Pill><Moon className="w-2.5 h-2.5 inline mr-1" />dormente</Pill>}
                                {!c.registration_completed && <Pill tone="warn">registo por concluir</Pill>}
                            </div>
                            <p className="text-sm text-fg-40 font-medium">
                                {c.email}{c.nif ? ` · NIF ${c.nif}` : ""}
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                        <Link href={`/admin/users/${c.id}/dev-mode`}
                            className="bg-accent/10 text-accent-ink border border-accent/20 px-4 py-3 rounded-2xl font-mono text-[10px] uppercase tracking-[0.18em] flex items-center gap-2 hover:bg-accent/18 transition-all">
                            <Wrench className="w-3 h-3" /> Dev mode
                        </Link>
                        <button
                            type="button"
                            onClick={async () => {
                                await fetch("/api/admin/impersonate", {
                                    method: "POST", headers: { "content-type": "application/json" },
                                    body: JSON.stringify({ targetId: c.id }),
                                }).then(r => { if (r.ok) window.location.href = "/dashboard"; }).catch(() => { });
                            }}
                            className="bg-fg text-surface px-4 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2 hover:bg-destructive hover:text-on-accent transition-all">
                            <UserCog className="w-3 h-3" /> Impersonar
                        </button>
                    </div>
                </div>

                {/* Tabs */}
                <div className="flex flex-wrap gap-2 pt-2">
                    {TABS.map(({ id, label, icon: Icon }) => (
                        <button key={id} type="button" onClick={() => setTab(id)}
                            className={`px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-widest border transition-all flex items-center gap-2 ${tab === id ? "bg-accent/18 text-accent-ink border-accent/40" : "bg-surface-2/50 text-fg-40 border-hairline hover:text-fg"}`}>
                            <Icon className="w-3 h-3" /> {label}
                        </button>
                    ))}
                </div>
            </div>

            {tab === "identidade" && <IdentityTab data={data} code={code} onSaved={load} />}
            {tab === "subscricoes" && <SubscriptionsTab data={data} base={base} />}
            {tab === "integracoes" && <ConnectionsTab data={data} />}
            {tab === "fiscal" && <FiscalTab data={data} code={code} onSaved={load} />}
            {tab === "stripe" && <StripeTab data={data} base={base} />}
            {tab === "faturas" && (
                <Section icon={<Receipt className="w-5 h-5 text-accent-ink" />} title="Faturas de serviço da Kapta"
                    desc="O documento que cada pagamento deste cliente pagou, e a forma de corrigir um que esteja errado.">
                    <BillingInvoiceLink targetUserId={c.id} />
                </Section>
            )}
            {tab === "registos" && <LogsTab userId={c.id} connections={data.connections} />}
        </div>
    );
}

/**
 * The two fields the merchant cannot change, and the operator can.
 *
 * Editable only for a hiperadmin — the same gate every other write that decides
 * what a document says carries. Before this, applying a client's request meant
 * impersonating them and re-running their onboarding form.
 */
function FiscalField({ code, field, label, value, mono, onSaved }: {
    code: string; field: "nif" | "company_name"; label: string;
    value: string | null; mono?: boolean; onSaved: () => void;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(value ?? "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const save = async () => {
        setBusy(true); setError(null);
        try {
            const res = await fetch(`/api/admin/clientes/${encodeURIComponent(code)}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ field, value: draft }),
            });
            const body: any = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(body?.error === "nif_must_be_nine_digits" ? "O NIF tem de ter nove dígitos." : (body?.error || `HTTP ${res.status}`));
                return;
            }
            setEditing(false);
            onSaved();
        } catch (e: any) {
            setError(String(e));
        } finally {
            setBusy(false);
        }
    };

    if (!editing) {
        return (
            <div className="space-y-1">
                <span className="text-[10px] font-black uppercase tracking-widest text-fg-40">{label}</span>
                <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-sm font-bold text-fg ${mono ? "font-mono text-xs" : ""}`}>
                        {value || <span className="text-fg-40 font-medium">—</span>}
                    </span>
                    <button type="button" onClick={() => { setDraft(value ?? ""); setEditing(true); }}
                        className="text-[10px] font-black uppercase tracking-widest text-accent-ink hover:underline">
                        alterar
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-2">
            <span className="text-[10px] font-black uppercase tracking-widest text-fg-40">{label}</span>
            <input
                autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
                className="w-full bg-surface-2 border border-hairline rounded-xl px-3 py-2 text-sm font-medium text-fg focus:outline-none focus:border-accent/40"
            />
            <div className="flex items-center gap-2 flex-wrap">
                <button type="button" onClick={save} disabled={busy}
                    className="bg-fg text-surface px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2 disabled:opacity-30">
                    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Guardar
                </button>
                <button type="button" onClick={() => setEditing(false)}
                    className="text-[10px] font-black uppercase tracking-widest text-fg-40 hover:text-fg">cancelar</button>
                {error && <span className="text-[10px] font-black uppercase tracking-widest text-destructive">{error}</span>}
            </div>
        </div>
    );
}

/**
 * The language this client is written to in — screens, toasts and emails.
 *
 * Two buttons and not a text field: there are two values and typing a third is
 * the only mistake this setting can make. It writes through the same PATCH the
 * fiscal fields use, so the change lands in `config_audit` beside everything
 * else that was ever changed about this account, with who changed it.
 *
 * The client has the same selector on their Conta page. Whoever touched it last
 * wins, which is the right answer for a preference and the wrong one for a NIF —
 * hence the different gate.
 */
function LanguageField({ code, value, onSaved }: { code: string; value: string; onSaved: () => void }) {
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const current = value === "en" ? "en" : "pt";

    const pick = async (language: string) => {
        if (language === current) return;
        setBusy(language); setError(null);
        try {
            const res = await fetch(`/api/admin/clientes/${encodeURIComponent(code)}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ field: "language", value: language }),
            });
            const body: any = await res.json().catch(() => ({}));
            if (!res.ok) { setError(body?.error || `HTTP ${res.status}`); return; }
            onSaved();
        } catch (e: any) {
            setError(String(e));
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="space-y-1">
            <span className="text-[10px] font-black uppercase tracking-widest text-fg-40">Língua</span>
            <div className="flex items-center gap-2 flex-wrap">
                <div className="inline-flex items-center gap-0.5 rounded-full p-0.5 border border-hairline bg-surface-2">
                    {[["pt", "Português"], ["en", "English"]].map(([value, label]) => (
                        <button
                            key={value} type="button" disabled={busy !== null}
                            onClick={() => pick(value)}
                            aria-pressed={current === value}
                            className={`rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-widest transition-colors disabled:opacity-40 ${
                                current === value ? "bg-fg text-surface" : "text-fg-40 hover:text-fg"
                            }`}
                        >
                            {busy === value ? <Loader2 className="w-3 h-3 animate-spin" /> : label}
                        </button>
                    ))}
                </div>
                {error && <span className="text-[10px] font-black uppercase tracking-widest text-destructive">{error}</span>}
            </div>
        </div>
    );
}

/**
 * Answer the request: grant it with the value the client asked for, or refuse it.
 *
 * Granting sends that value rather than making the operator retype it — the one
 * step in this loop where a wrong digit could be introduced, on the number that
 * prints on every invoice the client is ever issued.
 *
 * Refusing writes a row of its own, because a refusal changes no value and the
 * state is read off the trail. The reason is optional and travels to the client
 * as typed; leaving it empty says nothing rather than inventing something.
 */
function AnswerRequest({ code, field, value, onAnswered }: {
    code: string; field: string; value: string; onAnswered: () => void;
}) {
    const [busy, setBusy] = useState<"apply" | "reject" | null>(null);
    const [rejecting, setRejecting] = useState(false);
    const [reason, setReason] = useState("");
    const [error, setError] = useState<string | null>(null);

    const send = async (payload: Record<string, unknown>, kind: "apply" | "reject") => {
        setBusy(kind); setError(null);
        try {
            const res = await fetch(`/api/admin/clientes/${encodeURIComponent(code)}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ field, ...payload }),
            });
            const body: any = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(body?.error === "nif_must_be_nine_digits" ? "O NIF pedido não tem nove dígitos." : (body?.error || `HTTP ${res.status}`));
                return;
            }
            onAnswered();
        } catch (e: any) {
            setError(String(e));
        } finally {
            setBusy(null);
        }
    };

    if (rejecting) {
        return (
            <div className="w-full flex flex-wrap items-center gap-2 pt-2">
                <input
                    autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") send({ reject: true, reason }, "reject"); if (e.key === "Escape") setRejecting(false); }}
                    placeholder="Motivo (opcional) — vai tal como o escrever"
                    className="flex-1 min-w-[220px] bg-surface-2 border border-hairline rounded-xl px-3 py-2 text-sm font-medium text-fg focus:outline-none focus:border-accent/40"
                />
                <button type="button" disabled={busy !== null} onClick={() => send({ reject: true, reason }, "reject")}
                    className="bg-destructive/15 text-destructive border border-destructive/30 px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2 disabled:opacity-30">
                    {busy === "reject" ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />} Recusar
                </button>
                <button type="button" onClick={() => setRejecting(false)}
                    className="text-[10px] font-black uppercase tracking-widest text-fg-40 hover:text-fg">cancelar</button>
                {error && <span className="w-full text-[10px] font-black uppercase tracking-widest text-destructive">{error}</span>}
            </div>
        );
    }

    return (
        <>
            <div className="ml-auto flex items-center gap-2">
                <button type="button" disabled={busy !== null} onClick={() => setRejecting(true)}
                    className="px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest text-fg-40 hover:text-destructive transition-colors disabled:opacity-30">
                    Recusar
                </button>
                <button type="button" disabled={busy !== null} onClick={() => send({ value }, "apply")}
                    className="bg-fg text-surface px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2 hover:opacity-90 transition-all disabled:opacity-30">
                    {busy === "apply" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Aplicar
                </button>
            </div>
            {error && <span className="w-full text-[10px] font-black uppercase tracking-widest text-destructive">{error}</span>}
        </>
    );
}

function IdentityTab({ data, code, onSaved }: { data: any; code: string; onSaved: () => void }) {
    const c = data.customer;
    const identity = c.identity ?? {};
    const requests: any[] = data.identity_requests ?? [];
    const pending = requests.filter((r) => r.outcome === "pending");
    const answered = requests.filter((r) => r.outcome !== "pending");
    const fieldLabel = (f: string) => (f === "nif" ? "NIF" : "nome fiscal");

    return (
        <div className="space-y-6">
            {pending.length > 0 && (
                <Section icon={<AlertTriangle className="w-5 h-5 text-soon" />} title="Pedidos por responder"
                    desc="O cliente pediu isto a partir da página Conta. Aplicar grava o valor que ele pediu; recusar fica registado, com o motivo que escrever. Em qualquer dos casos ele é avisado no painel.">
                    <div className="space-y-2">
                        {pending.map((r) => (
                            <div key={r.field} className="text-sm flex flex-wrap items-center gap-2 border-b border-hairline/60 pb-2">
                                <Pill tone="warn">{fieldLabel(r.field)}</Pill>
                                <span className="font-mono text-xs text-fg-40">{(r.field === "nif" ? c.nif : c.company_name) || "—"}</span>
                                <span className="text-fg-40">→</span>
                                <span className="font-mono text-xs font-bold text-fg">{r.requested}</span>
                                <span className="text-[10px] text-fg-40 uppercase tracking-widest">{moment(r.requested_at)}</span>
                                {data.fiscal_visible && (
                                    <AnswerRequest code={code} field={r.field} value={r.requested} onAnswered={onSaved} />
                                )}
                            </div>
                        ))}
                    </div>
                </Section>
            )}

            {answered.length > 0 && (
                <Section icon={<ScrollText className="w-5 h-5 text-fg-40" />} title="Pedidos já respondidos"
                    desc="O que o cliente pediu antes e o que lhe foi dado. Se voltar a pedir o mesmo campo, o pedido novo é mais recente do que esta decisão e volta a contar.">
                    <div className="space-y-2">
                        {answered.map((r) => (
                            <div key={r.field} className="text-sm flex flex-wrap items-center gap-2 border-b border-hairline/60 pb-2">
                                <Pill tone={r.outcome === "applied" ? "good" : "bad"}>
                                    {r.outcome === "applied" ? "aplicado" : "recusado"}
                                </Pill>
                                <span className="text-fg-40">{fieldLabel(r.field)}</span>
                                {/* For a recorded grant, what the record says now — a
                                    corrected value, or nothing if it was cleared. For a
                                    refusal, or a grant with no decision row, what was
                                    asked for. */}
                                <span className="font-mono text-xs font-bold text-fg">
                                    {r.outcome === "applied" && r.decided_at ? (r.decided_value || "— (removido)") : r.requested}
                                </span>
                                {/* A grant read off the stored value has no decision row and
                                    so no date; the request's date must not pose as the day
                                    it was applied. */}
                                <span className="text-[10px] text-fg-40 uppercase tracking-widest">
                                    {r.decided_at
                                        ? moment(r.decided_at)
                                        : `pedido a ${moment(r.requested_at)} · decisão sem registo`}
                                </span>
                                {r.reason && <span className="w-full text-xs text-fg-40 italic">“{r.reason}”</span>}
                            </div>
                        ))}
                    </div>
                </Section>
            )}

            <Section icon={<Building2 className="w-5 h-5 text-accent-ink" />} title="Dados do registo"
                desc="O que o cliente preencheu no onboarding. É o que a página Conta lê e, salvo o NIF e o nome fiscal, o que ele pode corrigir. A língua manda no painel que ele vê e em todos os emails que lhe enviamos.">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                    <Field label="Código" value={c.client_code} mono />
                    <LanguageField code={code} value={c.language} onSaved={onSaved} />
                    {data.fiscal_visible ? (
                        <>
                            <FiscalField code={code} field="company_name" label="Nome fiscal" value={c.company_name} onSaved={onSaved} />
                            <FiscalField code={code} field="nif" label="NIF" value={c.nif} mono onSaved={onSaved} />
                        </>
                    ) : (
                        <>
                            <Field label="Nome fiscal" value={c.company_name} />
                            <Field label="NIF" value={c.nif} mono />
                        </>
                    )}
                    <Field label="Nome" value={c.name} />
                    <Field label="Email" value={c.email} />
                    <Field label="Telefone" value={c.phone} />
                    <Field label="Morada de faturação" value={c.fiscal_address} />
                    <Field label="Website" value={c.website} />
                    <Field label="Etiqueta interna" value={c.admin_label} />
                    <Field label="Conta criada" value={day(c.created_at)} />
                    <Field label="Último acesso" value={moment(c.last_login)} />
                    <Field label="Privacidade aceite" value={c.privacy_policy_accepted_at ? day(c.privacy_policy_accepted_at) : (c.privacy_policy_accepted ? "sim, sem data" : "não")} />
                </div>
            </Section>

            <Section icon={<Scale className="w-5 h-5 text-accent-ink" />} title="Identidade que paga"
                desc="O que o emparelhador de faturas Kapta usa. A cópia do Checkout ganha à do registo: é a identidade que efectivamente pagou.">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                    <Field label="NIF" value={identity.nif} mono />
                    <Field label="Nome" value={identity.name} />
                    <Field label="Email" value={identity.email} />
                    <Field label="Morada" value={identity.address} />
                    <Field label="Código postal" value={identity.zip} mono />
                </div>
            </Section>

            <Section icon={<Users className="w-5 h-5 text-accent-ink" />} title="Utilizadores da conta"
                desc={data.seats ? `${data.seats.occupied} de ${data.seats.capacity} lugares ocupados (${data.seats.paid} comprados, ${data.seats.included} incluído).` : undefined}>
                {(data.members ?? []).length === 0 ? (
                    <p className="text-sm text-fg-40 font-medium">Só o titular.</p>
                ) : (
                    <div className="space-y-2">
                        {data.members.map((m: any) => (
                            <div key={m.id} className="flex flex-wrap items-center gap-3 text-sm">
                                <span className="font-bold text-fg">{m.email}</span>
                                <Pill tone={m.status === "active" ? "good" : m.status === "revoked" ? "bad" : "warn"}>{m.status}</Pill>
                                <Pill>{m.role}</Pill>
                                <span className="text-fg-40 text-xs">convidado em {day(m.created_at)}</span>
                            </div>
                        ))}
                    </div>
                )}
            </Section>

            <Section icon={<IdCard className="w-5 h-5 text-accent-ink" />} title="Origem"
                desc="De onde veio este registo, capturado uma única vez.">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                    <Field label="Fonte" value={c.acq_utm_source} />
                    <Field label="Meio" value={c.acq_utm_medium} />
                    <Field label="Referência" value={c.acq_referrer} />
                    <Field label="Página de entrada" value={c.acq_landing} />
                    <Field label="País" value={c.acq_country} />
                    <Field label="Capturado" value={day(c.acq_captured_at)} />
                </div>
            </Section>

            <ReferralsSection referrals={data.referrals} />
        </div>
    );
}

/** The same words ReferralsCard uses, so the campaign reads alike on both pages. */
const REFERRAL_STATE_PT: Record<string, string> = {
    pending: "inscreveu-se",
    subscribed: "subscreveu, por pagar",
    rewarded: "creditado",
    void: "anulado",
};

const REFERRAL_STATE_TONE: Record<string, "neutral" | "good" | "warn" | "bad"> = {
    pending: "neutral",
    subscribed: "warn",
    rewarded: "good",
    void: "bad",
};

/** Another account, by name and number, the number opening its own record. */
const AccountRef = ({ label, id, code }: { label: string | null; id: string; code: string | null }) => (
    <span className="inline-flex flex-wrap items-center gap-2">
        <span className="font-bold text-fg">{label || id}</span>
        {code && (
            <Link href={`/admin/clientes/${code}`} className="font-mono text-[11px] tracking-[0.18em] text-accent-ink hover:underline">
                {code}
            </Link>
        )}
    </span>
);

/**
 * Both directions of the referral campaign for this account.
 *
 * The paid flag is on every row it was invited, and it is only a warning where
 * it matters: a reward is granted when the invitee's subscription is created,
 * before any money, so "creditado" beside "ainda não pagou" is the shape abuse
 * takes. A failed read says so rather than claiming nobody was invited.
 */
function ReferralsSection({ referrals }: { referrals: any }) {
    if (!referrals) {
        return (
            <Section icon={<Gift className="w-5 h-5 text-soon" />} title="Convites">
                <p className="text-sm text-fg-40 font-medium">Não foi possível ler os convites desta conta.</p>
            </Section>
        );
    }

    const by = referrals.invited_by;
    const invited: any[] = referrals.invited ?? [];

    return (
        <Section icon={<Gift className="w-5 h-5 text-accent-ink" />} title="Convites"
            desc={`${referrals.rewards_used}/${referrals.max_rewards} recompensas usadas. Cada uma são 2 meses empurrados na subscrição de quem convida, dados quando a do convidado é criada, antes de haver pagamento.`}>
            <div className="space-y-2">
                <span className="text-[10px] font-black uppercase tracking-widest text-fg-40">Convidado por</span>
                {!by ? (
                    <p className="text-sm text-fg-40 font-medium">Ninguém. Não chegou por convite.</p>
                ) : (
                    <div className="text-sm flex flex-wrap items-center gap-2">
                        <AccountRef label={by.inviter_label} id={by.inviter_user_id} code={by.inviter_client_code} />
                        <Pill tone={REFERRAL_STATE_TONE[by.state]}>{REFERRAL_STATE_PT[by.state] ?? by.state}</Pill>
                        <span className="text-[10px] text-fg-40 uppercase tracking-widest">convite a {day(by.claimed_at)}</span>
                        {by.reward_until && (
                            <span className="text-[10px] text-fg-40 uppercase tracking-widest">
                                2 meses a quem convidou, até {day(by.reward_until)}
                            </span>
                        )}
                    </div>
                )}
            </div>

            <div className="space-y-2">
                <span className="text-[10px] font-black uppercase tracking-widest text-fg-40">Convidou</span>
                {invited.length === 0 ? (
                    <p className="text-sm text-fg-40 font-medium">Ninguém.</p>
                ) : invited.map((r) => (
                    <div key={r.invitee_user_id} className="text-sm flex flex-wrap items-center gap-2 border-b border-hairline/60 pb-2">
                        <AccountRef label={r.invitee_label} id={r.invitee_user_id} code={r.invitee_client_code} />
                        <Pill tone={REFERRAL_STATE_TONE[r.state]}>{REFERRAL_STATE_PT[r.state] ?? r.state}</Pill>
                        <Pill tone={r.invitee_paid ? "good" : r.state === "rewarded" ? "warn" : "neutral"}>
                            {r.invitee_paid ? "já pagou" : "ainda não pagou"}
                        </Pill>
                        <span className="text-[10px] text-fg-40 uppercase tracking-widest">
                            convite a {day(r.claimed_at)}
                            {r.invitee_subscribed_at ? ` · subscreveu a ${day(r.invitee_subscribed_at)}` : ""}
                            {r.reward_until ? ` · creditado até ${day(r.reward_until)}` : ""}
                        </span>
                        {(r.void_reason || r.note) && (
                            <span className="w-full text-xs text-destructive">{r.void_reason || r.note}</span>
                        )}
                    </div>
                ))}
            </div>
        </Section>
    );
}

function SubscriptionsTab({ data, base }: { data: any; base: string }) {
    const subs: any[] = data.subscriptions ?? [];
    return (
        <Section icon={<CreditCard className="w-5 h-5 text-accent-ink" />} title="Subscrições"
            desc="Uma por ligação desde a migração 0044: uma conta com dois canais paga dois.">
            {subs.length === 0 ? (
                <p className="text-sm text-fg-40 font-medium">Sem subscrição.</p>
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {subs.map((s) => (
                        <div key={`${s.user_id}:${s.connection_key}`} className="rounded-2xl border border-hairline bg-surface-2/40 p-5 space-y-4">
                            <div className="flex items-center justify-between gap-3 flex-wrap">
                                <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg">{s.connection_key}</span>
                                <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-widest border ${SUB_STATE_STYLE[s.sub_state] ?? SUB_STATE_STYLE.exempt}`}>
                                    {s.sub_state}
                                </span>
                            </div>
                            {/* Only a row with a Stripe subscription pays for anything. The
                                rest are placeholders written under the column default at
                                sign-up, and "paga" on them sent the operator hunting a charge
                                that does not exist. */}
                            {!s.connection_exists && (
                                <p className="text-[11px] font-bold text-soon">
                                    {s.stripe_subscription_id
                                        ? "Paga uma ligação que a conta não tem — verificar antes de cobrar outra."
                                        : "Linha sem ligação correspondente (sem cobrança)."}
                                </p>
                            )}
                            <div className="grid grid-cols-2 gap-4">
                                <Field label="Estado" value={s.status} />
                                <Field label="Plano" value={s.plan ?? "—"} />
                                <Field label="Escalão" value={s.tier} />
                                <Field label="Preço" value={s.unit_amount_cents != null ? `${money(s.unit_amount_cents, "eur")} / ${s.interval === "year" ? "ano" : "mês"}` : "—"} />
                                <Field label="Período até" value={day(s.current_period_end)} />
                                <Field label="Fim do trial" value={day(s.trial_end)} />
                                {s.cancel_at && <Field label="Cancela a" value={day(s.cancel_at)} />}
                                {s.sunset_at && <Field label="Preço antigo acaba" value={day(s.sunset_at)} />}
                            </div>
                            <div className="space-y-1 pt-1 border-t border-hairline">
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] font-black uppercase tracking-widest text-fg-40 shrink-0">Cliente</span>
                                    <StripeLink base={base} kind="customers" id={s.stripe_customer_id} />
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] font-black uppercase tracking-widest text-fg-40 shrink-0">Subscrição</span>
                                    <StripeLink base={base} kind="subscriptions" id={s.stripe_subscription_id} />
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </Section>
    );
}

function ConnectionsTab({ data }: { data: any }) {
    const conns: any[] = data.connections ?? [];
    const legacy = data.legacy;
    return (
        <div className="space-y-6">
            <Section icon={<Zap className="w-5 h-5 text-accent-ink" />} title="Integrações"
                desc={`${data.counts?.documents ?? 0} documentos emitidos · ${data.counts?.incidents_open ?? 0} incidentes por fechar.`}>
                {conns.length === 0 ? (
                    <p className="text-sm text-fg-40 font-medium">Nenhuma ligação configurada.</p>
                ) : (
                    <div className="space-y-3">
                        {conns.map((conn) => (
                            <div key={conn.key} className="rounded-2xl border border-hairline bg-surface-2/40 p-5 space-y-3">
                                <div className="flex items-center gap-3 flex-wrap">
                                    <span className="font-black text-sm">{connectionLabel(conn.source_kind, conn.destination_kind)}</span>
                                    <Pill tone={conn.status === "active" ? "good" : conn.status === "paused" ? "warn" : "neutral"}>{conn.status}</Pill>
                                    {conn.legacy && <Pill>legado</Pill>}
                                    {/* The gate's verdict, not the row's existence: an early-bird
                                        trial that ran out is a row the worker refuses on. */}
                                    {conn.subscribed === false && (
                                        <Pill tone="bad">
                                            {conn.subscription_status == null
                                                ? "sem subscrição"
                                                // A blocked trial is one with no paid Stripe subscription
                                                // behind it: it ran out, or it never had an end.
                                                : conn.subscription_status === "trialing"
                                                    ? (conn.subscription_trial_end
                                                        ? `trial terminou a ${day(conn.subscription_trial_end)}`
                                                        : "trial sem subscrição paga")
                                                    : `subscrição ${conn.subscription_status}`}
                                            {" — o worker recusa faturar"}
                                        </Pill>
                                    )}
                                    {conn.admin_label && <span className="text-xs text-fg-40 font-bold">{conn.admin_label}</span>}
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                    <Field label="Identificador" value={conn.identifier} mono />
                                    <Field label="Fatura desde" value={day(conn.invoice_cutoff ?? conn.created_at)} />
                                    <Field label="Criada" value={day(conn.created_at)} />
                                </div>
                                {/* Only what this pair needs, so every ✗ is a real gap. */}
                                {conn.credentials_present && Object.keys(conn.credentials_present).length > 0 && (
                                    <div className="flex flex-wrap gap-2 pt-1">
                                        {Object.entries(conn.credentials_present).map(([k, present]) => (
                                            <Pill key={k} tone={present ? "good" : "bad"}>{present ? "✓" : "✗"} {k}</Pill>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </Section>

            {/* Only for an account that has a shop. A row without one only ever held
                the InvoiceXpress credentials — each connection's checklist above now
                says whether it can use them — and drawing it as "the Shopify pair",
                with a stale "IX autorizado: sim" beside "chave: não", read as a pipe. */}
            {legacy?.shopify_domain && (
                <Section icon={<Zap className="w-5 h-5 text-fg-40" />} title="Linha legada (integrations)"
                    desc="A configuração do par Shopify→InvoiceXpress, que não tem linha em connections. Credenciais mostradas só como presença.">
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        <Field label="Loja" value={legacy.shopify_domain} mono />
                        <Field label="Conta IX" value={legacy.ix_account_name} mono />
                        <Field label="Ambiente IX" value={legacy.ix_environment} />
                        <Field label="Webhooks activos" value={legacy.webhooks_active ? "sim" : "não"} />
                        <Field label="Shopify autorizado" value={legacy.shopify_authorized ? "sim" : "não"} />
                        <Field label="IX autorizado" value={legacy.ix_authorized ? "sim" : "não"} />
                        <Field label="Chave IX guardada" value={legacy.has_ix_api_key ? "sim" : "não"} />
                        <Field label="Token Shopify guardado" value={legacy.has_shopify_token ? "sim" : "não"} />
                        <Field label="Em pausa" value={legacy.is_paused ? "sim" : "não"} />
                    </div>
                </Section>
            )}
        </div>
    );
}

/**
 * What the operator knows about this company that the configuration cannot say.
 *
 * Under the settings and not beside them, because the two are different kinds of
 * thing: above is what the system APPLIES, here is what a person needs to know
 * to read it — an instruction that arrived by email, why an exemption code is
 * the one it is, what was agreed and when. A note changes no document.
 *
 * The same note as the one in /admin/client-rules: one row, two screens. It also
 * travels with this company's incident diagnoses, with emails and tax numbers
 * stripped out, so an alert is read with the context the operator has.
 */
function CompanyNotesCard({ code, value, onSaved }: { code: string; value: string; onSaved: () => void }) {
    const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
    const [error, setError] = useState<string | null>(null);

    const save = async (next: string) => {
        if (next === value) return;
        setState("saving"); setError(null);
        try {
            const res = await fetch(`/api/admin/clientes/${encodeURIComponent(code)}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ field: "notes", value: next }),
            });
            const body: any = await res.json().catch(() => ({}));
            if (!res.ok) { setError(body?.error || `HTTP ${res.status}`); setState("idle"); return; }
            setState("saved");
            onSaved();
        } catch (e: any) {
            setError(String(e)); setState("idle");
        }
    };

    return (
        <Section icon={<NotebookPen className="w-5 h-5 text-accent-ink" />} title="Notas desta conta"
            desc="As alterações específicas feitas para este cliente, para não se perderem. Guardado ao sair do campo, e fica no registo."
            right={
                state === "saving"
                    ? <Loader2 className="w-3 h-3 animate-spin text-fg-40" />
                    : state === "saved"
                        ? <span className="text-[10px] font-black uppercase tracking-widest text-fg-40">Guardado</span>
                        : null
            }>
            <textarea
                className="w-full min-h-[160px] rounded-2xl border border-hairline bg-surface-2/40 p-4 text-sm text-fg font-medium leading-relaxed outline-none focus:border-accent/40"
                maxLength={MAX_NOTES_CHARS}
                defaultValue={value}
                onFocus={() => setState("idle")}
                onBlur={(e) => void save(e.target.value)}
                placeholder="ex.: portes a 0% por decisão de 12/08; a série FT2026 foi comunicada em 14/09; a Matilde pediu que as faturas saiam em rascunho até fecharem o ano."
            />
            <p className="text-[10px] text-fg-40 mt-2">
                Não altera nenhum documento — o que o sistema aplica é a configuração acima. Vai anexado aos
                diagnósticos de incidentes desta empresa, com emails e NIFs removidos.
            </p>
            {error && <p className="text-[10px] font-black uppercase tracking-widest text-destructive mt-2">{error}</p>}
        </Section>
    );
}

function FiscalTab({ data, code, onSaved }: { data: any; code: string; onSaved: () => void }) {
    if (!data.fiscal_visible) {
        return (
            <Section icon={<Scale className="w-5 h-5 text-soon" />} title="Regras fiscais">
                <p className="text-sm text-fg-40 font-medium">
                    A configuração fiscal de uma empresa é visível a hiperadmin. Proteger a página e não os dados
                    não protege nada, por isso este bloco nem sequer vem no payload.
                </p>
            </Section>
        );
    }

    const conns: any[] = (data.connections ?? []).filter((c: any) => c.fiscal && Object.keys(c.fiscal).length > 0);
    return (
        <div className="space-y-6">
            <Section icon={<Scale className="w-5 h-5 text-accent-ink" />} title="Regras fiscais"
                desc="Leitura. Editar é em /admin/client-rules, onde cada alteração passa pela confirmação dos campos perigosos e fica no registo."
                right={
                    <Link href="/admin/client-rules" className="text-[10px] font-black uppercase tracking-widest text-accent-ink hover:underline">
                        Editar regras →
                    </Link>
                }>
                {conns.length === 0 ? (
                    <p className="text-sm text-fg-40 font-medium">
                        Nenhuma configuração fiscal registada nesta conta — nem nas ligações nem na linha
                        legada <span className="font-mono">integrations</span>.
                    </p>
                ) : (
                    <div className="space-y-5">
                        {conns.map((conn) => (
                            <div key={conn.key} className="rounded-2xl border border-hairline bg-surface-2/40 p-5 space-y-3">
                                <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg">{conn.key}</span>
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                                    {Object.entries(conn.fiscal).map(([k, v]) => (
                                        <Field key={k} label={k} value={typeof v === "boolean" ? (v ? "sim" : "não") : String(v ?? "")} mono />
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </Section>

            <CompanyNotesCard code={code} value={String(data.company_notes ?? "")} onSaved={onSaved} />
        </div>
    );
}

function StripeTab({ data, base }: { data: any; base: string }) {
    const events: any[] = data.stripe?.events ?? [];
    const customerIds: string[] = data.stripe?.customer_ids ?? [];
    const isTest = base.endsWith("/test");
    return (
        <Section icon={<CreditCard className="w-5 h-5 text-accent-ink" />} title="Stripe"
            desc={`Lido do que os webhooks já guardaram — nenhuma chamada à API por visita. Dashboard ${isTest ? "de teste" : "live"}.`}>
            <div className="space-y-2">
                <span className="text-[10px] font-black uppercase tracking-widest text-fg-40">Clientes Stripe</span>
                {customerIds.length === 0 ? (
                    <p className="text-sm text-fg-40 font-medium">Nenhum cliente Stripe registado, nem nas subscrições nem nos pagamentos.</p>
                ) : (
                    <div className="flex flex-col gap-1">
                        {customerIds.map(id => <StripeLink key={id} base={base} kind="customers" id={id} />)}
                    </div>
                )}
            </div>

            <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse min-w-[720px]">
                    <thead>
                        <tr className="border-b border-hairline">
                            {["Data", "Tipo", "Valor", "Estado", "Objecto Stripe", "Pagamento", "Documento Kapta"].map(h => (
                                <th key={h} className="py-3 pr-4 text-[10px] font-black uppercase tracking-widest text-fg-40">{h}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {events.length === 0 && (
                            <tr><td colSpan={7} className="py-6 text-sm text-fg-40 font-medium">Sem pagamentos registados.</td></tr>
                        )}
                        {events.map((e) => {
                            // The webhook stores Stripe's invoice status, which is "open"
                            // on a failed attempt — so the type says it, not the status.
                            const failed = e.type === "invoice.payment_failed";
                            // What the matcher will ever pair: paid rows with an amount.
                            // "Por emparelhar" on a failed attempt or a €0 invoice is a
                            // task nobody can finish.
                            const pairable = (e.type === "invoice.paid" || e.type === "charge.refunded") && Number(e.amount_cents) > 0;
                            return (
                                <tr key={e.id} className="border-b border-hairline/60 align-top">
                                    <td className="py-3 pr-4 text-xs font-bold text-fg whitespace-nowrap">{day(e.created_at)}</td>
                                    <td className="py-3 pr-4 text-xs text-fg-40 font-medium">{e.type}</td>
                                    <td className="py-3 pr-4 text-xs font-bold text-fg whitespace-nowrap">{money(e.amount_cents, e.currency)}</td>
                                    <td className="py-3 pr-4">
                                        <Pill tone={failed ? "bad" : e.status === "paid" ? "good" : "neutral"}>{failed ? "falhou" : e.status}</Pill>
                                    </td>
                                    <td className="py-3 pr-4">
                                        <StripeLink base={base} id={e.stripe_object_id} />
                                        {e.stripe_invoice_number && <div className="text-[10px] text-fg-40 font-mono">{e.stripe_invoice_number}</div>}
                                    </td>
                                    <td className="py-3 pr-4"><StripeLink base={base} kind="payments" id={e.payment_intent_id} /></td>
                                    <td className="py-3 pr-4">
                                        {e.ix_invoice_permalink ? (
                                            <a href={e.ix_invoice_permalink} target="_blank" rel="noopener noreferrer"
                                                className="inline-flex items-center gap-1 text-[11px] text-accent-ink hover:underline">
                                                ver <ExternalLink className="w-3 h-3" />
                                            </a>
                                        ) : pairable
                                            ? <span className="text-fg-40 text-xs">por emparelhar</span>
                                            : <span className="text-fg-40 text-xs">—</span>}
                                        {e.ix_match_method && <div className="text-[10px] text-fg-40">{e.ix_match_method}</div>}
                                        {/* One payment, recorded by the webhook AND by a manual link. */}
                                        {e.ix_conflict ? (
                                            <div className="text-[10px] font-bold text-destructive space-y-1">
                                                <div>registado {e.duplicate_rows}× com documentos diferentes — confirmar qual é o certo</div>
                                                {(e.ix_alternatives ?? []).map((alt: any) => alt.ix_invoice_permalink ? (
                                                    <a key={String(alt.ix_invoice_id)} href={alt.ix_invoice_permalink} target="_blank" rel="noopener noreferrer"
                                                        className="flex items-center gap-1 font-medium text-accent-ink hover:underline">
                                                        outro documento: {String(alt.ix_invoice_id)} <ExternalLink className="w-3 h-3" />
                                                    </a>
                                                ) : (
                                                    <div key={String(alt.ix_invoice_id)} className="font-mono font-medium text-fg-40">
                                                        outro documento: {String(alt.ix_invoice_id)}
                                                    </div>
                                                ))}
                                            </div>
                                        ) : e.duplicate_rows > 1 ? (
                                            <div className="text-[10px] text-fg-40">registado {e.duplicate_rows}×</div>
                                        ) : null}
                                        {e.ix_shared && (
                                            <div className="text-[10px] font-bold text-soon">documento também ligado a outro pagamento</div>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </Section>
    );
}

/**
 * Three logs, filed under the connection each row belongs to.
 *
 * Two of the three can be filed exactly. Incidents mostly cannot: only the
 * connection-health check writes `connection_id`, every other reportIncident call
 * site leaves it null, so they are listed for the whole account with that said
 * out loud. Guessing the connection from the incident kind would be a guess
 * printed as a fact.
 */
function LogsTab({ userId, connections }: { userId: string; connections: any[] }) {
    const [audit, setAudit] = useState<any[]>([]);
    const [events, setEvents] = useState<any[]>([]);
    const [incidents, setIncidents] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<string | null>(null); // connection_key, or null for everything

    useEffect(() => {
        let alive = true;
        setLoading(true);
        Promise.all([
            fetch(`/api/admin/config-audit?user_id=${encodeURIComponent(userId)}&limit=200`).then(r => r.json()).catch(() => ({})),
            fetch(`/api/admin/document-log?user_id=${encodeURIComponent(userId)}&limit=200`).then(r => r.json()).catch(() => ({})),
            fetch(`/api/admin/incidents?user_id=${encodeURIComponent(userId)}&status=all&limit=200`).then(r => r.json()).catch(() => ({})),
        ]).then(([a, d, i]: any[]) => {
            if (!alive) return;
            setAudit(a?.entries ?? []);
            setEvents(d?.events ?? []);
            setIncidents(i?.incidents ?? []);
        }).finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, [userId]);

    const keys = (connections ?? []).map((c: any) => c.key);
    const auditByConn = groupByConnection(audit, (r: any) => connectionKeyForScope(r.scope));
    // Also files a source-only row — the dead-letter queue's — under the one
    // connection that takes that source, instead of under "no connection".
    const eventsByConn = groupByConnection(events, (r: any) => attributeDocumentEvent(r, keys));

    // "Sem ligação" is the null bucket; comparing the sentinel to a null key
    // never matched, so the button always showed an empty page.
    const show = (key: string | null) => filter === null || (filter === "__none__" ? key === null : filter === key);
    const visibleAudit = [...auditByConn.entries()].filter(([k]) => show(k));
    const visibleEvents = [...eventsByConn.entries()].filter(([k]) => show(k));

    if (loading) {
        return <div className="flex items-center gap-3 text-fg-40 text-sm font-bold"><Loader2 className="w-4 h-4 animate-spin" /> A ler os registos…</div>;
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setFilter(null)}
                    className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all ${filter === null ? "bg-accent/18 text-accent-ink border-accent/40" : "bg-surface-2/50 text-fg-40 border-hairline hover:text-fg"}`}>
                    Tudo
                </button>
                {keys.map((k: string) => (
                    <button key={k} type="button" onClick={() => setFilter(k)}
                        className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all ${filter === k ? "bg-accent/18 text-accent-ink border-accent/40" : "bg-surface-2/50 text-fg-40 border-hairline hover:text-fg"}`}>
                        {k}
                    </button>
                ))}
                <button type="button" onClick={() => setFilter("__none__")}
                    className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all ${filter === "__none__" ? "bg-accent/18 text-accent-ink border-accent/40" : "bg-surface-2/50 text-fg-40 border-hairline hover:text-fg"}`}>
                    Sem ligação
                </button>
            </div>

            <Section icon={<ScrollText className="w-5 h-5 text-accent-ink" />} title="Alterações de configuração"
                desc="Quem mudou que campo, de que valor para qual. Credenciais entram como presença, nunca como valor.">
                {visibleAudit.length === 0 ? (
                    <p className="text-sm text-fg-40 font-medium">Nada registado.</p>
                ) : visibleAudit.map(([key, rows]) => (
                    <div key={String(key)} className="space-y-2">
                        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg-40">
                            {key ?? "conta (sem ligação)"}
                        </span>
                        {(rows as any[]).map((r) => (
                            <div key={r.id} className="text-xs border-b border-hairline/60 py-2">
                                <span className="font-mono text-fg font-bold">{r.field}</span>
                                {/* A refusal stores the reason in new_value and changes
                                    nothing; drawn as "— → reason" it read as the NIF
                                    being set to the operator's sentence. */}
                                <span className="text-fg-40">
                                    {r.scope === "profile_change_rejected"
                                        ? ` · pedido recusado${r.new_value ? ` · motivo: ${r.new_value}` : " · sem motivo"}`
                                        // `||`, not `??`: the writers store an empty field as "",
                                        // which drew a blank before the arrow.
                                        : `${r.scope === "profile_change_request" ? " · pedido" : r.scope === "profile" ? " · aplicado" : ""} · ${r.old_value || "—"} → ${r.new_value || "—"}`}
                                </span>
                                <span className="text-fg-40"> · {moment(r.created_at)}</span>
                                {r.actor && <span className="text-fg-40"> · {r.actor}</span>}
                            </div>
                        ))}
                    </div>
                ))}
            </Section>

            <Section icon={<ScrollText className="w-5 h-5 text-accent-ink" />} title="Documentos"
                desc="Os últimos 200 eventos da conta, até 60 por ligação. Rotina fica 90 dias, prova (falhas, derivas, notas de crédito, reemissões) fica 365. Um separador vazio numa conta antiga é a janela, não uma avaria.">
                {visibleEvents.length === 0 ? (
                    <p className="text-sm text-fg-40 font-medium">Nada na janela de retenção.</p>
                ) : visibleEvents.map(([key, rows]) => (
                    <div key={String(key)} className="space-y-2">
                        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg-40">
                            {key ?? "sem ligação"}
                        </span>
                        {(rows as any[]).slice(0, 60).map((e) => (
                            <div key={e.id} className="text-xs border-b border-hairline/60 py-2">
                                <Pill tone={e.severity === "error" ? "bad" : e.severity === "warning" ? "warn" : "neutral"}>{e.label ?? e.event}</Pill>
                                <span className="text-fg font-medium"> {e.summary}</span>
                                <span className="text-fg-40"> · {moment(e.created_at)}</span>
                            </div>
                        ))}
                    </div>
                ))}
            </Section>

            <Section icon={<AlertTriangle className="w-5 h-5 text-accent-ink" />} title="Incidentes"
                desc={`Da conta inteira${incidents.length ? ` — os ${incidents.length} mais recentes` : ""}. Só a verificação de ligações regista a que ligação um incidente pertence, por isso não há como dividi-los honestamente por subscrição.`}>
                {incidents.length === 0 ? (
                    <p className="text-sm text-fg-40 font-medium">Nenhum incidente.</p>
                ) : incidents.map((i) => (
                    <div key={i.id} className="text-xs border-b border-hairline/60 py-2 flex flex-wrap items-center gap-2">
                        <Pill tone={i.status === "open" ? "bad" : i.status === "acknowledged" ? "warn" : "neutral"}>{i.status}</Pill>
                        <span className="font-mono text-fg-40">{i.kind}</span>
                        <span className="text-fg font-medium">{i.summary}</span>
                        <span className="text-fg-40">· ×{i.occurrences} · {moment(i.last_seen_at)}</span>
                    </div>
                ))}
            </Section>
        </div>
    );
}
