"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
    Wrench, ArrowLeft, Loader2, AlertCircle, CheckCircle2, Mail, X,
    PlayCircle, RotateCw, FileCheck2, ScrollText, Calendar, Percent
} from "lucide-react";

type Target = {
    id: string;
    name: string;
    email: string;
    role: string;
    nif: string | null;
    company_name: string | null;
    shopify_domain: string | null;
    shopify_authorized: boolean;
    ix_authorized: boolean;
    shopify_error: string | null;
    ix_error: string | null;
};

type JobResult = {
    job_id?: string;
    total?: number;
    success?: number;
    skipped?: number;
    errors?: number;
    would_create?: number;
    would_finalize?: number;
    finalized?: number;
    results?: any[];
    error?: string;
    [k: string]: any;
};

export function DevModePanel({ target }: { target: Target }) {
    const [notifyEmails, setNotifyEmails] = useState<string[]>([]);
    const [emailInput, setEmailInput] = useState("");
    const [savingEmails, setSavingEmails] = useState(false);

    useEffect(() => {
        fetch(`/api/admin/dev-mode/notify-emails?targetUserId=${target.id}`)
            .then(r => r.json())
            .then((d: any) => setNotifyEmails(d.emails ?? []))
            .catch(console.error);
    }, [target.id]);

    const saveEmails = async (next: string[]) => {
        setSavingEmails(true);
        try {
            const res = await fetch("/api/admin/dev-mode/notify-emails", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetUserId: target.id, emails: next }),
            });
            const data: any = await res.json();
            setNotifyEmails(data.emails ?? next);
        } catch (e) { console.error(e); }
        finally { setSavingEmails(false); }
    };

    const addEmail = () => {
        const e = emailInput.trim();
        if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return;
        if (notifyEmails.includes(e)) { setEmailInput(""); return; }
        const next = [...notifyEmails, e];
        setEmailInput("");
        saveEmails(next);
    };
    const removeEmail = (e: string) => saveEmails(notifyEmails.filter(x => x !== e));

    const noShop = !target.shopify_domain;

    return (
        <div className="space-y-10 animate-in fade-in duration-500">
            {/* Header */}
            <div className="flex flex-col gap-6">
                <Link href="/superadmin" className="flex items-center gap-2 text-slate-500 hover:text-white text-[10px] font-black uppercase tracking-widest w-fit">
                    <ArrowLeft className="w-3 h-3" /> Voltar
                </Link>
                <div className="flex items-end justify-between flex-wrap gap-4">
                    <div className="flex items-center gap-4">
                        <div className="w-14 h-14 rounded-2xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center">
                            <Wrench className="w-7 h-7 text-sky-400" />
                        </div>
                        <div>
                            <h1 className="text-4xl font-black tracking-tight bg-gradient-to-r from-white to-slate-500 bg-clip-text text-transparent">
                                Dev Mode
                            </h1>
                            <p className="text-slate-400 font-semibold mt-1">
                                {target.name} · {target.email}
                                {target.shopify_domain && <span className="text-slate-600"> · {target.shopify_domain}</span>}
                            </p>
                        </div>
                    </div>
                </div>
                {noShop && (
                    <div className="glass rounded-2xl p-5 border border-amber-500/30 bg-amber-500/5 flex items-center gap-3 text-amber-300 text-sm font-bold">
                        <AlertCircle className="w-5 h-5" />
                        Esta conta não tem `shopify_domain` configurado. Ações Dev Mode indisponíveis.
                    </div>
                )}
            </div>

            {!noShop && (
                <>
                    <TaxOverrideCard targetUserId={target.id} />
                    <NotifyEmailsCard emails={notifyEmails} input={emailInput} setInput={setEmailInput} onAdd={addEmail} onRemove={removeEmail} saving={savingEmails} />
                    <BackfillCard targetUserId={target.id} notifyEmails={notifyEmails} />
                    <ReemitCard targetUserId={target.id} notifyEmails={notifyEmails} />
                    <FinalizeDraftsCard targetUserId={target.id} notifyEmails={notifyEmails} />
                    <LogsCard targetUserId={target.id} />
                </>
            )}
        </div>
    );
}

