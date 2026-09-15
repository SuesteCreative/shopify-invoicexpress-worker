"use client";

import { useState } from "react";
import { Check, Copy, Info, KeyRound, Link2, Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { moloniCallbackUri } from "@/lib/moloni-oauth";

/** What `/api/integrations/moloni-destination` offers from the account's other Moloni connection. */
export interface MoloniSiblingDefaults {
    moloni_client_id: string | null;
    has_client_secret: boolean;
    moloni_environment: string;
    moloni_company_name: string | null;
}

/**
 * The Moloni authorisation step, for the dashboard wizards that file into Moloni.
 *
 * Since 15/09/2026 every new Moloni connection authorises by OAuth, from any
 * door. Stripe, Lodgify and Shopify → Moloni used to ask for a username and a
 * password, each in its own copy of the form; this is the one they share now, so
 * they cannot drift apart the way those copies did.
 *
 * A connection set up with a username and a password before the change keeps
 * invoicing on it. The step says so and offers the switch instead of forcing it.
 *
 * Errors are reported through `onError` and rendered by the page, which also
 * hands them to its stepper and to the callback's `?moloni=` result.
 */
export default function MoloniOAuthStep({
    sourceKind,
    returnSlug,
    clientId,
    onClientId,
    clientSecret,
    onClientSecret,
    environment,
    onEnvironment,
    hasSavedSecret,
    authorized,
    legacyPassword,
    sibling,
    onError,
    onBack,
    onContinue,
}: {
    /** Which connection is authorising. The start route refuses to guess. */
    sourceKind: "stripe" | "lodgify" | "shopify";
    /** Where the Moloni callback puts the merchant down, from `@/lib/oauth-return`. */
    returnSlug: string;
    clientId: string;
    onClientId: (value: string) => void;
    clientSecret: string;
    onClientSecret: (value: string) => void;
    environment: "production" | "sandbox";
    onEnvironment: (value: "production" | "sandbox") => void;
    hasSavedSecret: boolean;
    authorized: boolean;
    legacyPassword: boolean;
    sibling: MoloniSiblingDefaults | null;
    onError: (message: string) => void;
    onBack?: () => void;
    onContinue?: () => void;
}) {
    const t = useTranslations("stripeConnectMoloniSetup");
    const tStep = useTranslations("moloniOAuthStep");
    const locale = useLocale();

    const [connecting, setConnecting] = useState(false);
    const [copied, setCopied] = useState(false);
    // A password connection only shows the OAuth form once the merchant asks for it.
    const [migrating, setMigrating] = useState(false);

    const redirectUri = moloniCallbackUri();

    // The account's other Moloni connection holds this app's secret already. The
    // start route reads it server-side — it never reaches the browser — but only
    // for the same app, so the Developer ID on screen has to be that one.
    const borrowsSiblingApp = !hasSavedSecret
        && !!sibling?.moloni_client_id
        && sibling.has_client_secret
        && clientId.trim() === String(sibling.moloni_client_id);
    const canAuthorize = !!clientId.trim() && (!!clientSecret.trim() || hasSavedSecret || borrowsSiblingApp);
    const showForm = !legacyPassword || migrating;

    const authorize = async () => {
        setConnecting(true);
        onError("");
        try {
            const res = await fetch("/api/integrations/moloni-oauth/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    source_kind: sourceKind,
                    client_id: clientId.trim(),
                    // Blank keeps the stored secret, or borrows the other connection's.
                    client_secret: clientSecret.trim() || undefined,
                    environment,
                    return_slug: returnSlug,
                    return_locale: locale,
                }),
            });
            const json: any = await res.json().catch(() => ({}));
            if (!res.ok || !json.authorize_url) {
                onError(json.error ?? `HTTP ${res.status}`);
                return;
            }
            // Full-page navigation, not a popup: the consent screen has to be
            // unmistakably Moloni's own page.
            window.location.href = json.authorize_url;
        } catch (e: any) {
            onError(e?.message ?? "Unknown error");
        } finally {
            setConnecting(false);
        }
    };

    const copyRedirectUri = async () => {
        try {
            await navigator.clipboard.writeText(redirectUri);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch { /* clipboard unavailable — the field is selectable anyway */ }
    };

    return (
        <div className="grid md:grid-cols-2 gap-8">
            {!showForm ? (
                <div className="md:col-span-2 glass p-6 rounded-2xl border-hairline space-y-4">
                    <div className="flex items-start gap-4">
                        <div className="w-10 h-10 rounded-xl bg-accent-hot/12 flex items-center justify-center shrink-0">
                            <KeyRound className="w-5 h-5 text-accent-hot" />
                        </div>
                        <div className="space-y-1 min-w-0">
                            <p className="font-bold text-sm">{tStep("legacyTitle")}</p>
                            <p className="text-[11px] text-fg-60 leading-relaxed">{tStep("legacyBody")}</p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => setMigrating(true)}
                        className="px-5 py-2.5 rounded-xl border border-hairline hover:border-rule text-[10px] font-black uppercase tracking-[0.18em] transition-colors"
                    >
                        {tStep("migrate")}
                    </button>
                </div>
            ) : (
                <>
                    {/* A merchant who already has the Moloni API active does not
                        create anything: they open the app they have, replace its
                        Redirect URI with ours and press Atualizar in Moloni. Told
                        to "activate the API as Developer" instead, they go looking
                        for a second app and end up with a Developer ID that does
                        not match the credentials this connection invoices with. */}
                    <div className="md:col-span-2 flex items-start gap-4 bg-accent/5 border border-accent/20 rounded-2xl px-6 py-4">
                        <Info className="w-5 h-5 text-accent-ink shrink-0 mt-0.5" />
                        <div className="space-y-1">
                            <p className="text-sm font-bold text-accent-ink">
                                {legacyPassword ? tStep("migrateTitle") : t("moloniIntroTitle")}
                            </p>
                            {legacyPassword && (
                                <p className="text-[11px] text-soon leading-relaxed">{tStep("migrateBody")}</p>
                            )}
                            <ol className="text-[11px] text-fg-60 mt-2 leading-relaxed list-decimal pl-4 space-y-1">
                                {legacyPassword ? (
                                    <>
                                        <li>{tStep("migrateStep1")}</li>
                                        <li>{tStep("migrateStep2")}</li>
                                        <li>{tStep("migrateStep3")}</li>
                                        <li>{tStep("migrateStep4")}</li>
                                    </>
                                ) : (
                                    <>
                                        <li>{t("moloniStep1")}</li>
                                        <li>{t("moloniStep2")}</li>
                                        <li>{t("moloniStep3")}</li>
                                    </>
                                )}
                            </ol>
                        </div>
                    </div>

                    {borrowsSiblingApp && (
                        <div className="md:col-span-2 flex items-start gap-3 px-6 py-4 rounded-2xl bg-accent-hot/8 border border-accent-hot/25">
                            <Check className="w-4 h-4 text-accent-hot shrink-0 mt-0.5" />
                            <p className="text-[11px] text-fg-60 leading-relaxed">{tStep("siblingApp")}</p>
                        </div>
                    )}

                    {/* The same URI for every merchant and every connection: a Moloni
                        developer app holds exactly one, and it must match byte for byte. */}
                    <div className="md:col-span-2 glass p-6 rounded-2xl border-hairline space-y-3">
                        <h3 className="font-bold text-sm">{t("redirectUriTitle")}</h3>
                        <p className="text-[10px] text-fg-40 leading-relaxed">{t("redirectUriBody")}</p>
                        <div className="flex items-center gap-3">
                            <code className="flex-1 bg-surface-2/60 border border-hairline rounded-xl px-4 py-3 text-[11px] font-mono break-all">
                                {redirectUri}
                            </code>
                            <button
                                type="button"
                                onClick={copyRedirectUri}
                                className="px-4 py-3 rounded-xl border border-hairline hover:border-rule text-[10px] font-black uppercase tracking-[0.18em] transition-colors shrink-0 flex items-center gap-2"
                            >
                                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                {copied ? t("copied") : t("copy")}
                            </button>
                        </div>
                    </div>

                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1">
                            <span className="w-1 h-1 rounded-full bg-accent" />{t("developerIdLabel")}
                        </label>
                        <input
                            type="text"
                            value={clientId}
                            onChange={(e) => onClientId(e.target.value)}
                            placeholder="000000"
                            className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium font-mono focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40"
                        />
                    </div>
                    <div className="space-y-3">
                        <label className="text-[10px] text-fg-40 font-black uppercase tracking-[0.2em] flex items-center gap-2 ml-1">
                            <span className="w-1 h-1 rounded-full bg-accent" />{t("clientSecretLabel")}
                        </label>
                        <input
                            type="password"
                            value={clientSecret}
                            onChange={(e) => onClientSecret(e.target.value)}
                            placeholder={hasSavedSecret || borrowsSiblingApp ? "••••••••" : ""}
                            className="w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium font-mono focus:ring-2 focus:ring-accent/20 focus:border-accent outline-none transition-all placeholder:text-fg-40"
                        />
                    </div>

                    <div className="md:col-span-2 glass p-6 rounded-2xl border-hairline space-y-3">
                        <h3 className="font-bold text-sm">{t("environmentLabel")}</h3>
                        <div className="flex gap-2">
                            {(["production", "sandbox"] as const).map((env) => (
                                <button
                                    key={env}
                                    type="button"
                                    onClick={() => onEnvironment(env)}
                                    className={`flex-1 py-3.5 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all duration-300 ${environment === env ? "bg-accent-hot text-surface shadow-lg" : "bg-surface-2/50 text-fg-40 hover:text-fg ring-1 ring-inset ring-hairline"}`}
                                >
                                    {env === "production" ? t("envProduction") : t("envSandbox")}
                                </button>
                            ))}
                        </div>
                    </div>

                    {authorized && (
                        <div className="md:col-span-2 flex items-center gap-4 px-6 py-4 rounded-2xl bg-accent-hot/8 border border-accent-hot/25">
                            <Check className="w-5 h-5 text-accent-hot shrink-0" />
                            <p className="text-sm font-bold text-accent-hot">{t("moloniAuthorized")}</p>
                        </div>
                    )}
                </>
            )}

            <div className="md:col-span-2 pt-2 flex items-center gap-4">
                {onBack && (
                    <button type="button" onClick={onBack} className="text-fg-40 hover:text-fg text-[10px] font-black uppercase tracking-widest transition-all px-4">
                        {tStep("back")}
                    </button>
                )}
                {showForm && (
                    <button
                        type="button"
                        onClick={authorize}
                        disabled={connecting || !canAuthorize}
                        className="flex-1 py-5 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all duration-500 transform active:scale-95 shadow-xl bg-fg text-surface hover:bg-accent-hot hover:text-surface disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed"
                    >
                        {connecting
                            ? <Loader2 className="w-5 h-5 animate-spin" />
                            : <><Link2 className="w-5 h-5" /> {authorized ? t("reauthorizeMoloni") : t("authorizeMoloni")}</>}
                    </button>
                )}
                {(authorized || legacyPassword) && onContinue && (
                    <button
                        type="button"
                        onClick={onContinue}
                        className="px-6 py-5 rounded-2xl border border-hairline hover:border-rule text-[10px] font-black uppercase tracking-[0.18em] transition-colors"
                    >
                        {t("continueToSettings")}
                    </button>
                )}
            </div>
        </div>
    );
}
