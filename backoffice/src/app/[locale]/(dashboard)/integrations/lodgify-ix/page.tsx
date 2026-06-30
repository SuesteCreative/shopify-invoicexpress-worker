"use client";

export const runtime = "edge";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Hotel, ClipboardList, Loader2, Check, AlertTriangle, ChevronRight, Settings2, Zap, Info, ShieldCheck, Copy } from "lucide-react";
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

export default function LodgifyIxIntegration() {
    const t = useTranslations("lodgifyIxSetup");

    const [step, setStep] = useState(1);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [globalError, setGlobalError] = useState("");
    const [userRole, setUserRole] = useState("");
    const [targetUserId, setTargetUserId] = useState("");

    // Lodgify
    const [apiKey, setApiKey] = useState("");
    const [hasSavedApiKey, setHasSavedApiKey] = useState(false);
    const [lodgifyError, setLodgifyError] = useState("");
    const [webhookUrl, setWebhookUrl] = useState("");
    const [copied, setCopied] = useState(false);
    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("");

    // IX
    const [ixAccount, setIxAccount] = useState("");
    const [ixApiKey, setIxApiKey] = useState("");
    const [ixEnvironment, setIxEnvironment] = useState("production");
    const [ixAuthorized, setIxAuthorized] = useState(false);
    const [ixError, setIxError] = useState("");

    // Settings
    const [vatIncluded, setVatIncluded] = useState(true);
    const [autoFinalize, setAutoFinalize] = useState(false);
    const [exemptionReason, setExemptionReason] = useState("M01");
    const [ixDocumentType, setIxDocumentType] = useState("invoice_receipt");
    const [ixPaymentTerm, setIxPaymentTerm] = useState(0);
    const [ixSequenceName, setIxSequenceName] = useState("");
    const [settingsSaved, setSettingsSaved] = useState(false);

    const lodgifySaved = hasSavedApiKey && connectionStatus === "active";
    const allComplete = lodgifySaved && ixAuthorized && settingsSaved;

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [integRes, lodgifyRes] = await Promise.all([
                    fetch("/api/integrations"),
                    fetch("/api/integrations/lodgify-source"),
                ]);
                if (cancelled) return;

                let ixOk = false, setOk = false;
                if (integRes.ok) {
                    const data = await integRes.json() as any;
                    if (data._viewer_role) setUserRole(data._viewer_role);
                    if (data.user_id) setTargetUserId(data.user_id);
                    if (data.ix_account_name) setIxAccount(data.ix_account_name);
                    if (data.ix_api_key) setIxApiKey(data.ix_api_key);
                    if (data.ix_environment) setIxEnvironment(data.ix_environment);
                    if (data.ix_exemption_reason) setExemptionReason(data.ix_exemption_reason);
                    if (data.vat_included !== undefined) setVatIncluded(data.vat_included === 1);
                    if (data.auto_finalize !== undefined) setAutoFinalize(data.auto_finalize === 1);
                    if (data.ix_document_type) setIxDocumentType(data.ix_document_type);
                    if (data.ix_payment_term !== undefined) setIxPaymentTerm(parseInt(String(data.ix_payment_term)));
                    if (data.ix_sequence_name) setIxSequenceName(data.ix_sequence_name);
                    if (data.ix_authorized !== undefined) {
                        ixOk = data.ix_authorized === 1;
                        setIxAuthorized(ixOk);
                    }
                    if (data.ix_error) setIxError(data.ix_error);
                    setOk = !!data.ix_sequence_name;
                    setSettingsSaved(setOk);
                }

                let lodgifyOk = false;
                if (lodgifyRes.ok) {
                    const data = await lodgifyRes.json() as {
                        connection?: {
                            status: ConnectionStatus;
                            source_config: { has_api_key: boolean };
                            webhook_url?: string;
                        } | null;
                    };
                    if (data.connection) {
                        const cfg = data.connection.source_config;
                        setHasSavedApiKey(cfg.has_api_key);
                        setConnectionStatus(data.connection.status);
                        if (data.connection.webhook_url) setWebhookUrl(data.connection.webhook_url);
                        lodgifyOk = cfg.has_api_key && data.connection.status === "active";
                    }
                }

                if (lodgifyOk && ixOk && setOk) setStep(4);
                else if (lodgifyOk && ixOk) setStep(3);
                else if (lodgifyOk) setStep(2);
                else setStep(1);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const handleLodgifyStep = async () => {
        setLodgifyError("");
        if (!apiKey.trim() && !hasSavedApiKey) {
            setLodgifyError(t("errorMissingApiKey"));
            return;
        }
        setSaving(true);
        try {
            const body: Record<string, unknown> = { destination_kind: "invoicexpress", status: "active" };
            if (apiKey.trim()) body.api_key = apiKey.trim();

            const res = await fetch("/api/integrations/lodgify-source", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const json: any = await res.json().catch(() => ({}));
            if (!res.ok) {
                setLodgifyError(json.error ?? `HTTP ${res.status}`);
                return;
            }
            if (json.webhook_url) setWebhookUrl(json.webhook_url);
            setHasSavedApiKey(true);
            setConnectionStatus("active");
            setApiKey("");
            setStep(2);
        } catch (e: any) {
            setLodgifyError(e?.message ?? "Unknown error");
        } finally {
            setSaving(false);
        }
    };

    const handleIxStep = async () => {
        setIxError("");
        if (!ixAccount.trim() || !ixApiKey.trim()) { setIxError(t("errorIxRequired")); return; }
        setSaving(true);
        try {
            const saveRes = await fetch("/api/integrations", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ix_account_name: ixAccount, ix_api_key: ixApiKey, ix_environment: ixEnvironment }),
            });
            if (!saveRes.ok) {
                const json: any = await saveRes.json().catch(() => ({}));
                setIxError(json.error || t("errorSaveIx"));
                return;
            }
            const valRes = await fetch("/api/integrations/validate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "ix" }),
            });
            const valData: any = await valRes.json().catch(() => ({}));
            setIxAuthorized(valData.isValid);
            setIxError(valData.error || "");
            if (valData.isValid) setStep(3);
        } catch (e: any) {
            setIxError(t("errorNetwork", { message: e.message }));
        } finally {
            setSaving(false);
        }
    };

    const handleSaveSettings = async () => {
        if (!ixSequenceName.trim()) { setGlobalError(t("errorSequenceRequired")); return; }
        setSaving(true);
        setGlobalError("");
        try {
            const res = await fetch("/api/integrations", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ix_sequence_name: ixSequenceName,
                    ix_exemption_reason: exemptionReason,
                    vat_included: vatIncluded,
                    auto_finalize: autoFinalize,
                    ix_document_type: ixDocumentType,
                    ix_payment_term: ixPaymentTerm,
                }),
            });
            if (!res.ok) {
                const json: any = await res.json().catch(() => ({}));
                setGlobalError(json.error ?? `HTTP ${res.status}`);
                return;
            }
            setSettingsSaved(true);
            setStep(4);
        } catch (e: any) {
            setGlobalError(e?.message ?? "Unknown error");
        } finally {
            setSaving(false);
        }
    };

    const copyWebhookUrl = () => {
        if (!webhookUrl) return;
        navigator.clipboard.writeText(webhookUrl).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
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
            logo: "/images/lodgify-logo-black.svg",
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
            icon: ClipboardList,
            logo: "/images/invoicexpress_logo2.png",
            logoWidth: 80,
            isAuthorized: ixAuthorized,
            errorMsg: ixError,
            flagName: "ix_authorized",
            body: (
                <div className="grid md:grid-cols-2 gap-8">
                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1">
                            <span className="w-1 h-1 rounded-full bg-accent" />{t("ixAccountLabel")}
                        </label>
                        <input
                            type="text"
                            value={ixAccount}
                            onChange={(e) => setIxAccount(e.target.value)}
                            placeholder={t("ixAccountPlaceholder")}
                            className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40"
                        />
                    </div>
                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1">
                            <span className="w-1 h-1 rounded-full bg-accent" />{t("ixApiKeyLabel")}
                        </label>
                        <input
                            type="password"
                            value={ixApiKey}
                            onChange={(e) => setIxApiKey(e.target.value)}
                            placeholder={t("ixApiKeyPlaceholder")}
                            className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40 font-mono"
                        />
                    </div>
                    <div className="md:col-span-2 space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1">
                            <span className="w-1 h-1 rounded-full bg-accent" />{t("ixEnvLabel")}
                        </label>
                        <input
                            type="text"
                            value={ixEnvironment}
                            onChange={(e) => setIxEnvironment(e.target.value)}
                            placeholder="production"
                            className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40 font-mono"
                        />
                    </div>
                    <div className="md:col-span-2 pt-4 flex items-center gap-4">
                        <button onClick={() => setStep(1)} className="text-fg-40 hover:text-fg text-[10px] font-black uppercase tracking-widest transition-all px-4">{t("back")}</button>
                        <button
                            onClick={handleIxStep}
                            disabled={saving}
                            className="flex-1 py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-white text-black hover:bg-accent hover:text-fg disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed"
                        >
                            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <>{t("verifyConnection")} <ChevronRight className="w-4 h-4" /></>}
                        </button>
                    </div>
                    {ixError && <p className="md:col-span-2 text-[11px] text-destructive font-bold text-center">{ixError}</p>}
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
                    <div className="md:col-span-2 flex items-start gap-4 bg-[rgba(94,234,212,0.05)] border border-[rgba(94,234,212,0.15)] rounded-2xl px-6 py-4">
                        <Info className="w-5 h-5 text-accent-hot shrink-0 mt-0.5" />
                        <p className="text-[11px] text-fg-60 leading-relaxed">{t("vatNote")}</p>
                    </div>
                    <div className="md:col-span-2 space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1">
                            <span className="w-1 h-1 rounded-full bg-accent" />{t("sequenceLabel")}
                        </label>
                        <input
                            type="text"
                            value={ixSequenceName}
                            onChange={(e) => setIxSequenceName(e.target.value)}
                            placeholder={t("sequencePlaceholder")}
                            className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40"
                        />
                        <p className="text-[10px] text-fg-40 ml-1">{t("sequenceHint")}</p>
                    </div>
                    <div className="glass p-6 rounded-2xl flex items-center justify-between border-hairline">
                        <div>
                            <h3 className="font-bold text-sm">{t("vatIncluded")}</h3>
                            <p className="text-[10px] text-fg-40 font-medium mt-1 uppercase tracking-wider">{vatIncluded ? t("vatIncludedOn") : t("vatIncludedOff")}</p>
                        </div>
                        <button onClick={() => setVatIncluded(!vatIncluded)} className={`w-12 h-6 rounded-full transition-all duration-500 relative ring-1 ring-inset ring-black/20 ${vatIncluded ? "bg-accent-hot" : "bg-surface-2"}`}>
                            <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-500 ${vatIncluded ? "left-7" : "left-1"}`} />
                        </button>
                    </div>
                    <div className="glass p-6 rounded-2xl flex items-center justify-between border-hairline">
                        <div>
                            <h3 className="font-bold text-sm">{t("autoFinalize")}</h3>
                            <p className="text-[10px] text-fg-40 font-medium mt-1 uppercase tracking-wider">{t("autoFinalizeDesc")}</p>
                        </div>
                        <button onClick={() => setAutoFinalize(!autoFinalize)} className={`w-12 h-6 rounded-full transition-all duration-500 relative ring-1 ring-inset ring-black/20 ${autoFinalize ? "bg-accent" : "bg-surface-2"}`}>
                            <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-500 ${autoFinalize ? "left-7" : "left-1"}`} />
                        </button>
                    </div>
                    <div className="md:col-span-2 glass p-6 rounded-2xl border-hairline space-y-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <h3 className="font-bold text-sm">{t("docType")}</h3>
                                <p className="text-[10px] text-fg-40 font-medium mt-1 uppercase tracking-wider">{ixDocumentType === "invoice_receipt" ? t("docTypeReceipt") : t("docTypeInvoice")}</p>
                            </div>
                            <div className="flex bg-surface-2/80 p-1 rounded-xl border border-hairline">
                                <button onClick={() => setIxDocumentType("invoice_receipt")} className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${ixDocumentType === "invoice_receipt" ? "bg-white text-black shadow-lg" : "text-fg-40 hover:text-fg"}`}>{t("docTypeReceiptShort")}</button>
                                <button onClick={() => setIxDocumentType("invoice")} className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${ixDocumentType === "invoice" ? "bg-white text-black shadow-lg" : "text-fg-40 hover:text-fg"}`}>{t("docTypeInvoiceShort")}</button>
                            </div>
                        </div>
                        {ixDocumentType === "invoice" && (
                            <div className="pt-4 border-t border-hairline flex items-center justify-between gap-4">
                                <div className="flex-1"><h4 className="text-[10px] font-black text-fg-40 uppercase tracking-[0.2em] mb-1">{t("paymentTerm")}</h4></div>
                                <div className="w-32"><input type="number" value={ixPaymentTerm} onChange={(e) => setIxPaymentTerm(parseInt(e.target.value) || 0)} className="w-full bg-surface-2/50 border border-hairline rounded-xl px-4 py-2 text-sm font-bold text-center focus:ring-2 focus:ring-accent/20 outline-none" /></div>
                            </div>
                        )}
                    </div>
                    <div className="md:col-span-2 glass p-5 sm:p-8 rounded-[2rem] border-hairline space-y-4">
                        <div className="flex items-center gap-3 mb-2">
                            <div className="p-2 bg-[rgba(245,158,11,0.10)] rounded-xl"><Info className="w-4 h-4 text-soon" /></div>
                            <h3 className="font-bold text-sm tracking-tight">{t("exemptionTitle")}</h3>
                        </div>
                        <p className="text-[10px] text-fg-40 font-medium uppercase tracking-wider leading-relaxed">{t("exemptionDesc")}</p>
                        <select
                            value={exemptionReason}
                            onChange={(e) => setExemptionReason(e.target.value)}
                            className="w-full bg-surface-2/80 border border-hairline rounded-2xl px-6 py-4 text-sm font-bold focus:ring-2 focus:ring-[rgba(245,158,11,0.20)] focus:border-soon outline-none transition-all cursor-pointer text-fg"
                        >
                            {exemptionOptions.map((opt) => (
                                <option key={opt.value} value={opt.value} className="bg-surface-2">{opt.value} - {opt.label}</option>
                            ))}
                        </select>
                    </div>
                    <div className="md:col-span-2 pt-4 flex items-center gap-4">
                        <button onClick={() => setStep(2)} className="text-fg-40 hover:text-fg text-[10px] font-black uppercase tracking-widest transition-all px-4">{t("back")}</button>
                        <button
                            onClick={handleSaveSettings}
                            disabled={saving}
                            className="flex-1 py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-white text-black hover:bg-accent-hot hover:text-surface disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed"
                        >
                            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Zap className="w-5 h-5" /> {t("saveSettings")}</>}
                        </button>
                    </div>
                    {globalError && <p className="md:col-span-2 text-[11px] text-destructive font-bold text-center">{globalError}</p>}
                </div>
            ),
        },
        {
            id: 4,
            title: t("doneTitle"),
            description: t("doneDesc"),
            icon: ShieldCheck,
            isAuthorized: allComplete,
            body: (
                <div className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-[rgba(94,234,212,0.05)] border-[rgba(94,234,212,0.20)]">
                            <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-[rgba(94,234,212,0.10)]"><Hotel className="w-4 h-4 text-accent-hot" /></div>
                            <div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">Lodgify</p><p className="text-xs font-bold text-accent-hot">{t("configured")}</p></div>
                            <Check className="w-4 h-4 text-accent-hot ml-auto" />
                        </div>
                        <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-[rgba(94,234,212,0.05)] border-[rgba(94,234,212,0.20)]">
                            <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-[rgba(94,234,212,0.10)]"><ClipboardList className="w-4 h-4 text-accent-hot" /></div>
                            <div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">{t("ixLabel")}</p><p className="text-xs font-bold text-accent-hot">{t("statusAuthorized")}</p></div>
                            <Check className="w-4 h-4 text-accent-hot ml-auto" />
                        </div>
                        <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-[rgba(94,234,212,0.05)] border-[rgba(94,234,212,0.20)]">
                            <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-[rgba(94,234,212,0.10)]"><Settings2 className="w-4 h-4 text-accent-hot" /></div>
                            <div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">{t("settingsLabel")}</p><p className="text-xs font-bold text-accent-hot">{t("configured")}</p></div>
                            <Check className="w-4 h-4 text-accent-hot ml-auto" />
                        </div>
                    </div>
                    <div className="flex items-start gap-4 bg-[rgba(94,234,212,0.05)] border border-[rgba(94,234,212,0.20)] rounded-2xl px-6 py-4">
                        <AlertTriangle className="w-5 h-5 text-accent-hot shrink-0 mt-0.5" />
                        <p className="text-[11px] text-fg-60 leading-relaxed">{t("doneWarning")}</p>
                    </div>
                </div>
            ),
        },
    ];

    const onForceAuth = async (flag: string): Promise<boolean> => {
        try {
            const res = await fetch("/api/admin/client-rules", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetUserId, flag, value: 1 }),
            });
            if (res.ok) {
                if (flag === "ix_authorized") setIxAuthorized(true);
                return true;
            }
            return false;
        } catch { return false; }
    };

    return (
        <div className="space-y-12 animate-in fade-in duration-1000 slide-in-from-bottom-4">
            <StepperHeader
                backHref="/integrations"
                backLabel={t("backToIntegrations")}
                title={t("pageTitle")}
                subtitle={t("engineSubtitle")}
                providers={[
                    { icon: Hotel, authorized: lodgifySaved },
                    { icon: ClipboardList, authorized: ixAuthorized },
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
                onForceAuth={onForceAuth}
                saving={saving}
                labels={labels}
            />

            {allComplete && (
                <motion.div
                    initial={{ opacity: 0, y: 20, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ duration: 0.6 }}
                    className="rounded-[2.5rem] p-1 shadow-2xl bg-[rgba(94,234,212,0.10)]"
                >
                    <div className="bg-surface rounded-[2.3rem] p-6 sm:p-10 flex flex-col gap-8 border border-white/5">
                        <div className="flex flex-col md:flex-row items-center justify-between gap-8">
                            <div className="flex items-center gap-8">
                                <div className="w-20 h-20 rounded-[1.8rem] flex items-center justify-center bg-[rgba(94,234,212,0.18)] ring-2 ring-accent-hot ring-offset-4 ring-offset-surface">
                                    <ShieldCheck className="w-10 h-10 text-accent-hot" />
                                </div>
                                <div className="space-y-1">
                                    <h3 className="text-2xl font-black tracking-tight">{t("integrationDoneTitle")}</h3>
                                    <p className="text-fg-40 font-bold uppercase tracking-widest text-[10px]">{t("integrationDoneSub")}</p>
                                </div>
                            </div>
                            <div className="px-6 py-3 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] border bg-[rgba(94,234,212,0.10)] text-accent-hot border-[rgba(94,234,212,0.30)]">
                                {t("onlineRealtime")}
                            </div>
                        </div>
                    </div>
                </motion.div>
            )}
        </div>
    );
}