function Section({ icon, title, desc, children }: { icon: React.ReactNode; title: string; desc?: string; children: React.ReactNode }) {
    return (
        <section className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
            <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center shrink-0">
                    {icon}
                </div>
                <div>
                    <h2 className="text-lg font-black tracking-tight">{title}</h2>
                    {desc && <p className="text-slate-500 text-xs font-medium mt-1">{desc}</p>}
                </div>
            </div>
            {children}
        </section>
    );
}

function ResultBox({ result }: { result: JobResult | null }) {
    if (!result) return null;
    const errored = result.error && !result.job_id;
    return (
        <pre className={`mt-4 rounded-2xl p-5 text-[11px] font-mono whitespace-pre-wrap border ${errored ? "bg-red-500/5 border-red-500/20 text-red-300" : "bg-slate-900/70 border-slate-800 text-slate-300"}`}>
            {JSON.stringify(result, null, 2)}
        </pre>
    );
}

function TaxOverrideCard({ targetUserId }: { targetUserId: string }) {
    const [rate, setRate] = useState<string>("");
    const [oss, setOss] = useState(true);
    const [loaded, setLoaded] = useState(false);
    const [saving, setSaving] = useState(false);
    const [savedAt, setSavedAt] = useState<number | null>(null);

    useEffect(() => {
        fetch(`/api/admin/dev-mode/tax-override?targetUserId=${targetUserId}`)
            .then(r => r.json())
            .then((d: any) => {
                setRate(d.force_tax_rate != null ? String(d.force_tax_rate) : "");
                setOss(d.oss_enabled !== 0);
                setLoaded(true);
            })
            .catch(console.error);
    }, [targetUserId]);

    const save = async () => {
        setSaving(true);
        try {
            const parsed = rate.trim() === "" ? null : Number(rate);
            const res = await fetch("/api/admin/dev-mode/tax-override", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetUserId, force_tax_rate: parsed, oss_enabled: oss }),
            });
            await res.json();
            setSavedAt(Date.now());
        } catch (e) { console.error(e); }
        finally { setSaving(false); }
    };

    return (
        <Section icon={<Percent className="w-5 h-5 text-cyan-400" />} title="Override de IVA" desc="Força uma taxa fixa em todas as faturas geradas (backfill + webhooks). Deixa vazio para usar dados do Shopify.">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                <label className="flex flex-col gap-1.5 text-[10px] font-black uppercase tracking-widest text-slate-500">
                    Force Tax (%)
                    <input
                        type="number" min={0} max={100} step="0.01"
                        value={rate} onChange={e => setRate(e.target.value)}
                        placeholder="ex: 6 ou vazio"
                        disabled={!loaded}
                        className="bg-slate-900/50 border border-slate-800 rounded-xl px-3 py-2 text-sm font-medium text-white"
                    />
                </label>
                <label className="flex items-center gap-3 cursor-pointer pb-2">
                    <input type="checkbox" checked={oss} onChange={e => setOss(e.target.checked)} disabled={!loaded} className="accent-cyan-500 w-4 h-4" />
                    <span className="text-xs font-bold text-slate-300">
                        OSS ativo (vendedor cross-border EU)
                    </span>
                </label>
                <button onClick={save} disabled={!loaded || saving}
                    className="bg-white text-black py-2.5 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-cyan-500 hover:text-white transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                    {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : savedAt && Date.now() - savedAt < 2000 ? <CheckCircle2 className="w-3 h-3" /> : null}
                    {savedAt && Date.now() - savedAt < 2000 ? "Guardado" : "Guardar"}
                </button>
            </div>
            <p className="text-[10px] text-slate-600 font-medium leading-relaxed">
                <strong className="text-slate-500">Force Tax:</strong> aplica esta taxa a todas as linhas de fatura, ignorando Shopify. Útil para vendedores com catálogo de taxa única (ex: livraria 6%).<br />
                <strong className="text-slate-500">OSS:</strong> informativo por agora. Rotação completa para small-seller (substituir taxas destino por taxa origem) requer rewrite do builder.
            </p>
        </Section>
    );
}

