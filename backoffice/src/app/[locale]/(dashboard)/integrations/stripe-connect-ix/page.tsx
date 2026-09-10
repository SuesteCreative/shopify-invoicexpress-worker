"use client";

export const runtime = "edge";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { CreditCard, Loader2, Check, ChevronRight, Settings2, Zap, Info, ShieldCheck, FileText, Link2, Unlink, AlertTriangle } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { IntegrationStepper, StepperHeader, type StepDef } from "@/components/IntegrationStepper";
import SuspendedBanner from "@/components/SuspendedBanner";
import TrialBanner from "@/components/TrialBanner";

/**
 * Stripe Connect → InvoiceXpress.
 *
 * A separate integration from Stripe Legacy → InvoiceXpress, not a replacement:
 * the merchants on that one pasted a restricted key, and their setup is
 * untouched. Here the Stripe half is one click and nothing sensitive is typed.
 *
 * The worker never needed changing for this — `runAdapterPipeline` has always
 * taken the connection's `destination_kind`, and the registry hands
 * `stripe_connect` the same StripeSource as `stripe`. Only the UI assumed
 * Moloni.
 *
 * The InvoiceXpress and activate steps deliberately borrow the existing
 * wizard's copy (`stripeIxSetup`) and the Stripe step borrows the Connect
 * wizard's (`stripeConnectMoloniSetup`): they configure the same things, and two
 * translations of one sentence drift apart.
 *
 * Subscribing is a link to /faturacao rather than price buttons. The prices this
 * connection bills at live on the Stripe Legacy → IX product, and duplicating
 * them into a third namespace is how a wizard ends up quoting a stale figure.
 */

const CONNECT_ENABLED = process.env.NEXT_PUBLIC_STRIPE_CONNECT_ENABLED === "1";
const SOURCE_KIND = "stripe_connect";
const DESTINATION_KIND = "invoicexpress";

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

