"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Mail, AlertTriangle, Send, Save, Eye } from "lucide-react";

/**
 * Writing to the whole client list.
 *
 * Same discipline as DunningCard, for a worse failure: preview before send, and
 * the send button stays dead until a preview has been drawn for exactly the copy
 * and filters now on screen. Edit one character afterwards and the preview is
 * discarded — a count from before an edit is not a count, and a newsletter is
 * the one thing here that cannot be corrected after it leaves.
 *
 * Labels are hardcoded Portuguese, like the rest of this surface.
 */

interface Template {
    slug: string; name: string; subject: string;
    preview_text: string | null; html: string; updated_at: string;
}
interface Campaign {
    id: string; slug: string; subject: string; recipients: number;
    segment_id: string | null; broadcast_id: string | null;
    scheduled_at: string | null; created_at: string; filters_json: string;
}
interface Recipient { user_id: string; email: string; label: string; first_name: string }
interface Preview {
    count: number; recipients: Recipient[]; html: string;
    subject: string; preview_text: string | null;
    legal_error: string | null; unknown_vars: string[];
}

/** The groups mirror the ones the SQL composes by, so "OR dentro do grupo"
 *  describes what actually happens rather than how the page is laid out. */
const GROUPS: { title: string; hint?: string; keys: [string, string][] }[] = [
    {
        title: "Plataforma", keys: [
            ["source:shopify", "Shopify"],
            ["source:stripe", "Stripe"],
            ["source:stripe_connect", "Stripe Connect"],
            ["source:lodgify", "Lodgify"],
            ["source:eupago", "EuPago"],
        ],
    },
    {
        title: "Destino", keys: [
            ["dest:invoicexpress", "InvoiceXpress"],
            ["dest:moloni", "Moloni"],
            ["dest:vendus", "Vendus"],
        ],
    },
    {
        title: "Subscrição", keys: [
            ["sub:active", "Activa"],
            ["sub:trialing", "Em período livre"],
            ["sub:past_due", "Pagamento em atraso"],
            ["sub:canceled", "Cancelada"],
            ["plan:monthly", "Mensal"],
            ["plan:annual", "Anual"],
        ],
    },
    {
        title: "Pagamentos", keys: [
            ["never_paid", "Nunca pagou"],
            ["has_paid", "Já pagou"],
            ["legacy_price", "Preço antigo"],
            ["early_bird_ending:30", "Early bird acaba em 30 dias"],
        ],
    },
    {
        title: "Facturação", hint: "o mesmo critério que o worker usa para recusar",
        keys: [
            ["blocked", "Bloqueada"],
            ["allowed", "A funcionar"],
        ],
    },
    {
        title: "Ligação", keys: [
            ["no_integration", "Sem integração"],
            ["has_integration", "Com integração"],
            ["never_issued", "Ligou mas nunca emitiu"],
        ],
    },
    {
        title: "Conta", hint: "uma conta parada recebe newsletters, só não recebe avisos",
        keys: [
            ["registered", "Registo completo"],
            ["not_registered", "Registo por acabar"],
            ["inactive", "Parada"],
            ["not_inactive", "Activa"],
        ],
    },
];

const n = (v: number) => new Intl.NumberFormat("pt-PT").format(v);
const BTN = "px-4 py-2 rounded-xl text-sm font-medium border border-hairline text-fg hover:bg-fg/5 transition-all disabled:opacity-40 flex items-center gap-2";
const BTN_PRIMARY = "px-4 py-2 rounded-xl text-sm font-medium bg-fg text-surface hover:bg-accent hover:text-on-accent transition-all disabled:opacity-40 flex items-center gap-2";
const FIELD = "w-full bg-surface-2/50 border border-hairline rounded-xl px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-accent/20";