function NotifyEmailsCard({ emails, input, setInput, onAdd, onRemove, saving }: {
    emails: string[]; input: string; setInput: (s: string) => void; onAdd: () => void; onRemove: (e: string) => void; saving: boolean;
}) {
    return (
        <Section icon={<Mail className="w-5 h-5 text-rose-400" />} title="Notificações por email" desc="Destinatários incluídos automaticamente em cada job Dev Mode.">
            <div className="flex flex-wrap gap-2">
                {emails.map(e => (
                    <span key={e} className="bg-slate-900 border border-slate-800 rounded-xl px-3 py-1.5 text-xs font-bold flex items-center gap-2">
                        {e}
                        <button onClick={() => onRemove(e)} className="text-slate-600 hover:text-rose-400"><X className="w-3 h-3" /></button>
                    </span>
                ))}
                <div className="flex items-center gap-2">
                    <input
                        type="email" placeholder="adicionar@email.com" value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); onAdd(); } }}
                        className="bg-slate-900/50 border border-slate-800 rounded-xl px-3 py-1.5 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500/40 w-56"
                    />
                    <button onClick={onAdd} disabled={saving} className="bg-white text-black px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest disabled:opacity-50">
                        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : "+"}
                    </button>
                </div>
            </div>
        </Section>
    );
}

function BackfillCard({ targetUserId, notifyEmails }: { targetUserId: string; notifyEmails: string[] }) {
    const [mode, setMode] = useState<"date_range" | "since_last">("date_range");
    const [from, setFrom] = useState("");
    const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
    const [type, setType] = useState<"create_orders" | "finalize_orders">("create_orders");
    const [dryRun, setDryRun] = useState(true);
    const [reason, setReason] = useState("");
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<JobResult | null>(null);

    const run = async () => {
        setLoading(true); setResult(null);
        try {
            const res = await fetch("/api/admin/dev-mode/backfill", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    targetUserId, type, dry_run: dryRun, reason,
                    notify_emails: notifyEmails,
                    ...(mode === "since_last"
                        ? { since_last_processed: true, to: new Date(to + "T23:59:59Z").toISOString() }
                        : { from: from ? new Date(from + "T00:00:00Z").toISOString() : undefined, to: to ? new Date(to + "T23:59:59Z").toISOString() : undefined }),
                }),
            });
            setResult(await res.json());
        } catch (e: any) { setResult({ error: String(e) }); }
        finally { setLoading(false); }
    };

    return (
        <Section icon={<PlayCircle className="w-5 h-5 text-emerald-400" />} title="Backfill de Faturas" desc="Gera faturas em falta para encomendas Shopify históricas. Verifica DB + InvoiceXpress para evitar duplicados.">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex gap-2">
                    {(["date_range", "since_last"] as const).map(m => (
                        <button key={m} onClick={() => setMode(m)}
                            className={`flex-1 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all ${mode === m ? "bg-sky-500/20 text-sky-300 border-sky-500/40" : "bg-slate-900/50 text-slate-500 border-slate-800 hover:text-slate-300"}`}>
                            {m === "date_range" ? "Intervalo de Datas" : "Desde Última"}
                        </button>
                    ))}
                </div>
                <div className="flex gap-2">
                    {(["create_orders", "finalize_orders"] as const).map(t => (
                        <button key={t} onClick={() => setType(t)}
                            className={`flex-1 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all ${type === t ? "bg-rose-500/20 text-rose-300 border-rose-500/40" : "bg-slate-900/50 text-slate-500 border-slate-800 hover:text-slate-300"}`}>
                            {t === "create_orders" ? "Criar Faturas" : "Finalizar"}
                        </button>
                    ))}
                </div>

                {mode === "date_range" && (
                    <label className="flex flex-col gap-1.5 text-[10px] font-black uppercase tracking-widest text-slate-500">
                        De <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="bg-slate-900/50 border border-slate-800 rounded-xl px-3 py-2 text-sm font-medium text-white" />
                    </label>
                )}
                <label className="flex flex-col gap-1.5 text-[10px] font-black uppercase tracking-widest text-slate-500">
                    Até <input type="date" value={to} onChange={e => setTo(e.target.value)} className="bg-slate-900/50 border border-slate-800 rounded-xl px-3 py-2 text-sm font-medium text-white" />
                </label>

                <label className="md:col-span-2 flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} className="accent-amber-500 w-4 h-4" />
                    <span className="text-xs font-bold text-slate-300">
                        Dry-run (simulação — não escreve em InvoiceXpress)
                    </span>
                </label>

                <textarea
                    placeholder="Motivo / contexto desta operação..."
                    value={reason} onChange={e => setReason(e.target.value)}
                    rows={2}
                    className="md:col-span-2 bg-slate-900/50 border border-slate-800 rounded-xl px-3 py-2 text-sm font-medium text-white resize-none"
                />
            </div>

            <button onClick={run} disabled={loading}
                className="w-full bg-white text-black py-3 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-emerald-500 hover:text-white transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
                {dryRun ? "Simular Backfill" : "Executar Backfill"}
            </button>
            <ResultBox result={result} />
        </Section>
    );
}

