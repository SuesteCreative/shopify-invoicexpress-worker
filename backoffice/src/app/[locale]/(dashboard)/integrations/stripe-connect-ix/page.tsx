"use client";

export const runtime = "edge";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { CreditCard, Loader2, Check, ChevronRight, Settings2, Zap, Info, ShieldCheck, FileText, Link2, Unlink, AlertTriangle } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { IntegrationStepper, StepperHeader, type StepDef } from "@/components/IntegrationStepper";
import SubscriptionCard from "@/components/SubscriptionCard";
import { RETURN_SLUG_WIZARD_IX } from "@/lib/oauth-return";
import TaxRegistrations from "@/components/TaxRegistrations";
import InvoiceNote from "@/components/InvoiceNote";
import type { ConnectionFiscal } from "@/lib/connection-fiscal";
import { cn } from "@/lib/utils";
import { VAT_EXEMPTION_OPTIONS as exemptionOptions } from "@/lib/vat-exemptions";
import { ixStepState } from "@/lib/ix-step-state";

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
 * Subscribing happens on this page, through the same card the Stripe→IX page
 * mounts, named with this connection's key: status, price and checkout all ask
 * about `stripe_connect:invoicexpress`. It used to be a link to /faturacao,
 * which reads and bills the account's PRIMARY connection, so an account with an
 * older shop was shown this pair as unpaid and then sent to pay for the other.
 */

const CONNECT_ENABLED = process.env.NEXT_PUBLIC_STRIPE_CONNECT_ENABLED === "1";
const SOURCE_KIND = "stripe_connect";
const DESTINATION_KIND = "invoicexpress";

type ConnectionStatus = "draft" | "active" | "paused" | "error" | "";

