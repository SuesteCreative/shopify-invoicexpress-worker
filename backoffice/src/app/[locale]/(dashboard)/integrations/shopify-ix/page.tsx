"use client";

export const runtime = "edge";

import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect } from "react";
import { Check, Lock, ChevronRight, Store, ClipboardList, Settings2, Loader2, Circle, HelpCircle, Info, ShieldCheck, Webhook, AlertTriangle, Zap, BookOpen, X, Copy, ArrowLeft } from "lucide-react";
import Image from "next/image";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { useUser } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import SubscriptionCard from "@/components/SubscriptionCard";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export default function ShopifyIXIntegration() {
    const t = useTranslations("shopifyIxSetup");
    const { user: clerkUser } = useUser();
    const searchParams = useSearchParams();
    const stripeSuccess = searchParams?.get("stripe") === "success";
    // Use DB name (correct under impersonation). Falls back to Clerk name until data loads.
    const [dbUserName, setDbUserName] = useState("");
    const firstName = (dbUserName || clerkUser?.firstName || clerkUser?.fullName || "").split(" ")[0];
    const [step, setStep] = useState(1);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [activating, setActivating] = useState(false);
    const [webhookStatus, setWebhookStatus] = useState<"idle" | "success" | "error">("idle");
    const [userRole, setUserRole] = useState("");
    const [targetUserId, setTargetUserId] = useState("");
    const [openDiagnostic, setOpenDiagnostic] = useState<number | null>(null);

    // Form State
    const [shopifyDomain, setShopifyDomain] = useState("");
    const [shopifyToken, setShopifyToken] = useState("");
    const [shopifyWebhookSecret, setShopifyWebhookSecret] = useState("");
    const [shopifyApiVersion, setShopifyApiVersion] = useState("2026-01");
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

    // Validation State
    const [shopifyAuthorized, setShopifyAuthorized] = useState(false);
    const [webhooksActive, setWebhooksActive] = useState(false);
    const [ixAuthorized, setIxAuthorized] = useState(false);
    const [shopifyError, setShopifyError] = useState("");
    const [ixError, setIxError] = useState("");
    const [isPaused, setIsPaused] = useState(false);
    const [togglingPaused, setTogglingPaused] = useState(false);

    // allComplete: all 3 integrations are validated
    // webhooksActive can be "unknown" when token lacks read_webhooks, so we also
    // allow completion if both Shopify and IX are authorized AND we're on step 4+
    const allComplete = shopifyAuthorized && ixAuthorized && (webhooksActive || step >= 4);

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

    // Load existing data
    useEffect(() => {
        fetch("/api/auth/sync", { method: "POST" }).catch(console.error);

        fetch("/api/integrations")
            .then(res => res.json())
            .then((data: any) => {
                if (data._user_name) setDbUserName(data._user_name);
                setShopifyDomain(data.shopify_domain || "");
                if (data.shopify_token) setShopifyToken(data.shopify_token);
                if (data.shopify_webhook_secret) setShopifyWebhookSecret(data.shopify_webhook_secret);
                if (data.shopify_api_version) setShopifyApiVersion(data.shopify_api_version);
                if (data.ix_account_name) setIxAccount(data.ix_account_name);
                if (data.ix_api_key) setIxApiKey(data.ix_api_key);
                if (data.ix_environment) setIxEnvironment(data.ix_environment);
                if (data.ix_exemption_reason) setExemptionReason(data.ix_exemption_reason);
                if (data.vat_included !== undefined) setVatIncluded(data.vat_included === 1);
                if (data.auto_finalize !== undefined) setAutoFinalize(data.auto_finalize === 1);
                if (data.shopify_authorized !== undefined) setShopifyAuthorized(data.shopify_authorized === 1);
                if (data.ix_authorized !== undefined) setIxAuthorized(data.ix_authorized === 1);
                if (data.ix_document_type) setIxDocumentType(data.ix_document_type);
                if (data.ix_payment_term !== undefined) setIxPaymentTerm(parseInt(String(data.ix_payment_term)));
                if (data.ix_sequence_name) setIxSequenceName(data.ix_sequence_name);
                if (data.ix_retention_enabled !== undefined) setIxRetentionEnabled(data.ix_retention_enabled === 1);
                if (data.ix_retention !== undefined && data.ix_retention !== null) {
                    const v = parseFloat(String(data.ix_retention));
                    if (Number.isFinite(v)) setIxRetention(v);
                }
                if (data.webhooks_active !== undefined) setWebhooksActive(data.webhooks_active === 1);
                if (data.is_paused !== undefined) setIsPaused(data.is_paused === 1);
                if (data.shopify_error) setShopifyError(data.shopify_error);
                if (data.ix_error) setIxError(data.ix_error);
                if (data._viewer_role) setUserRole(data._viewer_role);
                if (data.user_id) setTargetUserId(data.user_id);

                // Smart step resume 
                if (data.shopify_authorized && data.ix_authorized && data.ix_api_key) setStep(5);
                else if (data.ix_api_key && data.shopify_token) setStep(4);
                else if (data.webhooks_active) setStep(3);
                else if (data.shopify_token) setStep(2);
                else setStep(1);
            })
            .finally(() => setLoading(false));
    }, []);

    // --- Step 1: Save Shopify credentials & validate ---
    const handleShopifyConnect = async () => {
        if (!shopifyDomain || !shopifyToken) return;
        setSaving(true);
        try {
            const saveRes = await fetch("/api/integrations", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    shopify_domain: shopifyDomain,
                    shopify_token: shopifyToken,
                    shopify_webhook_secret: shopifyWebhookSecret,
                    shopify_api_version: shopifyApiVersion,
                    ix_account_name: ixAccount,
                    ix_api_key: ixApiKey,
                    ix_environment: ixEnvironment,
                    ix_exemption_reason: exemptionReason,
                    vat_included: vatIncluded,
                    auto_finalize: autoFinalize,
                    ix_document_type: ixDocumentType,
                    ix_payment_term: ixPaymentTerm,
                    ix_sequence_name: ixSequenceName, ix_retention_enabled: ixRetentionEnabled ? 1 : 0, ix_retention: ixRetention
                })
            });
            if (!saveRes.ok) { alert(t("alertSaveError")); return; }

            const valRes = await fetch("/api/integrations/validate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "shopify" })
            });
            const valData = await valRes.json() as any;
            setShopifyAuthorized(valData.isValid);
            setShopifyError(valData.error || "");
            if (valData.webhooks_active !== undefined) setWebhooksActive(valData.webhooks_active === 1);

            setStep(2);
        } catch (e: any) {
            alert(t("alertNetworkError", { message: e.message }));
        } finally {
            setSaving(false);
        }
    };

    // --- Step 2: Install webhooks & verify ---
    const handleWebhooksInstall = async () => {
        if (!shopifyWebhookSecret) return;
        setSaving(true);
        setActivating(true);
        setWebhookStatus("idle");
        try {
            await fetch("/api/integrations", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    shopify_domain: shopifyDomain, shopify_token: shopifyToken,
                    shopify_webhook_secret: shopifyWebhookSecret, shopify_api_version: shopifyApiVersion,
                    ix_account_name: ixAccount, ix_api_key: ixApiKey, ix_environment: ixEnvironment,
                    ix_exemption_reason: exemptionReason, vat_included: vatIncluded, auto_finalize: autoFinalize,
                    ix_document_type: ixDocumentType, ix_payment_term: ixPaymentTerm, ix_sequence_name: ixSequenceName, ix_retention_enabled: ixRetentionEnabled ? 1 : 0, ix_retention: ixRetention
                })
            });

            const actRes = await fetch("/api/integrations/activate", { method: "POST" });
            if (actRes.ok) {
                setWebhookStatus("success");
                setWebhooksActive(true);
                setStep(3);
            } else {
                setWebhookStatus("error");
            }
        } catch {
            setWebhookStatus("error");
        } finally {
            setSaving(false);
            setActivating(false);
        }
    };

    // --- Step 2b: Manually confirm webhooks were installed ---
    const handleWebhooksConfirm = async () => {
        if (!shopifyWebhookSecret) return;
        setSaving(true);
        try {
            await fetch("/api/integrations", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    shopify_domain: shopifyDomain, shopify_token: shopifyToken,
                    shopify_webhook_secret: shopifyWebhookSecret, shopify_api_version: shopifyApiVersion,
                    ix_account_name: ixAccount, ix_api_key: ixApiKey, ix_environment: ixEnvironment,
                    ix_exemption_reason: exemptionReason, vat_included: vatIncluded, auto_finalize: autoFinalize,
                    ix_document_type: ixDocumentType, ix_payment_term: ixPaymentTerm, ix_sequence_name: ixSequenceName, ix_retention_enabled: ixRetentionEnabled ? 1 : 0, ix_retention: ixRetention
                })
            });
            const confirmRes = await fetch("/api/integrations/webhooks-confirm", { method: "POST" });
            if (confirmRes.ok) {
                setWebhooksActive(true);
                setWebhookStatus("success");
                setStep(3);
            } else {
                alert(t("alertConfirmError"));
            }
        } catch (e: any) {
            alert(t("alertNetworkError", { message: e.message }));
        } finally {
            setSaving(false);
        }
    };

    // --- Step 3: Save IX credentials & validate ---
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
                    ix_document_type: ixDocumentType, ix_payment_term: ixPaymentTerm, ix_sequence_name: ixSequenceName, ix_retention_enabled: ixRetentionEnabled ? 1 : 0, ix_retention: ixRetention
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

            if (valData.isValid) setStep(4);
        } catch (e: any) {
            alert(t("alertNetworkError", { message: e.message }));
        } finally {
            setSaving(false);
        }
    };

    // --- Step 4: Save settings ---
    const handleSaveSettings = async () => {
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

            const res = await fetch("/api/integrations", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    shopify_domain: shopifyDomain, shopify_token: shopifyToken,
                    shopify_webhook_secret: shopifyWebhookSecret, shopify_api_version: shopifyApiVersion,
                    ix_account_name: ixAccount, ix_api_key: ixApiKey, ix_environment: ixEnvironment,
                    ix_exemption_reason: exemptionReason, vat_included: vatIncluded, auto_finalize: autoFinalize,
                    ix_document_type: ixDocumentType, ix_payment_term: ixPaymentTerm, ix_sequence_name: ixSequenceName, ix_retention_enabled: ixRetentionEnabled ? 1 : 0, ix_retention: ixRetention
                })
            });
            if (res.ok) setStep(5);
            else alert(t("alertSaveSettingsError"));
        } catch (e: any) {
            alert(t("alertSaveExtError", { message: e.message }));
        } finally {
            setSaving(false);
        }
    };

    // --- Pause / resume the live connection -------------------------------
    // Optimistically flips the local toggle; reverts on API failure so the UI
    // never lies about server state. Worker reads `is_paused` on each event.
    const handleTogglePaused = async (next: boolean) => {
        const previous = isPaused;
        setIsPaused(next);
        setTogglingPaused(true);
        try {
            const res = await fetch("/api/integrations/toggle", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ paused: next }),
            });
            if (!res.ok) {
                setIsPaused(previous);
                alert(t("alertToggleError"));
            }
        } catch (e: any) {
            setIsPaused(previous);
            alert(t("alertNetworkError", { message: e.message }));
        } finally {
            setTogglingPaused(false);
        }
    };

    if (loading) {
        return (
            <div className="min-h-[60vh] flex items-center justify-center">
                <Loader2 className="w-12 h-12 text-accent animate-spin opacity-50" />
            </div>
        );
    }

    const StatusBadge = ({ isAuthorized, errorMsg, stepId }: { isAuthorized: boolean; errorMsg?: string; stepId: number }) => {
        const isHiper = userRole === "hiperadmin" || userRole === "superadmin";
        const isOpen = openDiagnostic === stepId;
        const [isHovered, setIsHovered] = useState(false);
        const [showConfirm, setShowConfirm] = useState(false);

        const handleManualForce = async (e: React.MouseEvent) => {
            e.stopPropagation();
            if (!showConfirm) { setShowConfirm(true); return; }
            const flagMap: Record<number, string> = { 1: "shopify_authorized", 2: "webhooks_active", 3: "ix_authorized" };
            const flag = flagMap[stepId];
            if (!flag) return;
            setSaving(true);
            try {
                const res = await fetch("/api/admin/client-rules", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ targetUserId, flag, value: 1 })
                });
                if (res.ok) {
                    if (stepId === 1) setShopifyAuthorized(true);
                    if (stepId === 2) setWebhooksActive(true);
                    if (stepId === 3) setIxAuthorized(true);
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
                            {isHiper && isOpen && (
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

    const steps = [
        {
            id: 1, title: t("step1Title"), description: t("step1Desc"),
            icon: Store, logo: "/images/shopify-logo.webp", logoWidth: 80, isAuthorized: shopifyAuthorized, errorMsg: shopifyError,
            fields: [
                { label: t("fieldDomainLabel"), value: shopifyDomain, setter: setShopifyDomain, placeholder: t("fieldDomainPlaceholder"), type: "text", helpAnchor: "shopify-domain" },
                { label: t("fieldTokenLabel"), value: shopifyToken, setter: setShopifyToken, placeholder: t("fieldTokenPlaceholder"), type: "password", helpAnchor: "shopify-token" },
                { label: t("fieldApiVersionLabel"), value: shopifyApiVersion, setter: setShopifyApiVersion, placeholder: t("fieldApiVersionPlaceholder"), type: "text", helpAnchor: "shopify-api-version" }
            ],
            action: handleShopifyConnect, actionLabel: t("verifyConnection"), isDisabled: !shopifyDomain || !shopifyToken,
        },
        {
            id: 2, title: t("step2Title"), description: t("step2Desc"),
            icon: Webhook, logo: "/images/shopify-logo.webp", logoWidth: 80, isAuthorized: webhooksActive,
            errorMsg: webhookStatus === "error" ? t("webhookInstallError") : "",
            fields: [{ label: t("fieldWebhookSecretLabel"), value: shopifyWebhookSecret, setter: setShopifyWebhookSecret, placeholder: t("fieldWebhookSecretPlaceholder"), type: "password", helpAnchor: "shopify-webhook" }],
            action: handleWebhooksInstall, actionLabel: webhookStatus === "error" ? t("retryWebhooks") : t("installWebhooks"), isDisabled: !shopifyWebhookSecret, isWebhookStep: true,
        },
        {
            id: 3, title: t("step3Title"), description: t("step3Desc"),
            icon: ClipboardList, logo: "/images/invoicexpress_logo2.png", logoWidth: 80, isAuthorized: ixAuthorized, errorMsg: ixError,
            fields: [
                { label: t("fieldIxAccountLabel"), value: ixAccount, setter: setIxAccount, placeholder: t("fieldIxAccountPlaceholder"), type: "text", helpAnchor: "ix-account" },
                { label: t("fieldIxApiKeyLabel"), value: ixApiKey, setter: setIxApiKey, placeholder: t("fieldIxApiKeyPlaceholder"), type: "password", helpAnchor: "ix-api-key" },
                { label: t("fieldIxEnvLabel"), value: ixEnvironment, setter: setIxEnvironment, placeholder: t("fieldIxEnvPlaceholder"), type: "text", helpAnchor: "ix-environment", helpLabel: t("helpWhatIs") }
            ],
            action: handleIxConnect, actionLabel: t("verifyConnection"), isDisabled: !ixAccount || !ixApiKey,
        },
        {
            id: 4, title: t("step4Title"), description: t("step4Desc"),
            icon: Settings2, hasGearLogo: true, isAuthorized: true, errorMsg: "", isConfig: true, action: handleSaveSettings, actionLabel: t("save"), isDisabled: false,
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
                        <div className={cn("h-9 w-9 rounded-full ring-4 ring-surface flex items-center justify-center border", shopifyAuthorized ? "bg-[rgba(94,234,212,0.10)] border-[rgba(94,234,212,0.30)]" : "bg-surface-2 border-hairline")}>
                            <Store className={cn("w-4 h-4", shopifyAuthorized ? "text-accent-hot" : "text-fg-40")} />
                        </div>
                        <div className={cn("h-9 w-9 rounded-full ring-4 ring-surface flex items-center justify-center border", webhooksActive ? "bg-[rgba(2,141,196,0.10)] border-[rgba(2,141,196,0.30)]" : "bg-surface-2 border-hairline")}>
                            <Webhook className={cn("w-4 h-4", webhooksActive ? "text-accent" : "text-fg-40")} />
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

            {allComplete && (
                <div className={cn(
                    "glass rounded-[2rem] border p-6 flex items-center justify-between gap-6 transition-colors duration-500",
                    isPaused ? "border-[rgba(245,158,11,0.30)] bg-[rgba(245,158,11,0.04)]" : "border-[rgba(94,234,212,0.25)] bg-[rgba(94,234,212,0.04)]"
                )}>
                    <div className="flex items-center gap-5 min-w-0">
                        <div className={cn(
                            "w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border",
                            isPaused
                                ? "bg-[rgba(245,158,11,0.10)] border-[rgba(245,158,11,0.30)] text-soon"
                                : "bg-[rgba(94,234,212,0.10)] border-[rgba(94,234,212,0.30)] text-accent-hot"
                        )}>
                            <Zap className={cn("w-5 h-5", isPaused ? "opacity-50" : "")} />
                        </div>
                        <div className="min-w-0">
                            <div className="flex items-center gap-2">
                                <h3 className="text-base font-bold tracking-tight">
                                    {isPaused ? t("integrationPaused") : t("integrationActive")}
                                </h3>
                                <span className={cn(
                                    "px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-widest border",
                                    isPaused ? "bg-[rgba(245,158,11,0.10)] text-soon border-[rgba(245,158,11,0.30)]"
                                             : "bg-[rgba(94,234,212,0.10)] text-accent-hot border-[rgba(94,234,212,0.30)]"
                                )}>
                                    {isPaused ? t("pausedBadge") : t("activeBadge")}
                                </span>
                            </div>
                            <p className="text-xs text-fg-60 mt-1 leading-relaxed max-w-xl">
                                {isPaused ? t("pausedBody") : t("activeBody")}
                            </p>
                        </div>
                    </div>

                    <button
                        type="button"
                        onClick={() => handleTogglePaused(!isPaused)}
                        disabled={togglingPaused}
                        aria-pressed={!isPaused}
                        aria-label={isPaused ? t("ariaResume") : t("ariaPause")}
                        className={cn(
                            "relative shrink-0 inline-flex h-8 w-14 items-center rounded-full transition-colors duration-300",
                            "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
                            isPaused
                                ? "bg-surface-2 border border-hairline focus-visible:ring-[rgba(245,158,11,0.50)]"
                                : "bg-accent-hot focus-visible:ring-[rgba(94,234,212,0.50)]",
                            togglingPaused && "opacity-60 cursor-wait"
                        )}
                    >
                        <span
                            className={cn(
                                "inline-block h-6 w-6 transform rounded-full bg-white shadow-lg transition-transform duration-300",
                                isPaused ? "translate-x-1" : "translate-x-7"
                            )}
                        />
                    </button>
                </div>
            )}

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
                                        <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2.5">
                                            {s.id === 4 && <Settings2 className="w-6 h-6 text-fg-60 group-hover:text-fg transition-colors" />}
                                            {s.title}
                                        </h2>
                                        {(isComplete || isActive) && <StatusBadge isAuthorized={s.isAuthorized} errorMsg={s.errorMsg} stepId={s.id} />}
                                        {isActive && <div className="h-1.5 w-1.5 rounded-full bg-accent animate-ping" />}
                                    </div>
                                    <p className="text-fg-60 font-medium leading-relaxed max-w-xl">{s.description}</p>
                                </div>
                                <div className="flex items-center gap-10 w-full lg:w-auto">
                                    {s.logo && <div className={cn("hidden xl:block transition-all duration-700 transform", isActive ? "opacity-100 grayscale-0" : "opacity-20 grayscale")}><Image src={s.logo} alt={s.title} width={s.logoWidth ?? 80} height={40} className="object-contain" /></div>}
                                    {s.hasGearLogo && <div className={cn("hidden xl:block transition-all duration-700", isActive ? "opacity-100" : "opacity-20")}><Settings2 className="w-16 h-16 text-fg-60 stroke-[1]" /></div>}
                                    {isActive && (
                                        <div className="flex items-center gap-4 ml-auto">
                                            {step > 1 && <button onClick={() => setStep(step - 1)} className="text-fg-40 hover:text-fg text-[10px] font-black uppercase tracking-widest transition-all px-4">{t("back")}</button>}
                                            {!s.isConfig && (
                                                <button onClick={s.action} disabled={saving || activating || s.isDisabled} className={cn("px-5 sm:px-8 py-3.5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center gap-3 transition-all duration-500 transform active:scale-95 group shadow-xl shadow-white/5 disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed", s.isWebhookStep && webhookStatus === "error" ? "bg-destructive text-white hover:bg-destructive/85" : "bg-white text-black hover:bg-accent hover:text-fg")}>
                                                    {(saving || activating) ? <Loader2 className="w-4 h-4 animate-spin" /> : s.actionLabel}
                                                    {!(saving || activating) && <ChevronRight className="w-4 h-4 group-hover:translate-x-1.5 transition-transform" />}
                                                </button>
                                            )}
                                        </div>
                                    )}
                                    {isComplete && <button onClick={() => setStep(s.id)} className="ml-auto bg-surface-2 hover:bg-surface-2 text-fg px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all border border-hairline/50">{t("update")}</button>}
                                </div>
                            </div>
                            <motion.div animate={{ height: isActive ? "auto" : 0 }} className="overflow-hidden bg-surface/40 border-t border-hairline">
                                {isActive && (
                                    <div className="p-6 sm:p-10 pt-8 grid md:grid-cols-2 gap-8 animate-in zoom-in-95 duration-700">
                                        {s.isConfig ? (
                                            <>
                                                <div className="glass p-6 rounded-2xl flex items-center justify-between border-hairline">
                                                    <div>
                                                        <div className="flex items-center gap-3"><h3 className="font-bold text-sm">{t("vatIncluded")}</h3><a href="/help" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[10px] font-black text-fg-40 uppercase tracking-widest hover:text-accent transition-colors"><BookOpen className="w-3 h-3" />{t("helpWhatIs")}</a></div>
                                                        <p className="text-[10px] text-fg-40 font-medium mt-1 uppercase tracking-wider">{vatIncluded ? t("vatIncludedOn") : t("vatIncludedOff")}</p>
                                                    </div>
                                                    <button onClick={() => setVatIncluded(!vatIncluded)} className={cn("w-12 h-6 rounded-full transition-all duration-500 relative ring-1 ring-inset ring-black/20", vatIncluded ? "bg-accent-hot shadow-[0_0_15px_rgba(16,185,129,0.3)]" : "bg-surface-2")}><div className={cn("absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-500 shadow-sm", vatIncluded ? "left-7" : "left-1")} /></button>
                                                </div>
                                                <div className="glass p-6 rounded-2xl flex items-center justify-between border-hairline">
                                                    <div>
                                                        <div className="flex items-center gap-3"><h3 className="font-bold text-sm">{t("autoFinalize")}</h3><a href="/help" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[10px] font-black text-fg-40 uppercase tracking-widest hover:text-accent transition-colors"><BookOpen className="w-3 h-3" />{t("helpWhatIs")}</a></div>
                                                        <p className="text-[10px] text-fg-40 font-medium mt-1 uppercase tracking-wider">{t("autoFinalizeDesc")}</p>
                                                    </div>
                                                    <button onClick={() => setAutoFinalize(!autoFinalize)} className={cn("w-12 h-6 rounded-full transition-all duration-500 relative ring-1 ring-inset ring-black/20", autoFinalize ? "bg-accent shadow-[0_0_15px_rgba(56,189,248,0.3)]" : "bg-surface-2")}><div className={cn("absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-500 shadow-sm", autoFinalize ? "left-7" : "left-1")} /></button>
                                                </div>
                                                <div className="md:col-span-2 glass p-6 rounded-2xl border-hairline space-y-6">
                                                    <div className="flex items-center justify-between">
                                                        <div>
                                                            <div className="flex items-center gap-3"><h3 className="font-bold text-sm">{t("retention")}</h3><a href="/help" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[10px] font-black text-fg-40 uppercase tracking-widest hover:text-accent transition-colors"><BookOpen className="w-3 h-3" />{t("helpWhatIs")}</a></div>
                                                            <p className="text-[10px] text-fg-40 font-medium mt-1 uppercase tracking-wider">{ixRetentionEnabled ? t("retentionOn", { value: ixRetention.toFixed(2).replace('.', ',') }) : t("retentionOff")}</p>
                                                        </div>
                                                        <button onClick={() => setIxRetentionEnabled(!ixRetentionEnabled)} className={cn("w-12 h-6 rounded-full transition-all duration-500 relative ring-1 ring-inset ring-black/20", ixRetentionEnabled ? "bg-destructive" : "bg-surface-2")}><div className={cn("absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-500 shadow-sm", ixRetentionEnabled ? "left-7" : "left-1")} /></button>
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
                                                                        <div className="w-32 relative">
                                                                            <input type="number" min={0} max={99.99} step={0.01} value={ixRetention} onChange={(e) => { const v = parseFloat(e.target.value); setIxRetention(Number.isFinite(v) ? Math.max(0, Math.min(99.99, v)) : 0); }} className="w-full bg-surface-2/50 border border-hairline rounded-xl px-4 py-2 text-sm font-bold text-center focus:ring-2 focus:ring-[rgba(244,63,94,0.20)] outline-none" />
                                                                        </div>
                                                                    </div>
                                                                )}
                                                            </motion.div>
                                                        )}
                                                    </AnimatePresence>
                                                </div>
                                                <div className="md:col-span-2 glass p-6 rounded-2xl border-hairline space-y-6">
                                                    <div className="flex items-center justify-between">
                                                        <div>
                                                            <div className="flex items-center gap-3"><h3 className="font-bold text-sm">{t("docType")}</h3><a href="/help#ix-doc-type" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[10px] font-black text-fg-40 uppercase tracking-widest hover:text-accent transition-colors"><BookOpen className="w-3 h-3" />{t("helpWhatIs")}</a></div>
                                                            <p className="text-[10px] text-fg-40 font-medium mt-1 uppercase tracking-wider leading-relaxed">{ixDocumentType === "invoice_receipt" ? t("docTypeReceipt") : t("docTypeInvoice")}</p>
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
                                                                    <div className="flex-1"><h4 className="text-[10px] font-black text-fg-40 uppercase tracking-[0.2em] mb-1">{t("paymentTerm")}</h4><p className="text-[10px] text-fg-40 font-bold uppercase">{t("paymentTermDesc")}</p></div>
                                                                    <div className="w-32 relative"><input type="number" value={ixPaymentTerm} onChange={(e) => setIxPaymentTerm(parseInt(e.target.value) || 0)} className="w-full bg-surface-2/50 border border-hairline rounded-xl px-4 py-2 text-sm font-bold text-center focus:ring-2 focus:ring-accent/20 outline-none" /></div>
                                                                </div>
                                                            </motion.div>
                                                        )}
                                                    </AnimatePresence>
                                                </div>
                                                <div className="md:col-span-2 glass p-6 rounded-2xl border-hairline">
                                                    <div className="flex items-center justify-start gap-4 ml-1 mb-4">
                                                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2"><span className="w-1 h-1 rounded-full bg-accent" />{t("sequence")}</label>
                                                        <a href="/help#ix-sequence" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[10px] font-black text-fg-40 uppercase tracking-widest hover:text-accent transition-colors"><BookOpen className="w-3 h-3" />{t("helpWhatIs")}</a>
                                                    </div>
                                                    <input type="text" value={ixSequenceName} onChange={(e) => setIxSequenceName(e.target.value)} placeholder={t("sequencePlaceholder")} className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-[rgba(2,141,196,0.20)] focus:border-accent outline-none transition-all placeholder:text-fg-40" />
                                                </div>
                                                <div className="md:col-span-2 glass p-5 sm:p-8 rounded-[2rem] border-hairline space-y-4">
                                                    <div className="flex items-center gap-3 mb-2"><div className="p-2 bg-[rgba(245,158,11,0.10)] rounded-xl"><Info className="w-4 h-4 text-soon" /></div><h3 className="font-bold text-sm tracking-tight">{t("exemptionTitle")}</h3><a href="/help" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[10px] font-black text-fg-40 uppercase tracking-widest hover:text-accent transition-colors"><BookOpen className="w-3 h-3" />{t("helpWhatIs")}</a></div>
                                                    <p className="text-[10px] text-fg-40 font-medium uppercase tracking-wider leading-relaxed">{t("exemptionDesc")}</p>
                                                    <div className="relative pt-2">
                                                        <select value={exemptionReason} onChange={(e) => setExemptionReason(e.target.value)} className="w-full bg-surface-2/80 border border-hairline rounded-2xl px-6 py-4 text-sm font-bold focus:ring-2 focus:ring-[rgba(245,158,11,0.20)] focus:border-soon outline-none transition-all appearance-none cursor-pointer pr-12 text-fg">
                                                            {exemptionOptions.map((opt) => (<option key={opt.value} value={opt.value} className="bg-surface-2 py-2">{opt.value} - {opt.label}</option>))}
                                                        </select>
                                                        <div className="absolute right-6 top-[55%] -translate-y-1/2 pointer-events-none opacity-40"><ChevronRight className="w-5 h-5 rotate-90 text-soon" /></div>
                                                    </div>
                                                </div>
                                                <div className="md:col-span-2 pt-4"><button onClick={handleSaveSettings} disabled={saving} className="w-full py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-white text-black hover:bg-accent-hot hover:text-surface">{saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Zap className="w-5 h-5" /> {t("saveSettings")}</>}</button></div>
                                            </>
                                        ) : (
                                            s.fields?.map((f: any, i: number) => (
                                                <div key={i} className="space-y-3">
                                                    <div className="flex items-center justify-between ml-1">
                                                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2"><span className="w-1 h-1 rounded-full bg-accent" />{f.label}</label>
                                                        {f.helpAnchor && (<a href={`/help#${f.helpAnchor}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[10px] font-black text-fg-40 uppercase tracking-widest hover:text-accent transition-colors group/help"><BookOpen className="w-3 h-3 group-hover/help:scale-110 transition-transform" />{f.helpLabel || t("helpWhereFind")}</a>)}
                                                    </div>
                                                    <input type={f.type} value={f.value} onChange={(e) => f.setter(e.target.value)} placeholder={f.placeholder} className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40" />
                                                </div>
                                            ))
                                        )}
                                        {s.isWebhookStep && (
                                            <><div className="md:col-span-2 flex items-start gap-4 bg-[rgba(2,141,196,0.05)] border border-[rgba(2,141,196,0.20)] rounded-2xl px-6 py-4"><Webhook className="w-5 h-5 text-accent shrink-0 mt-0.5" /><div><p className="text-sm font-bold text-accent">{t("webhooksWhatTitle")}</p><p className="text-[11px] text-fg-60 mt-1 leading-relaxed" dangerouslySetInnerHTML={{ __html: t("webhooksWhatBody").replace(/<span>/g, '<span class="text-accent font-semibold">') }} /></div></div><div className="md:col-span-2 flex items-start gap-4 bg-surface-2/50 border border-hairline rounded-2xl px-6 py-4"><AlertTriangle className="w-5 h-5 text-soon shrink-0 mt-0.5" /><div className="flex-1"><p className="text-sm font-bold text-soon">{t("tokenNoReadOrdersTitle")}</p><p className="text-[11px] text-fg-60 mt-1 mb-3 leading-relaxed" dangerouslySetInnerHTML={{ __html: t("tokenNoReadOrdersBody").replace(/<code>/g, '<code class="bg-surface-2 px-1 rounded">') }} /><div className="flex flex-wrap gap-3"><button onClick={handleWebhooksConfirm} disabled={saving || !shopifyWebhookSecret} className="px-5 py-2.5 rounded-xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2 bg-[rgba(245,158,11,0.10)] text-soon border border-[rgba(245,158,11,0.20)] hover:bg-[rgba(245,158,11,0.20)] transition-all disabled:opacity-30 disabled:cursor-not-allowed">{saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}{t("confirmManualInstall")}</button><a href="/help#shopify-webhook" target="_blank" rel="noopener noreferrer" className="px-5 py-2.5 rounded-xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2 bg-surface-2 text-fg border border-hairline hover:bg-surface-2 transition-all"><BookOpen className="w-3.5 h-3.5" />{t("howTo")}</a></div></div></div></>
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
                                <div className="flex items-center gap-8"><div className="w-20 h-20 rounded-[1.8rem] flex items-center justify-center bg-[rgba(94,234,212,0.18)] ring-2 ring-accent-hot ring-offset-4 ring-offset-surface"><ShieldCheck className="w-10 h-10 text-accent-hot" /></div><div className="space-y-1"><h3 className="text-2xl font-black tracking-tight">{t("integrationDoneTitle")}</h3><p className="text-fg-40 font-bold uppercase tracking-widest text-[10px]">{t("integrationDoneSub")}</p></div></div>
                                <div className="px-6 py-3 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] border bg-[rgba(94,234,212,0.10)] text-accent-hot border-[rgba(94,234,212,0.30)]">{t("onlineRealtime")}</div>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-white/5 pt-8">
                                <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-[rgba(94,234,212,0.05)] border-[rgba(94,234,212,0.20)]"><div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-[rgba(94,234,212,0.10)]"><Store className="w-4 h-4 text-accent-hot" /></div><div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">{t("shopifyLabel")}</p><p className="text-xs font-bold text-accent-hot">{t("authorized")}</p></div><Check className="w-4 h-4 text-accent-hot ml-auto" /></div>
                                <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-[rgba(94,234,212,0.05)] border-[rgba(94,234,212,0.20)]"><div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-[rgba(94,234,212,0.10)]"><Webhook className="w-4 h-4 text-accent-hot" /></div><div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">{t("webhooksLabel")}</p><p className="text-xs font-bold text-accent-hot">{t("registered")}</p></div><Check className="w-4 h-4 text-accent-hot ml-auto" /></div>
                                <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-[rgba(94,234,212,0.05)] border-[rgba(94,234,212,0.20)]"><div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-[rgba(94,234,212,0.10)]"><ClipboardList className="w-4 h-4 text-accent-hot" /></div><div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">{t("invoicexpressLabel")}</p><p className="text-xs font-bold text-accent-hot">{t("authorized")}</p></div><Check className="w-4 h-4 text-accent-hot ml-auto" /></div>
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