function ReemitCard({ targetUserId, notifyEmails }: { targetUserId: string; notifyEmails: string[] }) {
    const [orderNumber, setOrderNumber] = useState("");
    const [force, setForce] = useState(false);
    const [reason, setReason] = useState("");
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<JobResult | null>(null);

    const run = async () => {
        if (!orderNumber) return;
        setLoading(true); setResult(null);
        try {
            const res = await fetch("/api/admin/dev-mode/reemit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetUserId, order_number: Number(orderNumber), force, reason, notify_emails: notifyEmails }),
            });
            setResult(await res.json());
        } catch (e: any) { setResult({ error: String(e) }); }
        finally { setLoading(false); }
    };

    return (
        <Section icon={<RotateCw className="w-5 h-5 text-amber-400" />} title="Re-emitir Fatura Única" desc="Força criação de fatura para uma encomenda específica. Útil para corrigir falhas pontuais.">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <label className="flex flex-col gap-1.5 text-[10px] font-black uppercase tracking-widest text-slate-500 md:col-span-1">
                    Order #
                    <input type="number" value={orderNumber} onChange={e => setOrderNumber(e.target.value)} placeholder="1234"
                        className="bg-slate-900/50 border border-slate-800 rounded-xl px-3 py-2 text-sm font-medium text-white" />
                </label>
                <label className="md:col-span-2 flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} className="accent-rose-500 w-4 h-4" />
                    <span className="text-xs font-bold text-slate-300">
                        Forçar (ignora dedup IX + apaga registo prévio)
                    </span>
                </label>
                <textarea placeholder="Motivo..." value={reason} onChange={e => setReason(e.target.value)} rows={2}
                    className="md:col-span-3 bg-slate-900/50 border border-slate-800 rounded-xl px-3 py-2 text-sm font-medium text-white resize-none" />
            </div>
            <button onClick={run} disabled={loading || !orderNumber}
                className="w-full bg-white text-black py-3 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-amber-500 hover:text-white transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCw className="w-4 h-4" />}
                Re-emitir
            </button>
            <ResultBox result={result} />
        </Section>
    );
}

function FinalizeDraftsCard({ targetUserId, notifyEmails }: { targetUserId: string; notifyEmails: string[] }) {
    const [limit, setLimit] = useState("100");
    const [dryRun, setDryRun] = useState(true);
    const [reason, setReason] = useState("");
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<JobResult | null>(null);

    const run = async () => {
        setLoading(true); setResult(null);
        try {
            const res = await fetch("/api/admin/dev-mode/finalize-drafts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetUserId, limit: Number(limit), dry_run: dryRun, reason, notify_emails: notifyEmails }),
            });
            setResult(await res.json());
        } catch (e: any) { setResult({ error: String(e) }); }
        finally { setLoading(false); }
    };

    return (
        <Section icon={<FileCheck2 className="w-5 h-5 text-violet-400" />} title="Finalizar Rascunhos em Massa" desc="Itera processed_orders, identifica faturas em draft no IX e finaliza-as.">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <label className="flex flex-col gap-1.5 text-[10px] font-black uppercase tracking-widest text-slate-500">
                    Limite
                    <input type="number" value={limit} onChange={e => setLimit(e.target.value)} min={1} max={500}
                        className="bg-slate-900/50 border border-slate-800 rounded-xl px-3 py-2 text-sm font-medium text-white" />
                </label>
                <label className="md:col-span-2 flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} className="accent-amber-500 w-4 h-4" />
                    <span className="text-xs font-bold text-slate-300">Dry-run</span>
                </label>
                <textarea placeholder="Motivo..." value={reason} onChange={e => setReason(e.target.value)} rows={2}
                    className="md:col-span-3 bg-slate-900/50 border border-slate-800 rounded-xl px-3 py-2 text-sm font-medium text-white resize-none" />
            </div>
            <button onClick={run} disabled={loading}
                className="w-full bg-white text-black py-3 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-violet-500 hover:text-white transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileCheck2 className="w-4 h-4" />}
                {dryRun ? "Simular Finalização" : "Finalizar Rascunhos"}
            </button>
            <ResultBox result={result} />
        </Section>
    );
}