export default function StripeConnectIxIntegration() {
    const t = useTranslations("stripeConnectMoloniSetup");
    const tIx = useTranslations("stripeIxSetup");
    const tPage = useTranslations("stripeConnectIxSetup");
    const params = useSearchParams();

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
    /** A key is stored, so leaving the field blank keeps it. */
    const [ixKeyStored, setIxKeyStored] = useState(false);
    const [ixEnvironment, setIxEnvironment] = useState("production");
    const [ixError, setIxError] = useState("");

    // Fiscal identity, which belongs to THIS connection and not to the account
    const [ixSequenceName, setIxSequenceName] = useState("");
    const [ixDocumentType, setIxDocumentType] = useState<"invoice" | "invoice_receipt">("invoice_receipt");
    const [exemptionReason, setExemptionReason] = useState("M01");
    const [vatIncluded, setVatIncluded] = useState(true);
    const [autoFinalize, setAutoFinalize] = useState(false);
    const [settingsSaved, setSettingsSaved] = useState(false);
    // Whether the account can actually reach InvoiceXpress. Separate from
    // `settingsSaved`, which only says a series and a document type were
    // chosen: this step asks for both halves and used to show its green tick on
    // the fiscal half alone. A merchant saved the settings, never pasted the
    // credentials, and read "AUTORIZADO" for a day while every payment died at
    // the proxy with UNAUTHENTICATED.
    const [ixCredsSaved, setIxCredsSaved] = useState(false);
    // Whether the key InvoiceXpress holds is the key we hold. This wizard never
    // asked, so "AUTORIZADO" here only ever meant "a credential is stored", and
    // a rotated key pasted one character short read exactly the same as a good
    // one. Set from presence on load, from a real answer after a save — which is
    // as honest as it can be without persisting the verdict.
    const [ixAuthorized, setIxAuthorized] = useState(false);
    /** ISO minute of the last successful save, so the merchant can see it landed. */
    const [savedAt, setSavedAt] = useState("");
    // Exactly what the connection states, and nothing else. Starting from {} and
    // only ever merging what the merchant touches is what keeps a key that was
    // never stated from being written as `false` on the next save.
    const [registrations, setRegistrations] = useState<ConnectionFiscal>({});

    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("");

    const load = useCallback(async () => {
        const [integ, connect, source] = await Promise.all([
            fetch("/api/integrations").then(r => r.json()).catch(() => ({})),
            fetch(`/api/integrations/stripe-connect?destination_kind=${DESTINATION_KIND}`).then(r => r.json()).catch(() => ({})),
            fetch(`/api/integrations/stripe-source?source_kind=${SOURCE_KIND}&destination_kind=${DESTINATION_KIND}`).then(r => r.json()).catch(() => ({})),
        ]) as any[];

        if (integ?._viewer_role) setUserRole(integ._viewer_role);
        if (integ?.user_id) setTargetUserId(integ.user_id);
        // One rule, both places a credential can live, every wizard. Reading
        // either place alone is what gave this page a dead "Atualizar" button
        // and the others a pending badge over a working connection.
        const ix = ixStepState(integ, source?.connection);
        setIxAccount(ix.accountName);
        if (integ?.ix_environment) setIxEnvironment(String(integ.ix_environment));
        const hasIxKey = ix.keyStored;
        setIxKeyStored(hasIxKey);
        setIxCredsSaved(hasIxKey);
        setIxAuthorized(ix.authorized);

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
        setRegistrations({
            ...(typeof fiscal.oss_engine === "boolean" ? { oss_engine: fiscal.oss_engine } : {}),
            ...(typeof fiscal.pt_regional_rates === "boolean" ? { pt_regional_rates: fiscal.pt_regional_rates } : {}),
            ...(typeof fiscal.b2b_reverse_charge_pipeline === "boolean" ? { b2b_reverse_charge_pipeline: fiscal.b2b_reverse_charge_pipeline } : {}),
            ...(typeof fiscal.oss_export_exemption_code === "string" ? { oss_export_exemption_code: fiscal.oss_export_exemption_code } : {}),
            ...(typeof fiscal.custom_invoice_note === "string" ? { custom_invoice_note: fiscal.custom_invoice_note } : {}),
        });
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
                body: JSON.stringify({ destination_kind: DESTINATION_KIND, return_slug: RETURN_SLUG_WIZARD_IX }),
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
            await fetch(`/api/integrations/stripe-connect?destination_kind=${DESTINATION_KIND}`, { method: "DELETE" });
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
        // The body below already omits a blank key, so a stored one survives a
        // save that only changes the account name or the environment.
        //
        // Says why it did nothing. A bare `return` here left the button looking
        // broken: clicking it produced no save, no error and no spinner.
        if (!ixAccount.trim() || (!ixApiKey.trim() && !ixKeyStored)) {
            setIxError(tPage("errorIxRequired"));
            return;
        }
        setSaving(true);
        setIxError("");
        setSavedAt("");
        try {
            // Credentials AND fiscal identity on the connection, in one post.
            //
            // They used to be split: the credentials went to the account's
            // legacy `integrations` row and the fiscal identity here. That split
            // gave an account with no Shopify an `integrations` row anyway, the
            // admin console drew it as a broken "Shopify → InvoiceXpress" pipe,
            // and deleting the pipe that did not exist destroyed the credential
            // that did. It cost two merchants their invoicing.
            const fiscalRes = await postSource({
                ix_credentials: {
                    ix_account_name: ixAccount.trim(),
                    // An absent key means "leave it alone" — a form that
                    // rendered before its GET returned must not clear one.
                    ...(ixApiKey.trim() ? { ix_api_key: ixApiKey.trim() } : {}),
                    ix_environment: ixEnvironment,
                },
                fiscal: {
                    ix_sequence_name: ixSequenceName.trim(),
                    ix_document_type: ixDocumentType,
                    ix_exemption_reason: exemptionReason,
                    vat_included: vatIncluded,
                    auto_finalize: autoFinalize,
                    // Spread last and only what was stated: a registration the
                    // merchant never touched is absent here, and absent is off.
                    ...registrations,
                },
                // No status: this is a settings save, not a lifecycle change.
                // It used to post "draft", which deactivated the connection.
            });
            if (!fiscalRes.ok) {
                const d: any = await fiscalRes.json().catch(() => ({}));
                setIxError(d.error ?? tIx("alertSaveError"));
                return;
            }
            setSettingsSaved(true);

            // Ask InvoiceXpress whether the key actually works, the way every
            // other IX wizard does. Presence is not a verdict, and a merchant who
            // has just rotated a key is precisely the one who needs the verdict:
            // theirs is the case where a good save and a mistyped one look
            // identical until the first sale of the day fails to invoice.
            //
            // Deliberately AFTER the save. They rotated the key; the new one has
            // to be stored even if it was pasted wrong, or the next attempt
            // starts from a credential nobody has any more.
            const valRes = await fetch("/api/integrations/validate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "ix", source_kind: SOURCE_KIND }),
            });
            const valData = await valRes.json().catch(() => ({})) as { isValid?: boolean; error?: string };

            // The key is on the server now, so the field goes back to showing
            // that one is stored rather than holding a copy of it.
            setIxApiKey("");
            // The server's account of things, including the status: `load` also
            // decides which step to open, so nothing may set a step after it.
            await load();
            // AFTER the reload, never before: `load` sets `ixAuthorized` from
            // presence, which would overwrite the verdict just obtained and put
            // a green tick back on a key InvoiceXpress had refused.
            setIxAuthorized(!!valData.isValid);

            if (!valData.isValid) {
                setIxError(valData.error || tIx("alertSaveError"));
                return;
            }
            setSavedAt(new Date().toTimeString().slice(0, 5));
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
            isAuthorized: ixAuthorized && settingsSaved,
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
                        <input type="password" value={ixApiKey} onChange={(e) => setIxApiKey(e.target.value)} placeholder={ixKeyStored ? "••••••••••••" : tIx("fieldIxApiKeyPlaceholder")} className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium font-mono focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40" />
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

                    <TaxRegistrations
                        value={registrations}
                        onChange={(patch) => setRegistrations((r) => ({ ...r, ...patch }))}
                        disabled={saving}
                        destination="invoicexpress"
                    />
                    <InvoiceNote
                        value={registrations.custom_invoice_note ?? ""}
                        onChange={(v) => setRegistrations((r) => ({ ...r, custom_invoice_note: v }))}
                        disabled={saving}
                    />

                    <div className="md:col-span-2 glass p-5 sm:p-6 rounded-2xl border-hairline flex items-center justify-between gap-4">
                        <div className="min-w-0">
                            <h3 className="font-bold text-sm">{tIx("tagRoutingTitle")}</h3>
                            <p className="text-[10px] text-fg-40 font-medium mt-0.5 uppercase tracking-wider truncate">{tIx("tagRoutingDesc")}</p>
                        </div>
                        <Link href={`/integrations/tag-routing?source_kind=${SOURCE_KIND}&destination_kind=${DESTINATION_KIND}`} className="px-5 py-2.5 rounded-xl border border-hairline hover:border-rule text-[10px] font-black uppercase tracking-[0.18em] transition-colors shrink-0">{tIx("manageTagRouting")}</Link>
                    </div>

                    <div className="md:col-span-2 pt-2 flex items-center gap-4">
                        <button onClick={() => setStep(1)} className="text-fg-40 hover:text-fg text-[10px] font-black uppercase tracking-widest transition-all px-4">{tIx("back")}</button>
                        <button onClick={handleSaveIx} disabled={saving || !ixAccount.trim() || (!ixApiKey.trim() && !ixKeyStored)} className="flex-1 py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-fg text-surface hover:bg-accent-hot hover:text-surface disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed">
                            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Zap className="w-5 h-5" /> {tIx("update")}</>}
                        </button>
                    </div>
                </div>
            ),
        },
        {
            id: 3,
            // `stripeIxSetup.activateTitle` is numbered by the caller: that
            // wizard has four steps, this one has three. Omitting the argument
            // printed the placeholder itself, "Passo {n}".
            title: tIx("activateTitle", { n: 3 }),
            description: tIx("activateDesc"),
            icon: Zap,
            isAuthorized: connectionStatus === "active",
            body: (
                <div className="space-y-8">
                    {/* Both cards used to be hardcoded green. This is the last
                        screen before a merchant commits, so it is the worst
                        possible place to state that something is configured
                        without looking. */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {([
                            { icon: CreditCard, label: tIx("stripeLabel"), ok: stripeConnected },
                            { icon: FileText, label: tIx("ixLabel"), ok: ixAuthorized && settingsSaved },
                        ] as const).map(({ icon: Icon, label, ok }) => (
                            <div key={label} className={cn("flex items-center gap-3 px-5 py-4 rounded-2xl border", ok ? "bg-accent-hot/5 border-accent-hot/20" : "bg-soon/5 border-soon/20")}>
                                <div className={cn("w-8 h-8 rounded-xl flex items-center justify-center shrink-0", ok ? "bg-accent-hot/10" : "bg-soon/10")}><Icon className={cn("w-4 h-4", ok ? "text-accent-hot" : "text-soon")} /></div>
                                <div><p className="text-[10px] font-black uppercase tracking-wider text-fg-40">{label}</p><p className={cn("text-xs font-bold", ok ? "text-accent-hot" : "text-soon")}>{ok ? tIx("configured") : tIx("statusPending")}</p></div>
                                {ok && <Check className="w-4 h-4 text-accent-hot ml-auto" />}
                            </div>
                        ))}
                    </div>
                    <div className="flex items-start gap-4 bg-surface-2/50 border border-hairline rounded-2xl px-6 py-4">
                        <AlertTriangle className="w-5 h-5 text-soon shrink-0 mt-0.5" />
                        <p className="text-[11px] text-fg-60 leading-relaxed">{tIx("activateWarning")}</p>
                    </div>
                    <button onClick={handleActivate} disabled={saving || connectionStatus === "active" || !stripeConnected || !ixCredsSaved || !settingsSaved} className="w-full py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-fg text-surface hover:bg-accent-hot hover:text-surface disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed">
                        {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Zap className="w-5 h-5" /> {connectionStatus === "active" ? tIx("active") : tIx("markAsActive")}</>}
                    </button>
                    {globalError && <p className="text-[11px] text-destructive font-bold text-center">{globalError}</p>}
                </div>
            ),
        },
    ];

    return (
        <div className="max-w-5xl mx-auto space-y-8 pb-24">
            <SubscriptionCard
                onSuccess={params.get("stripe") === "success"}
                source="stripe-connect-ix"
                connectionKey={`${SOURCE_KIND}:${DESTINATION_KIND}`}
            />

            <StepperHeader
                backHref="/integrations"
                backLabel={t("backToIntegrations")}
                title={tPage("pageTitle")}
                subtitle={tPage("engineSubtitle")}
                providers={[
                    { icon: CreditCard, authorized: stripeConnected },
                    { icon: FileText, authorized: ixAuthorized && settingsSaved },
                    { icon: Settings2, authorized: allComplete, color: "accentHot" },
                ]}
                allComplete={allComplete}
                syncStateLabel={tIx("syncState")}
                realtimeOnLabel={tIx("realtimeOn")}
                waitingLabel={tIx("waitingConnection")}
            />

            {/* Saying so is the whole point, and it has to be said out here.
                The key field is empty by design on every load, so a merchant who
                has just pasted a rotated key cannot otherwise tell a save that
                worked from one that did nothing. Inside the step it would be
                invisible in the case that matters most: on a live connection the
                reload collapses the stepper, taking the step body with it. */}
            {savedAt && !ixError && (
                <p className="text-[11px] font-bold text-accent-hot text-center">
                    {tPage("savedVerified", { time: savedAt })}
                </p>
            )}

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
