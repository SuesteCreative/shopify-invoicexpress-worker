"use client";

export const runtime = "edge";

import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect } from "react";
import { Check, Lock, ChevronRight, CreditCard, ClipboardList, Loader2, Circle, HelpCircle, Info, ShieldCheck, Webhook, AlertTriangle, Zap, BookOpen, X, Copy, ArrowLeft } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
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
    const t = useTranslations("stripeIxSetup");
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
    const [ixRetentionEnabled, setIxRetentionEnabled] = useState(false);
    const [ixRetention, setIxRetention] = useState<number>(16.5);
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
        { value: "M09", label: "IVA – não confere direito a dedução" },
        { value: "M10", label: "Regime especial de isenção artigo 53.º do CIVA" },
        { value: "M11", label: "Regime particular do tabaco" },
        { value: "M12", label: "Regime da margem de lucro – Agências de Viagens" },
        { value: "M13", label: "Regime da margem de lucro – Bens em segunda mão" },
        { value: "M14", label: "Regime da margem de lucro – Objetos de arte" },
        { value: "M15", label: "Regime da margem de lucro – Objetos de coleção e antiguidades" },
        { value: "M16", label: "Isento artigo 14.º do RITI" },
        { value: "M19", label: "Outras isenções" },
        { value: "M20", label: "IVA - regime forfetário" },
        { value: "M21", label: "IVA – não confere direito à dedução (ou expressão similar)" },
        { value: "M25", label: "Mercadorias à consignação" },
        { value: "M26", label: "Isenção de IVA com direito à dedução no cabaz alimentar" },
        { value: "M30", label: "IVA - autoliquidação (artigo 2.º, n.º 1, alínea i) do CIVA)" },
        { value: "M31", label: "IVA - autoliquidação (artigo 2.º, n.º 1, alínea j) do CIVA)" },
        { value: "M32", label: "IVA - autoliquidação (artigo 2.º, n.º 1, alínea l) do CIVA)" },
        { value: "M33", label: "IVA - autoliquidação (artigo 2.º, n.º 1, alínea m) do CIVA)" },
        { value: "M34", label: "IVA - autoliquidação (artigo 2.º, n.º 1, alínea n) do CIVA)" },
        { value: "M40", label: "IVA - autoliquidação (artigo 6.º, n.º 6, alínea a) do CIVA, a contrário)" },
        { value: "M41", label: "IVA - autoliquidação (artigo 8.º, n.º 3 do RITI)" },
        { value: "M42", label: "IVA - autoliquidação (Decreto-Lei n.º 21/2007, de 29 de janeiro)" },
        { value: "M43", label: "IVA - autoliquidação (Decreto-Lei n.º 362/99, de 16 de setembro)" },
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
            if (integ.ix_retention_enabled !== undefined) setIxRetentionEnabled(integ.ix_retention_enabled === 1);
            if (integ.ix_retention !== undefined && integ.ix_retention !== null) {
                const v = parseFloat(String(integ.ix_retention));
                if (Number.isFinite(v)) setIxRetention(v);
            }
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
                setStripeError(data.error || t("errorSaveCreds"));
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
                const msg = instData.error || t("errorInstallWebhook");
                setInstallError(`${msg}${instData.stripe_code ? ` (${instData.stripe_code})` : ""}`);
                setShowManualFallback(true);
                return; // stay on step 1, show fallback UI
            }

            setHasWebhookSaved(true);
            setStep(needsIxStep ? 2 : activateStepId);
        } catch (e: any) {
            setStripeError(t("errorNetwork", { message: e.message }));
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
                setStripeError(data.error || t("errorSaveWebhookSecret"));
                return;
            }
            setHasWebhookSaved(true);
            setShowManualFallback(false);
            setStep(needsIxStep ? 2 : activateStepId);
        } catch (e: any) {
            setStripeError(t("errorNetwork", { message: e.message }));
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
                        if (!confirm(t("confirmSequenceMissing", { name: ixSequenceName }))) {
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
                    ix_document_type: ixDocumentType, ix_payment_term: ixPaymentTerm, ix_sequence_name: ixSequenceName,
                    ix_retention_enabled: ixRetentionEnabled ? 1 : 0, ix_retention: ixRetention
                })
            });
            if (!saveRes.ok) { alert(t("alertSaveError")); return; }

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
            alert(t("errorNetwork", { message: e.message }));
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
                setStripeError(data.error || t("errorActivate"));
                return;
            }
            setConnectionStatus("active");
            setStep(activateStepId + 1);
        } catch (e: any) {
            setStripeError(t("errorNetwork", { message: e.message }));
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
                <Link href="/integrations" className="text-[10px] font-black text-accent uppercase tracking-widest hover:text-fg transition-colors flex items-center gap-2">
                    <ArrowLeft className="w-3 h-3" /> {t("backToIntegrations")}
                </Link>
                <div className="glass rounded-[2.5rem] p-6 sm:p-12 border-[rgba(245,158,11,0.20)] bg-[rgba(245,158,11,0.04)] flex flex-col items-center text-center gap-6">
                    <div className="w-20 h-20 rounded-2xl bg-[rgba(245,158,11,0.10)] ring-1 ring-[rgba(245,158,11,0.20)] flex items-center justify-center">
                        <Lock className="w-10 h-10 text-soon" />
                    </div>
                    <div className="space-y-2">
                        <h1 className="text-2xl font-black tracking-tight">{t("disabledTitle")}</h1>
                        <p className="text-fg-60 text-sm max-w-md" dangerouslySetInnerHTML={{ __html: t("disabledBody").replace(/<code>/g, '<code class="bg-surface-2 px-2 py-0.5 rounded text-soon">') }} />
                    </div>
                </div>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="min-h-[60vh] flex items-center justify-center">
                <Loader2 className="w-12 h-12 text-accent animate-spin opacity-50" />
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
                } else alert(t("alertForceAuthError"));
            } catch (e: any) { alert(e.message); } finally { setSaving(false); setShowConfirm(false); }
        };

        const showPanel = isOpen || isHovered;

        return (
            <div className="relative" onMouseEnter={() => setIsHovered(true)} onMouseLeave={() => setIsHovered(false)}>
                <button
                    onClick={(e) => { e.stopPropagation(); setOpenDiagnostic(isOpen ? null : stepId); setShowConfirm(false); }}
                    className={cn(
                        "px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-[0.15em] border flex items-center gap-2 transition-all active:scale-95",
                        isAuthorized ? "bg-[rgba(94,234,212,0.10)] text-accent-hot border-[rgba(94,234,212,0.20)]" : "bg-[rgba(245,158,11,0.10)] text-soon border-[rgba(245,158,11,0.20)] hover:bg-[rgba(245,158,11,0.20)]",
                        isOpen && "ring-2 ring-[rgba(245,158,11,0.30)]"
                    )}
                >
                    {isAuthorized ? t("statusAuthorized") : t("statusPending")}
                    {!isAuthorized && <HelpCircle className={cn("w-3 h-3 cursor-help transition-transform", isOpen && "rotate-180")} />}
                </button>
                <AnimatePresence>
                    {!isAuthorized && showPanel && (
                        <motion.div
                            initial={{ opacity: 0, y: 10, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.95 }}
                            className="absolute bottom-full left-1/2 -translate-x-1/2 mb-4 w-[90vw] max-w-[20rem] p-6 bg-surface-2 border-2 border-[rgba(245,158,11,0.20)] rounded-[2rem] shadow-[0_20px_60px_rgba(0,0,0,0.9)] z-[100] backdrop-blur-3xl pointer-events-auto"
                        >
                            <div className="flex items-center justify-between mb-4">
                                <div className="flex items-center gap-3 text-soon">
                                    <div className="bg-[rgba(245,158,11,0.10)] p-2 rounded-xl ring-1 ring-[rgba(245,158,11,0.20)]"><Info className="w-5 h-5" /></div>
                                    <div className="flex flex-col text-left">
                                        <p className="text-[10px] font-black uppercase tracking-[0.2em] leading-none">{t("diagnostic")}</p>
                                        <p className="text-[10px] font-bold text-soon/60 uppercase mt-1">{t("diagnosticSub")}</p>
                                    </div>
                                </div>
                                {isOpen && <button onClick={() => setOpenDiagnostic(null)} className="p-1 hover:bg-white/5 rounded-lg text-fg-40 transition-colors"><X className="w-4 h-4" /></button>}
                            </div>
                            <div className="bg-black/40 rounded-[1.25rem] p-4 border border-white/5 mb-4">
                                <p className="text-[13px] text-fg font-bold leading-relaxed text-left">{errorMsg || t("diagnosticDefault")}</p>
                            </div>
                            {isHiper && isOpen && flagName && (
                                <div className="space-y-2">
                                    <button onClick={handleManualForce} disabled={saving} className={cn("w-full py-3 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all flex items-center justify-center gap-2", showConfirm ? "bg-destructive text-white hover:bg-destructive/85 animate-pulse" : "bg-soon text-surface hover:bg-soon/85")}>
                                        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />}
                                        {showConfirm ? t("areYouSure") : t("forceAuth")}
                                    </button>
                                    {showConfirm && <button onClick={() => setShowConfirm(false)} className="w-full text-[10px] font-bold text-fg-40 uppercase tracking-widest hover:text-fg transition-colors py-1">{t("cancelAction")}</button>}
                                </div>
                            )}
                            <div className="absolute -bottom-2.5 left-1/2 -translate-x-1/2 w-5 h-5 bg-surface-2 rotate-45 border-r-2 border-b-2 border-[rgba(245,158,11,0.10)]" />
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
            id: 1, title: t("step1Title"),
            description: t("step1Desc"),
            icon: CreditCard, isAuthorized: hasStripeSaved && hasWebhookSaved,
            errorMsg: stripeError || installError, kind: "stripe"
        },
        ...(needsIxStep ? [{
            id: 2, title: t("step2Title"),
            description: t("step2Desc"),
            icon: ClipboardList, isAuthorized: ixAuthorized, errorMsg: ixError, flagName: "ix_authorized", kind: "ix" as const
        }] : []),
        {
            id: activateStepId, title: t("activateTitle", { n: activateStepId }),
            description: t("activateDesc"),
            icon: Zap, isAuthorized: connectionStatus === "active", kind: "activate"
        }
    ];

    return (
        <div className="space-y-12 animate-in fade-in duration-1000 slide-in-from-bottom-4">
            <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-8">
                <div className="space-y-2">
                    <Link href="/integrations" className="text-[10px] font-black text-accent uppercase tracking-widest hover:text-fg transition-colors flex items-center gap-2 mb-4">
                        <ArrowLeft className="w-3 h-3" /> {t("backToIntegrations")}
                    </Link>
                    <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black tracking-tight bg-gradient-to-r from-fg via-fg to-fg-40 bg-clip-text text-transparent">
                        {t("pageTitle")}
                    </h1>
                    <p className="text-fg-60 font-semibold tracking-wide flex items-center gap-2">
                        Rioko 2.0 Engine <span className="w-1 h-1 rounded-full bg-fg-40" /> {t("engineSubtitle")}
                    </p>
                </div>
                <div className="flex items-center gap-5 glass px-5 py-3 rounded-2xl border-hairline">
                    <div className="flex -space-x-2.5">
                        <div className={cn("h-9 w-9 rounded-full ring-4 ring-surface flex items-center justify-center border", hasStripeSaved ? "bg-[rgba(2,141,196,0.10)] border-[rgba(2,141,196,0.30)]" : "bg-surface-2 border-hairline")}>
                            <CreditCard className={cn("w-4 h-4", hasStripeSaved ? "text-accent" : "text-fg-40")} />
                        </div>
                        <div className={cn("h-9 w-9 rounded-full ring-4 ring-surface flex items-center justify-center border", hasWebhookSaved ? "bg-[rgba(2,141,196,0.10)] border-[rgba(2,141,196,0.30)]" : "bg-surface-2 border-hairline")}>
                            <Webhook className={cn("w-4 h-4", hasWebhookSaved ? "text-accent" : "text-fg-40")} />
                        </div>
                        <div className={cn("h-9 w-9 rounded-full ring-4 ring-surface flex items-center justify-center border", ixAuthorized ? "bg-[rgba(2,141,196,0.10)] border-[rgba(2,141,196,0.30)]" : "bg-surface-2 border-hairline")}>
                            <ClipboardList className={cn("w-4 h-4", ixAuthorized ? "text-accent" : "text-fg-40")} />
                        </div>
                    </div>
                    <div className="flex flex-col">
                        <span className="text-[10px] font-black text-fg-40 uppercase tracking-[0.2em]">{t("syncState")}</span>
                        <span className={cn("text-xs font-bold flex items-center gap-1.5", allComplete ? "text-accent-hot" : "text-fg-40 animate-pulse")}>
                            <span className={cn("w-1.5 h-1.5 rounded-full", allComplete ? "bg-accent-hot animate-pulse" : "bg-surface-2")} />
                            {allComplete ? t("realtimeOn") : t("waitingConnection")}
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
                            className={cn("glass rounded-[2rem] overflow-visible relative group transition-all duration-700", isActive && "border-accent/40 shadow-[0_20px_50px_rgba(0,0,0,0.5),0_0_30px_rgba(2,141,196,0.10)]", isComplete && s.isAuthorized && "border-[rgba(94,234,212,0.30)] bg-[rgba(94,234,212,0.04)]", isComplete && !s.isAuthorized && "border-[rgba(245,158,11,0.30)] bg-[rgba(245,158,11,0.04)]", isLocked && "grayscale scale-[0.98] !overflow-hidden")}
                        >
                            <div className="p-6 sm:p-10 flex flex-col lg:flex-row items-start lg:items-center gap-10">
                                <div className={cn("w-20 h-20 rounded-2xl flex items-center justify-center transition-all duration-700 shrink-0 shadow-inner p-1", isActive ? "bg-accent/20 text-accent ring-1 ring-accent/30" : isComplete ? (s.isAuthorized ? "bg-[rgba(94,234,212,0.18)] text-accent-hot ring-1 ring-[rgba(94,234,212,0.30)]" : "bg-[rgba(245,158,11,0.10)] text-soon ring-1 ring-[rgba(245,158,11,0.30)]") : "bg-surface-2/50 text-fg-40 ring-1 ring-hairline")}>
                                    {isComplete ? (s.isAuthorized ? <Check className="w-10 h-10 stroke-[3]" /> : <Circle className="w-10 h-10 stroke-[4] text-soon" />) : (isLocked ? <Lock className="w-8 h-8 opacity-30" /> : <StepIcon className="w-10 h-10 stroke-[1.5]" />)}
                                </div>
                                <div className="flex-1 space-y-2">
                                    <div className="flex items-center gap-4">
                                        <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2.5">{s.title}</h2>
                                        {(isComplete || isActive) && <StatusBadge isAuthorized={s.isAuthorized} errorMsg={s.errorMsg} stepId={s.id} flagName={s.flagName} />}
                                        {isActive && <div className="h-1.5 w-1.5 rounded-full bg-accent animate-ping" />}
                                    </div>
                                    <p className="text-fg-60 font-medium leading-relaxed max-w-xl">{s.description}</p>
                                </div>
                                <div className="flex items-center gap-10 w-full lg:w-auto">
                                    {isComplete && <button onClick={() => setStep(s.id)} className="ml-auto bg-surface-2 hover:bg-surface-2 text-fg px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all border border-hairline/50">{t("update")}</button>}
                                </div>
                            </div>

                            <motion.div animate={{ height: isActive ? "auto" : 0 }} className="overflow-hidden bg-surface/40 border-t border-hairline">
                                {isActive && (
                                    <div className="p-6 sm:p-10 pt-8 animate-in zoom-in-95 duration-700">
                                        {s.kind === "stripe" && (
                                            <div className="grid md:grid-cols-2 gap-8">
                                                <div className="md:col-span-2 flex items-start gap-4 bg-[rgba(2,141,196,0.05)] border border-[rgba(2,141,196,0.20)] rounded-2xl px-6 py-4">
                                                    <Info className="w-5 h-5 text-accent shrink-0 mt-0.5" />
                                                    <div>
                                                        <p className="text-sm font-bold text-accent">{t("restrictedKeyHowTitle")}</p>
                                                        <ol className="text-[11px] text-fg-60 mt-2 leading-relaxed list-decimal pl-4 space-y-1">
                                                            <li dangerouslySetInnerHTML={{ __html: t("restrictedKeyStep1").replace(/<span>/g, '<span class="text-accent font-semibold">') }} />
                                                            <li dangerouslySetInnerHTML={{ __html: t("restrictedKeyStep2").replace(/<code>/g, '<code class="bg-surface-2 px-1 rounded text-accent">') }} />
                                                            <li dangerouslySetInnerHTML={{ __html: t("restrictedKeyStep3").replace(/<code>/g, '<code class="bg-surface-2 px-1 rounded text-accent">') }} />
                                                            <li dangerouslySetInnerHTML={{ __html: t("restrictedKeyStep4").replace(/<code>/g, '<code class="bg-surface-2 px-1 rounded">') }} />
                                                        </ol>
                                                    </div>
                                                </div>

                                                <div className="space-y-3">
                                                    <div className="flex items-center justify-between ml-1">
                                                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2"><span className="w-1 h-1 rounded-full bg-accent" />{t("stripeAccountIdLabel")}</label>
                                                        <a href="/help#stripe-account-id" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[10px] font-black text-fg-40 uppercase tracking-widest hover:text-accent transition-colors"><BookOpen className="w-3 h-3" />{t("whereFind")}</a>
                                                    </div>
                                                    <input type="text" value={stripeAccountId} onChange={(e) => setStripeAccountId(e.target.value)} placeholder={t("stripeAccountIdPlaceholder")} className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40" />
                                                </div>
                                                <div className="space-y-3">
                                                    <div className="flex items-center justify-between ml-1">
                                                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2"><span className="w-1 h-1 rounded-full bg-accent" />{t("restrictedKeyLabel")}</label>
                                                        <a href="/help#stripe-restricted-key" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[10px] font-black text-fg-40 uppercase tracking-widest hover:text-accent transition-colors"><BookOpen className="w-3 h-3" />{t("whatIs")}</a>
                                                    </div>
                                                    <input type="password" value={restrictedKey} onChange={(e) => setRestrictedKey(e.target.value)} placeholder={t("restrictedKeyPlaceholder")} className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40" />
                                                    <p className="text-[10px] text-fg-40 font-medium mt-2 ml-1 uppercase tracking-wider" dangerouslySetInnerHTML={{ __html: t("scopesNote").replace(/<code>/g, '<code class="text-accent">') }} />
                                                </div>

                                                <div className="md:col-span-2 pt-4">
                                                    <button onClick={handleStripeStep} disabled={saving || !stripeAccountId.trim() || !restrictedKey.trim()} className="w-full py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-white text-black hover:bg-accent hover:text-fg disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed">
                                                        {saving ? <><Loader2 className="w-5 h-5 animate-spin" /> {t("installingWebhook")}</> : <><Webhook className="w-4 h-4" /> {t("connectStripe")}</>}
                                                    </button>
                                                    {installError && (
                                                        <p className="text-[11px] text-destructive font-bold text-center mt-4">{installError}</p>
                                                    )}
                                                </div>

                                                {/* Fallback: manual paste of signing secret if auto-install failed */}
                                                <AnimatePresence>
                                                    {showManualFallback && (
                                                        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="md:col-span-2 overflow-hidden">
                                                            <div className="mt-4 p-6 rounded-2xl bg-[rgba(245,158,11,0.05)] border border-[rgba(245,158,11,0.20)] space-y-4">
                                                                <div className="flex items-start gap-3">
                                                                    <AlertTriangle className="w-5 h-5 text-soon shrink-0 mt-0.5" />
                                                                    <div>
                                                                        <p className="text-sm font-bold text-soon">{t("manualFallbackTitle")}</p>
                                                                        <p className="text-[11px] text-fg-60 mt-1 leading-relaxed">{t("manualFallbackBody")}</p>
                                                                    </div>
                                                                </div>
                                                                <div className="space-y-2">
                                                                    <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] ml-1">{t("endpointUrl")}</label>
                                                                    <div className="flex gap-3">
                                                                        <input type="text" readOnly value={WEBHOOK_URL} className="flex-1 bg-surface-2/50 border border-hairline rounded-2xl px-5 py-3 text-xs font-mono text-accent outline-none" onClick={(e) => (e.target as HTMLInputElement).select()} />
                                                                        <button onClick={copyWebhookUrl} className="px-4 py-3 rounded-2xl bg-[rgba(2,141,196,0.10)] text-accent border border-[rgba(2,141,196,0.20)] hover:bg-[rgba(2,141,196,0.20)] transition-all font-black text-[10px] uppercase tracking-widest flex items-center gap-2">
                                                                            {copied ? <><Check className="w-3 h-3" />{t("copied")}</> : <><Copy className="w-3 h-3" />{t("copy")}</>}
                                                                        </button>
                                                                    </div>
                                                                    <p className="text-[10px] text-fg-40 ml-1 mt-1" dangerouslySetInnerHTML={{ __html: t("eventsToSelect", { events: RECOMMENDED_EVENTS.join(", ") }).replace(/<code>/g, '<code class="text-accent">') }} />
                                                                </div>
                                                                <div className="space-y-2">
                                                                    <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] ml-1">{t("signingSecret")}</label>
                                                                    <input type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder={t("signingSecretPlaceholder")} className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-3 text-xs font-medium focus:ring-2 focus:ring-[rgba(245,158,11,0.20)] focus:border-soon outline-none transition-all placeholder:text-fg-40" />
                                                                </div>
                                                                <button onClick={handleManualSecret} disabled={saving || !webhookSecret.trim()} className="w-full py-3 rounded-xl font-black text-[10px] uppercase tracking-widest flex items-center justify-center gap-2 bg-[rgba(245,158,11,0.10)] text-soon border border-[rgba(245,158,11,0.20)] hover:bg-[rgba(245,158,11,0.20)] transition-all disabled:opacity-30 disabled:cursor-not-allowed">
                                                                    {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                                                    {t("saveSigningSecret")}
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
                                                    <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{t("fieldIxAccountLabel")}</label>
                                                    <input type="text" value={ixAccount} onChange={(e) => setIxAccount(e.target.value)} placeholder={t("fieldIxAccountPlaceholder")} className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40" />
                                                </div>
                                                <div className="space-y-3">
                                                    <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{t("fieldIxApiKeyLabel")}</label>
                                                    <input type="password" value={ixApiKey} onChange={(e) => setIxApiKey(e.target.value)} placeholder={t("fieldIxApiKeyPlaceholder")} className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40" />
                                                </div>
                                                <div className="space-y-3">
                                                    <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{t("fieldIxEnvLabel")}</label>
                                                    <input type="text" value={ixEnvironment} onChange={(e) => setIxEnvironment(e.target.value)} placeholder={t("fieldIxEnvPlaceholder")} className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40" />
                                                </div>
                                                <div className="space-y-3">
                                                    <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{t("fieldSeqLabel")}</label>
                                                    <input type="text" value={ixSequenceName} onChange={(e) => setIxSequenceName(e.target.value)} placeholder={t("fieldSeqPlaceholder")} className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-[rgba(2,141,196,0.20)] focus:border-accent outline-none transition-all placeholder:text-fg-40" />
                                                </div>

                                                <div className="glass p-6 rounded-2xl flex items-center justify-between border-hairline">
                                                    <div>
                                                        <h3 className="font-bold text-sm">{t("vatIncluded")}</h3>
                                                        <p className="text-[10px] text-fg-40 font-medium mt-1 uppercase tracking-wider">{vatIncluded ? t("vatIncludedOn") : t("vatIncludedOff")}</p>
                                                    </div>
                                                    <button onClick={() => setVatIncluded(!vatIncluded)} className={cn("w-12 h-6 rounded-full transition-all duration-500 relative ring-1 ring-inset ring-black/20", vatIncluded ? "bg-accent-hot" : "bg-surface-2")}><div className={cn("absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-500", vatIncluded ? "left-7" : "left-1")} /></button>
                                                </div>
                                                <div className="glass p-6 rounded-2xl flex items-center justify-between border-hairline">
                                                    <div>
                                                        <h3 className="font-bold text-sm">{t("autoFinalize")}</h3>
                                                        <p className="text-[10px] text-fg-40 font-medium mt-1 uppercase tracking-wider">{t("autoFinalizeDesc")}</p>
                                                    </div>
                                                    <button onClick={() => setAutoFinalize(!autoFinalize)} className={cn("w-12 h-6 rounded-full transition-all duration-500 relative ring-1 ring-inset ring-black/20", autoFinalize ? "bg-accent" : "bg-surface-2")}><div className={cn("absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-500", autoFinalize ? "left-7" : "left-1")} /></button>
                                                </div>

                                                <div className="md:col-span-2 glass p-6 rounded-2xl border-hairline space-y-6">
                                                    <div className="flex items-center justify-between">
                                                        <div>
                                                            <h3 className="font-bold text-sm">{t("retention")}</h3>
                                                            <p className="text-[10px] text-fg-40 font-medium mt-1 uppercase tracking-wider">{ixRetentionEnabled ? t("retentionOn", { value: ixRetention.toFixed(2).replace('.', ',') }) : t("retentionOff")}</p>
                                                        </div>
                                                        <button onClick={() => setIxRetentionEnabled(!ixRetentionEnabled)} className={cn("w-12 h-6 rounded-full transition-all duration-500 relative ring-1 ring-inset ring-black/20", ixRetentionEnabled ? "bg-destructive" : "bg-surface-2")}><div className={cn("absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-500", ixRetentionEnabled ? "left-7" : "left-1")} /></button>
                                                    </div>
                                                    <AnimatePresence>
                                                        {ixRetentionEnabled && (
                                                            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="pt-4 border-t border-hairline space-y-4">
                                                                <div className="flex items-center justify-between gap-4">
                                                                    <div className="flex-1"><h4 className="text-[10px] font-black text-fg-40 uppercase tracking-[0.2em] mb-1">{t("retentionPercent")}</h4><p className="text-[10px] text-fg-40 font-bold uppercase">{t("retentionPercentDesc")}</p></div>
                                                                    <div className="w-44 relative">
                                                                        <select value={[0, 11.5, 16.5, 21.5, 25].includes(ixRetention) ? String(ixRetention) : "outro"} onChange={(e) => { if (e.target.value === "outro") { if ([0, 11.5, 16.5, 21.5, 25].includes(ixRetention)) setIxRetention(7.5); } else { setIxRetention(parseFloat(e.target.value)); } }} className="w-full bg-surface-2/50 border border-hairline rounded-xl px-4 py-2 text-sm font-bold focus:ring-2 focus:ring-[rgba(244,63,94,0.20)] outline-none appearance-none cursor-pointer pr-10">
                                                                            <option value="0">0%</option>
                                                                            <option value="11.5">11,5%</option>
                                                                            <option value="16.5">16,5%</option>
                                                                            <option value="21.5">21,5%</option>
                                                                            <option value="25">25%</option>
                                                                            <option value="outro">{t("retentionOther")}</option>
                                                                        </select>
                                                                        <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none opacity-40"><ChevronRight className="w-4 h-4 rotate-90 text-destructive" /></div>
                                                                    </div>
                                                                </div>
                                                                {!([0, 11.5, 16.5, 21.5, 25].includes(ixRetention)) && (
                                                                    <div className="flex items-center justify-between gap-4 pt-2 border-t border-hairline">
                                                                        <div className="flex-1"><h4 className="text-[10px] font-black text-fg-40 uppercase tracking-[0.2em] mb-1">{t("retentionCustom")}</h4><p className="text-[10px] text-fg-40 font-bold uppercase">{t("retentionCustomDesc")}</p></div>
                                                                        <div className="w-32"><input type="number" min={0} max={99.99} step={0.01} value={ixRetention} onChange={(e) => { const v = parseFloat(e.target.value); setIxRetention(Number.isFinite(v) ? Math.max(0, Math.min(99.99, v)) : 0); }} className="w-full bg-surface-2/50 border border-hairline rounded-xl px-4 py-2 text-sm font-bold text-center focus:ring-2 focus:ring-[rgba(244,63,94,0.20)] outline-none" /></div>
                                                                    </div>
                                                                )}
                                                            </motion.div>
                                                        )}
                                                    </AnimatePresence>
                                                </div>

                                                <div className="md:col-span-2 glass p-6 rounded-2xl border-hairline space-y-6">
                                                    <div className="flex items-center justify-between">
                                                        <div>
                                                            <h3 className="font-bold text-sm">{t("docType")}</h3>
                                                            <p className="text-[10px] text-fg-40 font-medium mt-1 uppercase tracking-wider">{ixDocumentType === "invoice_receipt" ? t("docTypeReceipt") : t("docTypeInvoice")}</p>
                                                        </div>
                                                        <div className="flex bg-surface-2/80 p-1 rounded-xl border border-hairline">
                                                            <button onClick={() => setIxDocumentType("invoice_receipt")} className={cn("px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all", ixDocumentType === "invoice_receipt" ? "bg-white text-black shadow-lg" : "text-fg-40 hover:text-fg")}>{t("docTypeReceiptShort")}</button>
                                                            <button onClick={() => setIxDocumentType("invoice")} className={cn("px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all", ixDocumentType === "invoice" ? "bg-white text-black shadow-lg" : "text-fg-40 hover:text-fg")}>{t("docTypeInvoiceShort")}</button>
                                                        </div>
                                                    </div>
                                                    <AnimatePresence>
                                                        {ixDocumentType === "invoice" && (
                                                            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="pt-4 border-t border-hairline">
                                                                <div className="flex items-center justify-between gap-4">
                                                                    <div className="flex-1"><h4 className="text-[10px] font-black text-fg-40 uppercase tracking-[0.2em] mb-1">{t("paymentTerm")}</h4></div>
                                                                    <div className="w-32"><input type="number" value={ixPaymentTerm} onChange={(e) => setIxPaymentTerm(parseInt(e.target.value) || 0)} className="w-full bg-surface-2/50 border border-hairline rounded-xl px-4 py-2 text-sm font-bold text-center focus:ring-2 focus:ring-accent/20 outline-none" /></div>
                                                                </div>
                                                            </motion.div>
                                                        )}
                                                    </AnimatePresence>
                                                </div>

                                                <div className="md:col-span-2 glass p-5 sm:p-8 rounded-[2rem] border-hairline space-y-4">
                                                    <div className="flex items-center gap-3 mb-2"><div className="p-2 bg-[rgba(245,158,11,0.10)] rounded-xl"><Info className="w-4 h-4 text-soon" /></div><h3 className="font-bold text-sm tracking-tight">{t("exemptionTitle")}</h3></div>
                                                    <select value={exemptionReason} onChange={(e) => setExemptionReason(e.target.value)} className="w-full bg-surface-2/80 border border-hairline rounded-2xl px-6 py-4 text-sm font-bold focus:ring-2 focus:ring-[rgba(245,158,11,0.20)] focus:border-soon outline-none transition-all cursor-pointer text-fg">
                                                        {exemptionOptions.map((opt) => (<option key={opt.value} value={opt.value} className="bg-surface-2">{opt.value} - {opt.label}</option>))}
                                                    </select>
                                                </div>

                                                <div className="md:col-span-2 glass p-5 sm:p-6 rounded-2xl border-hairline flex items-center justify-between gap-4">
                                                    <div className="min-w-0">
                                                        <h3 className="font-bold text-sm">{t("overridesTitle")}</h3>
                                                        <p className="text-[10px] text-fg-40 font-medium mt-0.5 uppercase tracking-wider truncate">{t("overridesDesc")}</p>
                                                    </div>
                                                    <Link href="/integrations/ix-overrides?source_kind=stripe" className="px-5 py-2.5 rounded-xl border border-hairline hover:border-rule text-[10px] font-black uppercase tracking-[0.18em] transition-colors shrink-0">{t("manageOverrides")}</Link>
                                                </div>
                                                <div className="md:col-span-2 glass p-5 sm:p-6 rounded-2xl border-hairline flex items-center justify-between gap-4">
                                                    <div className="min-w-0">
                                                        <h3 className="font-bold text-sm">{t("tagRoutingTitle")}</h3>
                                                        <p className="text-[10px] text-fg-40 font-medium mt-0.5 uppercase tracking-wider truncate">{t("tagRoutingDesc")}</p>
                                                    </div>
                                                    <Link href="/integrations/tag-routing?source_kind=stripe" className="px-5 py-2.5 rounded-xl border border-hairline hover:border-rule text-[10px] font-black uppercase tracking-[0.18em] transition-colors shrink-0">{t("manageTagRouting")}</Link>
                                                </div>

                                                <div className="md:col-span-2 pt-4 flex items-center gap-4">
                                                    <button onClick={() => setStep(step - 1)} className="text-fg-40 hover:text-fg text-[10px] font-black uppercase tracking-widest transition-all px-4">{t("back")}</button>
                                                    <button onClick={handleIxConnect} disabled={saving || !ixAccount || !ixApiKey} className="flex-1 py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-white text-black hover:bg-accent hover:text-fg disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed">
                                                        {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <>{t("verifyConnection")} <ChevronRight className="w-4 h-4" /></>}
                                                    </button>
                                                </div>
                                            </div>
                                        )}

                                        {s.kind === "activate" && (
                                            <div className="space-y-8">
                                                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                                    <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-[rgba(94,234,212,0.05)] border-[rgba(94,234,212,0.20)]">
                                                        <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-[rgba(94,234,212,0.10)]"><CreditCard className="w-4 h-4 text-accent-hot" /></div>
                                                        <div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">{t("stripeLabel")}</p><p className="text-xs font-bold text-accent-hot">{t("configured")}</p></div>
                                                        <Check className="w-4 h-4 text-accent-hot ml-auto" />
                                                    </div>
                                                    <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-[rgba(94,234,212,0.05)] border-[rgba(94,234,212,0.20)]">
                                                        <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-[rgba(94,234,212,0.10)]"><Webhook className="w-4 h-4 text-accent-hot" /></div>
                                                        <div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">{t("webhookLabel")}</p><p className="text-xs font-bold text-accent-hot">{t("installed")}</p></div>
                                                        <Check className="w-4 h-4 text-accent-hot ml-auto" />
                                                    </div>
                                                    <div className={cn("flex items-center gap-3 px-5 py-4 rounded-2xl border", ixAuthorized ? "bg-[rgba(94,234,212,0.05)] border-[rgba(94,234,212,0.20)]" : "bg-[rgba(245,158,11,0.05)] border-[rgba(245,158,11,0.20)]")}>
                                                        <div className={cn("w-8 h-8 rounded-xl flex items-center justify-center shrink-0", ixAuthorized ? "bg-[rgba(94,234,212,0.10)]" : "bg-[rgba(245,158,11,0.10)]")}><ClipboardList className={cn("w-4 h-4", ixAuthorized ? "text-accent-hot" : "text-soon")} /></div>
                                                        <div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">{t("ixLabel")}</p><p className={cn("text-xs font-bold", ixAuthorized ? "text-accent-hot" : "text-soon")}>{ixAuthorized ? t("statusAuthorized") : t("statusPending")}</p></div>
                                                        {ixAuthorized && <Check className="w-4 h-4 text-accent-hot ml-auto" />}
                                                    </div>
                                                </div>

                                                <div className="flex items-start gap-4 bg-surface-2/50 border border-hairline rounded-2xl px-6 py-4">
                                                    <AlertTriangle className="w-5 h-5 text-soon shrink-0 mt-0.5" />
                                                    <p className="text-[11px] text-fg-60 leading-relaxed">{t("activateWarning")}</p>
                                                </div>

                                                <button onClick={handleActivate} disabled={saving || !hasWebhookSaved || (needsIxStep && !ixAuthorized)} className="w-full py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-white text-black hover:bg-accent-hot hover:text-surface disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed">
                                                    {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Zap className="w-5 h-5" /> {t("markAsActive")}</>}
                                                </button>

                                                {stripeError && <p className="text-[11px] text-destructive font-bold text-center">{stripeError}</p>}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </motion.div>
                        </motion.div>
                    );
                })}

                {allComplete && (
                    <motion.div initial={{ opacity: 0, y: 20, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.6, ease: "easeOut" }} className="rounded-[2.5rem] p-1 shadow-2xl bg-[rgba(94,234,212,0.10)]">
                        <div className="bg-surface rounded-[2.3rem] p-6 sm:p-10 flex flex-col gap-8 border border-white/5">
                            <div className="flex flex-col md:flex-row items-center justify-between gap-8">
                                <div className="flex items-center gap-8">
                                    <div className="w-20 h-20 rounded-[1.8rem] flex items-center justify-center bg-[rgba(94,234,212,0.18)] ring-2 ring-accent-hot ring-offset-4 ring-offset-surface"><ShieldCheck className="w-10 h-10 text-accent-hot" /></div>
                                    <div className="space-y-1"><h3 className="text-2xl font-black tracking-tight">{t("integrationDoneTitle")}</h3><p className="text-fg-40 font-bold uppercase tracking-widest text-[10px]">{t("integrationDoneSub")}</p></div>
                                </div>
                                <div className="px-6 py-3 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] border bg-[rgba(94,234,212,0.10)] text-accent-hot border-[rgba(94,234,212,0.30)]">{t("onlineRealtime")}</div>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-white/5 pt-8">
                                <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-[rgba(94,234,212,0.05)] border-[rgba(94,234,212,0.20)]"><div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-[rgba(94,234,212,0.10)]"><CreditCard className="w-4 h-4 text-accent-hot" /></div><div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">{t("stripeLabel")}</p><p className="text-xs font-bold text-accent-hot">{t("active")}</p></div><Check className="w-4 h-4 text-accent-hot ml-auto" /></div>
                                <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-[rgba(94,234,212,0.05)] border-[rgba(94,234,212,0.20)]"><div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-[rgba(94,234,212,0.10)]"><Webhook className="w-4 h-4 text-accent-hot" /></div><div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">{t("webhookLabel")}</p><p className="text-xs font-bold text-accent-hot">{t("registered")}</p></div><Check className="w-4 h-4 text-accent-hot ml-auto" /></div>
                                <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-[rgba(94,234,212,0.05)] border-[rgba(94,234,212,0.20)]"><div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-[rgba(94,234,212,0.10)]"><ClipboardList className="w-4 h-4 text-accent-hot" /></div><div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">{t("ixLabel")}</p><p className="text-xs font-bold text-accent-hot">{t("statusAuthorized")}</p></div><Check className="w-4 h-4 text-accent-hot ml-auto" /></div>
                            </div>
                        </div>
                    </motion.div>
                )}
            </div>

            <div className="pt-12 text-center">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-surface-2 border border-hairline">
                    <div className="w-2 h-2 rounded-full bg-accent-hot animate-pulse" />
                    <span className="text-[10px] text-fg-40 font-bold uppercase tracking-wider">{t("d1Connected")}</span>
                </div>
            </div>
        </div>
    );
}
