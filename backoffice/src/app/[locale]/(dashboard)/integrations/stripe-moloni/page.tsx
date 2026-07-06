"use client";

export const runtime = "edge";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CreditCard, ClipboardList, Loader2, Check, AlertTriangle, ChevronRight, Webhook, Settings2, Zap, Info, ShieldCheck, BookOpen, Copy, Building2 } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { RIOKO_CONFIG } from "@/lib/config";
import { IntegrationStepper, StepperHeader, type StepDef } from "@/components/IntegrationStepper";

const STRIPE_ENABLED = process.env.NEXT_PUBLIC_STRIPE_SOURCE_ENABLED === "1";
const WEBHOOK_URL = `${RIOKO_CONFIG.workerUrl.replace(/\/$/, "")}/webhooks/stripe`;
const RECOMMENDED_EVENTS = ["payment_intent.succeeded", "charge.succeeded", "charge.refunded"];

type ConnectionStatus = "draft" | "active" | "paused" | "error" | "";

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
    { value: "M16", label: "Isento artigo 14.º do RITI" },
    { value: "M20", label: "IVA - regime forfetário" },
    { value: "M99", label: "Não sujeito; não tributado (ou similar)" },
];

export default function StripeMoloniIntegration() {
    const t = useTranslations("stripeMoloniSetup");
    const tCommon = useTranslations("integrationsIndex");

    const [step, setStep] = useState(1);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [globalError, setGlobalError] = useState("");
    const [userRole, setUserRole] = useState("");
    const [targetUserId, setTargetUserId] = useState("");

    // Stripe state
    const [stripeAccountId, setStripeAccountId] = useState("");
    const [restrictedKey, setRestrictedKey] = useState("");
    const [webhookSecret, setWebhookSecret] = useState("");
    const [hasStripeSaved, setHasStripeSaved] = useState(false);
    const [hasWebhookSaved, setHasWebhookSaved] = useState(false);
    const [stripeError, setStripeError] = useState("");
    const [installError, setInstallError] = useState("");
    const [showManualFallback, setShowManualFallback] = useState(false);
    const [copied, setCopied] = useState(false);

    // Moloni creds
    const [clientId, setClientId] = useState("");
    const [clientSecret, setClientSecret] = useState("");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [environment, setEnvironment] = useState<"production" | "sandbox">("production");
    const [hasSavedSecret, setHasSavedSecret] = useState(false);
    const [hasSavedPassword, setHasSavedPassword] = useState(false);
    const [moloniError, setMoloniError] = useState("");

    // Settings — company + série are entered by NAME; the Worker resolves the
    // Moloni IDs from the API lazily at invoice time (same as lodgify-moloni).
    const [companyId, setCompanyId] = useState("");
    const [documentSetId, setDocumentSetId] = useState("");
    const [companyName, setCompanyName] = useState("");
    const [documentSetName, setDocumentSetName] = useState("");
    const [vatIncluded, setVatIncluded] = useState(true);
    const [autoFinalize, setAutoFinalize] = useState(false);
    const [exemptionReason, setExemptionReason] = useState("M01");

    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("");

    const moloniCredsSaved = !!clientId && hasSavedSecret && !!username && hasSavedPassword;
    const settingsSaved = (!!companyId && !!documentSetId) || (!!companyName && !!documentSetName);
    const allComplete = connectionStatus === "active";

    useEffect(() => {
        if (!STRIPE_ENABLED) { setLoading(false); return; }
        fetch("/api/auth/sync", { method: "POST" }).catch(console.error);

        Promise.all([
            fetch("/api/integrations").then(r => r.json()).catch(() => ({})),
            fetch("/api/integrations/stripe-source").then(r => r.json()).catch(() => ({})),
            fetch("/api/integrations/moloni-destination?source_kind=stripe").then(r => r.json()).catch(() => ({})),
        ]).then(([integ, stripe, moloni]: any) => {
            if (integ?._viewer_role) setUserRole(integ._viewer_role);
            if (integ?.user_id) setTargetUserId(integ.user_id);

            const conn = stripe?.connection;
            const sCfg = conn?.source_config ?? {};
            if (sCfg.stripe_account_id) setStripeAccountId(sCfg.stripe_account_id);
            const stripeSaved = !!sCfg.stripe_account_id;
            const webhookSaved = !!sCfg.has_webhook_secret;
            setHasStripeSaved(stripeSaved);
            setHasWebhookSaved(webhookSaved);

            const mConn = moloni?.connection;
            if (mConn) {
                const cfg = mConn.destination_config ?? {};
                setClientId(String(cfg.moloni_client_id ?? ""));
                setHasSavedSecret(!!cfg.has_client_secret);
                setUsername(String(cfg.moloni_username ?? ""));
                setHasSavedPassword(!!cfg.has_password);
                setCompanyId(cfg.moloni_company_id != null ? String(cfg.moloni_company_id) : "");
                setDocumentSetId(cfg.moloni_document_set_id != null ? String(cfg.moloni_document_set_id) : "");
                setCompanyName(cfg.moloni_company_name ? String(cfg.moloni_company_name) : "");
                setDocumentSetName(cfg.moloni_document_set_name ? String(cfg.moloni_document_set_name) : "");
                setEnvironment((cfg.moloni_environment as "production" | "sandbox") ?? "production");
                if (typeof cfg.vat_included === "boolean") setVatIncluded(cfg.vat_included);
                if (typeof cfg.auto_finalize === "boolean") setAutoFinalize(cfg.auto_finalize);
                if (typeof cfg.exemption_reason === "string") setExemptionReason(cfg.exemption_reason);
                setConnectionStatus(mConn.status ?? "");
            }

            // Smart resume
            const credsOk = !!cfg_clientId(mConn) && !!cfg_hasSecret(mConn) && !!cfg_username(mConn) && !!cfg_hasPassword(mConn);
            const setOk = (!!cfg_companyId(mConn) && !!cfg_docSet(mConn)) || (!!mConn?.destination_config?.moloni_company_name && !!mConn?.destination_config?.moloni_document_set_name);
            const status = mConn?.status ?? "";
            if (status === "active") setStep(5);
            else if (stripeSaved && webhookSaved && credsOk && setOk) setStep(4);
            else if (stripeSaved && webhookSaved && credsOk) setStep(3);
            else if (stripeSaved && webhookSaved) setStep(2);
            else setStep(1);
        }).finally(() => setLoading(false));
    }, []);

    function cfg_clientId(c: any) { return c?.destination_config?.moloni_client_id; }
    function cfg_hasSecret(c: any) { return c?.destination_config?.has_client_secret; }
    function cfg_username(c: any) { return c?.destination_config?.moloni_username; }
    function cfg_hasPassword(c: any) { return c?.destination_config?.has_password; }
    function cfg_companyId(c: any) { return c?.destination_config?.moloni_company_id; }
    function cfg_docSet(c: any) { return c?.destination_config?.moloni_document_set_id; }

    const postStripeSource = async (patch: Record<string, any>) => {
        return fetch("/api/integrations/stripe-source", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                stripe_account_id: stripeAccountId,
                destination_kind: "moloni",
                ...patch
            })
        });
    };

    const handleStripeStep = async () => {
        if (!stripeAccountId.trim() || !restrictedKey.trim()) return;
        setSaving(true);
        setStripeError("");
        setInstallError("");
        try {
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
                return;
            }
            setHasWebhookSaved(true);
            setStep(2);
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
            const res = await postStripeSource({ webhook_secret: webhookSecret.trim(), status: "draft" });
            if (!res.ok) {
                const data: any = await res.json().catch(() => ({}));
                setStripeError(data.error || t("errorSaveWebhookSecret"));
                return;
            }
            setHasWebhookSaved(true);
            setShowManualFallback(false);
            setStep(2);
        } catch (e: any) {
            setStripeError(t("errorNetwork", { message: e.message }));
        } finally {
            setSaving(false);
        }
    };

    const handleMoloniStep = async () => {
        setMoloniError("");
        if (!clientId.trim() || !username.trim()) {
            setMoloniError(t("errorMoloniRequired"));
            return;
        }
        if (!clientSecret && !hasSavedSecret) { setMoloniError(t("errorMissingSecret")); return; }
        if (!password && !hasSavedPassword) { setMoloniError(t("errorMissingPassword")); return; }
        setSaving(true);
        try {
            const body: Record<string, unknown> = {
                source_kind: "stripe",
                moloni_client_id: clientId,
                moloni_username: username,
                moloni_environment: environment,
                status: "draft",
            };
            if (clientSecret) body.moloni_client_secret = clientSecret;
            if (password) body.moloni_password = password;

            const res = await fetch("/api/integrations/moloni-destination", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const json: any = await res.json().catch(() => ({}));
                setMoloniError(json.error ?? `HTTP ${res.status}`);
                return;
            }
            if (clientSecret) setHasSavedSecret(true);
            if (password) setHasSavedPassword(true);
            setClientSecret("");
            setPassword("");
            // Validate the credentials actually authenticate against Moloni (a
            // background grant via the companies proxy) before advancing — instant
            // ✓/✗ instead of discovering a bad login at invoice time.
            const valRes = await fetch("/api/integrations/moloni-destination/companies?source_kind=stripe");
            if (!valRes.ok) {
                const vjson: any = await valRes.json().catch(() => ({}));
                setMoloniError(vjson.error ?? t("errorMoloniAuth"));
                return;
            }
            setStep(3);
        } catch (e: any) {
            setMoloniError(e?.message ?? "Unknown error");
        } finally {
            setSaving(false);
        }
    };

    const handleSaveSettings = async () => {
        if (!companyName.trim() || !documentSetName.trim()) {
            setGlobalError(t("errorSettingsRequired"));
            return;
        }
        setSaving(true);
        setGlobalError("");
        try {
            const body: Record<string, unknown> = {
                source_kind: "stripe",
                moloni_company_name: companyName.trim(),
                moloni_document_set_name: documentSetName.trim(),
                vat_included: vatIncluded,
                auto_finalize: autoFinalize,
                exemption_reason: exemptionReason,
                status: "draft",
            };
            const res = await fetch("/api/integrations/moloni-destination", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const json: any = await res.json().catch(() => ({}));
                setGlobalError(json.error ?? `HTTP ${res.status}`);
                return;
            }
            setStep(4);
        } catch (e: any) {
            setGlobalError(e?.message ?? "Unknown error");
        } finally {
            setSaving(false);
        }
    };

    const handleActivate = async () => {
        setSaving(true);
        setGlobalError("");
        try {
            const res = await fetch("/api/integrations/moloni-destination", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ source_kind: "stripe", status: "active" }),
            });
            if (!res.ok) {
                const json: any = await res.json().catch(() => ({}));
                setGlobalError(json.error ?? t("errorActivate"));
                return;
            }
            setConnectionStatus("active");
            setStep(5);
        } catch (e: any) {
            setGlobalError(e?.message ?? "Unknown error");
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

    if (!STRIPE_ENABLED) {
        return (
            <div className="max-w-3xl mx-auto py-24 space-y-8">
                <Link href="/integrations" className="text-[10px] font-black text-accent uppercase tracking-widest flex items-center gap-2"><ChevronRight className="w-3 h-3 rotate-180" /> {t("backToIntegrations")}</Link>
                <div className="glass rounded-[2.5rem] p-12 border-[rgba(245,158,11,0.20)] bg-[rgba(245,158,11,0.04)] text-center">
                    <h1 className="text-2xl font-black tracking-tight mb-2">{t("disabledTitle")}</h1>
                    <p className="text-fg-60 text-sm">{t("disabledBody")}</p>
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

    const labels = {
        update: t("update"),
        back: t("back"),
        statusAuthorized: t("statusAuthorized"),
        statusPending: t("statusPending"),
        diagnostic: t("diagnostic"),
        diagnosticSub: t("diagnosticSub"),
        diagnosticDefault: t("diagnosticDefault"),
        forceAuth: t("forceAuth"),
        areYouSure: t("areYouSure"),
        cancelAction: t("cancelAction"),
        alertForceAuthError: t("alertForceAuthError"),
    };

    const steps: StepDef[] = [
        {
            id: 1,
            title: t("step1Title"),
            description: t("step1Desc"),
            icon: CreditCard,
            logo: "/images/stripe-logo.svg",
            logoWidth: 60,
            isAuthorized: hasStripeSaved && hasWebhookSaved,
            errorMsg: stripeError || installError,
            body: (
                <div className="grid md:grid-cols-2 gap-8">
                    <div className="md:col-span-2 flex items-start gap-4 bg-[rgba(2,141,196,0.05)] border border-[rgba(2,141,196,0.20)] rounded-2xl px-6 py-4">
                        <Info className="w-5 h-5 text-accent shrink-0 mt-0.5" />
                        <div>
                            <p className="text-sm font-bold text-accent">{t("restrictedKeyHowTitle")}</p>
                            <ol className="text-[11px] text-fg-60 mt-2 leading-relaxed list-decimal pl-4 space-y-1">
                                <li>{t("restrictedKeyStep1")}</li>
                                <li>{t("restrictedKeyStep2")}</li>
                                <li>{t("restrictedKeyStep3")}</li>
                                <li>{t("restrictedKeyStep4")}</li>
                            </ol>
                        </div>
                    </div>
                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{t("stripeAccountIdLabel")}</label>
                        <input type="text" value={stripeAccountId} onChange={(e) => setStripeAccountId(e.target.value)} placeholder={t("stripeAccountIdPlaceholder")} className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40" />
                    </div>
                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{t("restrictedKeyLabel")}</label>
                        <input type="password" value={restrictedKey} onChange={(e) => setRestrictedKey(e.target.value)} placeholder={t("restrictedKeyPlaceholder")} className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40" />
                    </div>
                    <div className="md:col-span-2 pt-4">
                        <button onClick={handleStripeStep} disabled={saving || !stripeAccountId.trim() || !restrictedKey.trim()} className="w-full py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-white text-black hover:bg-accent hover:text-fg disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed">
                            {saving ? <><Loader2 className="w-5 h-5 animate-spin" /> {t("installingWebhook")}</> : <><Webhook className="w-4 h-4" /> {t("connectStripe")}</>}
                        </button>
                        {installError && <p className="text-[11px] text-destructive font-bold text-center mt-4">{installError}</p>}
                    </div>
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
                                        <p className="text-[10px] text-fg-40 ml-1 mt-1">{t("eventsToSelect", { events: RECOMMENDED_EVENTS.join(", ") })}</p>
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
            ),
        },
        {
            id: 2,
            title: t("step2Title"),
            description: t("step2Desc"),
            icon: Building2,
            logo: "/images/moloni-logo.svg",
            logoWidth: 60,
            isAuthorized: moloniCredsSaved,
            errorMsg: moloniError,
            body: (
                <div className="grid md:grid-cols-2 gap-8">
                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{t("clientIdLabel")}</label>
                        <input type="text" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={t("clientIdPlaceholder")} className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40 font-mono" />
                        <p className="text-[10px] text-fg-40 ml-1">{t("clientIdHint")}</p>
                    </div>
                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{t("clientSecretLabel")}</label>
                        <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={hasSavedSecret ? "••••••••••••" : ""} className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40 font-mono" />
                        {hasSavedSecret && <p className="text-[10px] text-fg-40 ml-1">{t("secretStoredHint")}</p>}
                    </div>
                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{t("usernameLabel")}</label>
                        <input type="email" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="rioko@minhaempresa.pt" className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40" />
                    </div>
                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{t("passwordLabel")}</label>
                        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={hasSavedPassword ? "••••••••••••" : ""} className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40" />
                        {hasSavedPassword && <p className="text-[10px] text-fg-40 ml-1">{t("passwordStoredHint")}</p>}
                    </div>
                    <div className="md:col-span-2 space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{t("environmentLabel")}</label>
                        <div className="flex gap-3">
                            <button type="button" onClick={() => setEnvironment("production")} className={`flex-1 px-4 py-3 rounded-xl border text-sm font-mono uppercase tracking-[0.18em] transition-colors ${environment === "production" ? "border-accent bg-[rgba(2,141,196,0.10)] text-accent" : "border-hairline text-fg-60 hover:border-rule"}`}>{t("envProduction")}</button>
                            <button type="button" onClick={() => setEnvironment("sandbox")} className={`flex-1 px-4 py-3 rounded-xl border text-sm font-mono uppercase tracking-[0.18em] transition-colors ${environment === "sandbox" ? "border-accent bg-[rgba(2,141,196,0.10)] text-accent" : "border-hairline text-fg-60 hover:border-rule"}`}>{t("envSandbox")}</button>
                        </div>
                    </div>
                    <div className="md:col-span-2 pt-4 flex items-center gap-4">
                        <button onClick={() => setStep(1)} className="text-fg-40 hover:text-fg text-[10px] font-black uppercase tracking-widest transition-all px-4">{t("back")}</button>
                        <button onClick={handleMoloniStep} disabled={saving} className="flex-1 py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-white text-black hover:bg-accent hover:text-fg disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed">
                            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <>{t("saveMoloni")} <ChevronRight className="w-4 h-4" /></>}
                        </button>
                    </div>
                    {moloniError && <p className="md:col-span-2 text-[11px] text-destructive font-bold text-center">{moloniError}</p>}
                </div>
            ),
        },
        {
            id: 3,
            title: t("step3Title"),
            description: t("step3Desc"),
            icon: Settings2,
            hasGearLogo: true,
            isConfig: true,
            isAuthorized: settingsSaved,
            body: (
                <div className="grid md:grid-cols-2 gap-8">
                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{t("companyIdLabel")}</label>
                        <input type="text" value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Kapta, Lda" className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40" />
                        <p className="text-[10px] text-fg-40 ml-1">{t("companyNameHint")}</p>
                    </div>
                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{t("documentSetIdLabel")}</label>
                        <input type="text" value={documentSetName} onChange={(e) => setDocumentSetName(e.target.value)} placeholder="FR2026" className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40 font-mono" />
                        <p className="text-[10px] text-fg-40 ml-1">{t("documentSetNameHint")}</p>
                    </div>
                    <div className="glass p-6 rounded-2xl flex items-center justify-between border-hairline">
                        <div>
                            <h3 className="font-bold text-sm">{t("vatIncluded")}</h3>
                            <p className="text-[10px] text-fg-40 font-medium mt-1 uppercase tracking-wider">{vatIncluded ? t("vatIncludedOn") : t("vatIncludedOff")}</p>
                        </div>
                        <button onClick={() => setVatIncluded(!vatIncluded)} className={`w-12 h-6 rounded-full transition-all duration-500 relative ring-1 ring-inset ring-black/20 ${vatIncluded ? "bg-accent-hot" : "bg-surface-2"}`}><div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-500 ${vatIncluded ? "left-7" : "left-1"}`} /></button>
                    </div>
                    <div className="glass p-6 rounded-2xl flex items-center justify-between border-hairline">
                        <div>
                            <h3 className="font-bold text-sm">{t("autoFinalize")}</h3>
                            <p className="text-[10px] text-fg-40 font-medium mt-1 uppercase tracking-wider">{t("autoFinalizeDesc")}</p>
                        </div>
                        <button onClick={() => setAutoFinalize(!autoFinalize)} className={`w-12 h-6 rounded-full transition-all duration-500 relative ring-1 ring-inset ring-black/20 ${autoFinalize ? "bg-accent" : "bg-surface-2"}`}><div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-500 ${autoFinalize ? "left-7" : "left-1"}`} /></button>
                    </div>
                    <div className="md:col-span-2 glass p-5 sm:p-8 rounded-[2rem] border-hairline space-y-4">
                        <div className="flex items-center gap-3 mb-2"><div className="p-2 bg-[rgba(245,158,11,0.10)] rounded-xl"><Info className="w-4 h-4 text-soon" /></div><h3 className="font-bold text-sm tracking-tight">{t("exemptionTitle")}</h3></div>
                        <p className="text-[10px] text-fg-40 font-medium uppercase tracking-wider leading-relaxed">{t("exemptionDesc")}</p>
                        <select value={exemptionReason} onChange={(e) => setExemptionReason(e.target.value)} className="w-full bg-surface-2/80 border border-hairline rounded-2xl px-6 py-4 text-sm font-bold focus:ring-2 focus:ring-[rgba(245,158,11,0.20)] focus:border-soon outline-none transition-all cursor-pointer text-fg">
                            {exemptionOptions.map((opt) => (<option key={opt.value} value={opt.value} className="bg-surface-2">{opt.value} - {opt.label}</option>))}
                        </select>
                    </div>
                    <div className="md:col-span-2 glass p-5 sm:p-6 rounded-2xl border-hairline flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3 min-w-0">
                            <div className="p-2 bg-[rgba(2,141,196,0.10)] rounded-xl shrink-0"><Building2 className="w-4 h-4 text-accent" /></div>
                            <div className="min-w-0">
                                <h3 className="font-bold text-sm">{t("productMappingsTitle")}</h3>
                                <p className="text-[10px] text-fg-40 font-medium mt-0.5 uppercase tracking-wider truncate">{t("productMappingsDesc")}</p>
                            </div>
                        </div>
                        <Link href="/integrations/moloni-mappings?source_kind=stripe" className="px-5 py-2.5 rounded-xl border border-hairline hover:border-rule text-[10px] font-black uppercase tracking-[0.18em] transition-colors shrink-0">{t("manageMappings")}</Link>
                    </div>
                    <div className="md:col-span-2 glass p-5 sm:p-6 rounded-2xl border-hairline flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3 min-w-0">
                            <div className="p-2 bg-[rgba(2,141,196,0.10)] rounded-xl shrink-0"><Zap className="w-4 h-4 text-accent" /></div>
                            <div className="min-w-0">
                                <h3 className="font-bold text-sm">{t("tagRoutingTitle")}</h3>
                                <p className="text-[10px] text-fg-40 font-medium mt-0.5 uppercase tracking-wider truncate">{t("tagRoutingDesc")}</p>
                            </div>
                        </div>
                        <Link href="/integrations/tag-routing?source_kind=stripe&destination_kind=moloni" className="px-5 py-2.5 rounded-xl border border-hairline hover:border-rule text-[10px] font-black uppercase tracking-[0.18em] transition-colors shrink-0">{t("manageTagRouting")}</Link>
                    </div>
                    <div className="md:col-span-2 pt-4 flex items-center gap-4">
                        <button onClick={() => setStep(2)} className="text-fg-40 hover:text-fg text-[10px] font-black uppercase tracking-widest transition-all px-4">{t("back")}</button>
                        <button onClick={handleSaveSettings} disabled={saving} className="flex-1 py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-white text-black hover:bg-accent-hot hover:text-surface disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed">
                            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Zap className="w-5 h-5" /> {t("saveSettings")}</>}
                        </button>
                    </div>
                </div>
            ),
        },
        {
            id: 4,
            title: t("activateTitle"),
            description: t("activateDesc"),
            icon: Zap,
            isAuthorized: connectionStatus === "active",
            body: (
                <div className="space-y-8">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-[rgba(94,234,212,0.05)] border-[rgba(94,234,212,0.20)]">
                            <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-[rgba(94,234,212,0.10)]"><CreditCard className="w-4 h-4 text-accent-hot" /></div>
                            <div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">{t("stripeLabel")}</p><p className="text-xs font-bold text-accent-hot">{t("configured")}</p></div>
                            <Check className="w-4 h-4 text-accent-hot ml-auto" />
                        </div>
                        <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-[rgba(94,234,212,0.05)] border-[rgba(94,234,212,0.20)]">
                            <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-[rgba(94,234,212,0.10)]"><Building2 className="w-4 h-4 text-accent-hot" /></div>
                            <div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">{t("moloniLabel")}</p><p className="text-xs font-bold text-accent-hot">{t("statusAuthorized")}</p></div>
                            <Check className="w-4 h-4 text-accent-hot ml-auto" />
                        </div>
                        <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-[rgba(94,234,212,0.05)] border-[rgba(94,234,212,0.20)]">
                            <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-[rgba(94,234,212,0.10)]"><Settings2 className="w-4 h-4 text-accent-hot" /></div>
                            <div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">{t("settingsLabel")}</p><p className="text-xs font-bold text-accent-hot">{t("configured")}</p></div>
                            <Check className="w-4 h-4 text-accent-hot ml-auto" />
                        </div>
                    </div>
                    <div className="flex items-start gap-4 bg-surface-2/50 border border-hairline rounded-2xl px-6 py-4">
                        <AlertTriangle className="w-5 h-5 text-soon shrink-0 mt-0.5" />
                        <p className="text-[11px] text-fg-60 leading-relaxed">{t("activateWarning")}</p>
                    </div>
                    <button onClick={handleActivate} disabled={saving || connectionStatus === "active"} className="w-full py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-white text-black hover:bg-accent-hot hover:text-surface disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed">
                        {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Zap className="w-5 h-5" /> {connectionStatus === "active" ? t("currentlyActive") : t("markAsActive")}</>}
                    </button>
                    {globalError && <p className="text-[11px] text-destructive font-bold text-center">{globalError}</p>}
                </div>
            ),
        },
    ];

    return (
        <div className="space-y-12 animate-in fade-in duration-1000 slide-in-from-bottom-4">
            <StepperHeader
                backHref="/integrations"
                backLabel={t("backToIntegrations")}
                title={t("pageTitle")}
                subtitle={t("engineSubtitle")}
                providers={[
                    { icon: CreditCard, authorized: hasStripeSaved && hasWebhookSaved },
                    { icon: Building2, authorized: moloniCredsSaved },
                    { icon: Settings2, authorized: settingsSaved, color: "accentHot" },
                ]}
                allComplete={allComplete}
                syncStateLabel={t("syncState")}
                realtimeOnLabel={t("realtimeOn")}
                waitingLabel={t("waitingConnection")}
            />

            <IntegrationStepper
                steps={steps}
                step={step}
                setStep={setStep}
                userRole={userRole}
                targetUserId={targetUserId}
                saving={saving}
                labels={labels}
            />

            {allComplete && (
                <motion.div initial={{ opacity: 0, y: 20, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.6 }} className="rounded-[2.5rem] p-1 shadow-2xl bg-[rgba(94,234,212,0.10)]">
                    <div className="bg-surface rounded-[2.3rem] p-6 sm:p-10 flex flex-col gap-8 border border-white/5">
                        <div className="flex flex-col md:flex-row items-center justify-between gap-8">
                            <div className="flex items-center gap-8">
                                <div className="w-20 h-20 rounded-[1.8rem] flex items-center justify-center bg-[rgba(94,234,212,0.18)] ring-2 ring-accent-hot ring-offset-4 ring-offset-surface"><ShieldCheck className="w-10 h-10 text-accent-hot" /></div>
                                <div className="space-y-1"><h3 className="text-2xl font-black tracking-tight">{t("integrationDoneTitle")}</h3><p className="text-fg-40 font-bold uppercase tracking-widest text-[10px]">{t("integrationDoneSub")}</p></div>
                            </div>
                            <div className="px-6 py-3 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] border bg-[rgba(94,234,212,0.10)] text-accent-hot border-[rgba(94,234,212,0.30)]">{t("onlineRealtime")}</div>
                        </div>
                    </div>
                </motion.div>
            )}
        </div>
    );
}
