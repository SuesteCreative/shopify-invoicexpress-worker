"use client";

export const runtime = "edge";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Hotel, Building2, Loader2, Check, AlertTriangle, ChevronRight, Settings2, Zap, Info, ShieldCheck, Copy } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { IntegrationStepper, StepperHeader, type StepDef } from "@/components/IntegrationStepper";

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

export default function LodgifyMoloniIntegration() {
    const t = useTranslations("lodgifyMoloniSetup");

    const [step, setStep] = useState(1);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [globalError, setGlobalError] = useState("");
    const [userRole, setUserRole] = useState("");
    const [targetUserId, setTargetUserId] = useState("");

    // Lodgify
    const [apiKey, setApiKey] = useState("");
    const [hasSavedApiKey, setHasSavedApiKey] = useState(false);
    const [lodgifyStatus, setLodgifyStatus] = useState<ConnectionStatus>("");
    const [lodgifyError, setLodgifyError] = useState("");
    const [webhookUrl, setWebhookUrl] = useState("");
    const [webhookManual, setWebhookManual] = useState(false);
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

    // Settings
    const [companyId, setCompanyId] = useState("");
    const [documentSetId, setDocumentSetId] = useState("");
    const [vatIncluded, setVatIncluded] = useState(true);
    const [autoFinalize, setAutoFinalize] = useState(false);
    const [exemptionReason, setExemptionReason] = useState("M01");

    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("");

    const lodgifySaved = hasSavedApiKey && lodgifyStatus === "active";
    const moloniCredsSaved = !!clientId && hasSavedSecret && !!username && hasSavedPassword;
    const settingsSaved = !!companyId && !!documentSetId;
    const allComplete = connectionStatus === "active";

    useEffect(() => {
        fetch("/api/auth/sync", { method: "POST" }).catch(console.error);
        Promise.all([
            fetch("/api/integrations").then(r => r.json()).catch(() => ({})),
            fetch("/api/integrations/lodgify-source?destination_kind=moloni").then(r => r.json()).catch(() => ({})),
            fetch("/api/integrations/moloni-destination?source_kind=lodgify").then(r => r.json()).catch(() => ({})),
        ]).then(([integ, lodgify, moloni]: any) => {
            if (integ?._viewer_role) setUserRole(integ._viewer_role);
            if (integ?.user_id) setTargetUserId(integ.user_id);

            const lConn = lodgify?.connection;
            const lCfg = lConn?.source_config ?? {};
            setHasSavedApiKey(!!lCfg.has_api_key);
            setLodgifyStatus(lConn?.status ?? "");
            if (lConn?.webhook_url) setWebhookUrl(lConn.webhook_url);
            const lodgifyOk = !!lCfg.has_api_key && lConn?.status === "active";

            const mConn = moloni?.connection;
            let credsOk = false, setOk = false, mStatus = "";
            if (mConn) {
                const cfg = mConn.destination_config ?? {};
                setClientId(String(cfg.moloni_client_id ?? ""));
                setHasSavedSecret(!!cfg.has_client_secret);
                setUsername(String(cfg.moloni_username ?? ""));
                setHasSavedPassword(!!cfg.has_password);
                setCompanyId(cfg.moloni_company_id != null ? String(cfg.moloni_company_id) : "");
                setDocumentSetId(cfg.moloni_document_set_id != null ? String(cfg.moloni_document_set_id) : "");
                setEnvironment((cfg.moloni_environment as "production" | "sandbox") ?? "production");
                if (typeof cfg.vat_included === "boolean") setVatIncluded(cfg.vat_included);
                if (typeof cfg.auto_finalize === "boolean") setAutoFinalize(cfg.auto_finalize);
                if (typeof cfg.exemption_reason === "string") setExemptionReason(cfg.exemption_reason);
                setConnectionStatus(mConn.status ?? "");
                credsOk = !!cfg.moloni_client_id && !!cfg.has_client_secret && !!cfg.moloni_username && !!cfg.has_password;
                setOk = !!cfg.moloni_company_id && !!cfg.moloni_document_set_id;
                mStatus = mConn.status ?? "";
            }

            if (mStatus === "active") setStep(5);
            else if (lodgifyOk && credsOk && setOk) setStep(4);
            else if (lodgifyOk && credsOk) setStep(3);
            else if (lodgifyOk) setStep(2);
            else setStep(1);
        }).finally(() => setLoading(false));
    }, []);

    const handleLodgifyStep = async () => {
        setLodgifyError("");
        if (!apiKey.trim() && !hasSavedApiKey) { setLodgifyError(t("errorMissingApiKey")); return; }
        setSaving(true);
        try {
            const body: Record<string, unknown> = { destination_kind: "moloni", status: "active" };
            if (apiKey.trim()) body.api_key = apiKey.trim();
            const res = await fetch("/api/integrations/lodgify-source", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const json: any = await res.json().catch(() => ({}));
            if (!res.ok) { setLodgifyError(json.error ?? `HTTP ${res.status}`); return; }
            if (json.webhook_url) setWebhookUrl(json.webhook_url);
            if (json.needs_manual_webhook) setWebhookManual(true);
            setHasSavedApiKey(true);
            setLodgifyStatus("active");
            setApiKey("");
            setStep(2);
        } catch (e: any) {
            setLodgifyError(e?.message ?? "Unknown error");
        } finally {
            setSaving(false);
        }
    };

    const handleMoloniStep = async () => {
        setMoloniError("");
        if (!clientId.trim() || !username.trim()) { setMoloniError(t("errorMoloniRequired")); return; }
        if (!clientSecret && !hasSavedSecret) { setMoloniError(t("errorMissingSecret")); return; }
        if (!password && !hasSavedPassword) { setMoloniError(t("errorMissingPassword")); return; }
        setSaving(true);
        try {
            const body: Record<string, unknown> = {
                source_kind: "lodgify",
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
            if (!res.ok) { const json: any = await res.json().catch(() => ({})); setMoloniError(json.error ?? `HTTP ${res.status}`); return; }
            if (clientSecret) setHasSavedSecret(true);
            if (password) setHasSavedPassword(true);
            setClientSecret("");
            setPassword("");
            setStep(3);
        } catch (e: any) {
            setMoloniError(e?.message ?? "Unknown error");
        } finally {
            setSaving(false);
        }
    };

    const handleSaveSettings = async () => {
        if (!companyId || !documentSetId) { setGlobalError(t("errorSettingsRequired")); return; }
        setSaving(true);
        setGlobalError("");
        try {
            const res = await fetch("/api/integrations/moloni-destination", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    source_kind: "lodgify",
                    moloni_company_id: companyId,
                    moloni_document_set_id: documentSetId,
                    vat_included: vatIncluded,
                    auto_finalize: autoFinalize,
                    exemption_reason: exemptionReason,
                    status: "draft",
                }),
            });
            if (!res.ok) { const json: any = await res.json().catch(() => ({})); setGlobalError(json.error ?? `HTTP ${res.status}`); return; }
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
                body: JSON.stringify({ source_kind: "lodgify", status: "active" }),
            });
            if (!res.ok) { const json: any = await res.json().catch(() => ({})); setGlobalError(json.error ?? t("errorActivate")); return; }
            setConnectionStatus("active");
            setStep(5);
        } catch (e: any) {
            setGlobalError(e?.message ?? "Unknown error");
        } finally {
            setSaving(false);
        }
    };

    const copyWebhookUrl = () => {
        if (!webhookUrl) return;
        navigator.clipboard.writeText(webhookUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
    };

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
            icon: Hotel,
            logo: "/images/lodgify-logo-white.svg",
            logoWidth: 80,
            isAuthorized: lodgifySaved,
            errorMsg: lodgifyError,
            body: (
                <div className="grid md:grid-cols-2 gap-8">
                    <div className="md:col-span-2 flex items-start gap-4 bg-[rgba(245,158,11,0.05)] border border-[rgba(245,158,11,0.20)] rounded-2xl px-6 py-4">
                        <Info className="w-5 h-5 text-soon shrink-0 mt-0.5" />
                        <div>
                            <p className="text-sm font-bold text-soon">{t("noteTitle")}</p>
                            <p className="text-[11px] text-fg-60 mt-1 leading-relaxed">{t("noteBody")}</p>
                        </div>
                    </div>
                    <div className="md:col-span-2 space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1">
                            <span className="w-1 h-1 rounded-full bg-accent" />{t("apiKeyLabel")}
                        </label>
                        <input
                            type="password"
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            placeholder={hasSavedApiKey ? "••••••••••••" : t("apiKeyPlaceholder")}
                            className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40 font-mono"
                        />
                        <p className="text-[10px] text-fg-40 ml-1">{hasSavedApiKey ? t("apiKeyStoredHint") : t("apiKeyHint")}</p>
                    </div>
                    {webhookUrl && (
                        <div className="md:col-span-2 space-y-2 pt-2">
                            <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] ml-1">{t("webhookSection")}</label>
                            <p className="text-[10px] text-fg-60 ml-1">{t("webhookBody")}</p>
                            <div className="flex items-center gap-2 bg-surface-2 border border-hairline rounded-xl px-4 py-3">
                                <code className="flex-1 text-xs text-fg font-mono break-all">{webhookUrl}</code>
                                <button type="button" onClick={copyWebhookUrl} className="p-2 rounded-lg hover:bg-surface transition-colors flex-shrink-0">
                                    {copied ? <Check className="w-4 h-4 text-accent-hot" /> : <Copy className="w-4 h-4 text-fg-60" />}
                                </button>
                            </div>
                            {webhookManual && (
                                <p className="text-[10px] text-amber-400 ml-1 mt-1">{t("webhookManualNote")}</p>
                            )}
                        </div>
                    )}
                    <div className="md:col-span-2 pt-4">
                        <button
                            onClick={handleLodgifyStep}
                            disabled={saving}
                            className="w-full py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-white text-black hover:bg-accent hover:text-fg disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed"
                        >
                            {saving
                                ? <Loader2 className="w-5 h-5 animate-spin" />
                                : <>{hasSavedApiKey ? t("reconnectLodgify") : t("connectLodgify")} <ChevronRight className="w-4 h-4" /></>
                            }
                        </button>
                        {lodgifyError && <p className="text-[11px] text-destructive font-bold text-center mt-4">{lodgifyError}</p>}
                    </div>
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
                        <input type="text" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="rioko-app" className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40 font-mono" />
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
                        <input type="number" value={companyId} onChange={(e) => setCompanyId(e.target.value)} placeholder="12345" className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40 font-mono" />
                        <p className="text-[10px] text-fg-40 ml-1">{t("companyIdHint")}</p>
                    </div>
                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{t("documentSetIdLabel")}</label>
                        <input type="number" value={documentSetId} onChange={(e) => setDocumentSetId(e.target.value)} placeholder="67890" className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40 font-mono" />
                        <p className="text-[10px] text-fg-40 ml-1">{t("documentSetIdHint")}</p>
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
                        <Link href="/integrations/moloni-mappings?source_kind=lodgify" className="px-5 py-2.5 rounded-xl border border-hairline hover:border-rule text-[10px] font-black uppercase tracking-[0.18em] transition-colors shrink-0">{t("manageMappings")}</Link>
                    </div>
                    <div className="md:col-span-2 pt-4 flex items-center gap-4">
                        <button onClick={() => setStep(2)} className="text-fg-40 hover:text-fg text-[10px] font-black uppercase tracking-widest transition-all px-4">{t("back")}</button>
                        <button onClick={handleSaveSettings} disabled={saving} className="flex-1 py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-white text-black hover:bg-accent-hot hover:text-surface disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed">
                            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Zap className="w-5 h-5" /> {t("saveSettings")}</>}
                        </button>
                    </div>
                    {globalError && <p className="md:col-span-2 text-[11px] text-destructive font-bold text-center">{globalError}</p>}
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
                            <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-[rgba(94,234,212,0.10)]"><Hotel className="w-4 h-4 text-accent-hot" /></div>
                            <div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">Lodgify</p><p className="text-xs font-bold text-accent-hot">{t("configured")}</p></div>
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
                    { icon: Hotel, authorized: lodgifySaved },
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