function LogsCard({ targetUserId }: { targetUserId: string }) {
    const [tab, setTab] = useState<"jobs" | "errors" | "webhooks">("jobs");
    const [entries, setEntries] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [jobDetail, setJobDetail] = useState<any>(null);

    const load = async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/admin/dev-mode/logs?targetUserId=${targetUserId}&type=${tab}&limit=100`);
            const data: any = await res.json();
            setEntries(data.entries ?? []);
        } catch (e) { console.error(e); }
        finally { setLoading(false); }
    };

    useEffect(() => { load(); }, [tab, targetUserId]);

    const openJob = async (id: string) => {
        if (expanded === id) { setExpanded(null); setJobDetail(null); return; }
        setExpanded(id);
        setJobDetail(null);
        const res = await fetch(`/api/admin/dev-mode/jobs/${id}?targetUserId=${targetUserId}`);
        setJobDetail(await res.json());
    };

    return (
        <Section icon={<ScrollText className="w-5 h-5 text-slate-400" />} title="Logs Detalhados" desc="Histórico de jobs Dev Mode, erros e webhooks por conta.">
            <div className="flex gap-2 border-b border-slate-800/40 pb-3">
                {(["jobs", "errors", "webhooks"] as const).map(t => (
                    <button key={t} onClick={() => setTab(t)}
                        className={`px-4 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${tab === t ? "bg-white text-black" : "text-slate-500 hover:text-white"}`}>
                        {t}
                    </button>
                ))}
                <button onClick={load} disabled={loading} className="ml-auto px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-white">
                    {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : "↻"}
                </button>
            </div>

            {entries.length === 0 ? (
                <p className="text-slate-600 text-xs font-medium italic text-center py-8">Sem entradas.</p>
            ) : (
                <div className="space-y-2 max-h-[500px] overflow-y-auto">
                    {entries.map((e, i) => {
                        const id = e.id ?? e.webhook_id ?? String(i);
                        const isJob = tab === "jobs";
                        const ok = isJob ? e.status === "success" : (e.status ? e.status < 400 : e.state === "success");
                        return (
                            <div key={id} className="bg-slate-900/40 border border-slate-800/40 rounded-xl p-3">
                                <button onClick={() => isJob && openJob(e.id)}
                                    className="w-full flex items-center justify-between text-left">
                                    <div className="flex items-center gap-3 min-w-0">
                                        {ok ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> : <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />}
                                        <div className="min-w-0">
                                            <p className="text-xs font-bold text-slate-300 truncate">{e.type ?? e.topic} {isJob && e.summary && <span className="text-slate-500">· {e.summary.total ?? 0} order(s)</span>}</p>
                                            <p className="text-[10px] text-slate-500 font-medium flex items-center gap-2">
                                                <Calendar className="w-3 h-3" /> {e.started_at ?? e.created_at}
                                                {isJob && e.triggered_by && <span>· {e.triggered_by}</span>}
                                            </p>
                                        </div>
                                    </div>
                                    <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded ${ok ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-400"}`}>
                                        {e.status ?? e.state ?? "-"}
                                    </span>
                                </button>
                                {isJob && expanded === e.id && (
                                    <pre className="mt-3 bg-slate-950/60 rounded-lg p-3 text-[10px] font-mono whitespace-pre-wrap text-slate-400 max-h-80 overflow-y-auto">
                                        {jobDetail ? JSON.stringify(jobDetail, null, 2) : "Carregando..."}
                                    </pre>
                                )}
                                {!isJob && e.payload && (
                                    <pre className="mt-2 text-[10px] font-mono text-slate-500 truncate">{typeof e.payload === "string" ? e.payload.slice(0, 200) : JSON.stringify(e.payload).slice(0, 200)}</pre>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </Section>
    );
}
