"use client";

export const runtime = "edge";

import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect } from "react";
import { Check, Lock, ChevronRight, Store, ClipboardList, Settings2, Loader2, Circle, HelpCircle, Info, ShieldCheck, Webhook, AlertTriangle, Zap, BookOpen, X, Copy, ArrowLeft } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { useUser } from "@clerk/nextjs";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export default function ShopifyIXIntegration() {
    const { user: clerkUser } = useUser();
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

    // Validation State
    const [shopifyAuthorized, setShopifyAuthorized] = useState(false);
    const [webhooksActive, setWebhooksActive] = useState(false);
    const [ixAuthorized, setIxAuthorized] = useState(false);
    const [shopifyError, setShopifyError] = useState("");
    const [ixError, setIxError] = useState("");

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
                if (data.webhooks_active !== undefined) setWebhooksActive(data.webhooks_active === 1);
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
                    ix_sequence_name: ixSequenceName
                })
            });
            if (!saveRes.ok) { alert("Erro ao guardar. Tenta novamente."); return; }

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
            alert(`Erro de rede: ${e.message}`);
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
                    ix_document_type: ixDocumentType, ix_payment_term: ixPaymentTerm, ix_sequence_name: ixSequenceName
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
                    ix_document_type: ixDocumentType, ix_payment_term: ixPaymentTerm, ix_sequence_name: ixSequenceName
                })
            });
            const confirmRes = await fetch("/api/integrations/webhooks-confirm", { method: "POST" });
            if (confirmRes.ok) {
                setWebhooksActive(true);
                setWebhookStatus("success");
                setStep(3);
            } else {
                alert("Erro ao confirmar. Tenta novamente.");
            }
        } catch (e: any) {
            alert(`Erro de rede: ${e.message}`);
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

            if (valData.isValid) setStep(4);
        } catch (e: any) {
            alert(`Erro de rede: ${e.message}`);
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
                        if (!confirm(`A série de faturação "${ixSequenceName}" não foi encontrada no InvoiceXpress. Desejas continuar? (O Rioko usará a série pré-definida por omissão)`)) {
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
                    ix_document_type: ixDocumentType, ix_payment_term: ixPaymentTerm, ix_sequence_name: ixSequenceName
                })
            });
            if (res.ok) setStep(5);
            else alert("Erro ao guardar definições. Tenta novamente.");
        } catch (e: any) {
            alert(`Erro ao guardar: ${e.message}`);
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="min-h-[60vh] flex items-center justify-center">
                <Loader2 className="w-12 h-12 text-accent-blue animate-spin opacity-50" />
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
                            {isHiper && isOpen && (
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

    const steps = [
        {
            id: 1, title: "Passo 1: Ligação Shopify", description: "Conecte a sua loja Shopify através das credenciais de API.",
            icon: Store, logo: "/images/shopify-logo.webp", logoWidth: 80, isAuthorized: shopifyAuthorized, errorMsg: shopifyError,
            fields: [
                { label: "Domínio Shopify (.myshopify.com)", value: shopifyDomain, setter: setShopifyDomain, placeholder: "exemplo.myshopify.com", type: "text", helpAnchor: "dominio-shopify" },
                { label: "Admin API Access Token", value: shopifyToken, setter: setShopifyToken, placeholder: "shpat_xxxxxxxxxxxxxxxx", type: "password", helpAnchor: "access-token" },
                { label: "Versão da API", value: shopifyApiVersion, setter: setShopifyApiVersion, placeholder: "2026-01", type: "text", helpAnchor: "api-version" }
            ],
            action: handleShopifyConnect, actionLabel: "Verificar Ligação", isDisabled: !shopifyDomain || !shopifyToken,
        },
        {
            id: 2, title: "Passo 2: Criação de Webhooks", description: "Instale os webhooks para que o Rioko receba as encomendas automaticamente.",
            icon: Webhook, logo: "/images/shopify-logo.webp", logoWidth: 80, isAuthorized: webhooksActive,
            errorMsg: webhookStatus === "error" ? "Falha ao instalar webhooks. Verifica se o token tem permissão write_webhooks." : "",
            fields: [{ label: "Webhook Signing Secret", value: shopifyWebhookSecret, setter: setShopifyWebhookSecret, placeholder: "Ver Shopify Notificações > Webhooks", type: "password", helpAnchor: "webhook-secret" }],
            action: handleWebhooksInstall, actionLabel: webhookStatus === "error" ? "Tentar novamente" : "Instalar Webhooks", isDisabled: !shopifyWebhookSecret, isWebhookStep: true,
        },
        {
            id: 3, title: "Passo 3: Conexão InvoiceXpress", description: "Introduza os detalhes da sua conta InvoiceXpress para ligar as finanças.",
            icon: ClipboardList, logo: "/images/invoicexpress_logo2.png", logoWidth: 100, isAuthorized: ixAuthorized, errorMsg: ixError,
            fields: [
                { label: "Nome da Conta", value: ixAccount, setter: setIxAccount, placeholder: "ultramegasonico", type: "text", helpAnchor: "ix-account" },
                { label: "Chave API", value: ixApiKey, setter: setIxApiKey, placeholder: "••••••••••••••••••••••••", type: "password", helpAnchor: "ix-api-key" },
                { label: "Ambiente", value: ixEnvironment, setter: setIxEnvironment, placeholder: "Insira 'production' ou 'sandbox'", type: "text", helpAnchor: "ix-environment", helpLabel: "O que é?" }
            ],
            action: handleIxConnect, actionLabel: "Verificar Ligação", isDisabled: !ixAccount || !ixApiKey,
        },
        {
            id: 4, title: "Passo 4: Definições de Integração", description: "Defina as regras fiscais e o comportamento da emissão de documentos.",
            icon: Settings2, isAuthorized: true, errorMsg: "", isConfig: true, action: handleSaveSettings, actionLabel: "Guardar", isDisabled: false,
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
                        Shopify + InvoiceXpress
                    </h1>
                    <p className="text-slate-400 font-semibold tracking-wide flex items-center gap-2">
                        Rioko 2.0 Engine <span className="w-1 h-1 rounded-full bg-slate-600" /> Configuração de Automação Fiscal.
                    </p>
                </div>
                <div className="flex items-center gap-5 glass px-5 py-3 rounded-2xl border-slate-800/50">
                    <div className="flex -space-x-2.5">
                        <div className={cn("h-9 w-9 rounded-full ring-4 ring-slate-950 flex items-center justify-center border", shopifyAuthorized ? "bg-emerald-500/10 border-emerald-500/30" : "bg-slate-800/50 border-slate-700/30")}>
                            <Store className={cn("w-4 h-4", shopifyAuthorized ? "text-emerald-400" : "text-slate-600")} />
                        </div>
                        <div className={cn("h-9 w-9 rounded-full ring-4 ring-slate-950 flex items-center justify-center border", webhooksActive ? "bg-violet-500/10 border-violet-500/30" : "bg-slate-800/50 border-slate-700/30")}>
                            <Webhook className={cn("w-4 h-4", webhooksActive ? "text-violet-400" : "text-slate-600")} />
                        </div>
                        <div className={cn("h-9 w-9 rounded-full ring-4 ring-slate-950 flex items-center justify-center border transition-transform", ixAuthorized ? "bg-blue-500/10 border-blue-500/30 translate-x-[2px]" : "bg-slate-800/50 border-slate-700/30")}>
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
                                        <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2.5">
                                            {s.id === 4 && <Settings2 className="w-6 h-6 text-slate-400 group-hover:text-white transition-colors" />}
                                            {s.title}
                                        </h2>
                                        {(isComplete || isActive) && <StatusBadge isAuthorized={s.isAuthorized} errorMsg={s.errorMsg} stepId={s.id} />}
                                        {isActive && <div className="h-1.5 w-1.5 rounded-full bg-accent-blue animate-ping" />}
                                    </div>
                                    <p className="text-slate-400 font-medium leading-relaxed max-w-xl">{s.description}</p>
                                </div>
                                <div className="flex items-center gap-10 w-full lg:w-auto">
                                    {s.logo && <div className={cn("hidden xl:block transition-all duration-700 transform", isActive ? "opacity-100 grayscale-0" : "opacity-20 grayscale", s.id === 3 && "translate-x-3")}><Image src={s.logo} alt={s.title} width={s.logoWidth ?? 80} height={40} className="object-contain" /></div>}
                                    {isActive && (
                                        <div className="flex items-center gap-4 ml-auto">
                                            {step > 1 && <button onClick={() => setStep(step - 1)} className="text-slate-500 hover:text-white text-[10px] font-black uppercase tracking-widest transition-all px-4">Voltar</button>}
                                            {!s.isConfig && (
                                                <button onClick={s.action} disabled={saving || activating || s.isDisabled} className={cn("px-8 py-3.5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center gap-3 transition-all duration-500 transform active:scale-95 group shadow-xl shadow-white/5 disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed", s.isWebhookStep && webhookStatus === "error" ? "bg-rose-500 text-white hover:bg-rose-600" : "bg-white text-black hover:bg-accent-blue hover:text-white")}>
                                                    {(saving || activating) ? <Loader2 className="w-4 h-4 animate-spin" /> : s.actionLabel}
                                                    {!(saving || activating) && <ChevronRight className="w-4 h-4 group-hover:translate-x-1.5 transition-transform" />}
                                                </button>
                                            )}
                                        </div>
                                    )}
                                    {isComplete && <button onClick={() => setStep(s.id)} className="ml-auto bg-slate-800/50 hover:bg-slate-800 text-slate-300 px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all border border-slate-700/50">Atualizar</button>}
                                </div>
                            </div>
                            <motion.div animate={{ height: isActive ? "auto" : 0 }} className="overflow-hidden bg-slate-950/40 border-t border-slate-800/30">
                                {isActive && (
                                    <div className="p-10 pt-8 grid md:grid-cols-2 gap-8 animate-in zoom-in-95 duration-700">
                                        {s.isConfig ? (
                                            <>
                                                <div className="glass p-6 rounded-2xl flex items-center justify-between border-slate-800/50">
                                                    <div>
                                                        <div className="flex items-center gap-3"><h3 className="font-bold text-sm">IVA Incluído</h3><a href="/help#vat" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[9px] font-black text-slate-600 uppercase tracking-widest hover:text-rose-400 transition-colors"><BookOpen className="w-3 h-3" />O que é?</a></div>
                                                        <p className="text-[10px] text-slate-500 font-medium mt-1 uppercase tracking-wider">Os preços no Shopify já incluem IVA</p>
                                                    </div>
                                                    <button onClick={() => setVatIncluded(!vatIncluded)} className={cn("w-12 h-6 rounded-full transition-all duration-500 relative ring-1 ring-inset ring-black/20", vatIncluded ? "bg-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.3)]" : "bg-slate-800")}><div className={cn("absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-500 shadow-sm", vatIncluded ? "left-7" : "left-1")} /></button>
                                                </div>
                                                <div className="glass p-6 rounded-2xl flex items-center justify-between border-slate-800/50">
                                                    <div>
                                                        <div className="flex items-center gap-3"><h3 className="font-bold text-sm">Auto Finalizar</h3><a href="/help#auto-finalize" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[9px] font-black text-slate-600 uppercase tracking-widest hover:text-rose-400 transition-colors"><BookOpen className="w-3 h-3" />O que é?</a></div>
                                                        <p className="text-[10px] text-slate-500 font-medium mt-1 uppercase tracking-wider">Emitir e finalizar documentos imediatamente</p>
                                                    </div>
                                                    <button onClick={() => setAutoFinalize(!autoFinalize)} className={cn("w-12 h-6 rounded-full transition-all duration-500 relative ring-1 ring-inset ring-black/20", autoFinalize ? "bg-accent-blue shadow-[0_0_15px_rgba(56,189,248,0.3)]" : "bg-slate-800")}><div className={cn("absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-500 shadow-sm", autoFinalize ? "left-7" : "left-1")} /></button>
                                                </div>
                                                <div className="md:col-span-2 glass p-6 rounded-2xl border-slate-800/50 space-y-6">
                                                    <div className="flex items-center justify-between">
                                                        <div>
                                                            <div className="flex items-center gap-3"><h3 className="font-bold text-sm">Tipo de Fatura</h3><a href="/help#doc-type" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[9px] font-black text-slate-600 uppercase tracking-widest hover:text-rose-400 transition-colors"><BookOpen className="w-3 h-3" />O que é?</a></div>
                                                            <p className="text-[10px] text-slate-500 font-medium mt-1 uppercase tracking-wider leading-relaxed">{ixDocumentType === "invoice_receipt" ? "Fatura-Recibo: Documento emitido e pago no momento." : "Fatura: Documento emitido para pagamento posterior."}</p>
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
                                                                    <div className="flex-1"><h4 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-1">Prazo de Pagamento (Dias)</h4><p className="text-[9px] text-slate-600 font-bold uppercase">Define quantos dias o cliente tem para pagar</p></div>
                                                                    <div className="w-32 relative"><input type="number" value={ixPaymentTerm} onChange={(e) => setIxPaymentTerm(parseInt(e.target.value) || 0)} className="w-full bg-slate-950/50 border border-slate-800 rounded-xl px-4 py-2 text-sm font-bold text-center focus:ring-2 focus:ring-accent-blue/20 outline-none" /></div>
                                                                </div>
                                                            </motion.div>
                                                        )}
                                                    </AnimatePresence>
                                                </div>
                                                <div className="md:col-span-2 glass p-6 rounded-2xl border-slate-800/50">
                                                    <div className="flex items-center justify-start gap-4 ml-1 mb-4">
                                                        <label className="text-[10px] text-slate-500 font-black uppercase tracking-[0.2em] flex items-center gap-2"><span className="w-1 h-1 rounded-full bg-violet-400" />Série de Faturação</label>
                                                        <a href="/help#billing-sequence" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[9px] font-black text-slate-600 uppercase tracking-widest hover:text-rose-400 transition-colors"><BookOpen className="w-3 h-3" />O que é?</a>
                                                    </div>
                                                    <input type="text" value={ixSequenceName} onChange={(e) => setIxSequenceName(e.target.value)} placeholder="Deixe vazio para usar a série pré-definida no InvoiceXpress" className="w-full bg-slate-950/50 border border-slate-800/80 rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 outline-none transition-all placeholder:text-slate-800" />
                                                </div>
                                                <div className="md:col-span-2 glass p-8 rounded-[2rem] border-slate-800/50 space-y-4">
                                                    <div className="flex items-center gap-3 mb-2"><div className="p-2 bg-amber-500/10 rounded-xl"><Info className="w-4 h-4 text-amber-500" /></div><h3 className="font-bold text-sm tracking-tight">Razão de Isenção (IVA 0%)</h3><a href="/help#exemption" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[9px] font-black text-slate-600 uppercase tracking-widest hover:text-rose-400 transition-colors"><BookOpen className="w-3 h-3" />O que é?</a></div>
                                                    <p className="text-[10px] text-slate-500 font-medium uppercase tracking-wider leading-relaxed">Se algum artigo na Shopify tiver 0% de IVA, esta será a razão de isenção aplicada automaticamente na fatura.</p>
                                                    <div className="relative pt-2">
                                                        <select value={exemptionReason} onChange={(e) => setExemptionReason(e.target.value)} className="w-full bg-slate-900/80 border border-slate-800 rounded-2xl px-6 py-4 text-sm font-bold focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 outline-none transition-all appearance-none cursor-pointer pr-12 text-slate-200">
                                                            {exemptionOptions.map((opt) => (<option key={opt.value} value={opt.value} className="bg-slate-900 py-2">{opt.value} - {opt.label}</option>))}
                                                        </select>
                                                        <div className="absolute right-6 top-[55%] -translate-y-1/2 pointer-events-none opacity-40"><ChevronRight className="w-5 h-5 rotate-90 text-amber-500" /></div>
                                                    </div>
                                                </div>
                                                <div className="md:col-span-2 pt-4"><button onClick={handleSaveSettings} disabled={saving} className="w-full py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-white text-black hover:bg-emerald-400 hover:text-white">{saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Zap className="w-5 h-5" /> Guardar Definições</>}</button></div>
                                            </>
                                        ) : (
                                            s.fields?.map((f: any, i: number) => (
                                                <div key={i} className="space-y-3">
                                                    <div className="flex items-center justify-between ml-1">
                                                        <label className="text-[10px] text-slate-500 font-black uppercase tracking-[0.2em] flex items-center gap-2"><span className="w-1 h-1 rounded-full bg-accent-blue" />{f.label}</label>
                                                        {f.helpAnchor && (<a href={`/help#${f.helpAnchor}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[9px] font-black text-slate-600 uppercase tracking-widest hover:text-rose-400 transition-colors group/help"><BookOpen className="w-3 h-3 group-hover/help:scale-110 transition-transform" />{f.helpLabel || "Onde Encontrar"}</a>)}
                                                    </div>
                                                    <input type={f.type} value={f.value} onChange={(e) => f.setter(e.target.value)} placeholder={f.placeholder} className="w-full bg-slate-950/50 border border-slate-800/80 rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent-blue/20 focus:border-accent-blue outline-none transition-all placeholder:text-slate-800" />
                                                </div>
                                            ))
                                        )}
                                        {s.isWebhookStep && (
                                            <><div className="md:col-span-2 flex items-start gap-4 bg-violet-500/5 border border-violet-500/20 rounded-2xl px-6 py-4"><Webhook className="w-5 h-5 text-violet-400 shrink-0 mt-0.5" /><div><p className="text-sm font-bold text-violet-300">O que são os Webhooks?</p><p className="text-[11px] text-slate-400 mt-1 leading-relaxed">Os webhooks são notificações automáticas que a Shopify envia ao Rioko quando uma encomenda é paga ou um reembolso é criado. O Webhook Signing Secret valida que as notificações são autênticas. Encontra-o em <span className="text-violet-300 font-semibold">Shopify Admin → Definições → Notificações → Webhooks</span>.</p></div></div><div className="md:col-span-2 flex items-start gap-4 bg-slate-900/50 border border-slate-700/40 rounded-2xl px-6 py-4"><AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" /><div className="flex-1"><p className="text-sm font-bold text-amber-300">Token sem permissão write_webhooks?</p><p className="text-[11px] text-slate-400 mt-1 mb-3 leading-relaxed">Se o teu token não tem permissão para instalar webhooks automaticamente, podes instalá-los manualmente no painel Shopify (ver instruções acima) e depois confirmar aqui.</p><div className="flex flex-wrap gap-3"><button onClick={handleWebhooksConfirm} disabled={saving || !shopifyWebhookSecret} className="px-5 py-2.5 rounded-xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2 bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-all disabled:opacity-30 disabled:cursor-not-allowed">{saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}Confirmar Instalação Manual</button><a href="/help#manual-webhooks" target="_blank" rel="noopener noreferrer" className="px-5 py-2.5 rounded-xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2 bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-700 transition-all"><BookOpen className="w-3.5 h-3.5" />Como fazer?</a></div></div></div></>
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
                                <div className="flex items-center gap-8"><div className="w-20 h-20 rounded-[1.8rem] flex items-center justify-center bg-emerald-500/20 ring-2 ring-emerald-400 ring-offset-4 ring-offset-slate-950"><ShieldCheck className="w-10 h-10 text-emerald-400" /></div><div className="space-y-1"><h3 className="text-2xl font-black tracking-tight">Integração Concluída</h3><p className="text-slate-500 font-bold uppercase tracking-widest text-[10px]">A sua conta está configurada e protegida no Rioko 2.0</p></div></div>
                                <div className="px-6 py-3 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] border bg-emerald-500/10 text-emerald-400 border-emerald-500/30">ONLINE • REAL-TIME</div>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-white/5 pt-8">
                                <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-emerald-500/5 border-emerald-500/20"><div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-emerald-500/10"><Store className="w-4 h-4 text-emerald-400" /></div><div><p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Shopify</p><p className="text-xs font-bold text-emerald-400">Autorizado</p></div><Check className="w-4 h-4 text-emerald-400 ml-auto" /></div>
                                <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-emerald-500/5 border-emerald-500/20"><div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-emerald-500/10"><Webhook className="w-4 h-4 text-emerald-400" /></div><div><p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Webhooks</p><p className="text-xs font-bold text-emerald-400">Registados</p></div><Check className="w-4 h-4 text-emerald-400 ml-auto" /></div>
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
