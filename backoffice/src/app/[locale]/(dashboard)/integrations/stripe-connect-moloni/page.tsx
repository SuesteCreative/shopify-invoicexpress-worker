"use client";

export const runtime = "edge";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { CreditCard, Loader2, Check, CheckCheck, AlertTriangle, ChevronRight, Settings2, Zap, Info, ShieldCheck, Copy, Building2, Link2, Unlink } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { IntegrationStepper, StepperHeader, type StepDef } from "@/components/IntegrationStepper";
import { moloniCallbackUri } from "@/lib/moloni-oauth";
import SuspendedBanner from "@/components/SuspendedBanner";
import TrialBanner from "@/components/TrialBanner";

/**
 * Stripe Connect → Moloni.
 *
 * A separate integration from Stripe → Moloni, not a replacement: the merchants
 * on that one pasted a restricted key and a Moloni password, and their setup is
 * untouched. Here nothing sensitive is typed at all. Stripe is one click, and
 * Moloni is an authorisation the merchant can revoke from their own account.
 *
 * The settings and activate steps deliberately borrow the existing wizard's copy
 * (`stripeMoloniSetup`): they configure the same Moloni behaviour, and two
 * translations of the same sentence drift apart.
 */

const CONNECT_ENABLED = process.env.NEXT_PUBLIC_STRIPE_CONNECT_ENABLED === "1";
const SOURCE_KIND = "stripe_connect";

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

