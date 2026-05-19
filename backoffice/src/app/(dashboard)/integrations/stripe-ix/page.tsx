"use client";

export const runtime = "edge";

import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect } from "react";
import { Check, Lock, ChevronRight, CreditCard, ClipboardList, Loader2, Circle, HelpCircle, Info, ShieldCheck, Webhook, AlertTriangle, Zap, BookOpen, X, Copy, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { useUser } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import SubscriptionCard from "@/components/SubscriptionCard";
import { RIOKO_CONFIG } from "@/lib/config";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

const STRIPE_ENABLED = process.env.NEXT_PUBLIC_STRIPE_SOURCE_ENABLED === "1";
const WEBHOOK_URL = `${RIOKO_CONFIG.workerUrl.replace(/\/$/, "")}/webhooks/stripe`;
const RECOMMENDED_EVENTS = ["payment_intent.succeeded", "charge.succeeded", "charge.refunded"];

export default function StripeIXIntegration() {
    const { user: clerkUser } = useUser();
    const searchParams = useSearchParams();
    const stripeSuccess = searchParams?.get("stripe") === "success";
    const [dbUserName, setDbUserName] = useState("");
    const firstName = (dbUserName || clerkUser?.firstName || clerkUser?.fullName || "").split(" ")[0];

    const [step, setStep] = useState(1);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [userRole, setUserRole] = useState("");
    const [targetUserId, setTargetUserId] = useState("");
    const [openDiagnostic, setOpenDiagnostic] = useState<number | null>(null);
    const [copied, setCopied] = useState(false);

    // Stripe form state
    const [stripeAccountId, setStripeAccountId] = useState("");
    const [restrictedKey, setRestrictedKey] = useState("");
    const [webhookSecret, setWebhookSecret] = useState(""); // fallback path only
    const [hasStripeSaved, setHasStripeSaved] = useState(false);
    const [hasWebhookSaved, setHasWebhookSaved] = useState(false);
    const [connectionStatus, setConnectionStatus] = useState<"draft" | "active" | "paused" | "error" | "">("");
    const [stripeError, setStripeError] = useState("");
    const [installError, setInstallError] = useState("");
    const [showManualFallback, setShowManualFallback] = useState(false);

    // IX form state (only used if needsIxStep)
    const [needsIxStep, setNeedsIxStep] = useState(false);
    const [ixAccount, setIxAccount] = useState("");
    const [ixApiKey, setIxApiKey] = useState("");
    const [ixEnvironment, setIxEnvironment] = useState("production");
    const [vatIncluded, setVatIncluded] = useState(true);
    const [autoFinalize, setAutoFinalize] = useState(false);
    const [exemptionReason, setExemptionReason] = useState("M01");
    const [ixDocumentType, setIxDocumentType] = useState("invoice_receipt");
    const [ixPaymentTerm, setIxPaymentTerm] = useState(0);
    const [ixSequenceName, setIxSequenceName] = useState("");
    const [ixAuthorized, setIxAuthorized] = useState(false);
    const [ixError, setIxError] = useState("");

    // Carry-over Shopify fields (so POST /api/integrations doesn't clobber them)
    const [shopifyDomain, setShopifyDomain] = useState("");
    const [shopifyToken, setShopifyToken] = useState("");
    const [shopifyWebhookSecret, setShopifyWebhookSecret] = useState("");
    const [shopifyApiVersion, setShopifyApiVersion] = useState("2026-01");

    const exemptionOptions = [
        { value: "M01", label: "Artigo 16.º, n.º 6 do CIVA" },
        { value: "M02", label: "Artigo 6.º do Decreto-Lei n.º 198/90, de 19 de junho" },
        { value: "M04", label: "Isento artigo 13.º do CIVA" },
        { value: "M05", label: "Isento artigo 14.º do CIVA" },
        { value: "M06", label: "Isento artigo 15.º do CIVA" },
        { value: "M07", label: "Isento artigo 9.º do CIVA" },
        { value: "M08", label: "Simples: Não confere direito a dedução" },
        { value: "M09", label: "IVA – não confere direito a dedução" },
        { value: "M10", label: "Isento artigo 31.º do CIVA" },
        { value: "M11", label: "Regime especial de isenção artigo 53.º do CIVA" },
        { value: "M12", label: "Regime da margem de lucro – Agências de Viagens" },
        { value: "M13", label: "Regime da margem de lucro – Bens em segunda mão" },
        { value: "M14", label: "Regime da margem de lucro – Objetos de arte" },
        { value: "M15", label: "Regime da margem de lucro – Objetos de coleção e antiguidades" },
        { value: "M16", label: "Isento artigo 14.º do RITI" },
        { value: "M20", label: "IVA - autoliquidação" },
        { value: "M21", label: "IVA - autoliquidação (artigo 2.º, n.º 1, alínea i) do CIVA)" },
        { value: "M24", label: "IVA - autoliquidação (artigo 2.º, n.º 1, alínea m) do CIVA)" },
        { value: "M25", label: "IVA - autoliquidação (artigo 2.º, n.º 1, alínea j) do CIVA)" },
        { value: "M26", label: "IVA - autoliquidação (artigo 2.º, n.º 1, alínea l) do CIVA)" },
        { value: "M30", label: "IVA - inversão do sujeito passivo (artigo 6.º, n.º 6, alínea a) do CIVA)" },
        { value: "M31", label: "IVA - inversão do sujeito passivo (artigo 6.º, n.º 6, alínea b) do CIVA)" },
        { value: "M32", label: "IVA - inversão do sujeito passivo (artigo 6.º, n.º 6, alínea c) do CIVA)" },
        { value: "M33", label: "IVA - inversão do sujeito passivo (artigo 6.º, n.º 6, alínea e) do CIVA)" },
        { value: "M34", label: "IVA - inversão do sujeito passivo (artigo 6.º, n.º 6, alínea f) do CIVA)" },
        { value: "M35", label: "IVA - inversão do sujeito passivo (artigo 6.º, n.º 6, alínea g) do CIVA)" },
        { value: "M40", label: "IVA - autoliquidação (artigo 2.º, n.º 1, alínea n) do CIVA)" },
        { value: "M41", label: "IVA - autoliquidação (artigo 2.º, n.º 1, alínea p) do CIVA)" },
        { value: "M42", label: "IVA - autoliquidação (artigo 2.º, n.º 1, alínea q) do CIVA)" },
        { value: "M43", label: "IVA - autoliquidação (artigo 2.º, n.º 1, alínea r) do CIVA)" },
        { value: "M99", label: "Não sujeito; não tributado (ou similar)" },
    ];

    useEffect(() => {
        if (!STRIPE_ENABLED) { setLoading(false); return; }
        fetch("/api/auth/sync", { method: "POST" }).catch(console.error);

        Promise.all([
            fetch("/api/integrations").then(r => r.json()).catch(() => ({})),
            fetch("/api/integrations/stripe-source").then(r => r.json()).catch(() => ({}))
        ]).then(([integ, stripe]: any) => {
            if (integ._user_name) setDbUserName(integ._user_name);
            if (integ.shopify_domain) setShopifyDomain(integ.shopify_domain);
            if (integ.shopify_token) setShopifyToken(integ.shopify_token);
            if (integ.shopify_webhook_secret) setShopifyWebhookSecret(integ.shopify_webhook_secret);
            if (integ.shopify_api_version) setShopifyApiVersion(integ.shopify_api_version);
            if (integ.ix_account_name) setIxAccount(integ.ix_account_name);
            if (integ.ix_api_key) setIxApiKey(integ.ix_api_key);
            if (integ.ix_environment) setIxEnvironment(integ.ix_environment);
            if (integ.ix_exemption_reason) setExemptionReason(integ.ix_exemption_reason);
            if (integ.vat_included !== undefined) setVatIncluded(integ.vat_included === 1);
            if (integ.auto_finalize !== undefined) setAutoFinalize(integ.auto_finalize === 1);
            if (integ.ix_document_type) setIxDocumentType(integ.ix_document_type);
            if (integ.ix_payment_term !== undefined) setIxPaymentTerm(parseInt(String(integ.ix_payment_term)));
            if (integ.ix_sequence_name) setIxSequenceName(integ.ix_sequence_name);
            if (integ.ix_authorized !== undefined) setIxAuthorized(integ.ix_authorized === 1);
            if (integ.ix_error) setIxError(integ.ix_error);
            if (integ._viewer_role) setUserRole(integ._viewer_role);
            if (integ.user_id) setTargetUserId(integ.user_id);

            const ixOk = integ.ix_authorized === 1;
            setNeedsIxStep(!ixOk);

            const conn = stripe?.connection;
            const sCfg = conn?.source_config ?? {};
            if (sCfg.stripe_account_id) setStripeAccountId(sCfg.stripe_account_id);
            const stripeSaved = !!sCfg.stripe_account_id;
            const webhookSaved = !!sCfg.has_webhook_secret;
            setHasStripeSaved(stripeSaved);
            setHasWebhookSaved(webhookSaved);
            setConnectionStatus(conn?.status ?? "");

            // Smart resume — Stripe step is unified (creds + webhook auto-install)
            // Without IX: 1=stripe, 2=activate
            // With IX:    1=stripe, 2=ix, 3=activate
            const activateStep = ixOk ? 2 : 3;
            if (conn?.status === "active") setStep(activateStep + 1);
            else if (webhookSaved && ixOk) setStep(activateStep);
            else if (webhookSaved && !ixOk) setStep(2);
            else setStep(1);
        }).finally(() => setLoading(false));
    }, []);

    const totalSteps = needsIxStep ? 3 : 2;
    const activateStepId = totalSteps;
    const allComplete = connectionStatus === "active" && hasWebhookSaved && (!needsIxStep || ixAuthorized);

    // ─── Handlers ─────────────────────────────────────────────────────────────

    const postStripeSource = async (patch: Record<string, any>) => {
        const body: Record<string, any> = {
            stripe_account_id: stripeAccountId,
            destination_kind: "invoicexpress",
            ...patch
        };
        return fetch("/api/integrations/stripe-source", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
    };

    const handleStripeStep = async () => {
        if (!stripeAccountId.trim() || !restrictedKey.trim()) return;
        setSaving(true);
        setStripeError("");
        setInstallError("");
        try {
            // 1. Save credentials (draft)
            const saveRes = await postStripeSource({
                stripe_account_id: stripeAccountId.trim(),
                restricted_key: restrictedKey.trim(),
                status: "draft"
            });
            if (!saveRes.ok) {
                const data: any = await saveRes.json().catch(() => ({}));
                setStripeError(data.error || "Erro ao guardar credenciais.");
                return;
            }
            setHasStripeSaved(true);

            // 2. Auto-install webhook via Stripe API (server-side)
            const instRes = await fetch("/api/integrations/stripe-source/install-webhook", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ restricted_key: restrictedKey.trim() })
            });
            const instData: any = await instRes.json().catch(() => ({}));
            if (!instRes.ok) {
                const msg = instData.error || "Falha ao instalar webhook automaticamente.";
                setInstallError(`${msg}${instData.stripe_code ? ` (${instData.stripe_code})` : ""}`);
                setShowManualFallback(true);
                return; // stay on step 1, show fallback UI
            }

            setHasWebhookSaved(true);
            setStep(needsIxStep ? 2 : activateStepId);
        } catch (e: any) {
            setStripeError(`Erro de rede: ${e.message}`);
        } finally {
            setSaving(false);
        }
    };

    const handleManualSecret = async () => {
        if (!webhookSecret.trim() || !stripeAccountId) return;
        setSaving(true);
        try {
            const res = await postStripeSource({
                webhook_secret: webhookSecret.trim(),
                status: "draft"
            });
            if (!res.ok) {
                const data: any = await res.json().catch(() => ({}));
                setStripeError(data.error || "Erro ao guardar webhook secret.");
                return;
            }
            setHasWebhookSaved(true);
            setShowManualFallback(false);
            setStep(needsIxStep ? 2 : activateStepId);
        } catch (e: any) {
            setStripeError(`Erro de rede: ${e.message}`);
        } finally {
            setSaving(false);
        }
    };

    const handleIxConnect = async () => {
        if (!ixAccount || !ixApiKey) return;
        setSaving(true);
        try {
            if (ixSequenceName.trim()) {
                const seqRes = await fetch(`/api/integrations/sequences?account=${ixAccount}&apiKey=${ixApiKey}&environment=${ixEnvironment}`);
                if (seqRes.ok) {
                    const seqs = await seqRes.json() as any[];
                    const found = seqs.find(s => s.name.toLowerCase() === ixSequenceName.trim().toLowerCase());
                    if (!found) {
                        if (!confirm(`A série de faturação "${ixSequenceName}" não foi encontrada no InvoiceXpress. Desejas continuar? (O Rioko usará a série pré-definida por omissão)`)) {
                            setSaving(false);
                            return;
                        }
                    }
                }
            }
            const saveRes = await fetch("/api/integrations", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    shopify_domain: shopifyDomain, shopify_token: shopifyToken,
                    shopify_webhook_secret: shopifyWebhookSecret, shopify_api_version: shopifyApiVersion,
                    ix_account_name: ixAccount, ix_api_key: ixApiKey, ix_environment: ixEnvironment,
                    ix_exemption_reason: exemptionReason, vat_included: vatIncluded, auto_finalize: autoFinalize,
                    ix_document_type: ixDocumentType, ix_payment_term: ixPaymentTerm, ix_sequence_name: ixSequenceName
                })
            });
            if (!saveRes.ok) { alert("Erro ao guardar. Tenta novamente."); return; }

            const valRes = await fetch("/api/integrations/validate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "ix" })
            });
            const valData = await valRes.json() as any;
            setIxAuthorized(valData.isValid);
            setIxError(valData.error || "");
            if (valData.isValid) setStep(activateStepId);
        } catch (e: any) {
            alert(`Erro de rede: ${e.message}`);
        } finally {
            setSaving(false);
        }
    };

    const handleActivate = async () => {
        setSaving(true);
        try {
            const res = await postStripeSource({ status: "active" });
            if (!res.ok) {
                const data: any = await res.json().catch(() => ({}));
                setStripeError(data.error || "Erro ao ativar.");
                return;
            }
            setConnectionStatus("active");
            setStep(activateStepId + 1);
        } catch (e: any) {
            setStripeError(`Erro de rede: ${e.message}`);
        } finally {
            setSaving(false);
        }
    };

    const copyWebhookUrl = async () => {
        try {
            await navigator.clipboard.writeText(WEBHOOK_URL);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch { }
    };

    // ─── Feature-flag gate ─────────────────────────────────────────────────────

    if (!STRIPE_ENABLED) {
        return (
            <div className="max-w-3xl mx-auto py-24 space-y-8 animate-in fade-in duration-700">
                <Link href="/integrations" className="text-[10px] font-black text-sky-400 uppercase tracking-widest hover:text-white transition-colors flex items-center gap-2">
                    <ArrowLeft className="w-3 h-3" /> Voltar para Integrações
                </Link>
                <div className="glass rounded-[2.5rem] p-12 border-amber-500/20 bg-amber-500/[0.02] flex flex-col items-center text-center gap-6">
                    <div className="w-20 h-20 rounded-2xl bg-amber-500/10 ring-1 ring-amber-500/20 flex items-center justify-center">
                        <Lock className="w-10 h-10 text-amber-400" />
                    </div>
                    <div className="space-y-2">
                        <h1 className="text-2xl font-black tracking-tight">Stripe-as-source está desativado</h1>
                        <p className="text-slate-400 text-sm max-w-md">A integração Stripe → InvoiceXpress está em pré-acesso. Contacte o administrador para ativar a flag <code className="bg-slate-900 px-2 py-0.5 rounded text-amber-300">NEXT_PUBLIC_STRIPE_SOURCE_ENABLED</code>.</p>
                    </div>
                </div>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="min-h-[60vh] flex items-center justify-center">
                <Loader2 className="w-12 h-12 text-accent-blue animate-spin opacity-50" />
            </div>
        );
    }

    // ─── StatusBadge ──────────────────────────────────────────────────────────

    const StatusBadge = ({ isAuthorized, errorMsg, stepId, flagName }: { isAuthorized: boolean; errorMsg?: string; stepId: number; flagName?: string }) => {
        const isHiper = userRole === "hiperadmin" || userRole === "superadmin";
        const isOpen = openDiagnostic === stepId;
        const [isHovered, setIsHovered] = useState(false);
        const [showConfirm, setShowConfirm] = useState(false);

        const handleManualForce = async (e: React.MouseEvent) => {
            e.stopPropagation();
            if (!showConfirm) { setShowConfirm(true); return; }
            if (!flagName) return;
            setSaving(true);
            try {
                const res = await fetch("/api/admin/client-rules", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ targetUserId, flag: flagName, value: 1 })
                });
                if (res.ok) {
                    if (flagName === "ix_authorized") setIxAuthorized(true);
                    setOpenDiagnostic(null);
                } else alert("Erro ao forçar autorização.");
            } catch (e: any) { alert(e.message); } finally { setSaving(false); setShowConfirm(false); }
        };

        const showPanel = isOpen || isHovered;

        return (
            <div className="relative" onMouseEnter={() => setIsHovered(true)} onMouseLeave={() => setIsHovered(false)}>
                <button
                    onClick={(e) => { e.stopPropagation(); setOpenDiagnostic(isOpen ? null : stepId); setShowConfirm(false); }}
                    className={cn(
                        "px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-[0.15em] border flex items-center gap-2 transition-all active:scale-95",
                        isAuthorized ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" : "bg-amber-500/10 text-amber-500 border-amber-500/20 hover:bg-amber-500/20",
                        isOpen && "ring-2 ring-amber-500/30"
                    )}
                >
                    {isAuthorized ? "Autorizado" : "Pendente"}
                    {!isAuthorized && <HelpCircle className={cn("w-3 h-3 cursor-help transition-transform", isOpen && "rotate-180")} />}
                </button>
                <AnimatePresence>
                    {!isAuthorized && showPanel && (
                        <motion.div
                            initial={{ opacity: 0, y: 10, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.95 }}
                            className="absolute bottom-full left-1/2 -translate-x-1/2 mb-4 w-80 p-6 bg-slate-900 border-2 border-amber-500/20 rounded-[2rem] shadow-[0_20px_60px_rgba(0,0,0,0.9)] z-[100] backdrop-blur-3xl pointer-events-auto"
                        >
                            <div className="flex items-center justify-between mb-4">
                                <div className="flex items-center gap-3 text-amber-400">
                                    <div className="bg-amber-400/10 p-2 rounded-xl ring-1 ring-amber-400/20"><Info className="w-5 h-5" /></div>
                                    <div className="flex flex-col text-left">
                                        <p className="text-[10px] font-black uppercase tracking-[0.2em] leading-none">Diagnóstico</p>
                                        <p className="text-[9px] font-bold text-amber-500/60 uppercase mt-1">Rioko Engine</p>
                                    </div>
                                </div>
                                {isOpen && <button onClick={() => setOpenDiagnostic(null)} className="p-1 hover:bg-white/5 rounded-lg text-slate-500 transition-colors"><X className="w-4 h-4" /></button>}
                            </div>
                            <div className="bg-black/40 rounded-[1.25rem] p-4 border border-white/5 mb-4">
                                <p className="text-[13px] text-amber-50/90 font-bold leading-relaxed text-left">{errorMsg || "A aguardar verificação técnica..."}</p>
                            </div>
                            {isHiper && isOpen && flagName && (
                                <div className="space-y-2">
                                    <button onClick={handleManualForce} disabled={saving} className={cn("w-full py-3 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all flex items-center justify-center gap-2", showConfirm ? "bg-rose-500 text-white hover:bg-rose-600 animate-pulse" : "bg-amber-500 text-black hover:bg-amber-400")}>
                                        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />}
                                        {showConfirm ? "Tens a certeza? Clica para confirmar" : "Forçar Autorização"}
                                    </button>
                                    {showConfirm && <button onClick={() => setShowConfirm(false)} className="w-full text-[9px] font-bold text-slate-500 uppercase tracking-widest hover:text-white transition-colors py-1">Cancelar</button>}
                                </div>
                            )}
                            <div className="absolute -bottom-2.5 left-1/2 -translate-x-1/2 w-5 h-5 bg-slate-900 rotate-45 border-r-2 border-b-2 border-amber-500/10" />
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        );
    };

    // ─── Step definitions ──────────────────────────────────────────────────────

    type StepDef = {
        id: number;
        title: string;
        description: string;
        icon: any;
        isAuthorized: boolean;
        errorMsg?: string;
        flagName?: string;
        kind: "stripe" | "ix" | "activate";
    };

    const steps: StepDef[] = [
        {
            id: 1, title: "Passo 1: Stripe",
            description: "Ligue a sua conta Stripe — webhook instalado automaticamente.",
            icon: CreditCard, isAuthorized: hasStripeSaved && hasWebhookSaved,
            errorMsg: stripeError || installError, kind: "stripe"
        },
        ...(needsIxStep ? [{
            id: 2, title: "Passo 2: InvoiceXpress",
            description: "Introduza os detalhes da sua conta InvoiceXpress para emitir faturas.",
            icon: ClipboardList, isAuthorized: ixAuthorized, errorMsg: ixError, flagName: "ix_authorized", kind: "ix" as const
        }] : []),
        {
            id: activateStepId, title: `Passo ${activateStepId}: Ativar Integração`,
            description: "Confirme e ative a sincronização Stripe → InvoiceXpress.",
            icon: Zap, isAuthorized: connectionStatus === "active", kind: "activate"
        }
    ];

    return (
        <div className="space-y-12 animate-in fade-in duration-1000 slide-in-from-bottom-4">
            <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-8">
                <div className="space-y-2">
                    <Link href="/integrations" className="text-[10px] font-black text-sky-400 uppercase tracking-widest hover:text-white transition-colors flex items-center gap-2 mb-4">
                        <ArrowLeft className="w-3 h-3" /> Voltar para Integrações
                    </Link>
                    <h1 className="text-5xl font-black tracking-tight bg-gradient-to-r from-white via-white to-slate-500 bg-clip-text text-transparent">
                        Stripe + InvoiceXpress
                    </h1>
                    <p className="text-slate-400 font-semibold tracking-wide flex items-center gap-2">
                        Rioko 2.0 Engine <span className="w-1 h-1 rounded-full bg-slate-600" /> Configuração de Automação Fiscal.
                    </p>
                </div>
                <div className="flex items-center gap-5 glass px-5 py-3 rounded-2xl border-slate-800/50">
                    <div className="flex -space-x-2.5">
                        <div className={cn("h-9 w-9 rounded-full ring-4 ring-slate-950 flex items-center justify-center border", hasStripeSaved ? "bg-indigo-500/10 border-indigo-500/30" : "bg-slate-800/50 border-slate-700/30")}>
                            <CreditCard className={cn("w-4 h-4", hasStripeSaved ? "text-indigo-400" : "text-slate-600")} />
                        </div>
                        <div className={cn("h-9 w-9 rounded-full ring-4 ring-slate-950 flex items-center justify-center border", hasWebhookSaved ? "bg-violet-500/10 border-violet-500/30" : "bg-slate-800/50 border-slate-700/30")}>
                            <Webhook className={cn("w-4 h-4", hasWebhookSaved ? "text-violet-400" : "text-slate-600")} />
                        </div>
                        <div className={cn("h-9 w-9 rounded-full ring-4 ring-slate-950 flex items-center justify-center border", ixAuthorized ? "bg-blue-500/10 border-blue-500/30" : "bg-slate-800/50 border-slate-700/30")}>
                            <ClipboardList className={cn("w-4 h-4", ixAuthorized ? "text-blue-400" : "text-slate-600")} />
                        </div>
                    </div>
                    <div className="flex flex-col">
                        <span className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">Estado da Sincronização</span>
                        <span className={cn("text-xs font-bold flex items-center gap-1.5", allComplete ? "text-emerald-400" : "text-slate-500 animate-pulse")}>
                            <span className={cn("w-1.5 h-1.5 rounded-full", allComplete ? "bg-emerald-400 animate-pulse" : "bg-slate-700")} />
                            {allComplete ? "Tempo Real ATIVO" : "A aguardar ligação..."}
                        </span>
                    </div>
                </div>
            </div>

            <SubscriptionCard onSuccess={stripeSuccess} />

            <div className="grid gap-8">
                {steps.map((s) => {
                    const isActive = step === s.id;
                    const isComplete = step > s.id;
                    const isLocked = step < s.id;
                    const StepIcon = s.icon;
                    return (
                        <motion.div key={s.id} initial={false} animate={{ scale: isActive ? 1.01 : 1, opacity: isLocked ? 0.35 : 1, y: isActive ? -4 : 0 }}
                            className={cn("glass rounded-[2rem] overflow-visible relative group transition-all duration-700", isActive && "border-accent-blue/40 shadow-[0_20px_50px_rgba(0,0,0,0.5),0_0_30px_rgba(56,189,248,0.1)]", isComplete && s.isAuthorized && "border-emerald-500/30 bg-emerald-500/[0.02]", isComplete && !s.isAuthorized && "border-amber-500/30 bg-amber-500/[0.02]", isLocked && "grayscale scale-[0.98] !overflow-hidden")}
                        >
                            <div className="p-10 flex flex-col lg:flex-row items-start lg:items-center gap-10">
                                <div className={cn("w-20 h-20 rounded-2xl flex items-center justify-center transition-all duration-700 shrink-0 shadow-inner p-1", isActive ? "bg-accent-blue/20 text-accent-blue ring-1 ring-accent-blue/30" : isComplete ? (s.isAuthorized ? "bg-emerald-500/20 text-emerald-500 ring-1 ring-emerald-500/30" : "bg-amber-500/10 text-amber-500 ring-1 ring-amber-500/30") : "bg-slate-900/50 text-slate-700 ring-1 ring-slate-800")}>
                                    {isComplete ? (s.isAuthorized ? <Check className="w-10 h-10 stroke-[3]" /> : <Circle className="w-10 h-10 stroke-[4] text-amber-500" />) : (isLocked ? <Lock className="w-8 h-8 opacity-30" /> : <StepIcon className="w-10 h-10 stroke-[1.5]" />)}
                                </div>
                                <div className="flex-1 space-y-2">
                                    <div className="flex items-center gap-4">
                                        <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2.5">{s.title}</h2>
                                        {(isComplete || isActive) && <StatusBadge isAuthorized={s.isAuthorized} errorMsg={s.errorMsg} stepId={s.id} flagName={s.flagName} />}
                                        {isActive && <div className="h-1.5 w-1.5 rounded-full bg-accent-blue animate-ping" />}
                                    </div>
                                    <p className="text-slate-400 font-medium leading-relaxed max-w-xl">{s.description}</p>
                                </div>
                                <div className="flex items-center gap-10 w-full lg:w-auto">
                                    {isComplete && <button onClick={() => setStep(s.id)} className="ml-auto bg-slate-800/50 hover:bg-slate-800 text-slate-300 px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all border border-slate-700/50">Atualizar</button>}
                                </div>
                            </div>

                            <motion.div animate={{ height: isActive ? "auto" : 0 }} className="overflow-hidden bg-slate-950/40 border-t border-slate-800/30">
                                {isActive && (
                                    <div className="p-10 pt-8 animate-in zoom-in-95 duration-700">
                                        {s.kind === "stripe" && (
                                            <div className="grid md:grid-cols-2 gap-8">
                                                <div className="md:col-span-2 flex items-start gap-4 bg-indigo-500/5 border border-indigo-500/20 rounded-2xl px-6 py-4">
                                                    <Info className="w-5 h-5 text-indigo-400 shrink-0 mt-0.5" />
                                                    <div>
                                                        <p className="text-sm font-bold text-indigo-300">Como criar a Restricted Key</p>
                                                        <ol className="text-[11px] text-slate-400 mt-2 leading-relaxed list-decimal pl-4 space-y-1">
                                                            <li>Stripe Dashboard → <span className="text-indigo-300 font-semibold">Developers → API keys → Restricted keys → Create restricted key</span>.</li>
                                                            <li>Permissões: <code className="bg-slate-800 px-1 rounded text-indigo-200">Webhook Endpoints: Write</code>. Tudo o resto: None.</li>
                                                            <li>Copie a chave (começa por <code className="bg-slate-800 px-1 rounded">rk_live_</code> ou <code className="bg-slate-800 px-1 rounded">rk_test_</code>) e cole abaixo. O Rioko criará o webhook automaticamente.</li>
                                                        </ol>
                                                    </div>
                                                </div>

                                                <div className="space-y-3">
                                                    <div className="flex items-center justify-between ml-1">
                                                        <label className="text-[10px] text-slate-500 font-black uppercase tracking-[0.2em] flex items-center gap-2"><span className="w-1 h-1 rounded-full bg-accent-blue" />Stripe Account ID</label>
                                                        <a href="/help#stripe-account-id" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[9px] font-black text-slate-600 uppercase tracking-widest hover:text-rose-400 transition-colors"><BookOpen className="w-3 h-3" />Onde Encontrar</a>
                                                    </div>
                                                    <input type="text" value={stripeAccountId} onChange={(e) => setStripeAccountId(e.target.value)} placeholder="acct_xxxxxxxxxxxxxxxxxx" className="w-full bg-slate-950/50 border border-slate-800/80 rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent-blue/20 focus:border-accent-blue outline-none transition-all placeholder:text-slate-800" />
                                                </div>
                                                <div className="space-y-3">
                                                    <div className="flex items-center justify-between ml-1">
                                                        <label className="text-[10px] text-slate-500 font-black uppercase tracking-[0.2em] flex items-center gap-2"><span className="w-1 h-1 rounded-full bg-accent-blue" />Restricted Key</label>
                                                        <a href="/help#stripe-restricted-key" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[9px] font-black text-slate-600 uppercase tracking-widest hover:text-rose-400 transition-colors"><BookOpen className="w-3 h-3" />O que é?</a>
                                                    </div>
                                                    <input type="password" value={restrictedKey} onChange={(e) => setRestrictedKey(e.target.value)} placeholder="rk_live_xxxxxxxxxxxxxxxx" className="w-full bg-slate-950/50 border border-slate-800/80 rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent-blue/20 focus:border-accent-blue outline-none transition-all placeholder:text-slate-800" />
                                                    <p className="text-[10px] text-slate-600 font-medium mt-2 ml-1 uppercase tracking-wider">Scope obrigatório: <code className="text-indigo-300">Webhook Endpoints: Write</code></p>
                                                </div>

                                                <div className="md:col-span-2 pt-4">
                                                    <button onClick={handleStripeStep} disabled={saving || !stripeAccountId.trim() || !restrictedKey.trim()} className="w-full py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-white text-black hover:bg-accent-blue hover:text-white disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed">
                                                        {saving ? <><Loader2 className="w-5 h-5 animate-spin" /> A instalar webhook...</> : <><Webhook className="w-4 h-4" /> Conectar Stripe + Instalar Webhook</>}
                                                    </button>
                                                    {installError && (
                                                        <p className="text-[11px] text-rose-400 font-bold text-center mt-4">{installError}</p>
                                                    )}
                                                </div>

                                                {/* Fallback: manual paste of signing secret if auto-install failed */}
                                                <AnimatePresence>
                                                    {showManualFallback && (
                                                        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="md:col-span-2 overflow-hidden">
                                                            <div className="mt-4 p-6 rounded-2xl bg-amber-500/5 border border-amber-500/20 space-y-4">
                                                                <div className="flex items-start gap-3">
                                                                    <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                                                                    <div>
                                                                        <p className="text-sm font-bold text-amber-300">Fallback manual</p>
                                                                        <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">A instalação automática falhou. Crie o webhook manualmente no Stripe Dashboard usando o URL abaixo e cole o Signing Secret.</p>
                                                                    </div>
                                                                </div>
                                                                <div className="space-y-2">
                                                                    <label className="text-[10px] text-slate-500 font-black uppercase tracking-[0.2em] ml-1">Endpoint URL</label>
                                                                    <div className="flex gap-3">
                                                                        <input type="text" readOnly value={WEBHOOK_URL} className="flex-1 bg-slate-950/50 border border-slate-800/80 rounded-2xl px-5 py-3 text-xs font-mono text-violet-200 outline-none" onClick={(e) => (e.target as HTMLInputElement).select()} />
                                                                        <button onClick={copyWebhookUrl} className="px-4 py-3 rounded-2xl bg-violet-500/10 text-violet-300 border border-violet-500/20 hover:bg-violet-500/20 transition-all font-black text-[10px] uppercase tracking-widest flex items-center gap-2">
                                                                            {copied ? <><Check className="w-3 h-3" />Copiado</> : <><Copy className="w-3 h-3" />Copiar</>}
                                                                        </button>
                                                                    </div>
                                                                    <p className="text-[10px] text-slate-600 ml-1 mt-1">Eventos a selecionar: <code className="text-violet-300">{RECOMMENDED_EVENTS.join(", ")}</code></p>
                                                                </div>
                                                                <div className="space-y-2">
                                                                    <label className="text-[10px] text-slate-500 font-black uppercase tracking-[0.2em] ml-1">Signing Secret</label>
                                                                    <input type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder="whsec_xxxxxxxxxxxxxxxxxxxxxxxxxxxx" className="w-full bg-slate-950/50 border border-slate-800/80 rounded-2xl px-5 py-3 text-xs font-medium focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 outline-none transition-all placeholder:text-slate-800" />
                                                                </div>
                                                                <button onClick={handleManualSecret} disabled={saving || !webhookSecret.trim()} className="w-full py-3 rounded-xl font-black text-[10px] uppercase tracking-widest flex items-center justify-center gap-2 bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-all disabled:opacity-30 disabled:cursor-not-allowed">
                                                                    {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                                                    Guardar Signing Secret
                                                                </button>
                                                            </div>
                                                        </motion.div>
                                                    )}
                                                </AnimatePresence>
                                            </div>
                                        )}

                                        {s.kind === "ix" && (
                                            <div className="grid md:grid-cols-2 gap-8">
                                                <div className="space-y-3">
                                                    <label className="text-[10px] text-slate-500 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent-blue" />Nome da Conta</label>
                                                    <input type="text" value={ixAccount} onChange={(e) => setIxAccount(e.target.value)} placeholder="ultramegasonico" className="w-full bg-slate-950/50 border border-slate-800/80 rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent-blue/20 focus:border-accent-blue outline-none transition-all placeholder:text-slate-800" />
                                                </div>
                                                <div className="space-y-3">
                                                    <label className="text-[10px] text-slate-500 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent-blue" />Chave API</label>
                                                    <input type="password" value={ixApiKey} onChange={(e) => setIxApiKey(e.target.value)} placeholder="••••••••••••••••••••••••" className="w-full bg-slate-950/50 border border-slate-800/80 rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent-blue/20 focus:border-accent-blue outline-none transition-all placeholder:text-slate-800" />
                                                </div>
                                                <div className="space-y-3">
                                                    <label className="text-[10px] text-slate-500 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent-blue" />Ambiente</label>
                                                    <input type="text" value={ixEnvironment} onChange={(e) => setIxEnvironment(e.target.value)} placeholder="production ou sandbox" className="w-full bg-slate-950/50 border border-slate-800/80 rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent-blue/20 focus:border-accent-blue outline-none transition-all placeholder:text-slate-800" />
                                                </div>
                                                <div className="space-y-3">
                                                    <label className="text-[10px] text-slate-500 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-violet-400" />Série de Faturação</label>
                                                    <input type="text" value={ixSequenceName} onChange={(e) => setIxSequenceName(e.target.value)} placeholder="Vazio = série pré-definida" className="w-full bg-slate-950/50 border border-slate-800/80 rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 outline-none transition-all placeholder:text-slate-800" />
                                                </div>

                                                <div className="glass p-6 rounded-2xl flex items-center justify-between border-slate-800/50">
                                                    <div>
                                                        <h3 className="font-bold text-sm">IVA Incluído</h3>
                                                        <p className="text-[10px] text-slate-500 font-medium mt-1 uppercase tracking-wider">{vatIncluded ? "Preços já incluem IVA" : "Soma 23% sobre o preço"}</p>
                                                    </div>
                                                    <button onClick={() => setVatIncluded(!vatIncluded)} className={cn("w-12 h-6 rounded-full transition-all duration-500 relative ring-1 ring-inset ring-black/20", vatIncluded ? "bg-emerald-500" : "bg-slate-800")}><div className={cn("absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-500", vatIncluded ? "left-7" : "left-1")} /></button>
                                                </div>
                                                <div className="glass p-6 rounded-2xl flex items-center justify-between border-slate-800/50">
                                                    <div>
                                                        <h3 className="font-bold text-sm">Auto Finalizar</h3>
                                                        <p className="text-[10px] text-slate-500 font-medium mt-1 uppercase tracking-wider">Emitir documentos imediatamente</p>
                                                    </div>
                                                    <button onClick={() => setAutoFinalize(!autoFinalize)} className={cn("w-12 h-6 rounded-full transition-all duration-500 relative ring-1 ring-inset ring-black/20", autoFinalize ? "bg-accent-blue" : "bg-slate-800")}><div className={cn("absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-500", autoFinalize ? "left-7" : "left-1")} /></button>
                                                </div>

                                                <div className="md:col-span-2 glass p-6 rounded-2xl border-slate-800/50 space-y-6">
                                                    <div className="flex items-center justify-between">
                                                        <div>
                                                            <h3 className="font-bold text-sm">Tipo de Fatura</h3>
                                                            <p className="text-[10px] text-slate-500 font-medium mt-1 uppercase tracking-wider">{ixDocumentType === "invoice_receipt" ? "Fatura-Recibo (paga no momento)" : "Fatura (pagamento posterior)"}</p>
                                                        </div>
                                                        <div className="flex bg-slate-900/80 p-1 rounded-xl border border-slate-800">
                                                            <button onClick={() => setIxDocumentType("invoice_receipt")} className={cn("px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all", ixDocumentType === "invoice_receipt" ? "bg-white text-black shadow-lg" : "text-slate-500 hover:text-white")}>Fatura-Recibo</button>
                                                            <button onClick={() => setIxDocumentType("invoice")} className={cn("px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all", ixDocumentType === "invoice" ? "bg-white text-black shadow-lg" : "text-slate-500 hover:text-white")}>Fatura</button>
                                                        </div>
                                                    </div>
                                                    <AnimatePresence>
                                                        {ixDocumentType === "invoice" && (
                                                            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="pt-4 border-t border-slate-800/50">
                                                                <div className="flex items-center justify-between gap-4">
                                                                    <div className="flex-1"><h4 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-1">Prazo de Pagamento (Dias)</h4></div>
                                                                    <div className="w-32"><input type="number" value={ixPaymentTerm} onChange={(e) => setIxPaymentTerm(parseInt(e.target.value) || 0)} className="w-full bg-slate-950/50 border border-slate-800 rounded-xl px-4 py-2 text-sm font-bold text-center focus:ring-2 focus:ring-accent-blue/20 outline-none" /></div>
                                                                </div>
                                                            </motion.div>
                                                        )}
                                                    </AnimatePresence>
                                                </div>

                                                <div className="md:col-span-2 glass p-8 rounded-[2rem] border-slate-800/50 space-y-4">
                                                    <div className="flex items-center gap-3 mb-2"><div className="p-2 bg-amber-500/10 rounded-xl"><Info className="w-4 h-4 text-amber-500" /></div><h3 className="font-bold text-sm tracking-tight">Razão de Isenção (IVA 0%)</h3></div>
                                                    <select value={exemptionReason} onChange={(e) => setExemptionReason(e.target.value)} className="w-full bg-slate-900/80 border border-slate-800 rounded-2xl px-6 py-4 text-sm font-bold focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 outline-none transition-all cursor-pointer text-slate-200">
                                                        {exemptionOptions.map((opt) => (<option key={opt.value} value={opt.value} className="bg-slate-900">{opt.value} - {opt.label}</option>))}
                                                    </select>
                                                </div>

                                                <div className="md:col-span-2 pt-4 flex items-center gap-4">
                                                    <button onClick={() => setStep(step - 1)} className="text-slate-500 hover:text-white text-[10px] font-black uppercase tracking-widest transition-all px-4">Voltar</button>
                                                    <button onClick={handleIxConnect} disabled={saving || !ixAccount || !ixApiKey} className="flex-1 py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-white text-black hover:bg-accent-blue hover:text-white disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed">
                                                        {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <>Verificar Ligação <ChevronRight className="w-4 h-4" /></>}
                                                    </button>
                                                </div>
                                            </div>
                                        )}

                                        {s.kind === "activate" && (
                                            <div className="space-y-8">
                                                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                                    <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-emerald-500/5 border-emerald-500/20">
                                                        <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-emerald-500/10"><CreditCard className="w-4 h-4 text-emerald-400" /></div>
                                                        <div><p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Stripe</p><p className="text-xs font-bold text-emerald-400">Configurado</p></div>
                                                        <Check className="w-4 h-4 text-emerald-400 ml-auto" />
                                                    </div>
                                                    <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-emerald-500/5 border-emerald-500/20">
                                                        <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-emerald-500/10"><Webhook className="w-4 h-4 text-emerald-400" /></div>
                                                        <div><p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Webhook</p><p className="text-xs font-bold text-emerald-400">Instalado</p></div>
                                                        <Check className="w-4 h-4 text-emerald-400 ml-auto" />
                                                    </div>
                                                    <div className={cn("flex items-center gap-3 px-5 py-4 rounded-2xl border", ixAuthorized ? "bg-emerald-500/5 border-emerald-500/20" : "bg-amber-500/5 border-amber-500/20")}>
                                                        <div className={cn("w-8 h-8 rounded-xl flex items-center justify-center shrink-0", ixAuthorized ? "bg-emerald-500/10" : "bg-amber-500/10")}><ClipboardList className={cn("w-4 h-4", ixAuthorized ? "text-emerald-400" : "text-amber-400")} /></div>
                                                        <div><p className="text-[10px] font-black uppercase tracking-wider text-slate-500">InvoiceXpress</p><p className={cn("text-xs font-bold", ixAuthorized ? "text-emerald-400" : "text-amber-400")}>{ixAuthorized ? "Autorizado" : "Pendente"}</p></div>
                                                        {ixAuthorized && <Check className="w-4 h-4 text-emerald-400 ml-auto" />}
                                                    </div>
                                                </div>

                                                <div className="flex items-start gap-4 bg-slate-900/50 border border-slate-700/40 rounded-2xl px-6 py-4">
                                                    <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                                                    <p className="text-[11px] text-slate-400 leading-relaxed">Ao marcar como ativo, o Rioko começa a processar webhooks Stripe e a emitir faturas InvoiceXpress em tempo real. Pode pausar a qualquer momento.</p>
                                                </div>

                                                <button onClick={handleActivate} disabled={saving || !hasWebhookSaved || (needsIxStep && !ixAuthorized)} className="w-full py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-white text-black hover:bg-emerald-400 hover:text-white disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed">
                                                    {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Zap className="w-5 h-5" /> Marcar como Ativo</>}
                                                </button>

                                                {stripeError && <p className="text-[11px] text-rose-400 font-bold text-center">{stripeError}</p>}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </motion.div>
                        </motion.div>
                    );
                })}

                {allComplete && (
                    <motion.div initial={{ opacity: 0, y: 20, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.6, ease: "easeOut" }} className="rounded-[2.5rem] p-1 shadow-2xl bg-gradient-to-r from-emerald-500/40 via-emerald-400/10 to-emerald-500/40 shadow-[0_0_60px_rgba(16,185,129,0.25)]">
                        <div className="bg-slate-950 rounded-[2.3rem] p-10 flex flex-col gap-8 border border-white/5">
                            <div className="flex flex-col md:flex-row items-center justify-between gap-8">
                                <div className="flex items-center gap-8">
                                    <div className="w-20 h-20 rounded-[1.8rem] flex items-center justify-center bg-emerald-500/20 ring-2 ring-emerald-400 ring-offset-4 ring-offset-slate-950"><ShieldCheck className="w-10 h-10 text-emerald-400" /></div>
                                    <div className="space-y-1"><h3 className="text-2xl font-black tracking-tight">Integração Concluída</h3><p className="text-slate-500 font-bold uppercase tracking-widest text-[10px]">Stripe → InvoiceXpress online no Rioko 2.0</p></div>
                                </div>
                                <div className="px-6 py-3 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] border bg-emerald-500/10 text-emerald-400 border-emerald-500/30">ONLINE • REAL-TIME</div>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-white/5 pt-8">
                                <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-emerald-500/5 border-emerald-500/20"><div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-emerald-500/10"><CreditCard className="w-4 h-4 text-emerald-400" /></div><div><p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Stripe</p><p className="text-xs font-bold text-emerald-400">Ativo</p></div><Check className="w-4 h-4 text-emerald-400 ml-auto" /></div>
                                <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-emerald-500/5 border-emerald-500/20"><div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-emerald-500/10"><Webhook className="w-4 h-4 text-emerald-400" /></div><div><p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Webhook</p><p className="text-xs font-bold text-emerald-400">Registado</p></div><Check className="w-4 h-4 text-emerald-400 ml-auto" /></div>
                                <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-emerald-500/5 border-emerald-500/20"><div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-emerald-500/10"><ClipboardList className="w-4 h-4 text-emerald-400" /></div><div><p className="text-[10px] font-black uppercase tracking-wider text-slate-500">InvoiceXpress</p><p className="text-xs font-bold text-emerald-400">Autorizado</p></div><Check className="w-4 h-4 text-emerald-400 ml-auto" /></div>
                            </div>
                        </div>
                    </motion.div>
                )}
            </div>

            <div className="pt-12 text-center">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-900 border border-slate-800">
                    <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">D1 DATABASE LIGADA</span>
                </div>
            </div>
        </div>
    );
}