export default function StripeConnectIxIntegration() {
    const t = useTranslations("stripeConnectMoloniSetup");
    const tIx = useTranslations("stripeIxSetup");
    const tPage = useTranslations("stripeConnectIxSetup");
    const tB = useTranslations("faturacao");
    const params = useSearchParams();

    const [sub, setSub] = useState<any>(null);
    const [step, setStep] = useState(1);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [connecting, setConnecting] = useState(false);
    const [globalError, setGlobalError] = useState("");
    const [userRole, setUserRole] = useState("");
    const [targetUserId, setTargetUserId] = useState("");

    // Stripe (OAuth)
    const [stripeAccountId, setStripeAccountId] = useState("");
    const [stripeConnected, setStripeConnected] = useState(false);
    const [stripeError, setStripeError] = useState("");

    // InvoiceXpress
    const [ixAccount, setIxAccount] = useState("");
    const [ixApiKey, setIxApiKey] = useState("");
    const [ixEnvironment, setIxEnvironment] = useState("production");
    const [ixError, setIxError] = useState("");

    // Fiscal identity, which belongs to THIS connection and not to the account
    const [ixSequenceName, setIxSequenceName] = useState("");
    const [ixDocumentType, setIxDocumentType] = useState<"invoice" | "invoice_receipt">("invoice_receipt");
    const [exemptionReason, setExemptionReason] = useState("M01");
    const [vatIncluded, setVatIncluded] = useState(true);
    const [autoFinalize, setAutoFinalize] = useState(false);
    const [settingsSaved, setSettingsSaved] = useState(false);

    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("");

    const load = useCallback(async () => {
        const [integ, connect, source] = await Promise.all([
            fetch("/api/integrations").then(r => r.json()).catch(() => ({})),
            fetch("/api/integrations/stripe-connect").then(r => r.json()).catch(() => ({})),
            fetch(`/api/integrations/stripe-source?source_kind=${SOURCE_KIND}`).then(r => r.json()).catch(() => ({})),
        ]) as any[];

        if (integ?._viewer_role) setUserRole(integ._viewer_role);
        if (integ?.user_id) setTargetUserId(integ.user_id);
        // InvoiceXpress credentials live on the legacy row: one IX account per
        // Rioko account, shared by every connection that files into it.
        if (integ?.ix_account_name) setIxAccount(String(integ.ix_account_name));
        if (integ?.ix_api_key) setIxApiKey(String(integ.ix_api_key));
        if (integ?.ix_environment) setIxEnvironment(String(integ.ix_environment));
        const hasIxKey = !!integ?.ix_account_name && !!integ?.ix_api_key;

        const conn = connect?.connection;
        const sConnected = !!conn?.stripe?.connected;
        setStripeConnected(sConnected);
        setStripeAccountId(conn?.stripe?.stripe_account_id ?? "");

        // The fiscal identity this connection states for itself. Absent means
        // "inherit the account's legacy row", which is what the worker does.
        const fiscal = source?.connection?.fiscal ?? {};
        if (typeof fiscal.ix_sequence_name === "string") setIxSequenceName(fiscal.ix_sequence_name);
        if (fiscal.ix_document_type === "invoice" || fiscal.ix_document_type === "invoice_receipt") setIxDocumentType(fiscal.ix_document_type);
        if (typeof fiscal.ix_exemption_reason === "string" && fiscal.ix_exemption_reason) setExemptionReason(fiscal.ix_exemption_reason);
        if (typeof fiscal.vat_included === "boolean") setVatIncluded(fiscal.vat_included);
        if (typeof fiscal.auto_finalize === "boolean") setAutoFinalize(fiscal.auto_finalize);
        const hasFiscal = typeof fiscal.ix_document_type === "string";
        setSettingsSaved(hasFiscal);

        const status = (source?.connection?.status ?? conn?.status ?? "") as ConnectionStatus;
        setConnectionStatus(status);

        // Resume where the merchant actually is, not at the top.
        if (status === "active") setStep(4);
        else if (sConnected && hasIxKey && hasFiscal) setStep(3);
        else if (sConnected) setStep(2);
        else setStep(1);
    }, []);

    useEffect(() => {
        (async () => { await load(); setLoading(false); })();
        fetch("/api/billing/subscription").then(r => r.json()).then(setSub).catch(() => setSub(null));
    }, [load]);

    // The OAuth callback comes back here with its verdict in the query string.
    useEffect(() => {
        const status = params.get("stripe");
        if (!status) return;
        if (status === "connected") { load(); return; }
        if (status === "denied") setStripeError(t("stripeDenied"));
        else if (status === "error") setStripeError(params.get("detail") || t("stripeFailed"));
    }, [params, load, t]);

    const handleConnectStripe = async () => {
        setConnecting(true);
        setStripeError("");
        try {
            const res = await fetch("/api/integrations/stripe-connect/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ destination_kind: DESTINATION_KIND }),
            });
            const json: any = await res.json();
            if (!res.ok || !json.authorize_url) {
                setStripeError(json.error ?? `HTTP ${res.status}`);
                return;
            }
            // Full-page navigation, not a popup: Stripe's consent screen is where
            // the merchant picks which account to connect, and it has to be
            // unmistakably Stripe's own page.
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

    const postSource = (patch: Record<string, any>) => fetch("/api/integrations/stripe-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The account id is written by the OAuth callback and must not be echoed
        // back from a settings form that never held it.
        body: JSON.stringify({ source_kind: SOURCE_KIND, destination_kind: DESTINATION_KIND, ...patch }),
    });

    const handleSaveIx = async () => {
        if (!ixAccount.trim() || !ixApiKey.trim()) return;
        setSaving(true);
        setIxError("");
        try {
            // Credentials to the legacy row, fiscal identity to the connection.
            // Two integrations of one account may file into the SAME IX account
            // and still need different series, which is why the split exists.
            const credsRes = await fetch("/api/integrations", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // An absent key means "leave it alone"; an empty string would be
                // stored as NULL and lock the account out of InvoiceXpress.
                body: JSON.stringify({
                    ix_account_name: ixAccount.trim(),
                    ...(ixApiKey.trim() ? { ix_api_key: ixApiKey.trim() } : {}),
                    ix_environment: ixEnvironment,
                }),
            });
            if (!credsRes.ok) {
                const d: any = await credsRes.json().catch(() => ({}));
                setIxError(d.error ?? tIx("errorSaveCreds"));
                return;
            }

            const fiscalRes = await postSource({
                fiscal: {
                    ix_sequence_name: ixSequenceName.trim(),
                    ix_document_type: ixDocumentType,
                    ix_exemption_reason: exemptionReason,
                    vat_included: vatIncluded,
                    auto_finalize: autoFinalize,
                },
                status: "draft",
            });
            if (!fiscalRes.ok) {
                const d: any = await fiscalRes.json().catch(() => ({}));
                setIxError(d.error ?? tIx("alertSaveError"));
                return;
            }
            setSettingsSaved(true);
            setStep(3);
        } catch (e: any) {
            setIxError(e?.message ?? "Unknown error");
        } finally {
            setSaving(false);
        }
    };

    const handleActivate = async () => {
        setSaving(true);
        setGlobalError("");
        try {
            const res = await postSource({ status: "active" });
            if (!res.ok) {
                const d: any = await res.json().catch(() => ({}));
                setGlobalError(d.error ?? tIx("errorActivate"));
                return;
            }
            setConnectionStatus("active");
            setStep(4);
        } catch (e: any) {
            setGlobalError(e?.message ?? "Unknown error");
        } finally {
            setSaving(false);
        }
    };

    const subData = sub?.subscription;
    const uiState = sub?.ui_state;
    const hasActiveSub = uiState === "active";
    const showSubCta = sub !== null && !hasActiveSub && uiState !== "exempt";
    const subBlocked = !!sub?.blocked;
    const allComplete = connectionStatus === "active";

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
        update: tIx("update"),
        back: tIx("back"),
        statusAuthorized: tIx("statusAuthorized"),
        statusPending: tIx("statusPending"),
        diagnostic: tIx("diagnostic"),
        diagnosticSub: tIx("diagnosticSub"),
        diagnosticDefault: tIx("diagnosticDefault"),
        forceAuth: tIx("forceAuth"),
        areYouSure: tIx("areYouSure"),
        cancelAction: tIx("cancelAction"),
        alertForceAuthError: tIx("alertForceAuthError"),
    };

    const toggle = (on: boolean, onClick: () => void, hot = false) => (
        <button onClick={onClick} className={`w-12 h-6 rounded-full transition-all duration-500 relative ring-1 ring-inset ring-sunken ${on ? (hot ? "bg-accent-hot" : "bg-accent") : "bg-track-off"}`}>
            <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-500 ${on ? "left-7" : "left-1"}`} />
        </button>
    );

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
                            {t("continueToSettings")}
                        </button>
                    )}
                </div>
            ),
        },
        {
            id: 2,
            title: tPage("step2Title"),
            description: tPage("step2Desc"),
            icon: FileText,
            isAuthorized: settingsSaved,
            errorMsg: ixError,
            body: (
                <div className="grid md:grid-cols-2 gap-8">
                    <div className="md:col-span-2 flex items-start gap-4 bg-accent/5 border border-accent/20 rounded-2xl px-6 py-4">
                        <Info className="w-5 h-5 text-accent-ink shrink-0 mt-0.5" />
                        <div className="space-y-1">
                            <p className="text-sm font-bold text-accent-ink">{tPage("ixIntroTitle")}</p>
                            <p className="text-[11px] text-fg-60 leading-relaxed">{tPage("ixIntroBody")}</p>
                        </div>
                    </div>

                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{tIx("fieldIxAccountLabel")}</label>
                        <input type="text" value={ixAccount} onChange={(e) => setIxAccount(e.target.value)} placeholder={tIx("fieldIxAccountPlaceholder")} className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium font-mono focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40" />
                    </div>
                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{tIx("fieldIxApiKeyLabel")}</label>
                        <input type="password" value={ixApiKey} onChange={(e) => setIxApiKey(e.target.value)} placeholder={tIx("fieldIxApiKeyPlaceholder")} className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium font-mono focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40" />
                    </div>

                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{tIx("fieldSeqLabel")}</label>
                        <input type="text" value={ixSequenceName} onChange={(e) => setIxSequenceName(e.target.value)} placeholder={tIx("fieldSeqPlaceholder")} className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium font-mono focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40" />
                        <p className="text-[10px] text-fg-40 ml-1">{tPage("seqHint")}</p>
                    </div>
                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1"><span className="w-1 h-1 rounded-full bg-accent" />{tIx("fieldIxEnvLabel")}</label>
                        <div className="flex gap-2">
                            {(["production", "sandbox"] as const).map((e) => (
                                <button key={e} onClick={() => setIxEnvironment(e)} className={`flex-1 py-3.5 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all duration-300 ${ixEnvironment === e ? "bg-accent-hot text-surface shadow-lg" : "bg-surface-2/50 text-fg-40 hover:text-fg ring-1 ring-inset ring-hairline"}`}>
                                    {e}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="glass p-6 rounded-2xl flex items-center justify-between border-hairline">
                        <div>
                            <h3 className="font-bold text-sm">{tIx("vatIncluded")}</h3>
                            <p className="text-[10px] text-fg-40 font-medium mt-1 uppercase tracking-wider">{vatIncluded ? tIx("vatIncludedOn") : tIx("vatIncludedOff")}</p>
                        </div>
                        {toggle(vatIncluded, () => setVatIncluded(!vatIncluded), true)}
                    </div>
                    <div className="glass p-6 rounded-2xl flex items-center justify-between border-hairline">
                        <div>
                            <h3 className="font-bold text-sm">{tIx("autoFinalize")}</h3>
                            <p className="text-[10px] text-fg-40 font-medium mt-1 uppercase tracking-wider">{tIx("autoFinalizeDesc")}</p>
                        </div>
                        {toggle(autoFinalize, () => setAutoFinalize(!autoFinalize))}
                    </div>

                    <div className="md:col-span-2 glass p-6 rounded-2xl border-hairline space-y-3">
                        <h3 className="font-bold text-sm">{tIx("docType")}</h3>
                        <div className="flex gap-2">
                            {(["invoice_receipt", "invoice"] as const).map((dt) => (
                                <button key={dt} onClick={() => setIxDocumentType(dt)} className={`flex-1 py-3.5 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all duration-300 ${ixDocumentType === dt ? "bg-accent-hot text-surface shadow-lg" : "bg-surface-2/50 text-fg-40 hover:text-fg ring-1 ring-inset ring-hairline"}`}>
                                    {dt === "invoice_receipt" ? tIx("docTypeReceipt") : tIx("docTypeInvoice")}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="md:col-span-2 glass p-5 sm:p-8 rounded-[2rem] border-hairline space-y-4">
                        <div className="flex items-center gap-3 mb-2"><div className="p-2 bg-soon/10 rounded-xl"><Info className="w-4 h-4 text-soon" /></div><h3 className="font-bold text-sm tracking-tight">{tIx("exemptionTitle")}</h3></div>
                        <select value={exemptionReason} onChange={(e) => setExemptionReason(e.target.value)} className="w-full bg-surface-2/80 border border-hairline rounded-2xl px-6 py-4 text-sm font-bold focus:ring-2 focus:ring-soon/20 focus:border-soon outline-none transition-all cursor-pointer text-fg">
                            {exemptionOptions.map((opt) => (<option key={opt.value} value={opt.value} className="bg-surface-2">{opt.value} - {opt.label}</option>))}
                        </select>
                    </div>

                    <div className="md:col-span-2 glass p-5 sm:p-6 rounded-2xl border-hairline flex items-center justify-between gap-4">
                        <div className="min-w-0">
                            <h3 className="font-bold text-sm">{tIx("tagRoutingTitle")}</h3>
                            <p className="text-[10px] text-fg-40 font-medium mt-0.5 uppercase tracking-wider truncate">{tIx("tagRoutingDesc")}</p>
                        </div>
                        <Link href={`/integrations/tag-routing?source_kind=${SOURCE_KIND}&destination_kind=${DESTINATION_KIND}`} className="px-5 py-2.5 rounded-xl border border-hairline hover:border-rule text-[10px] font-black uppercase tracking-[0.18em] transition-colors shrink-0">{tIx("manageTagRouting")}</Link>
                    </div>

                    <div className="md:col-span-2 pt-2 flex items-center gap-4">
                        <button onClick={() => setStep(1)} className="text-fg-40 hover:text-fg text-[10px] font-black uppercase tracking-widest transition-all px-4">{tIx("back")}</button>
                        <button onClick={handleSaveIx} disabled={saving || !ixAccount.trim() || !ixApiKey.trim()} className="flex-1 py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-fg text-surface hover:bg-accent-hot hover:text-surface disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed">
                            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Zap className="w-5 h-5" /> {tIx("update")}</>}
                        </button>
                    </div>
                </div>
            ),
        },
        {
            id: 3,
            title: tIx("activateTitle"),
            description: tIx("activateDesc"),
            icon: Zap,
            isAuthorized: connectionStatus === "active",
            body: (
                <div className="space-y-8">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-accent-hot/5 border-accent-hot/20">
                            <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-accent-hot/10"><CreditCard className="w-4 h-4 text-accent-hot" /></div>
                            <div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">{tIx("stripeLabel")}</p><p className="text-xs font-bold text-accent-hot">{tIx("configured")}</p></div>
                            <Check className="w-4 h-4 text-accent-hot ml-auto" />
                        </div>
                        <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-accent-hot/5 border-accent-hot/20">
                            <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-accent-hot/10"><FileText className="w-4 h-4 text-accent-hot" /></div>
                            <div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">{tIx("ixLabel")}</p><p className="text-xs font-bold text-accent-hot">{tIx("configured")}</p></div>
                            <Check className="w-4 h-4 text-accent-hot ml-auto" />
                        </div>
                    </div>
                    <div className="flex items-start gap-4 bg-surface-2/50 border border-hairline rounded-2xl px-6 py-4">
                        <AlertTriangle className="w-5 h-5 text-soon shrink-0 mt-0.5" />
                        <p className="text-[11px] text-fg-60 leading-relaxed">{tIx("activateWarning")}</p>
                    </div>
                    <button onClick={handleActivate} disabled={saving || connectionStatus === "active"} className="w-full py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-fg text-surface hover:bg-accent-hot hover:text-surface disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed">
                        {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Zap className="w-5 h-5" /> {connectionStatus === "active" ? tIx("active") : tIx("markAsActive")}</>}
                    </button>
                    {globalError && <p className="text-[11px] text-destructive font-bold text-center">{globalError}</p>}
                </div>
            ),
        },
    ];

    return (
        <div className="max-w-5xl mx-auto space-y-8 pb-24">
            {showSubCta && (
                <div className="space-y-4">
                    {subBlocked ? <SuspendedBanner /> : <TrialBanner trialEnd={subData?.trial_end} />}
                    <div className="glass rounded-2xl border-hairline p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div>
                            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40 mb-1">{tB("subscribeHeading")}</p>
                            <p className="text-[11px] text-fg-60 leading-relaxed">{tPage("subscribeHint")}</p>
                        </div>
                        <Link href="/faturacao" className="px-5 py-3 rounded-2xl bg-accent text-surface font-mono text-[10px] uppercase tracking-[0.18em] hover:bg-accent-hot transition-all flex items-center gap-2 shrink-0">
                            <CreditCard className="w-4 h-4" />
                            {tB("subscribeHeading")}
                        </Link>
                    </div>
                </div>
            )}

            <StepperHeader
                backHref="/integrations"
                backLabel={t("backToIntegrations")}
                title={tPage("pageTitle")}
                subtitle={tPage("engineSubtitle")}
                providers={[
                    { icon: CreditCard, authorized: stripeConnected },
                    { icon: FileText, authorized: settingsSaved },
                    { icon: Settings2, authorized: allComplete, color: "accentHot" },
                ]}
                allComplete={allComplete}
                syncStateLabel={tIx("syncState")}
                realtimeOnLabel={tIx("realtimeOn")}
                waitingLabel={tIx("waitingConnection")}
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
                                <div className="space-y-1"><h3 className="text-2xl font-black tracking-tight">{tIx("integrationDoneTitle")}</h3><p className="text-fg-40 font-bold uppercase tracking-widest text-[10px]">{tIx("integrationDoneSub")}</p></div>
                            </div>
                            <div className="px-6 py-3 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] border bg-accent-hot/10 text-accent-hot border-accent-hot/30">{tIx("onlineRealtime")}</div>
                        </div>
                    </div>
                </motion.div>
            )}
        </div>
    );
}