export function NewsletterPanel() {
    const [templates, setTemplates] = useState<Template[]>([]);
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [slug, setSlug] = useState("");
    const [name, setName] = useState("");
    const [subject, setSubject] = useState("");
    const [previewText, setPreviewText] = useState("");
    const [html, setHtml] = useState("");
    const [filters, setFilters] = useState<string[]>([]);
    const [scheduledAt, setScheduledAt] = useState("");

    const [preview, setPreview] = useState<Preview | null>(null);
    const [previewedFor, setPreviewedFor] = useState<string | null>(null);
    const [busy, setBusy] = useState<"" | "preview" | "test" | "send" | "save">("");
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);

    /** What the preview was drawn for. Anything typed afterwards invalidates it. */
    const signature = useMemo(
        () => JSON.stringify([subject, html, [...filters].sort()]),
        [subject, html, filters],
    );
    const previewIsCurrent = preview !== null && previewedFor === signature;

    const load = useCallback(async () => {
        try {
            const res = await fetch("/api/admin/newsletter");
            const body = await res.json() as any;
            if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
            setTemplates(body.templates ?? []);
            setCampaigns(body.campaigns ?? []);
        } catch (e) {
            setError(String((e as Error).message ?? e));
        }
    }, []);

    useEffect(() => { void load(); }, [load]);

    const pick = (t: Template) => {
        setSlug(t.slug); setName(t.name); setSubject(t.subject);
        setPreviewText(t.preview_text ?? ""); setHtml(t.html);
        setPreview(null); setPreviewedFor(null); setNote(null);
    };

    const post = async (action: "preview" | "test" | "send") => {
        setBusy(action); setError(null); setNote(null);
        try {
            const res = await fetch("/api/admin/newsletter", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action, slug, subject, html, filters,
                    preview_text: previewText || undefined,
                    scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
                }),
            });
            const body = await res.json() as any;
            if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);

            if (action === "preview") {
                setPreview(body as Preview);
                setPreviewedFor(signature);
            } else if (action === "test") {
                setNote(`Teste enviado para ${body.tested}.`);
            } else {
                setNote(
                    body.scheduled_at
                        ? `Agendada para ${body.scheduled_at} · ${n(body.synced)} contactos`
                        : `Enviada a ${n(body.synced)} contactos.`,
                );
                setPreview(null); setPreviewedFor(null);
                void load();
            }
        } catch (e) {
            setError(String((e as Error).message ?? e));
        } finally {
            setBusy("");
        }
    };

    const save = async () => {
        setBusy("save"); setError(null); setNote(null);
        try {
            const res = await fetch("/api/admin/newsletter/template", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ slug, name, subject, preview_text: previewText, html }),
            });
            const body = await res.json() as any;
            if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
            setNote("Template gravado.");
            void load();
        } catch (e) {
            setError(String((e as Error).message ?? e));
        } finally {
            setBusy("");
        }
    };

    const toggle = (key: string) =>
        setFilters((f) => (f.includes(key) ? f.filter((k) => k !== key) : [...f, key]));

    const ready = Boolean(slug && subject.trim() && html.trim());

    return (
        <div className="space-y-6">
            <header>
                <h1 className="text-2xl font-medium tracking-tight text-fg">Newsletter</h1>
                <p className="mt-1 text-[11px] text-fg-40 leading-snug max-w-2xl">
                    Vai por Broadcast da Resend, que é dona do cancelamento de subscrição: quem
                    cancelar deixa de receber newsletters e continua a receber avisos de
                    facturação e de serviço, porque esses saem por outro caminho.
                </p>
            </header>

            {error && (
                <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-destructive/5 border border-destructive/20 text-destructive text-xs font-medium">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                    <span>{error}</span>
                </div>
            )}
            {note && (
                <div className="px-4 py-3 rounded-xl bg-accent/10 border border-accent/25 text-accent-ink text-xs font-medium">
                    {note}
                </div>
            )}

            {/* 1 — the copy */}
            <section className="glass rounded-[2rem] p-5 sm:p-7 border-hairline space-y-4">
                <h2 className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">Mensagem</h2>

                <div className="flex flex-wrap gap-2">
                    {templates.map((t) => (
                        <button
                            key={t.slug}
                            onClick={() => pick(t)}
                            className={`px-3 py-1.5 rounded-full text-xs border transition-all ${
                                slug === t.slug
                                    ? "bg-accent/18 text-accent-ink border-accent/45"
                                    : "border-hairline text-fg-60 hover:text-fg hover:bg-fg/5"
                            }`}
                        >
                            {t.name}
                        </button>
                    ))}
                    {templates.length === 0 && (
                        <p className="text-[11px] text-fg-40">
                            Sem templates. Escreve um slug e grava para criar o primeiro.
                        </p>
                    )}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1">
                        <span className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.18em]">Slug</span>
                        <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="convite" className={FIELD} />
                    </label>
                    <label className="space-y-1">
                        <span className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.18em]">Nome</span>
                        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Campanha de convites" className={FIELD} />
                    </label>
                </div>

                <label className="space-y-1 block">
                    <span className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.18em]">Assunto</span>
                    <input value={subject} onChange={(e) => setSubject(e.target.value)} className={FIELD} />
                </label>

                <label className="space-y-1 block">
                    <span className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.18em]">
                        Pré-visualização na caixa de entrada
                    </span>
                    <input value={previewText} onChange={(e) => setPreviewText(e.target.value)} className={FIELD} />
                </label>

                <label className="space-y-1 block">
                    <span className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.18em]">HTML</span>
                    <textarea
                        value={html}
                        onChange={(e) => setHtml(e.target.value)}
                        rows={12}
                        spellCheck={false}
                        className={`${FIELD} font-mono text-[11px] leading-relaxed`}
                    />
                    <span className="text-[10px] text-fg-40 leading-snug block">
                        {"{{VAR}}"} é nosso e resolve no envio. {"{{{VAR}}}"} é da Resend e passa
                        intacto — {"{{{RESEND_UNSUBSCRIBE_URL}}}"} é obrigatório.
                    </span>
                </label>

                <button onClick={save} disabled={!ready || busy !== ""} className={BTN}>
                    {busy === "save" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    Gravar template
                </button>
            </section>

            {/* 2 — who gets it */}
            <section className="glass rounded-[2rem] p-5 sm:p-7 border-hairline space-y-5">
                <div>
                    <h2 className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">Destinatários</h2>
                    <p className="mt-1 text-[11px] text-fg-40">
                        OU dentro de cada grupo, E entre grupos. Sem nada escolhido, vai para todas
                        as contas de cliente com email.
                    </p>
                </div>

                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {GROUPS.map((g) => (
                        <fieldset key={g.title} className="space-y-2">
                            <legend className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.18em]">
                                {g.title}
                            </legend>
                            {g.hint && <p className="text-[10px] text-fg-40 leading-snug">{g.hint}</p>}
                            <div className="flex flex-wrap gap-1.5">
                                {g.keys.map(([key, label]) => (
                                    <button
                                        key={key}
                                        onClick={() => toggle(key)}
                                        className={`px-2.5 py-1 rounded-lg text-[11px] border transition-all ${
                                            filters.includes(key)
                                                ? "bg-accent/18 text-accent-ink border-accent/45"
                                                : "border-hairline text-fg-60 hover:text-fg hover:bg-fg/5"
                                        }`}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </fieldset>
                    ))}
                </div>

                {preview && (
                    <div className="rounded-2xl p-4 bg-surface-2 border border-hairline space-y-3">
                        <p className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.18em]">
                            {previewIsCurrent
                                ? `${n(preview.count)} destinatários`
                                : "Simulação antiga — a mensagem ou os filtros mudaram"}
                        </p>

                        {preview.legal_error && (
                            <p className="text-[11px] text-destructive font-medium">
                                {preview.legal_error}
                            </p>
                        )}
                        {preview.unknown_vars.length > 0 && (
                            <p className="text-[11px] text-soon">
                                Variáveis por preencher: {preview.unknown_vars.join(", ")}
                            </p>
                        )}

                        <div className="max-h-56 overflow-y-auto space-y-1">
                            {preview.recipients.map((r) => (
                                <div key={r.user_id} className="flex items-baseline justify-between gap-3">
                                    <span className="text-sm text-fg truncate">{r.label}</span>
                                    <span className="font-mono text-[10px] text-fg-40 shrink-0">{r.email}</span>
                                </div>
                            ))}
                        </div>
                        {preview.count > preview.recipients.length && (
                            <p className="font-mono text-[10px] text-fg-40">
                                mais {n(preview.count - preview.recipients.length)} não listados
                            </p>
                        )}

                        {/* The two lines the iframe cannot show, resolved. A
                            placeholder left in the subject reaches everybody and
                            would otherwise never be seen before sending. */}
                        <div className="rounded-xl bg-surface-2/60 border border-hairline px-3 py-2">
                            <p className="text-sm text-fg">{preview.subject}</p>
                            {preview.preview_text && (
                                <p className="text-[11px] text-fg-40 mt-0.5">{preview.preview_text}</p>
                            )}
                        </div>

                        <iframe
                            title="Pré-visualização"
                            srcDoc={preview.html}
                            className="w-full h-96 rounded-xl bg-white border border-hairline"
                            sandbox=""
                        />
                    </div>
                )}

                <div className="flex flex-wrap gap-2 items-center">
                    <button onClick={() => post("preview")} disabled={!ready || busy !== ""} className={BTN}>
                        {busy === "preview" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
                        Simular
                    </button>
                    <button onClick={() => post("test")} disabled={!ready || busy !== ""} className={BTN}>
                        {busy === "test" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                        Enviar teste a mim
                    </button>
                    <button
                        onClick={() => post("send")}
                        disabled={
                            busy !== "" || !previewIsCurrent || !preview
                            || preview.count === 0 || Boolean(preview.legal_error)
                        }
                        title={
                            !previewIsCurrent ? "Simula primeiro, para esta mensagem e estes filtros"
                                : preview?.legal_error ? preview.legal_error
                                : preview?.count === 0 ? "Ninguém nestes filtros"
                                : undefined
                        }
                        className={BTN_PRIMARY}
                    >
                        {busy === "send" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                        {previewIsCurrent && preview ? `Enviar a ${n(preview.count)}` : "Enviar"}
                    </button>

                    <label className="ml-auto flex items-center gap-2 text-[11px] text-fg-40">
                        Agendar
                        <input
                            type="datetime-local"
                            value={scheduledAt}
                            onChange={(e) => setScheduledAt(e.target.value)}
                            className="bg-surface-2/50 border border-hairline rounded-lg px-2 py-1 font-mono text-[11px] text-fg focus:outline-none focus:ring-2 focus:ring-accent/20"
                        />
                    </label>
                </div>
            </section>

            {/* 3 — what already went out */}
            <section className="glass rounded-[2rem] p-5 sm:p-7 border-hairline space-y-3">
                <h2 className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">Enviadas</h2>
                {campaigns.length === 0 ? (
                    <p className="text-[11px] text-fg-40">Ainda nenhuma.</p>
                ) : (
                    <div className="space-y-1">
                        {campaigns.map((c) => (
                            <div key={c.id} className="flex items-baseline justify-between gap-3">
                                <span className="text-sm text-fg truncate">
                                    {c.subject}
                                    <span className="ml-2 font-mono text-[10px] text-fg-40">{c.slug}</span>
                                </span>
                                <span className="font-mono text-[10px] text-fg-40 shrink-0">
                                    {n(c.recipients)} · {String(c.created_at).slice(0, 10)}
                                    {c.scheduled_at && <span className="text-soon"> · agendada</span>}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}
