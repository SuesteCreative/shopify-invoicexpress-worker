"use client";

export const runtime = "edge";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Store, Loader2, Check, AlertTriangle, ChevronRight, Settings2, Zap, Info, ShieldCheck, Receipt } from "lucide-react";
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

export default function ShopifyVendusIntegration() {
    const t = useTranslations("shopifyVendusSetup");

    const [step, setStep] = useState(1);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [globalError, setGlobalError] = useState("");
    const [userRole, setUserRole] = useState("");
    const [targetUserId, setTargetUserId] = useState("");

    // Shopify
    const [shopifyDomain, setShopifyDomain] = useState("");
    const [shopifyToken, setShopifyToken] = useState("");
    const [shopifyApiVersion, setShopifyApiVersion] = useState("2026-01");
    const [shopifyAuthorized, setShopifyAuthorized] = useState(false);
    const [shopifyError, setShopifyError] = useState("");

    // Vendus creds
    const [apiKey, setApiKey] = useState("");
    const [environment, setEnvironment] = useState<"production" | "sandbox">("production");
    const [hasSavedApiKey, setHasSavedApiKey] = useState(false);
    const [vendusError, setVendusError] = useState("");

    // Settings
    const [registerId, setRegisterId] = useState("");
    const [seriesId, setSeriesId] = useState("");
    const [vatIncluded, setVatIncluded] = useState(true);
    const [autoFinalize, setAutoFinalize] = useState(false);
    const [exemptionReason, setExemptionReason] = useState("M01");

    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("");

    const vendusCredsSaved = hasSavedApiKey;
    const settingsSaved = !!registerId && !!seriesId;
    const allComplete = connectionStatus === "active";

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [integRes, vendusRes] = await Promise.all([
                    fetch("/api/integrations"),
                    fetch("/api/integrations/vendus-destination?source_kind=shopify"),
                ]);
                if (cancelled) return;

                let shopOk = false;
                if (integRes.ok) {
                    const data = await integRes.json() as any;
                    if (data._viewer_role) setUserRole(data._viewer_role);
                    if (data.user_id) setTargetUserId(data.user_id);
                    if (data.shopify_domain) setShopifyDomain(data.shopify_domain);
                    if (data.shopify_token) setShopifyToken(data.shopify_token);
                    if (data.shopify_api_version) setShopifyApiVersion(data.shopify_api_version);
                    shopOk = !!data.shopify_domain && data.shopify_authorized === 1;
                    setShopifyAuthorized(shopOk);
                }

                let credsOk = false, setOk = false, vStatus = "";
                if (vendusRes.ok) {
                    const data = await vendusRes.json() as { connection?: { status: ConnectionStatus; destination_config: Record<string, unknown> } | null };
                    if (data.connection) {
                        const cfg = data.connection.destination_config;
                        setHasSavedApiKey(!!cfg.has_api_key);
                        setRegisterId(cfg.vendus_register_id != null ? String(cfg.vendus_register_id) : "");
                        setSeriesId(cfg.vendus_series_id != null ? String(cfg.vendus_series_id) : "");
                        setEnvironment((cfg.vendus_environment as "production" | "sandbox") ?? "production");
                        if (typeof cfg.vat_included === "boolean") setVatIncluded(cfg.vat_included);
                        if (typeof cfg.auto_finalize === "boolean") setAutoFinalize(cfg.auto_finalize);
                        if (typeof cfg.exemption_reason === "string") setExemptionReason(cfg.exemption_reason);
                        setConnectionStatus(data.connection.status);
                        credsOk = !!cfg.has_api_key;
                        setOk = !!cfg.vendus_register_id && !!cfg.vendus_series_id;
                        vStatus = data.connection.status;
                    }
                }

                if (vStatus === "active") setStep(5);
                else if (shopOk && credsOk && setOk) setStep(4);
                else if (shopOk && credsOk) setStep(3);
                else if (shopOk) setStep(2);
                else setStep(1);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const handleShopifyStep = async () => {
        setShopifyError("");
        if (!shopifyDomain.trim() || !shopifyToken.trim()) { setShopifyError(t("errorShopifyRequired")); return; }
        setSaving(true);
        try {
            const saveRes = await fetch("/api/integrations", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    shopify_domain: shopifyDomain.trim(),
                    shopify_token: shopifyToken.trim(),
                    shopify_api_version: shopifyApiVersion.trim() || "2026-01",
                }),
            });
            if (!saveRes.ok) {
                const json: any = await saveRes.json().catch(() => ({}));
                setShopifyError(json.error || t("errorSaveShopify"));
                return;
            }
            const valRes = await fetch("/api/integrations/validate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "shopify" }),
            });
            const valData: any = await valRes.json().catch(() => ({}));
            if (!valData.isValid) {
                setShopifyError(valData.error || t("errorShopifyInvalid"));
                return;
            }
            setShopifyAuthorized(true);
            setStep(2);
        } catch (e: any) {
            setShopifyError(t("errorNetwork", { message: e.message }));
        } finally {
            setSaving(false);
        }
    };

    const handleVendusStep = async () => {
        setVendusError("");
        if (!apiKey && !hasSavedApiKey) { setVendusError(t("errorMissingApiKey")); return; }
        setSaving(true);
        try {
            const body: Record<string, unknown> = {
                source_kind: "shopify",
                vendus_environment: environment,
                status: "draft",
            };
            if (apiKey) body.vendus_api_key = apiKey;
            const res = await fetch("/api/integrations/vendus-destination", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const json: any = await res.json().catch(() => ({}));
                setVendusError(json.error ?? `HTTP ${res.status}`);
                return;
            }
            if (apiKey) setHasSavedApiKey(true);
            setApiKey("");
            setStep(3);
        } catch (e: any) {
            setVendusError(e?.message ?? "Unknown error");
        } finally {
            setSaving(false);
        }
    };

    const handleSaveSettings = async () => {
        if (!registerId || !seriesId) { setGlobalError(t("errorSettingsRequired")); return; }
        setSaving(true);
        setGlobalError("");
        try {
            const body: Record<string, unknown> = {
                source_kind: "shopify",
                vendus_register_id: registerId,
                vendus_series_id: seriesId,
                vat_included: vatIncluded,
                auto_finalize: autoFinalize,
                exemption_reason: exemptionReason,
                status: "draft",
            };
            const res = await fetch("/api/integrations/vendus-destination", {
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
            const res = await fetch("/api/integrations/vendus-destination", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ source_kind: "shopify", status: "active" }),
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
            icon: Store,
            logo: "/images/shopify-logo.webp",
            logoWidth: 80,
            isAuthorized: shopifyAuthorized,
            errorMsg: shopifyError,
            body: (
                <div className="grid md:grid-cols-2 gap-8">
                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{t("shopifyDomainLabel")}</label>
                        <input type="text" value={shopifyDomain} onChange={(e) => setShopifyDomain(e.target.value)} placeholder="meu-shop.myshopify.com" className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40 font-mono" />
                    </div>
                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{t("shopifyTokenLabel")}</label>
                        <input type="password" value={shopifyToken} onChange={(e) => setShopifyToken(e.target.value)} placeholder="shpat_••••••••" className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40 font-mono" />
                    </div>
                    <div className="md:col-span-2 space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{t("shopifyApiVersionLabel")}</label>
                        <input type="text" value={shopifyApiVersion} onChange={(e) => setShopifyApiVersion(e.target.value)} placeholder="2026-01" className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40 font-mono" />
                    </div>
                    <div className="md:col-span-2 pt-4">
                        <button onClick={handleShopifyStep} disabled={saving || !shopifyDomain.trim() || !shopifyToken.trim()} className="w-full py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-white text-black hover:bg-accent hover:text-fg disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed">
                            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <>{t("verifyConnection")} <ChevronRight className="w-4 h-4" /></>}
                        </button>
                        {shopifyError && <p className="text-[11px] text-destructive font-bold text-center mt-4">{shopifyError}</p>}
                    </div>
                </div>
            ),
        },
        {
            id: 2,
            title: t("step2Title"),
            description: t("step2Desc"),
            icon: Receipt,
            logo: "/images/vendus-logo.svg",
            logoWidth: 60,
            isAuthorized: vendusCredsSaved,
            errorMsg: vendusError,
            body: (
                <div className="grid md:grid-cols-2 gap-8">
                    <div className="md:col-span-2 space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{t("apiKeyLabel")}</label>
                        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={hasSavedApiKey ? "••••••••••••" : ""} className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40 font-mono" />
                        <p className="text-[10px] text-fg-40 ml-1">{hasSavedApiKey ? t("apiKeyStoredHint") : t("apiKeyHint")}</p>
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
                        <button onClick={handleVendusStep} disabled={saving} className="flex-1 py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-white text-black hover:bg-accent hover:text-fg disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed">
                            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <>{t("saveVendus")} <ChevronRight className="w-4 h-4" /></>}
                        </button>
                    </div>
                    {vendusError && <p className="md:col-span-2 text-[11px] text-destructive font-bold text-center">{vendusError}</p>}
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
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{t("registerIdLabel")}</label>
                        <input type="number" value={registerId} onChange={(e) => setRegisterId(e.target.value)} placeholder="1234" className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40 font-mono" />
                        <p className="text-[10px] text-fg-40 ml-1">{t("registerIdHint")}</p>
                    </div>
                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{t("seriesIdLabel")}</label>
                        <input type="text" value={seriesId} onChange={(e) => setSeriesId(e.target.value)} placeholder="01P2026" className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40 font-mono" />
                        <p className="text-[10px] text-fg-40 ml-1">{t("seriesIdHint")}</p>
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
                            <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-[rgba(94,234,212,0.10)]"><Store className="w-4 h-4 text-accent-hot" /></div>
                            <div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">{t("shopifyLabel")}</p><p className="text-xs font-bold text-accent-hot">{t("statusAuthorized")}</p></div>
                            <Check className="w-4 h-4 text-accent-hot ml-auto" />
                        </div>
                        <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-[rgba(94,234,212,0.05)] border-[rgba(94,234,212,0.20)]">
                            <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-[rgba(94,234,212,0.10)]"><Receipt className="w-4 h-4 text-accent-hot" /></div>
                            <div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">{t("vendusLabel")}</p><p className="text-xs font-bold text-accent-hot">{t("statusAuthorized")}</p></div>
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
                    { icon: Store, authorized: shopifyAuthorized },
                    { icon: Receipt, authorized: vendusCredsSaved },
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
