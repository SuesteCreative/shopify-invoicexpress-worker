"use client";

export const runtime = "edge";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, Check, AlertTriangle, ArrowLeft, Lock, Info } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import Image from "next/image";
import MoloniOAuthStep, { type MoloniSiblingDefaults } from "@/components/MoloniOAuthStep";
import { RETURN_SLUG_WIZARD_SHOPIFY_MOLONI } from "@/lib/oauth-return";

type ConnectionStatus = "draft" | "active" | "paused" | "error" | "";

export default function ShopifyMoloniIntegration() {
    const t = useTranslations("shopifyMoloniSetup");
    const tCommon = useTranslations("integrationsIndex");
    const tConnect = useTranslations("stripeConnectMoloniSetup");
    const tStep = useTranslations("moloniOAuthStep");

    // Set by the Moloni callback when it sends the merchant back here.
    const searchParams = useSearchParams();
    const moloniResult = searchParams.get("moloni");
    const callbackDetail = searchParams.get("detail");

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState(false);

    const [shopifyConnected, setShopifyConnected] = useState<boolean | null>(null);

    // Moloni. Every new connection authorises by OAuth (15/09/2026); a username
    // and a password are only read, to recognise a connection set up before.
    const [clientId, setClientId] = useState("");
    const [clientSecret, setClientSecret] = useState("");
    const [environment, setEnvironment] = useState<"production" | "sandbox">("production");
    const [hasSavedSecret, setHasSavedSecret] = useState(false);
    const [username, setUsername] = useState("");
    const [hasSavedPassword, setHasSavedPassword] = useState(false);
    const [moloniAuthorized, setMoloniAuthorized] = useState(false);
    const [siblingDefaults, setSiblingDefaults] = useState<MoloniSiblingDefaults | null>(null);
    const [moloniError, setMoloniError] = useState("");

    const [companyName, setCompanyName] = useState("");
    const [documentSetName, setDocumentSetName] = useState("");
    const [status, setStatus] = useState<ConnectionStatus>("");

    // A connection set up with a password before OAuth is still a working one.
    const legacyPassword = !moloniAuthorized && !!username && hasSavedPassword;
    const moloniReady = moloniAuthorized || legacyPassword;

    // What the Moloni callback came back with.
    useEffect(() => {
        if (moloniResult === "denied") setMoloniError(tConnect("moloniDenied"));
        else if (moloniResult === "error") setMoloniError(callbackDetail || tConnect("moloniFailed"));
    }, [moloniResult, callbackDetail, tConnect]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [integRes, moloniRes] = await Promise.all([
                    fetch("/api/integrations"),
                    fetch("/api/integrations/moloni-destination?source_kind=shopify"),
                ]);
                if (cancelled) return;

                if (integRes.ok) {
                    const data = await integRes.json() as { shopify_domain?: string; shopify_authorized?: number };
                    setShopifyConnected(!!data.shopify_domain && data.shopify_authorized === 1);
                } else {
                    setShopifyConnected(false);
                }

                if (moloniRes.ok) {
                    const data = await moloniRes.json() as {
                        connection?: { status: ConnectionStatus; destination_config: Record<string, unknown> } | null;
                        sibling_defaults?: MoloniSiblingDefaults | null;
                    };
                    const cfg = data.connection?.destination_config ?? {};
                    if (data.connection) {
                        setClientId(String(cfg.moloni_client_id ?? ""));
                        setHasSavedSecret(!!cfg.has_client_secret);
                        setUsername(String(cfg.moloni_username ?? ""));
                        setHasSavedPassword(!!cfg.has_password);
                        setMoloniAuthorized(!!cfg.moloni_authorized);
                        setCompanyName(String(cfg.moloni_company_name ?? ""));
                        setDocumentSetName(String(cfg.moloni_document_set_name ?? ""));
                        setEnvironment((cfg.moloni_environment as "production" | "sandbox") ?? "production");
                        setStatus(data.connection.status);
                    }

                    // A second Moloni connection starts from the account's first: the
                    // same app and, most of the time, the same company, wherever this
                    // one states nothing. Never the tokens (it authorises on its own)
                    // and never the fiscal settings (those are its own decisions).
                    const sibling = data.sibling_defaults ?? null;
                    setSiblingDefaults(sibling);
                    if (sibling && !cfg.moloni_client_id && sibling.moloni_client_id) {
                        setClientId(String(sibling.moloni_client_id));
                        if (sibling.moloni_environment === "sandbox") setEnvironment("sandbox");
                    }
                    if (sibling && !cfg.moloni_company_name && sibling.moloni_company_name) {
                        setCompanyName(String(sibling.moloni_company_name));
                    }
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    async function save(targetStatus: "draft" | "active") {
        setError("");
        setSuccess(false);
        setSaving(true);
        try {
            if (targetStatus === "active" && !moloniReady) throw new Error(tStep("authorizeFirst"));

            // The credential is the authorisation, written by the start route and the
            // callback. This save is the invoicing settings, and only those.
            const res = await fetch("/api/integrations/moloni-destination", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    source_kind: "shopify",
                    moloni_company_name: companyName.trim(),
                    moloni_document_set_name: documentSetName.trim(),
                    moloni_environment: environment,
                    status: targetStatus,
                }),
            });
            if (!res.ok) {
                const json = await res.json().catch(() => ({})) as { error?: string };
                throw new Error(json.error ?? `HTTP ${res.status}`);
            }
            // Prove the credential answers, whichever way it authenticates.
            if (moloniReady) {
                const valRes = await fetch("/api/integrations/moloni-destination/companies?source_kind=shopify");
                if (!valRes.ok) {
                    const vjson = await valRes.json().catch(() => ({})) as { error?: string };
                    throw new Error(vjson.error ?? t("errorMoloniAuth"));
                }
            }
            setSuccess(true);
            setStatus(targetStatus);
        } catch (e: any) {
            setError(e?.message ?? "Unknown error");
        } finally {
            setSaving(false);
        }
    }

    if (loading) {
        return (
            <div className="max-w-3xl mx-auto py-20 flex items-center justify-center">
                <Loader2 className="w-6 h-6 animate-spin text-fg-60" />
            </div>
        );
    }

    return (
        <div className="max-w-3xl mx-auto py-6 sm:py-12 space-y-10">
            <div>
                <Link href="/integrations" className="inline-flex items-center gap-2 text-sm text-fg-60 hover:text-fg transition-colors">
                    <ArrowLeft className="w-4 h-4" /> {tCommon("title")}
                </Link>
            </div>

            <header className="space-y-4">
                <div className="flex items-center gap-4">
                    <div className="flex -space-x-3">
                        <div className="w-14 h-14 rounded-2xl bg-veil border border-hairline flex items-center justify-center backdrop-blur-xl ring-4 ring-surface p-3">
                            <Image src="/images/shopify-logo.webp" alt="Shopify" width={32} height={32} className="object-contain" />
                        </div>
                        <div className="w-14 h-14 rounded-2xl bg-veil border border-hairline flex items-center justify-center backdrop-blur-xl ring-4 ring-surface p-3">
                            <Image src="/images/moloni-logo.svg" alt="Moloni" width={30} height={30} className="object-contain" />
                        </div>
                    </div>
                    <div>
                        <h1 className="text-3xl font-medium tracking-tight">{t("title")}</h1>
                        <p className="text-fg-60 text-sm mt-1">{t("subtitle")}</p>
                    </div>
                </div>
            </header>

            <div className="glass p-5 sm:p-6 rounded-2xl border border-soon/30 bg-soon/5 flex items-start gap-3 sm:gap-4">
                <Info className="w-5 h-5 text-soon flex-shrink-0 mt-0.5" />
                <div className="space-y-2 min-w-0">
                    <p className="text-sm font-medium text-fg">{t("limitationsTitle")}</p>
                    <p className="text-xs text-fg-60 leading-relaxed">{t("limitationsBody")}</p>
                </div>
            </div>

            {!shopifyConnected && (
                <div className="glass p-5 sm:p-6 rounded-2xl border border-destructive/30 bg-destructive/5 flex items-start gap-4">
                    <AlertTriangle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
                    <div className="space-y-3">
                        <p className="text-sm text-fg">{t("shopifyMissingTitle")}</p>
                        <p className="text-xs text-fg-60">{t("shopifyMissingBody")}</p>
                        <Link href="/integrations/shopify-ix" className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-hairline hover:border-rule text-xs font-mono uppercase tracking-[0.18em]">
                            {t("configureShopify")}
                        </Link>
                    </div>
                </div>
            )}

            {moloniResult === "connected" && (
                <div className="glass p-4 rounded-xl border border-accent-hot/30 bg-accent-hot/5 flex items-start gap-3">
                    <Check className="w-4 h-4 text-accent-hot flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-accent-hot">{tConnect("moloniConnectedBanner")}</p>
                </div>
            )}

            <section className="space-y-5">
                <h2 className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{t("credentialsSection")}</h2>
                <MoloniOAuthStep
                    sourceKind="shopify"
                    returnSlug={RETURN_SLUG_WIZARD_SHOPIFY_MOLONI}
                    clientId={clientId}
                    onClientId={setClientId}
                    clientSecret={clientSecret}
                    onClientSecret={setClientSecret}
                    environment={environment}
                    onEnvironment={setEnvironment}
                    hasSavedSecret={hasSavedSecret}
                    authorized={moloniAuthorized}
                    legacyPassword={legacyPassword}
                    sibling={siblingDefaults}
                    onError={setMoloniError}
                />
                {moloniError && (
                    <div className="glass p-4 rounded-xl border border-destructive/30 bg-destructive/5 flex items-start gap-3">
                        <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
                        <p className="text-sm text-destructive">{moloniError}</p>
                    </div>
                )}
            </section>

            <section className="space-y-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Field label={t("companyIdLabel")} hint={t("companyNameHint")}>
                        <input
                            type="text"
                            value={companyName}
                            onChange={(e) => setCompanyName(e.target.value)}
                            placeholder="Kapta, Lda"
                            className="w-full bg-surface-2 border border-hairline rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-accent transition-colors"
                        />
                    </Field>
                    <Field label={t("documentSetIdLabel")} hint={t("documentSetNameHint")}>
                        <input
                            type="text"
                            value={documentSetName}
                            onChange={(e) => setDocumentSetName(e.target.value)}
                            placeholder="FR2026"
                            className="w-full bg-surface-2 border border-hairline rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-accent transition-colors font-mono"
                        />
                    </Field>
                </div>
            </section>

            {error && (
                <div className="glass p-4 rounded-xl border border-destructive/30 bg-destructive/5 flex items-start gap-3">
                    <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-destructive">{error}</p>
                </div>
            )}

            {success && (
                <div className="glass p-4 rounded-xl border border-accent-hot/30 bg-accent-hot/5 flex items-start gap-3">
                    <Check className="w-4 h-4 text-accent-hot flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-accent-hot">{t("savedOk")}</p>
                </div>
            )}

            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <button
                    type="button"
                    disabled={saving}
                    onClick={() => save("draft")}
                    className="px-6 py-3 rounded-2xl border border-hairline hover:border-rule text-sm font-mono uppercase tracking-[0.18em] disabled:opacity-50 disabled:cursor-not-allowed transition-colors w-full sm:w-auto"
                >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : t("saveDraft")}
                </button>
                <button
                    type="button"
                    disabled={saving || !shopifyConnected || !moloniReady}
                    onClick={() => save("active")}
                    className="px-6 py-3 rounded-2xl bg-fg text-surface font-mono text-sm uppercase tracking-[0.18em] hover:bg-accent-hot transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 w-full sm:w-auto"
                >
                    {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                    {t("activate")}
                </button>
                {status === "active" && (
                    <span className="text-xs font-mono uppercase tracking-[0.18em] text-accent-hot flex items-center gap-1">
                        <Check className="w-3 h-3" /> {t("currentlyActive")}
                    </span>
                )}
            </div>

            <section className="glass p-5 rounded-2xl border-hairline flex items-center justify-between gap-4">
                <div className="min-w-0">
                    <h3 className="font-bold text-sm">{t("productMappingsTitle")}</h3>
                    <p className="text-[10px] text-fg-40 font-medium mt-0.5 uppercase tracking-wider truncate">{t("productMappingsDesc")}</p>
                </div>
                <Link href="/integrations/moloni-mappings?source_kind=shopify" className="px-5 py-2.5 rounded-xl border border-hairline hover:border-rule text-[10px] font-black uppercase tracking-[0.18em] transition-colors shrink-0">{t("manageMappings")}</Link>
            </section>

            <section className="glass p-5 rounded-2xl border-hairline flex items-center justify-between gap-4">
                <div className="min-w-0">
                    <h3 className="font-bold text-sm">{t("tagRoutingTitle")}</h3>
                    <p className="text-[10px] text-fg-40 font-medium mt-0.5 uppercase tracking-wider truncate">{t("tagRoutingDesc")}</p>
                </div>
                <Link href="/integrations/tag-routing?source_kind=shopify&destination_kind=moloni" className="px-5 py-2.5 rounded-xl border border-hairline hover:border-rule text-[10px] font-black uppercase tracking-[0.18em] transition-colors shrink-0">{t("manageTagRouting")}</Link>
            </section>

            <section className="pt-8 border-t border-hairline">
                <div className="flex items-start gap-3">
                    <Lock className="w-4 h-4 text-fg-40 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-fg-60">{t("securityFooter")}</p>
                </div>
            </section>
        </div>
    );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <label className="block space-y-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-60">{label}</span>
            {children}
            {hint && <span className="block text-xs text-fg-40">{hint}</span>}
        </label>
    );
}