export default function StripeConnectMoloniIntegration() {
    const t = useTranslations("stripeConnectMoloniSetup");
    const tShared = useTranslations("stripeMoloniSetup");
    const tB = useTranslations("faturacao");
    const searchParams = useSearchParams();

    // Set by the two OAuth callbacks when they redirect the merchant back here.
    const stripeResult = searchParams.get("stripe");
    const moloniResult = searchParams.get("moloni");
    const callbackDetail = searchParams.get("detail");

    const [sub, setSub] = useState<any>(null);
    const [subscribing, setSubscribing] = useState<"monthly" | "annual" | null>(null);

    const [step, setStep] = useState(1);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [connecting, setConnecting] = useState(false);
    const [globalError, setGlobalError] = useState("");
    const [userRole, setUserRole] = useState("");
    const [targetUserId, setTargetUserId] = useState("");

    // Stripe (Connect). No key, no secret — only the account we were authorised against.
    const [stripeAccountId, setStripeAccountId] = useState("");
    const [stripeConnected, setStripeConnected] = useState(false);
    const [stripeError, setStripeError] = useState("");

    // Moloni (OAuth). The app credentials are still typed; the password is not.
    const [clientId, setClientId] = useState("");
    const [clientSecret, setClientSecret] = useState("");
    const [environment, setEnvironment] = useState<"production" | "sandbox">("production");
    const [moloniAuthorized, setMoloniAuthorized] = useState(false);
    const [moloniExpiresAt, setMoloniExpiresAt] = useState<string | null>(null);
    const [moloniError, setMoloniError] = useState("");
    const [redirectCopied, setRedirectCopied] = useState(false);

    // Invoicing settings — identical to the existing Stripe→Moloni wizard.
    const [companyName, setCompanyName] = useState("");
    const [documentSetName, setDocumentSetName] = useState("");
    const [vatIncluded, setVatIncluded] = useState(true);
    const [autoFinalize, setAutoFinalize] = useState(false);
    const [sendEmail, setSendEmail] = useState(false);
    const [partialInvoicing, setPartialInvoicing] = useState(false);
    const [documentType, setDocumentType] = useState<"invoice" | "invoice_receipt">("invoice_receipt");
    const [exemptionReason, setExemptionReason] = useState("M01");
    const [defaultVatRate, setDefaultVatRate] = useState("");

    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("");

    const settingsSaved = !!companyName;
    const allComplete = connectionStatus === "active";

    // The redirect URI the merchant pastes into their Moloni developer app. The
    // same one for everybody and it never changes: a Moloni app holds exactly one
    // callback, so a URI carrying the connection id stopped matching as soon as a
    // second connection existed. Which connection a code belongs to is decided in
    // the callback instead.
    const moloniRedirectUri = moloniCallbackUri();

    const load = useCallback(async () => {
        const [integ, connect, moloni] = await Promise.all([
            fetch("/api/integrations").then(r => r.json()).catch(() => ({})),
            fetch("/api/integrations/stripe-connect").then(r => r.json()).catch(() => ({})),
            fetch(`/api/integrations/moloni-destination?source_kind=${SOURCE_KIND}`).then(r => r.json()).catch(() => ({})),
        ]) as any[];

        if (integ?._viewer_role) setUserRole(integ._viewer_role);
        if (integ?.user_id) setTargetUserId(integ.user_id);

        const conn = connect?.connection;
        const sConnected = !!conn?.stripe?.connected;
        setStripeConnected(sConnected);
        setStripeAccountId(conn?.stripe?.stripe_account_id ?? "");
        setMoloniAuthorized(!!conn?.moloni?.authorized);
        setMoloniExpiresAt(conn?.moloni?.refresh_expires_at ?? null);
        if (conn?.moloni?.error) setMoloniError(String(conn.moloni.error));

        const mConn = moloni?.connection;
        const cfg = mConn?.destination_config ?? {};
        if (mConn) {
            setClientId(String(cfg.moloni_client_id ?? ""));
            setCompanyName(cfg.moloni_company_name ? String(cfg.moloni_company_name) : "");
            setDocumentSetName(cfg.moloni_document_set_name ? String(cfg.moloni_document_set_name) : "");
            setEnvironment((cfg.moloni_environment as "production" | "sandbox") ?? "production");
            if (typeof cfg.vat_included === "boolean") setVatIncluded(cfg.vat_included);
            if (typeof cfg.auto_finalize === "boolean") setAutoFinalize(cfg.auto_finalize);
            if (typeof cfg.send_email === "boolean") setSendEmail(cfg.send_email);
            if (typeof cfg.moloni_partial_invoicing === "boolean") setPartialInvoicing(cfg.moloni_partial_invoicing);
            if (typeof cfg.moloni_document_type === "string") setDocumentType(cfg.moloni_document_type === "invoice_receipt" ? "invoice_receipt" : "invoice");
            if (typeof cfg.exemption_reason === "string") setExemptionReason(cfg.exemption_reason);
            if (cfg.default_vat_rate != null) setDefaultVatRate(String(cfg.default_vat_rate));
        }

        const status = (conn?.status ?? mConn?.status ?? "") as ConnectionStatus;
        setConnectionStatus(status);

        // Resume where the merchant actually is, not at the top.
        const authorized = !!conn?.moloni?.authorized;
        const hasSettings = !!cfg.moloni_company_name;
        if (status === "active") setStep(5);
        else if (sConnected && authorized && hasSettings) setStep(4);
        else if (sConnected && authorized) setStep(3);
        else if (sConnected) setStep(2);
        else setStep(1);
    }, []);

    useEffect(() => {
        if (!CONNECT_ENABLED) { setLoading(false); return; }
        fetch("/api/auth/sync", { method: "POST" }).catch(console.error);
        fetch("/api/billing/subscription").then(r => r.json()).then(setSub).catch(() => setSub(null));
        load().finally(() => setLoading(false));
    }, [load]);

    // Surface whatever the callback came back with, once, on mount.
    useEffect(() => {
        if (stripeResult === "denied") setStripeError(t("stripeDenied"));
        else if (stripeResult === "error") setStripeError(callbackDetail || t("stripeFailed"));
        if (moloniResult === "denied") setMoloniError(t("moloniDenied"));
        else if (moloniResult === "error") setMoloniError(callbackDetail || t("moloniFailed"));
    }, [stripeResult, moloniResult, callbackDetail, t]);

    const handleConnectStripe = async () => {
        setConnecting(true);
        setStripeError("");
        try {
            const res = await fetch("/api/integrations/stripe-connect/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ destination_kind: "moloni" }),
            });
            const json: any = await res.json();
            if (!res.ok || !json.authorize_url) {
                setStripeError(json.error ?? `HTTP ${res.status}`);
                return;
            }
            // Full-page navigation, not a popup: Stripe's consent screen is where
            // the merchant picks which of their accounts to connect, and it has to
            // be unmistakably Stripe's own page.
            window.location.href = json.authorize_url;
        } catch (e: any) {
            setStripeError(e?.message ?? "Unknown error");
        } finally {
            setConnecting(false);
        }
    };

    const handleDisconnectStripe = async () => {
        if (!confirm(t("disconnectConfirm"))) return;
        setSaving(true);
        try {
            await fetch("/api/integrations/stripe-connect", { method: "DELETE" });
            await load();
        } finally {
            setSaving(false);
        }
    };

    const handleAuthorizeMoloni = async () => {
        setConnecting(true);
        setMoloniError("");
        try {
            const res = await fetch("/api/integrations/moloni-oauth/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    client_id: clientId.trim(),
                    client_secret: clientSecret.trim() || undefined,
                    environment,
                }),
            });
            const json: any = await res.json();
            if (!res.ok || !json.authorize_url) {
                setMoloniError(json.error ?? `HTTP ${res.status}`);
                return;
            }
            window.location.href = json.authorize_url;
        } catch (e: any) {
            setMoloniError(e?.message ?? "Unknown error");
        } finally {
            setConnecting(false);
        }
    };

    const copyRedirectUri = async () => {
        try {
            await navigator.clipboard.writeText(moloniRedirectUri);
            setRedirectCopied(true);
            setTimeout(() => setRedirectCopied(false), 2000);
        } catch { /* clipboard unavailable — the field is selectable anyway */ }
    };

    const handleSaveSettings = async () => {
        if (!companyName.trim()) {
            setGlobalError(tShared("errorSettingsRequired"));
            return;
        }
        setSaving(true);
        setGlobalError("");
        try {
            const res = await fetch("/api/integrations/moloni-destination", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    source_kind: SOURCE_KIND,
                    moloni_company_name: companyName.trim(),
                    moloni_document_set_name: documentSetName.trim(),
                    moloni_document_type: documentType,
                    moloni_environment: environment,
                    vat_included: vatIncluded,
                    auto_finalize: autoFinalize,
                    send_email: sendEmail,
                    moloni_partial_invoicing: partialInvoicing,
                    exemption_reason: exemptionReason,
                    default_vat_rate: defaultVatRate.trim() === "" ? null : Number(defaultVatRate),
                    status: "draft",
                }),
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
                body: JSON.stringify({ source_kind: SOURCE_KIND, status: "active" }),
            });
            if (!res.ok) {
                const json: any = await res.json().catch(() => ({}));
                setGlobalError(json.error ?? tShared("errorActivate"));
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

    const handleSubscribe = async (plan: "monthly" | "annual") => {
        setSubscribing(plan);
        try {
            const r = await fetch("/api/billing/checkout", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ plan, source: "stripe-connect-moloni" }),
            });
            const d: any = await r.json();
            if (d.url) window.location.href = d.url;
            else alert(d.error || tB("genericError"));
        } finally {
            setSubscribing(null);
        }
    };

    const subData = sub?.subscription;
    const uiState = sub?.ui_state;
    const hasActiveSub = uiState === "active";
    const showSubCta = sub !== null && !hasActiveSub && uiState !== "exempt";
    const subBlocked = !!sub?.blocked;

    if (!CONNECT_ENABLED) {
        return (
            <div className="max-w-3xl mx-auto py-24 space-y-8">
                <Link href="/integrations" className="text-[10px] font-black text-accent-ink uppercase tracking-widest flex items-center gap-2"><ChevronRight className="w-3 h-3 rotate-180" /> {t("backToIntegrations")}</Link>
                <div className="glass rounded-[2.5rem] p-12 border-soon/20 bg-soon/4 text-center">
                    <h1 className="text-2xl font-black tracking-tight mb-2">{t("disabledTitle")}</h1>
                    <p className="text-fg-60 text-sm">{t("disabledBody")}</p>
                </div>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="min-h-[60vh] flex items-center justify-center">
                <Loader2 className="w-12 h-12 text-accent-ink animate-spin opacity-50" />
            </div>
        );
    }

    const labels = {
        update: tShared("update"),
        back: tShared("back"),
        statusAuthorized: tShared("statusAuthorized"),
        statusPending: tShared("statusPending"),
        diagnostic: tShared("diagnostic"),
        diagnosticSub: tShared("diagnosticSub"),
        diagnosticDefault: tShared("diagnosticDefault"),
        forceAuth: tShared("forceAuth"),
        areYouSure: tShared("areYouSure"),
        cancelAction: tShared("cancelAction"),
        alertForceAuthError: tShared("alertForceAuthError"),
    };

    const steps: StepDef[] = [
        {
            id: 1,
            title: t("step1Title"),
            description: t("step1Desc"),
            icon: CreditCard,
            logo: "/images/stripe-logo.svg",
            logoWidth: 60,
            isAuthorized: stripeConnected,
            errorMsg: stripeError,
            body: (
                <div className="space-y-8">
                    <div className="flex items-start gap-4 bg-accent/5 border border-accent/20 rounded-2xl px-6 py-4">
                        <Info className="w-5 h-5 text-accent-ink shrink-0 mt-0.5" />
                        <div className="space-y-1">
                            <p className="text-sm font-bold text-accent-ink">{t("stripeIntroTitle")}</p>
                            <p className="text-[11px] text-fg-60 leading-relaxed">{t("stripeIntroBody")}</p>
                            <p className="text-[11px] text-fg-40 leading-relaxed">{t("stripeScopeNote")}</p>
                        </div>
                    </div>

                    {stripeConnected ? (
                        <div className="glass p-6 rounded-2xl border-hairline flex items-center justify-between gap-4">
                            <div className="flex items-center gap-4 min-w-0">
                                <div className="w-10 h-10 rounded-xl bg-accent-hot/12 flex items-center justify-center shrink-0"><Check className="w-5 h-5 text-accent-hot" /></div>
                                <div className="min-w-0">
                                    <p className="font-bold text-sm">{t("stripeConnected")}</p>
                                    <p className="text-[10px] text-fg-40 font-mono mt-0.5 truncate">{stripeAccountId}</p>
                                </div>
                            </div>
                            <button onClick={handleDisconnectStripe} disabled={saving} className="px-5 py-2.5 rounded-xl border border-hairline hover:border-destructive/60 text-[10px] font-black uppercase tracking-[0.18em] transition-colors shrink-0 flex items-center gap-2 disabled:opacity-40">
                                <Unlink className="w-3.5 h-3.5" /> {t("disconnect")}
                            </button>
                        </div>
                    ) : (
                        <button onClick={handleConnectStripe} disabled={connecting} className="w-full py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-fg text-surface hover:bg-accent-hot hover:text-surface disabled:opacity-30 disabled:cursor-not-allowed">
                            {connecting ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Link2 className="w-5 h-5" /> {t("connectStripe")}</>}
                        </button>
                    )}

                    {stripeConnected && (
                        <button onClick={() => setStep(2)} className="w-full py-4 rounded-2xl border border-hairline hover:border-rule text-[10px] font-black uppercase tracking-[0.18em] transition-colors">
                            {t("continueToMoloni")}
                        </button>
                    )}
                </div>
            ),
        },
        {
            id: 2,
            title: t("step2Title"),
            description: t("step2Desc"),
            icon: Building2,
            isAuthorized: moloniAuthorized,
            errorMsg: moloniError,
            body: (
                <div className="grid md:grid-cols-2 gap-8">
                    <div className="md:col-span-2 flex items-start gap-4 bg-accent/5 border border-accent/20 rounded-2xl px-6 py-4">
                        <Info className="w-5 h-5 text-accent-ink shrink-0 mt-0.5" />
                        <div className="space-y-1">
                            <p className="text-sm font-bold text-accent-ink">{t("moloniIntroTitle")}</p>
                            <ol className="text-[11px] text-fg-60 mt-2 leading-relaxed list-decimal pl-4 space-y-1">
                                <li>{t("moloniStep1")}</li>
                                <li>{t("moloniStep2")}</li>
                                <li>{t("moloniStep3")}</li>
                            </ol>
                        </div>
                    </div>

                    {/* The redirect URI is unique to this connection, and Moloni allows
                        exactly one per developer app. It must match byte for byte. */}
                    <div className="md:col-span-2 glass p-6 rounded-2xl border-hairline space-y-3">
                        <h3 className="font-bold text-sm">{t("redirectUriTitle")}</h3>
                        <p className="text-[10px] text-fg-40 leading-relaxed">{t("redirectUriBody")}</p>
                        <div className="flex items-center gap-3">
                            <code className="flex-1 bg-surface-2/60 border border-hairline rounded-xl px-4 py-3 text-[11px] font-mono break-all">
                                {moloniRedirectUri}
                            </code>
                            <button onClick={copyRedirectUri} disabled={!moloniRedirectUri} className="px-4 py-3 rounded-xl border border-hairline hover:border-rule text-[10px] font-black uppercase tracking-[0.18em] transition-colors shrink-0 flex items-center gap-2 disabled:opacity-30">
                                {redirectCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                {redirectCopied ? t("copied") : t("copy")}
                            </button>
                        </div>
                    </div>

                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{t("developerIdLabel")}</label>
                        <input type="text" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="000000" className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium font-mono focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40" />
                    </div>
                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{t("clientSecretLabel")}</label>
                        <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={moloniAuthorized ? "••••••••" : ""} className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium font-mono focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40" />
                    </div>

                    <div className="md:col-span-2 glass p-6 rounded-2xl border-hairline space-y-3">
                        <h3 className="font-bold text-sm">{t("environmentLabel")}</h3>
                        <div className="flex gap-2">
                            {(["production", "sandbox"] as const).map((e) => (
                                <button key={e} onClick={() => setEnvironment(e)} className={`flex-1 py-3.5 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all duration-300 ${environment === e ? "bg-accent-hot text-surface shadow-lg" : "bg-surface-2/50 text-fg-40 hover:text-fg ring-1 ring-inset ring-hairline"}`}>
                                    {e === "production" ? t("envProduction") : t("envSandbox")}
                                </button>
                            ))}
                        </div>
                    </div>

                    {moloniAuthorized && (
                        <div className="md:col-span-2 flex items-center gap-4 px-6 py-4 rounded-2xl bg-accent-hot/8 border border-accent-hot/25">
                            <Check className="w-5 h-5 text-accent-hot shrink-0" />
                            <div>
                                <p className="text-sm font-bold text-accent-hot">{t("moloniAuthorized")}</p>
                                {moloniExpiresAt && (
                                    <p className="text-[10px] text-fg-40 mt-0.5">
                                        {t("moloniRenewal", { date: new Date(moloniExpiresAt).toLocaleDateString("pt-PT") })}
                                    </p>
                                )}
                            </div>
                        </div>
                    )}

                    <div className="md:col-span-2 pt-2 flex items-center gap-4">
                        <button onClick={() => setStep(1)} className="text-fg-40 hover:text-fg text-[10px] font-black uppercase tracking-widest transition-all px-4">{tShared("back")}</button>
                        <button onClick={handleAuthorizeMoloni} disabled={connecting || !clientId.trim()} className="flex-1 py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-fg text-surface hover:bg-accent-hot hover:text-surface disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed">
                            {connecting ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Link2 className="w-5 h-5" /> {moloniAuthorized ? t("reauthorizeMoloni") : t("authorizeMoloni")}</>}
                        </button>
                        {moloniAuthorized && (
                            <button onClick={() => setStep(3)} className="px-6 py-5 rounded-2xl border border-hairline hover:border-rule text-[10px] font-black uppercase tracking-[0.18em] transition-colors">
                                {t("continueToSettings")}
                            </button>
                        )}
                    </div>
                </div>
            ),
        },
        {
            id: 3,
            title: tShared("step3Title"),
            description: tShared("step3Desc"),
            icon: Settings2,
            hasGearLogo: true,
            isConfig: true,
            isAuthorized: settingsSaved,
            body: (
                <div className="grid md:grid-cols-2 gap-8">
                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{tShared("companyIdLabel")}</label>
                        <input type="text" value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Kapta, Lda" className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40" />
                        <p className="text-[10px] text-fg-40 ml-1">{tShared("companyNameHint")}</p>
                    </div>
                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{tShared("documentSetIdLabel")}</label>
                        <input type="text" value={documentSetName} onChange={(e) => setDocumentSetName(e.target.value)} placeholder="FR2026" className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40 font-mono" />
                        <p className="text-[10px] text-fg-40 ml-1">{tShared("documentSetNameHint")}</p>
                    </div>
                    <div className="md:col-span-2 space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{tShared("defaultVatRateLabel")}</label>
                        <input type="number" step="0.01" min="0" max="100" value={defaultVatRate} onChange={(e) => setDefaultVatRate(e.target.value)} placeholder="23" className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40 font-mono" />
                        <p className="text-[10px] text-fg-40 ml-1">{tShared("defaultVatRateHint")}</p>
                    </div>
                    <div className="glass p-6 rounded-2xl flex items-center justify-between border-hairline">
                        <div>
                            <h3 className="font-bold text-sm">{tShared("vatIncluded")}</h3>
                            <p className="text-[10px] text-fg-40 font-medium mt-1 uppercase tracking-wider">{vatIncluded ? tShared("vatIncludedOn") : tShared("vatIncludedOff")}</p>
                        </div>
                        <button onClick={() => setVatIncluded(!vatIncluded)} className={`w-12 h-6 rounded-full transition-all duration-500 relative ring-1 ring-inset ring-sunken ${vatIncluded ? "bg-accent-hot" : "bg-track-off"}`}><div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-500 ${vatIncluded ? "left-7" : "left-1"}`} /></button>
                    </div>
                    <div className="glass p-6 rounded-2xl flex items-center justify-between border-hairline">
                        <div>
                            <h3 className="font-bold text-sm">{tShared("autoFinalize")}</h3>
                            <p className="text-[10px] text-fg-40 font-medium mt-1 uppercase tracking-wider">{tShared("autoFinalizeDesc")}</p>
                        </div>
                        <button onClick={() => setAutoFinalize(!autoFinalize)} className={`w-12 h-6 rounded-full transition-all duration-500 relative ring-1 ring-inset ring-sunken ${autoFinalize ? "bg-accent" : "bg-track-off"}`}><div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-500 ${autoFinalize ? "left-7" : "left-1"}`} /></button>
                    </div>
                    <div className="glass p-6 rounded-2xl flex flex-col gap-3 border-hairline">
                        <div className="flex items-center justify-between">
                            <div>
                                <h3 className="font-bold text-sm">{tShared("sendEmail")}</h3>
                                <p className="text-[10px] text-fg-40 font-medium mt-1 uppercase tracking-wider">{sendEmail ? tShared("sendEmailOn") : tShared("sendEmailOff")}</p>
                            </div>
                            <button onClick={() => setSendEmail(!sendEmail)} className={`w-12 h-6 rounded-full transition-all duration-500 relative ring-1 ring-inset ring-sunken shrink-0 ${sendEmail ? "bg-accent" : "bg-track-off"}`}><div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-500 ${sendEmail ? "left-7" : "left-1"}`} /></button>
                        </div>
                        {sendEmail && !autoFinalize && (
                            <p className="text-[10px] leading-relaxed font-medium text-soon/90 border-l-2 border-soon/40 pl-3">{tShared("sendEmailNeedsFinalize")}</p>
                        )}
                    </div>
                    <div className="glass p-6 rounded-2xl flex items-center justify-between border-hairline">
                        <div>
                            <div className="flex items-center gap-1.5">
                                <h3 className="font-bold text-sm">{tShared("partialInvoicing")}</h3>
                                <span title={tShared("partialInvoicingTooltip")} className="inline-flex cursor-help"><Info className="w-3.5 h-3.5 text-fg-40 shrink-0" /></span>
                            </div>
                            <p className="text-[10px] text-fg-40 font-medium mt-1 uppercase tracking-wider">{partialInvoicing ? tShared("partialInvoicingOn") : tShared("partialInvoicingOff")}</p>
                        </div>
                        <button onClick={() => setPartialInvoicing(!partialInvoicing)} className={`w-12 h-6 rounded-full transition-all duration-500 relative ring-1 ring-inset ring-sunken ${partialInvoicing ? "bg-accent" : "bg-track-off"}`}><div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-500 ${partialInvoicing ? "left-7" : "left-1"}`} /></button>
                    </div>
                    <div className="md:col-span-2 glass p-6 rounded-2xl border-hairline space-y-3">
                        <h3 className="font-bold text-sm">{tShared("documentTypeTitle")}</h3>
                        <p className="text-[10px] text-fg-40 font-medium uppercase tracking-wider leading-relaxed">{tShared("documentTypeDesc")}</p>
                        <div className="flex gap-2">
                            {(["invoice_receipt", "invoice"] as const).map((dt) => (
                                <button key={dt} onClick={() => setDocumentType(dt)} className={`flex-1 py-3.5 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all duration-300 ${documentType === dt ? "bg-accent-hot text-surface shadow-lg" : "bg-surface-2/50 text-fg-40 hover:text-fg ring-1 ring-inset ring-hairline"}`}>
                                    {dt === "invoice_receipt" ? tShared("documentTypeInvoiceReceipt") : tShared("documentTypeInvoice")}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="md:col-span-2 glass p-5 sm:p-8 rounded-[2rem] border-hairline space-y-4">
                        <div className="flex items-center gap-3 mb-2"><div className="p-2 bg-soon/10 rounded-xl"><Info className="w-4 h-4 text-soon" /></div><h3 className="font-bold text-sm tracking-tight">{tShared("exemptionTitle")}</h3></div>
                        <p className="text-[10px] text-fg-40 font-medium uppercase tracking-wider leading-relaxed">{tShared("exemptionDesc")}</p>
                        <select value={exemptionReason} onChange={(e) => setExemptionReason(e.target.value)} className="w-full bg-surface-2/80 border border-hairline rounded-2xl px-6 py-4 text-sm font-bold focus:ring-2 focus:ring-soon/20 focus:border-soon outline-none transition-all cursor-pointer text-fg">
                            {exemptionOptions.map((opt) => (<option key={opt.value} value={opt.value} className="bg-surface-2">{opt.value} - {opt.label}</option>))}
                        </select>
                    </div>
                    <div className="md:col-span-2 glass p-5 sm:p-6 rounded-2xl border-hairline flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3 min-w-0">
                            <div className="p-2 bg-accent/10 rounded-xl shrink-0"><Building2 className="w-4 h-4 text-accent-ink" /></div>
                            <div className="min-w-0">
                                <h3 className="font-bold text-sm">{tShared("productMappingsTitle")}</h3>
                                <p className="text-[10px] text-fg-40 font-medium mt-0.5 uppercase tracking-wider truncate">{tShared("productMappingsDesc")}</p>
                            </div>
                        </div>
                        <Link href={`/integrations/moloni-mappings?source_kind=${SOURCE_KIND}`} className="px-5 py-2.5 rounded-xl border border-hairline hover:border-rule text-[10px] font-black uppercase tracking-[0.18em] transition-colors shrink-0">{tShared("manageMappings")}</Link>
                    </div>
                    <div className="md:col-span-2 glass p-5 sm:p-6 rounded-2xl border-hairline flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3 min-w-0">
                            <div className="p-2 bg-accent/10 rounded-xl shrink-0"><Zap className="w-4 h-4 text-accent-ink" /></div>
                            <div className="min-w-0">
                                <h3 className="font-bold text-sm">{tShared("tagRoutingTitle")}</h3>
                                <p className="text-[10px] text-fg-40 font-medium mt-0.5 uppercase tracking-wider truncate">{tShared("tagRoutingDesc")}</p>
                            </div>
                        </div>
                        <Link href={`/integrations/tag-routing?source_kind=${SOURCE_KIND}&destination_kind=moloni`} className="px-5 py-2.5 rounded-xl border border-hairline hover:border-rule text-[10px] font-black uppercase tracking-[0.18em] transition-colors shrink-0">{tShared("manageTagRouting")}</Link>
                    </div>
                    <div className="md:col-span-2 pt-4 flex items-center gap-4">
                        <button onClick={() => setStep(2)} className="text-fg-40 hover:text-fg text-[10px] font-black uppercase tracking-widest transition-all px-4">{tShared("back")}</button>
                        <button onClick={handleSaveSettings} disabled={saving} className="flex-1 py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-fg text-surface hover:bg-accent-hot hover:text-surface disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed">
                            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Zap className="w-5 h-5" /> {tShared("saveSettings")}</>}
                        </button>
                    </div>
                </div>
            ),
        },
        {
            id: 4,
            title: tShared("activateTitle"),
            description: tShared("activateDesc"),
            icon: Zap,
            isAuthorized: connectionStatus === "active",
            body: (
                <div className="space-y-8">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-accent-hot/5 border-accent-hot/20">
                            <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-accent-hot/10"><CreditCard className="w-4 h-4 text-accent-hot" /></div>
                            <div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">{tShared("stripeLabel")}</p><p className="text-xs font-bold text-accent-hot">{tShared("configured")}</p></div>
                            <Check className="w-4 h-4 text-accent-hot ml-auto" />
                        </div>
                        <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-accent-hot/5 border-accent-hot/20">
                            <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-accent-hot/10"><Building2 className="w-4 h-4 text-accent-hot" /></div>
                            <div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">{tShared("moloniLabel")}</p><p className="text-xs font-bold text-accent-hot">{tShared("statusAuthorized")}</p></div>
                            <Check className="w-4 h-4 text-accent-hot ml-auto" />
                        </div>
                        <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-accent-hot/5 border-accent-hot/20">
                            <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-accent-hot/10"><Settings2 className="w-4 h-4 text-accent-hot" /></div>
                            <div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">{tShared("settingsLabel")}</p><p className="text-xs font-bold text-accent-hot">{tShared("configured")}</p></div>
                            <Check className="w-4 h-4 text-accent-hot ml-auto" />
                        </div>
                    </div>
                    <div className="flex items-start gap-4 bg-surface-2/50 border border-hairline rounded-2xl px-6 py-4">
                        <AlertTriangle className="w-5 h-5 text-soon shrink-0 mt-0.5" />
                        <p className="text-[11px] text-fg-60 leading-relaxed">{tShared("activateWarning")}</p>
                    </div>
                    <button onClick={handleActivate} disabled={saving || connectionStatus === "active"} className="w-full py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-fg text-surface hover:bg-accent-hot hover:text-surface disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed">
                        {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Zap className="w-5 h-5" /> {connectionStatus === "active" ? tShared("currentlyActive") : tShared("markAsActive")}</>}
                    </button>
                    {globalError && <p className="text-[11px] text-destructive font-bold text-center">{globalError}</p>}
                </div>
            ),
        },
    ];

    return (
        <div className="space-y-12 animate-in fade-in duration-1000 slide-in-from-bottom-4">
            {stripeResult === "connected" && (
                <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-4 px-6 py-4 rounded-2xl bg-accent-hot/12 border border-accent-hot/30 text-accent-hot">
                    <CheckCheck className="w-5 h-5 shrink-0" />
                    <p className="font-mono text-xs uppercase tracking-[0.18em]">{t("stripeConnectedBanner")}</p>
                </motion.div>
            )}
            {moloniResult === "connected" && (
                <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-4 px-6 py-4 rounded-2xl bg-accent-hot/12 border border-accent-hot/30 text-accent-hot">
                    <CheckCheck className="w-5 h-5 shrink-0" />
                    <p className="font-mono text-xs uppercase tracking-[0.18em]">{t("moloniConnectedBanner")}</p>
                </motion.div>
            )}

            {sub !== null && (
                <div className="glass rounded-[2rem] p-5 sm:p-8">
                    {hasActiveSub ? (
                        <div className="flex items-center justify-between gap-4">
                            <div className="flex items-center gap-4">
                                <div className="w-12 h-12 rounded-2xl bg-accent-hot/15 ring-1 ring-accent-hot/30 flex items-center justify-center">
                                    <CreditCard className="w-5 h-5 text-accent-hot" />
                                </div>
                                <div>
                                    <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40 mb-1">{tB("subscribeHeading")}</p>
                                    <span className="px-2 py-0.5 rounded-md font-mono text-[10px] uppercase tracking-[0.22em] border bg-accent-hot/10 text-accent-hot border-accent-hot/20">
                                        {tB("statusActive")}
                                    </span>
                                </div>
                            </div>
                            <Link href="/faturacao" className="px-5 py-3 rounded-2xl bg-veil border border-hairline text-fg font-mono text-[10px] uppercase tracking-[0.18em] hover:bg-fg/10 transition-all flex items-center gap-2">
                                <CreditCard className="w-4 h-4" />
                                {tB("changeCard")}
                            </Link>
                        </div>
                    ) : showSubCta && (
                        <div className="space-y-4">
                            {subBlocked ? <SuspendedBanner /> : <TrialBanner trialEnd={subData?.trial_end} />}
                            <h2 className="font-mono text-[11px] text-fg-40 uppercase tracking-[0.22em]">{tB("subscribeHeading")}</h2>
                            <div className="grid sm:grid-cols-2 gap-4">
                                <div className="rounded-2xl p-5 flex flex-col gap-4 border border-hairline bg-surface-2/30">
                                    <div>
                                        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40 mb-1">{tB("monthlyPlan")}</p>
                                        <p className="text-2xl font-medium tracking-tight">{tShared("monthlyPrice")}</p>
                                    </div>
                                    <button onClick={() => handleSubscribe("monthly")} disabled={!!subscribing} className="w-full py-3 rounded-xl font-mono text-[10px] uppercase tracking-[0.18em] bg-veil border border-hairline hover:border-rule hover:bg-fg/10 transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                                        {subscribing === "monthly" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                                        {tB("btnSubscribeMonthly")}
                                    </button>
                                </div>
                                <div className="rounded-2xl p-5 flex flex-col gap-4 border border-accent/30 bg-accent/4">
                                    <div>
                                        <div className="flex items-center gap-2 mb-1">
                                            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40">{tB("annualPlan")}</p>
                                            <span className="px-2 py-0.5 rounded-md font-mono text-[9px] uppercase tracking-[0.18em] bg-accent-hot/15 text-accent-hot border border-accent-hot/25">{tB("annualSaving")}</span>
                                        </div>
                                        <p className="text-2xl font-medium tracking-tight">{tShared("annualPrice")}</p>
                                    </div>
                                    <button onClick={() => handleSubscribe("annual")} disabled={!!subscribing} className="w-full py-3 rounded-xl font-mono text-[10px] uppercase tracking-[0.18em] bg-accent text-surface font-bold hover:bg-accent-hot transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                                        {subscribing === "annual" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                                        {tB("btnSubscribeAnnual")}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            <StepperHeader
                backHref="/integrations"
                backLabel={t("backToIntegrations")}
                title={t("pageTitle")}
                subtitle={t("engineSubtitle")}
                providers={[
                    { icon: CreditCard, authorized: stripeConnected },
                    { icon: Building2, authorized: moloniAuthorized },
                    { icon: Settings2, authorized: settingsSaved, color: "accentHot" },
                ]}
                allComplete={allComplete}
                syncStateLabel={tShared("syncState")}
                realtimeOnLabel={tShared("realtimeOn")}
                waitingLabel={tShared("waitingConnection")}
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
                <motion.div initial={{ opacity: 0, y: 20, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.6 }} className="rounded-[2.5rem] p-1 shadow-2xl bg-accent-hot/10">
                    <div className="bg-surface rounded-[2.3rem] p-6 sm:p-10 flex flex-col gap-8 border border-veil">
                        <div className="flex flex-col md:flex-row items-center justify-between gap-8">
                            <div className="flex items-center gap-8">
                                <div className="w-20 h-20 rounded-[1.8rem] flex items-center justify-center bg-accent-hot/18 ring-2 ring-accent-hot ring-offset-4 ring-offset-surface"><ShieldCheck className="w-10 h-10 text-accent-hot" /></div>
                                <div className="space-y-1"><h3 className="text-2xl font-black tracking-tight">{tShared("integrationDoneTitle")}</h3><p className="text-fg-40 font-bold uppercase tracking-widest text-[10px]">{tShared("integrationDoneSub")}</p></div>
                            </div>
                            <div className="px-6 py-3 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] border bg-accent-hot/10 text-accent-hot border-accent-hot/30">{tShared("onlineRealtime")}</div>
                        </div>
                    </div>
                </motion.div>
            )}
        </div>
    );
}
