"use client";

import { useCallback, useEffect, useState } from "react";
import { useClerk, useUser } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
    AlertTriangle, ArrowRight, Building2, Check, ChevronDown, Copy, Globe, KeyRound,
    Loader2, Lock, LogOut, MapPin, Phone, Settings2, ShieldCheck, Sparkles, User, UserPlus,
} from "lucide-react";
import { Link } from "@/i18n/navigation";
import OnboardingSubscribe from "@/components/onboarding/OnboardingSubscribe";
import { ThemedLogo } from "@/components/ThemedLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LangToggle } from "@/components/landing/LangToggle";
import { LegalLinks } from "@/components/LegalLinks";
import { useOnboardingInvite } from "@/lib/use-onboarding-invite";
import {
    RETURN_SLUG_ONBOARDING_LODGIFY_IX, RETURN_SLUG_ONBOARDING_LODGIFY_MOLONI,
} from "@/lib/oauth-return";
import { moloniCallbackUri } from "@/lib/moloni-oauth";
import { VAT_EXEMPTION_OPTIONS } from "@/lib/vat-exemptions";
import { ixSubdomain } from "@/lib/ix-account";

import { cn } from "@/lib/utils";

/**
 * The client-facing onboarding for Lodgify, to InvoiceXpress or to Moloni.
 *
 * One component for both pairs, unlike the Stripe Connect pages which are a
 * file each: everything except the fourth step is the same sentence twice, and
 * the two Connect pages have already shown what keeping two copies costs. The
 * destination decides the fourth step, the fifth step's fields and where the
 * settings are written, and nothing else.
 *
 * Lodgify itself asks for one thing, an API key. There is no way to check it
 * here: Lodgify allowlists by IP and this page has no fixed egress, so the key
 * is saved and the WORKER registers the webhooks through the relay. Whether
 * that worked is the only signal we get, and a Lodgify account that will not
 * take webhooks is not broken — the half-hourly poll invoices it anyway.
 */

const SOURCE_KIND = "lodgify";
const SUPPORT_EMAIL = "rioko@kapta.pt";

type Destination = "invoicexpress" | "moloni";
type StepId = "account" | "company" | "lodgify" | "destination" | "settings" | "subscribe";
const STEP_IDS: StepId[] = ["account", "company", "lodgify", "destination", "settings", "subscribe"];

const INPUT_CLASS =
    "w-full bg-surface-2/50 border border-hairline rounded-2xl px-5 py-4 text-sm font-medium text-fg outline-none transition-all placeholder:text-fg-40 focus:border-accent focus:ring-2 focus:ring-accent/20";

const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];

function Eyebrow({ children }: { children: React.ReactNode }) {
    return (
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40 flex items-center gap-2 ml-1">
            <span className="w-1 h-1 rounded-full bg-accent" />
            {children}
        </span>
    );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <div className="space-y-2.5">
            <Eyebrow>{label}</Eyebrow>
            {children}
            {hint && <p className="text-[11px] leading-relaxed text-fg-40 ml-1">{hint}</p>}
        </div>
    );
}

function Switch({
    checked, onChange, label, hint,
}: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            onClick={() => onChange(!checked)}
            className="w-full flex items-start gap-4 rounded-2xl border border-hairline bg-surface-2/40 px-5 py-4 text-left transition-colors hover:border-rule"
        >
            <span className={cn("mt-0.5 h-6 w-11 shrink-0 rounded-full p-0.5 transition-colors duration-300", checked ? "bg-accent-hot" : "bg-track-off")}>
                <span className={cn("block h-5 w-5 rounded-full bg-media-plate transition-transform duration-300", checked && "translate-x-5")} />
            </span>
            <span className="min-w-0">
                <span className="block text-sm font-medium text-fg">{label}</span>
                <span className="block text-[11px] leading-relaxed text-fg-60 mt-0.5">{hint}</span>
            </span>
        </button>
    );
}

function Notice({ tone, children }: { tone: "info" | "good" | "bad" | "warn"; children: React.ReactNode }) {
    const palette = {
        info: "border-accent/20 bg-accent/5 text-fg-60",
        good: "border-accent-hot/25 bg-accent-hot/8 text-fg-60",
        warn: "border-soon/30 bg-soon/8 text-fg-60",
        bad: "border-destructive/30 bg-destructive/8 text-destructive",
    }[tone];
    const Icon = tone === "bad" || tone === "warn" ? AlertTriangle : tone === "good" ? Check : ShieldCheck;
    const iconColor = tone === "bad" ? "text-destructive" : tone === "warn" ? "text-soon" : tone === "good" ? "text-accent-hot" : "text-accent-ink";
    return (
        <div
            role={tone === "bad" ? "alert" : undefined}
            className={cn("flex items-start gap-3.5 rounded-2xl border px-5 py-4 text-[12px] leading-relaxed", palette)}
        >
            <Icon className={cn("w-4 h-4 shrink-0 mt-0.5", iconColor)} aria-hidden />
            <div className="min-w-0 space-y-1">{children}</div>
        </div>
    );
}

function PrimaryButton({
    onClick, disabled, busy, children, type = "button",
}: {
    onClick?: () => void; disabled?: boolean; busy?: boolean;
    children: React.ReactNode; type?: "button" | "submit";
}) {
    return (
        <button
            type={type}
            onClick={onClick}
            disabled={disabled || busy}
            className="w-full min-h-[3.25rem] py-4 rounded-2xl bg-fg text-surface font-mono text-xs uppercase tracking-[0.18em] flex items-center justify-center gap-3 transition-all duration-300 transform active:scale-[0.98] hover:bg-accent-hot disabled:opacity-30 disabled:cursor-not-allowed shadow-[0_8px_30px_-12px_color-mix(in_srgb,var(--accent)_45%,transparent)]"
        >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : children}
        </button>
    );
}

export default function LodgifyOnboarding({ destination, invite }: { destination: Destination; invite?: string }) {
    const isIx = destination === "invoicexpress";
    const CONNECTION_KEY = `${SOURCE_KIND}:${destination}`;
    const RETURN_SLUG = isIx ? RETURN_SLUG_ONBOARDING_LODGIFY_IX : RETURN_SLUG_ONBOARDING_LODGIFY_MOLONI;

    const t = useTranslations("lodgifyOnboarding");
    const tReg = useTranslations("registrationForm");
    const tLod = useTranslations(isIx ? "lodgifyIxSetup" : "lodgifyMoloniSetup");
    const tIx = useTranslations("lodgifyIxSetup");
    const tWiz = useTranslations("stripeConnectMoloniSetup");
    const tMol = useTranslations("stripeMoloniSetup");
    const tSub = useTranslations("onboardingSubscribe");
    const locale = useLocale();
    const reduceMotion = useReducedMotion();
    const { isLoaded: clerkLoaded, isSignedIn, user } = useUser();
    const { signOut } = useClerk();
    const params = useSearchParams();

    const [loading, setLoading] = useState(true);
    // Set when an invite link was handed to this merchant and the server would
    // not honour it. Shown in the subscription step; never in the way of paying.
    const [inviteError, setInviteError] = useState("");
    const claimInvite = useOnboardingInvite(invite);
    const [openStep, setOpenStep] = useState<StepId | null>(null);

    // Server-side truth for every step: the Moloni step leaves the site, and a
    // flow resumed from local state would resume in the wrong place.
    const [profileDone, setProfileDone] = useState(false);
    const [lodgifySaved, setLodgifySaved] = useState(false);
    const [webhookUrl, setWebhookUrl] = useState("");
    const [needsManualWebhook, setNeedsManualWebhook] = useState(false);
    const [ixVerified, setIxVerified] = useState(false);
    const [ixSaved, setIxSaved] = useState(false);
    const [moloniAuthorized, setMoloniAuthorized] = useState(false);
    const [settingsSaved, setSettingsSaved] = useState(false);
    const [subActive, setSubActive] = useState(false);

    // Step 2 — the company details, written to the profile the dashboard reads.
    const [form, setForm] = useState({
        nif: "", name: "", company_name: "", fiscal_address: "", phone: "", website: "",
        privacy_policy_accepted: false,
    });
    const [savingProfile, setSavingProfile] = useState(false);
    const [profileError, setProfileError] = useState("");

    // Step 3 — Lodgify.
    const [apiKey, setApiKey] = useState("");
    const [apiKeyStored, setApiKeyStored] = useState("");

    // Step 4 — the destination.
    const [ixAccount, setIxAccount] = useState("");
    const [ixApiKey, setIxApiKey] = useState("");
    /** A key is stored, so leaving the field blank keeps it. */
    const [ixKeyStored, setIxKeyStored] = useState(false);
    const [clientId, setClientId] = useState("");
    const [clientSecret, setClientSecret] = useState("");
    const [environment, setEnvironment] = useState<"production" | "sandbox">("production");
    const [copied, setCopied] = useState(false);

    // Step 5 — invoicing settings, which belong to THIS connection.
    const [sequenceName, setSequenceName] = useState("");
    const [companyName, setCompanyName] = useState("");
    const [documentSetName, setDocumentSetName] = useState("");
    const [documentType, setDocumentType] = useState<"invoice" | "invoice_receipt">("invoice_receipt");
    const [vatIncluded, setVatIncluded] = useState(true);
    const [autoFinalize, setAutoFinalize] = useState(false);
    const [sendEmail, setSendEmail] = useState(false);
    const [partialInvoicing, setPartialInvoicing] = useState(false);
    const [defaultVatRate, setDefaultVatRate] = useState("");
    const [exemptionReason, setExemptionReason] = useState("M01");

    const [busy, setBusy] = useState<"lodgify" | "destination" | "settings" | null>(null);
    const [lodgifyError, setLodgifyError] = useState("");
    const [destError, setDestError] = useState("");
    const [settingsError, setSettingsError] = useState("");

    const load = useCallback(async () => {
        // This call is what creates the users row, and the profile write needs it
        // to exist: a sign-up whose Clerk webhook has not landed yet has no row.
        await fetch("/api/auth/sync", { method: "POST" }).catch(() => {});

        const [profile, lodgify, integ, moloni, sub] = await Promise.all([
            fetch("/api/user/profile").then(r => (r.ok ? r.json() : null)).catch(() => null),
            fetch(`/api/integrations/lodgify-source?destination_kind=${destination}`).then(r => r.json()).catch(() => ({})),
            isIx ? fetch("/api/integrations").then(r => r.json()).catch(() => ({})) : Promise.resolve({}),
            isIx ? Promise.resolve({}) : fetch(`/api/integrations/moloni-destination?source_kind=${SOURCE_KIND}`).then(r => r.json()).catch(() => ({})),
            fetch(`/api/billing/subscription?connection_key=${encodeURIComponent(CONNECTION_KEY)}`).then(r => r.json()).catch(() => ({})),
        ]) as any[];

        if (profile) {
            setProfileDone(profile.registration_completed === 1);
            setForm(f => ({
                ...f,
                nif: profile.nif ?? f.nif,
                name: profile.name ?? f.name,
                company_name: profile.company_name ?? f.company_name,
                fiscal_address: profile.fiscal_address ?? f.fiscal_address,
                phone: profile.phone ?? f.phone,
                website: profile.website ?? f.website,
                privacy_policy_accepted: profile.privacy_policy_accepted === 1 || f.privacy_policy_accepted,
            }));
        }

        const conn = lodgify?.connection;
        setLodgifySaved(!!conn?.source_config?.has_api_key);
        setApiKeyStored(conn?.source_config?.api_key_masked ?? "");
        if (conn?.webhook_url) setWebhookUrl(String(conn.webhook_url));
        // A key that was saved without signing secrets is one Lodgify would not
        // take webhooks for, which is the state the manual note is written for.
        if (conn?.source_config?.has_api_key && !conn?.source_config?.has_webhook_secret) setNeedsManualWebhook(true);

        const fiscal = conn?.fiscal ?? {};
        if (typeof fiscal.ix_sequence_name === "string") setSequenceName(fiscal.ix_sequence_name);
        if (fiscal.ix_document_type === "invoice" || fiscal.ix_document_type === "invoice_receipt") setDocumentType(fiscal.ix_document_type);
        if (typeof fiscal.ix_exemption_reason === "string" && fiscal.ix_exemption_reason) setExemptionReason(fiscal.ix_exemption_reason);

        if (isIx) {
            // InvoiceXpress credentials live on the account's legacy row: one IX
            // account per Rioko account, shared by every connection filing into it.
            if (integ?.ix_account_name) setIxAccount(String(integ.ix_account_name));
            // The key itself stays on the server; `has_ix_api_key` is the
            // presence answer, which is all this step ever read it for.
            setIxKeyStored(!!integ?.has_ix_api_key);
    // The connection's own credentials first; the account's legacy row is
            // the fallback for a setup made before a connection could hold them.
            const connIxName = lodgify?.connection?.ix_account_name;
            if (connIxName) setIxAccount(String(connIxName));
            if (lodgify?.connection?.has_ix_credentials) setIxKeyStored(true);
            setIxSaved(!!lodgify?.connection?.has_ix_credentials
                || (!!integ?.ix_account_name && !!integ?.has_ix_api_key));
            setIxVerified(integ?.ix_authorized === 1);
            if (typeof fiscal.vat_included === "boolean") setVatIncluded(fiscal.vat_included);
            if (typeof fiscal.auto_finalize === "boolean") setAutoFinalize(fiscal.auto_finalize);
            // The settings step has run when it has written the one field it
            // always writes. The connection's own status says nothing here: the
            // Lodgify step already left it active.
            setSettingsSaved(typeof fiscal.ix_document_type === "string");
        } else {
            const cfg = moloni?.connection?.destination_config ?? {};
            setMoloniAuthorized(!!cfg.moloni_authorized);
            if (cfg.moloni_oauth_error) setDestError(String(cfg.moloni_oauth_error));
            if (cfg.moloni_client_id) setClientId(String(cfg.moloni_client_id));
            if (cfg.moloni_company_name) setCompanyName(String(cfg.moloni_company_name));
            if (cfg.moloni_document_set_name) setDocumentSetName(String(cfg.moloni_document_set_name));
            if (cfg.moloni_environment === "sandbox" || cfg.moloni_environment === "production") setEnvironment(cfg.moloni_environment);
            if (cfg.moloni_document_type === "invoice" || cfg.moloni_document_type === "invoice_receipt") setDocumentType(cfg.moloni_document_type);
            if (typeof cfg.vat_included === "boolean") setVatIncluded(cfg.vat_included);
            if (typeof cfg.auto_finalize === "boolean") setAutoFinalize(cfg.auto_finalize);
            if (typeof cfg.send_email === "boolean") setSendEmail(cfg.send_email);
            if (typeof cfg.moloni_partial_invoicing === "boolean") setPartialInvoicing(cfg.moloni_partial_invoicing);
            if (cfg.default_vat_rate != null) setDefaultVatRate(String(cfg.default_vat_rate));
            if (typeof cfg.exemption_reason === "string" && cfg.exemption_reason) setExemptionReason(cfg.exemption_reason);
            // Moloni has an activation of its own, and it is what "settings done"
            // means on this side.
            setSettingsSaved(moloni?.connection?.status === "active");
        }

        setSubActive(sub?.ui_state === "active" || sub?.ui_state === "exempt");
    }, [destination, isIx, CONNECTION_KEY]);

    useEffect(() => {
        if (!clerkLoaded) return;
        if (!isSignedIn) { setLoading(false); return; }
        setForm(f => ({ ...f, name: f.name || user?.fullName || "" }));
        // The invite, if this page was reached through one, before the first
        // read: claiming it is what makes the subscription step read "covered".
        claimInvite()
            .then(r => { if (r.state === "refused") setInviteError(r.reason); })
            .finally(() => load().finally(() => setLoading(false)));
    }, [clerkLoaded, isSignedIn, user, load]);

    // Whatever the Moloni callback came back with, shown inside its own step.
    useEffect(() => {
        const detail = params.get("detail");
        const moloniResult = params.get("moloni");
        if (moloniResult === "denied") setDestError(tWiz("moloniDenied"));
        else if (moloniResult === "error") setDestError(detail || tWiz("moloniFailed"));
    }, [params, tWiz]);

    const done: Record<StepId, boolean> = {
        account: !!isSignedIn,
        company: profileDone,
        lodgify: lodgifySaved,
        destination: isIx ? ixSaved : moloniAuthorized,
        settings: settingsSaved,
        subscribe: subActive,
    };
    const doneCount = STEP_IDS.filter(id => done[id]).length;
    const firstOpenIndex = STEP_IDS.findIndex(id => !done[id]);
    const currentIndex = firstOpenIndex === -1 ? STEP_IDS.length - 1 : firstOpenIndex;
    const activeStep = openStep ?? STEP_IDS[currentIndex];
    const allDone = doneCount === STEP_IDS.length;

    /** A company NIF starts with 5, 6, 8 or 9; only then is a legal name asked for. */
    const isCompany = ["5", "6", "8", "9"].includes(form.nif.trim()[0] ?? "");

    // The same for every merchant and every connection: a Moloni developer app
    // holds one callback URL. Taken from the shared helper rather than from
    // window.location, because what has to match is the URL the server sends.
    const redirectUri = moloniCallbackUri();

    const copyRedirectUri = async () => {
        try {
            await navigator.clipboard.writeText(redirectUri);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch { /* clipboard refused; the string is on screen to copy by hand */ }
    };

    const saveProfile = async (e: React.FormEvent) => {
        e.preventDefault();
        setSavingProfile(true);
        setProfileError("");
        const body = JSON.stringify({
            ...form,
            email: user?.primaryEmailAddress?.emailAddress ?? "",
            onboarding_source_kind: SOURCE_KIND,
            onboarding_destination_kind: destination,
        });
        const post = () => fetch("/api/user/profile", {
            method: "POST", headers: { "Content-Type": "application/json" }, body,
        });
        try {
            let res = await post();
            // 409 is "no users row yet": the sync on load lost the race with a
            // sign-up that had only just finished. Sync again and retry once.
            if (res.status === 409) {
                await fetch("/api/auth/sync", { method: "POST" }).catch(() => {});
                res = await post();
            }
            if (!res.ok) {
                setProfileError(tReg("saveError"));
                return;
            }
            setProfileDone(true);
            setOpenStep("lodgify");
        } catch {
            setProfileError(tReg("saveError"));
        } finally {
            setSavingProfile(false);
        }
    };

    /**
     * Save the Lodgify key and let the worker register the webhooks.
     *
     * There is no verification to do here and none is pretended: Lodgify only
     * talks to the relay's IP, so this route answers ok for a key that is wrong
     * as readily as for one that is right. What comes back is whether Lodgify
     * accepted a webhook registration, and even that failing is survivable.
     */
    const saveLodgify = async () => {
        if (!apiKey.trim() && !lodgifySaved) {
            setLodgifyError(tLod("errorMissingApiKey"));
            return;
        }
        setBusy("lodgify");
        setLodgifyError("");
        try {
            const body: Record<string, unknown> = { destination_kind: destination, status: "active" };
            if (apiKey.trim()) body.api_key = apiKey.trim();
            const res = await fetch("/api/integrations/lodgify-source", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
            });
            const json: any = await res.json().catch(() => ({}));
            if (!res.ok) {
                setLodgifyError(json.error ?? `HTTP ${res.status}`);
                return;
            }
            setLodgifySaved(true);
            setApiKey("");
            if (json.webhook_url) setWebhookUrl(String(json.webhook_url));
            setNeedsManualWebhook(!!json.needs_manual_webhook);
            setOpenStep("destination");
        } catch (e: any) {
            setLodgifyError(e?.message ?? "Unknown error");
        } finally {
            setBusy(null);
        }
    };

    /**
     * Save the InvoiceXpress credentials, then make InvoiceXpress answer with
     * them. The verification is the point of the step: a key with a stray space,
     * or one from the sandbox account, saves without complaint and only surfaces
     * days later as documents that were never issued.
     */
    const saveIx = async () => {
        const account = ixSubdomain(ixAccount);
        // Blank with one already stored means "keep it": the POST reads a blank
        // key as unchanged, so a resumed onboarding need not re-type it.
        if (!account || (!ixApiKey.trim() && !ixKeyStored)) {
            setDestError(tIx("errorIxRequired"));
            return;
        }
        setBusy("destination");
        setDestError("");
        setIxVerified(false);
        try {
            // The credentials go on the connection, beside its fiscal identity.
            // On the account's legacy row they gave a merchant with no Shopify an
            // `integrations` row that the admin console drew as a broken
            // "Shopify → InvoiceXpress" pipe; deleting that phantom destroyed the
            // credential the real connection uses.
            const credsRes = await fetch("/api/integrations/lodgify-source", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    source_kind: "lodgify",
                    destination_kind: "invoicexpress",
                    ix_credentials: {
                        ix_account_name: account,
                        // Absent means "leave it alone": the merchant who comes
                        // back to this step with a key already stored types
                        // nothing, and must not lose it.
                        ...(ixApiKey.trim() ? { ix_api_key: ixApiKey.trim() } : {}),
                        ix_environment: "production",
                    },
                }),
            });
            if (!credsRes.ok) {
                const d: any = await credsRes.json().catch(() => ({}));
                setDestError(d.error ?? tIx("errorSaveIx"));
                return;
            }
            setIxAccount(account);
            setIxSaved(true);

            const check = await fetch("/api/integrations/validate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "ix", source_kind: "lodgify" }),
            });
            // `isValid`, not `valid`: the endpoint answers 200 with the verdict in
            // the body, and reading `res.ok` alone calls a rejected key good.
            const verdict: any = await check.json().catch(() => ({}));
            if (!check.ok || !verdict?.isValid) {
                setDestError(verdict?.error || verdict?.message || t("destination.ixVerifyFailed"));
                return;
            }
            setIxVerified(true);
            setOpenStep("settings");
        } catch (e: any) {
            setDestError(e?.message ?? "Unknown error");
        } finally {
            setBusy(null);
        }
    };

    /** Hand the merchant to Moloni's consent page for THIS connection. */
    const authorizeMoloni = async () => {
        setBusy("destination");
        setDestError("");
        try {
            const res = await fetch("/api/integrations/moloni-oauth/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    source_kind: SOURCE_KIND,
                    client_id: clientId.trim(),
                    client_secret: clientSecret.trim() || undefined,
                    environment,
                    // So the callback brings them back here, and not to the
                    // Stripe wizard, which is where it lands without a slug.
                    return_slug: RETURN_SLUG,
                    return_locale: locale,
                }),
            });
            const json: any = await res.json();
            if (!res.ok || !json.authorize_url) {
                setDestError(json.error ?? `HTTP ${res.status}`);
                return;
            }
            // Full-page navigation on purpose: the consent screen is where the
            // merchant signs in, and it has to be unmistakably Moloni's.
            window.location.href = json.authorize_url;
        } catch (e: any) {
            setDestError(e?.message ?? "Unknown error");
        } finally {
            setBusy(null);
        }
    };

    const saveSettings = async () => {
        setBusy("settings");
        setSettingsError("");
        try {
            if (isIx) {
                // A settings-only post: no api_key and no status, which is what
                // keeps it out of the branch that re-registers the webhooks.
                const res = await fetch("/api/integrations/lodgify-source", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        destination_kind: destination,
                        fiscal: {
                            ix_sequence_name: sequenceName.trim(),
                            ix_document_type: documentType,
                            ix_exemption_reason: exemptionReason,
                            vat_included: vatIncluded,
                            auto_finalize: autoFinalize,
                        },
                    }),
                });
                if (!res.ok) {
                    const json: any = await res.json().catch(() => ({}));
                    setSettingsError(json.error ?? t("settings.saveFailed"));
                    return;
                }
            } else {
                if (!companyName.trim()) {
                    setSettingsError(tMol("errorSettingsRequired"));
                    return;
                }
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
                        status: "active",
                    }),
                });
                if (!res.ok) {
                    const json: any = await res.json().catch(() => ({}));
                    setSettingsError(json.error ?? tMol("errorActivate"));
                    return;
                }
            }
            setSettingsSaved(true);
            setOpenStep("subscribe");
        } catch (e: any) {
            setSettingsError(e?.message ?? "Unknown error");
        } finally {
            setBusy(null);
        }
    };

    const authHref = (page: "sign-up" | "sign-in") => `/${locale}/${page}?onboarding=${RETURN_SLUG}`;

    const bodies: Record<StepId, React.ReactNode> = {
        account: isSignedIn ? (
            <div className="space-y-5">
                <Notice tone="good">
                    <p className="font-medium text-fg">{t("account.signedInAs", { email: user?.primaryEmailAddress?.emailAddress ?? "" })}</p>
                    <p>{t("account.signedInBody")}</p>
                </Notice>
                <PrimaryButton onClick={() => setOpenStep("company")}>
                    {t("continue")} <ArrowRight className="w-4 h-4" aria-hidden />
                </PrimaryButton>
            </div>
        ) : (
            <div className="space-y-5">
                <Notice tone="info"><p>{t("account.body")}</p></Notice>
                <a
                    href={authHref("sign-up")}
                    className="w-full min-h-[3.25rem] py-4 rounded-2xl bg-fg text-surface font-mono text-xs uppercase tracking-[0.18em] flex items-center justify-center gap-3 transition-all duration-300 transform active:scale-[0.98] hover:bg-accent-hot shadow-[0_8px_30px_-12px_color-mix(in_srgb,var(--accent)_45%,transparent)]"
                >
                    <UserPlus className="w-4 h-4" aria-hidden /> {t("account.create")}
                </a>
                <p className="text-center text-[12px] text-fg-60">
                    {t("account.haveAccount")}{" "}
                    <a href={authHref("sign-in")} className="text-accent-ink font-medium hover:text-accent-hover transition-colors">
                        {t("account.signIn")}
                    </a>
                </p>
            </div>
        ),

        company: (
            <form onSubmit={saveProfile} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="md:col-span-2">
                    <Notice tone="info"><p>{t("company.body")}</p></Notice>
                </div>

                <div className="md:col-span-2">
                    <Field label={tReg("nifLabel")}>
                        <div className="relative">
                            <ShieldCheck className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40" aria-hidden />
                            <input
                                required inputMode="numeric" maxLength={9} placeholder={tReg("nifPlaceholder")}
                                className={cn(INPUT_CLASS, "pl-14 font-mono")}
                                value={form.nif}
                                onChange={e => setForm({ ...form, nif: e.target.value.replace(/\D/g, "") })}
                            />
                        </div>
                    </Field>
                </div>

                <div className="md:col-span-2">
                    <Field label={isCompany ? tReg("companyNameLabel") : tReg("personNameLabel")}>
                        <div className="relative">
                            {isCompany
                                ? <Building2 className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40" aria-hidden />
                                : <User className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40" aria-hidden />}
                            <input
                                required
                                autoComplete={isCompany ? "organization" : "name"}
                                placeholder={isCompany ? tReg("companyNamePlaceholder") : tReg("personNamePlaceholder")}
                                className={cn(INPUT_CLASS, "pl-14")}
                                value={isCompany ? form.company_name : form.name}
                                onChange={e => setForm(isCompany
                                    ? { ...form, company_name: e.target.value }
                                    : { ...form, name: e.target.value })}
                            />
                        </div>
                    </Field>
                </div>

                <div className="md:col-span-2">
                    <Field label={tReg("addressLabel")}>
                        <div className="relative">
                            <MapPin className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40" aria-hidden />
                            <input
                                required autoComplete="street-address" placeholder={tReg("addressPlaceholder")}
                                className={cn(INPUT_CLASS, "pl-14")}
                                value={form.fiscal_address}
                                onChange={e => setForm({ ...form, fiscal_address: e.target.value })}
                            />
                        </div>
                    </Field>
                </div>

                <Field label={tReg("phoneLabel")}>
                    <div className="relative">
                        <Phone className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40" aria-hidden />
                        <input
                            type="tel" autoComplete="tel" className={cn(INPUT_CLASS, "pl-14")}
                            value={form.phone}
                            onChange={e => setForm({ ...form, phone: e.target.value })}
                        />
                    </div>
                </Field>

                <Field label={tReg("websiteLabel")}>
                    <div className="relative">
                        <Globe className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-40" aria-hidden />
                        <input
                            type="url" autoComplete="url" placeholder={tReg("websitePlaceholder")}
                            className={cn(INPUT_CLASS, "pl-14")}
                            value={form.website}
                            onChange={e => setForm({ ...form, website: e.target.value })}
                        />
                    </div>
                </Field>

                <label className="md:col-span-2 flex items-start gap-3 cursor-pointer group py-1">
                    <input
                        required type="checkbox" className="peer sr-only"
                        checked={form.privacy_policy_accepted}
                        onChange={e => setForm({ ...form, privacy_policy_accepted: e.target.checked })}
                    />
                    <span className="mt-0.5 w-6 h-6 shrink-0 rounded-lg border-2 border-hairline bg-surface-2 flex items-center justify-center transition-all group-hover:border-accent/50 peer-checked:bg-accent peer-checked:border-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent/45 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background">
                        <Check className="w-3.5 h-3.5 text-on-accent opacity-0 peer-checked:opacity-100 transition-opacity" aria-hidden />
                    </span>
                    <span className="text-[13px] font-medium text-fg-60 group-hover:text-fg transition-colors">
                        {tReg("privacyAccept")}{" "}
                        <Link href="/privacy" className="text-accent-ink hover:text-accent-hover transition-colors">
                            {t("company.privacyLink")}
                        </Link>
                    </span>
                </label>

                {profileError && (
                    <div className="md:col-span-2"><Notice tone="bad"><p>{profileError}</p></Notice></div>
                )}

                <div className="md:col-span-2">
                    <PrimaryButton type="submit" busy={savingProfile}>
                        {profileDone ? t("company.update") : t("continue")} <ArrowRight className="w-4 h-4" aria-hidden />
                    </PrimaryButton>
                </div>
            </form>
        ),

        lodgify: (
            <div className="space-y-6">
                <Notice tone="info">
                    <p className="font-medium text-fg">{tLod("noteTitle")}</p>
                    <p>{tLod("noteBody")}</p>
                </Notice>

                <Field
                    label={tLod("apiKeyLabel")}
                    hint={lodgifySaved ? tLod("apiKeyStoredHint") : tLod("apiKeyHint")}
                >
                    <input
                        type="password" autoComplete="off" spellCheck={false}
                        placeholder={lodgifySaved ? apiKeyStored || "••••••••••••" : tLod("apiKeyPlaceholder")}
                        className={cn(INPUT_CLASS, "font-mono")}
                        value={apiKey}
                        onChange={e => setApiKey(e.target.value)}
                    />
                </Field>

                {lodgifyError && <Notice tone="bad"><p>{lodgifyError}</p></Notice>}

                {lodgifySaved && (
                    <>
                        <Notice tone="good">
                            <p className="font-medium text-fg">{t("lodgify.savedTitle")}</p>
                            <p>{t("lodgify.savedBody")}</p>
                        </Notice>
                        {webhookUrl && (
                            <div className="rounded-2xl border border-hairline bg-surface-2/40 p-5 space-y-3">
                                <p className="text-sm font-medium text-fg">{tLod("webhookSection")}</p>
                                <p className="text-[11px] leading-relaxed text-fg-40">{tLod("webhookBody")}</p>
                                <code className="block rounded-xl border border-hairline bg-surface-2/60 px-4 py-3 font-mono text-[11px] break-all">
                                    {webhookUrl}
                                </code>
                                {needsManualWebhook && (
                                    <Notice tone="warn"><p>{tLod("webhookManualNote")}</p></Notice>
                                )}
                            </div>
                        )}
                    </>
                )}

                <div className="space-y-3">
                    <PrimaryButton onClick={saveLodgify} busy={busy === "lodgify"}>
                        {lodgifySaved ? tLod("reconnectLodgify") : tLod("connectLodgify")}
                        <ArrowRight className="w-4 h-4" aria-hidden />
                    </PrimaryButton>
                    {lodgifySaved && (
                        <button
                            type="button"
                            onClick={() => setOpenStep("destination")}
                            className="w-full min-h-[3rem] py-4 rounded-2xl border border-hairline font-mono text-[10px] uppercase tracking-[0.18em] transition-colors hover:border-rule"
                        >
                            {t("continue")}
                        </button>
                    )}
                </div>
            </div>
        ),

        destination: isIx ? (
            <div className="space-y-6">
                <Notice tone="info">
                    <p className="font-medium text-fg">{t("destination.ixIntroTitle")}</p>
                    <p>{t("destination.ixIntroBody")}</p>
                </Notice>

                <div className="grid md:grid-cols-2 gap-6">
                    <Field label={tIx("ixAccountLabel")} hint={t("destination.ixAccountHint")}>
                        <input
                            className={cn(INPUT_CLASS, "font-mono")} placeholder={tIx("ixAccountPlaceholder")}
                            value={ixAccount} onChange={e => setIxAccount(e.target.value)}
                        />
                    </Field>
                    <Field label={tIx("ixApiKeyLabel")} hint={t("destination.ixApiKeyHint")}>
                        <input
                            type="password" autoComplete="off" spellCheck={false}
                            className={cn(INPUT_CLASS, "font-mono")} placeholder={ixKeyStored ? "••••••••••••" : tIx("ixApiKeyPlaceholder")}
                            value={ixApiKey} onChange={e => setIxApiKey(e.target.value)}
                        />
                    </Field>
                </div>

                {destError && <Notice tone="bad"><p>{destError}</p></Notice>}
                {ixVerified && (
                    <Notice tone="good">
                        <p className="font-medium text-fg">{t("destination.ixVerified")}</p>
                        <p>{t("destination.ixVerifiedBody")}</p>
                    </Notice>
                )}

                <div className="space-y-3">
                    <PrimaryButton onClick={saveIx} busy={busy === "destination"} disabled={!ixAccount.trim() || (!ixApiKey.trim() && !ixKeyStored)}>
                        {tIx("verifyConnection")} <ArrowRight className="w-4 h-4" aria-hidden />
                    </PrimaryButton>
                    {ixSaved && (
                        <button
                            type="button"
                            onClick={() => setOpenStep("settings")}
                            className="w-full min-h-[3rem] py-4 rounded-2xl border border-hairline font-mono text-[10px] uppercase tracking-[0.18em] transition-colors hover:border-rule"
                        >
                            {t("continue")}
                        </button>
                    )}
                </div>
            </div>
        ) : (
            <div className="space-y-6">
                <Notice tone="info">
                    <p className="font-medium text-fg">{tWiz("moloniIntroTitle")}</p>
                    <ol className="list-decimal pl-4 space-y-1.5 mt-1.5">
                        <li>{t("destination.moloniStep1")}</li>
                        <li>{tWiz("moloniStep2")}</li>
                        <li>{tWiz("moloniStep3")}</li>
                    </ol>
                </Notice>

                <div className="rounded-2xl border border-hairline bg-surface-2/40 p-5 space-y-3">
                    <p className="text-sm font-medium text-fg">{tWiz("redirectUriTitle")}</p>
                    <p className="text-[11px] leading-relaxed text-fg-40">{tWiz("redirectUriBody")}</p>
                    <div className="flex flex-col sm:flex-row items-stretch gap-3">
                        <code className="flex-1 min-w-0 rounded-xl border border-hairline bg-surface-2/60 px-4 py-3 font-mono text-[11px] break-all">
                            {redirectUri}
                        </code>
                        <button
                            type="button" onClick={copyRedirectUri} disabled={!redirectUri}
                            className="shrink-0 rounded-xl border border-hairline px-4 py-3 font-mono text-[10px] uppercase tracking-[0.18em] flex items-center justify-center gap-2 transition-colors hover:border-rule disabled:opacity-30"
                        >
                            {copied ? <Check className="w-3.5 h-3.5" aria-hidden /> : <Copy className="w-3.5 h-3.5" aria-hidden />}
                            {copied ? tWiz("copied") : tWiz("copy")}
                        </button>
                    </div>
                </div>

                <div className="grid md:grid-cols-2 gap-6">
                    <Field label={tWiz("developerIdLabel")} hint={tMol("clientIdHint")}>
                        <input
                            className={cn(INPUT_CLASS, "font-mono")} placeholder={tMol("clientIdPlaceholder")}
                            value={clientId} onChange={e => setClientId(e.target.value)}
                        />
                    </Field>
                    <Field
                        label={tWiz("clientSecretLabel")}
                        hint={moloniAuthorized ? tMol("secretStoredHint") : tMol("clientSecretHint")}
                    >
                        <input
                            type="password" autoComplete="off" className={cn(INPUT_CLASS, "font-mono")}
                            placeholder={moloniAuthorized ? "••••••••" : ""}
                            value={clientSecret} onChange={e => setClientSecret(e.target.value)}
                        />
                    </Field>
                </div>

                <div className="space-y-2.5">
                    <Eyebrow>{tWiz("environmentLabel")}</Eyebrow>
                    <div className="flex gap-2">
                        {(["production", "sandbox"] as const).map(env => (
                            <button
                                key={env} type="button" onClick={() => setEnvironment(env)}
                                aria-pressed={environment === env}
                                className={cn(
                                    "flex-1 min-h-[3rem] rounded-xl py-3.5 font-mono text-[10px] uppercase tracking-[0.18em] transition-all duration-300",
                                    environment === env
                                        ? "bg-accent-hot text-surface"
                                        : "bg-surface-2/50 text-fg-40 ring-1 ring-inset ring-hairline hover:text-fg",
                                )}
                            >
                                {env === "production" ? tWiz("envProduction") : tWiz("envSandbox")}
                            </button>
                        ))}
                    </div>
                    <p className="text-[11px] text-fg-40 ml-1">{tMol("environmentHint")}</p>
                </div>

                {destError && <Notice tone="bad"><p>{destError}</p></Notice>}
                {moloniAuthorized && (
                    <Notice tone="good">
                        <p className="font-medium text-fg">{tWiz("moloniAuthorized")}</p>
                        <p>{t("destination.moloniAuthorizedBody")}</p>
                    </Notice>
                )}

                <div className="space-y-3">
                    <PrimaryButton onClick={authorizeMoloni} busy={busy === "destination"} disabled={!clientId.trim()}>
                        {moloniAuthorized ? tWiz("reauthorizeMoloni") : tWiz("authorizeMoloni")}
                        <ArrowRight className="w-4 h-4" aria-hidden />
                    </PrimaryButton>
                    {moloniAuthorized && (
                        <button
                            type="button"
                            onClick={() => setOpenStep("settings")}
                            className="w-full min-h-[3rem] py-4 rounded-2xl border border-hairline font-mono text-[10px] uppercase tracking-[0.18em] transition-colors hover:border-rule"
                        >
                            {tWiz("continueToSettings")}
                        </button>
                    )}
                </div>
            </div>
        ),

        settings: (
            <div className="space-y-6">
                <Notice tone="info"><p>{t("settings.body")}</p></Notice>

                {isIx ? (
                    <Field label={tIx("sequenceLabel")} hint={tIx("sequenceHint")}>
                        <input
                            className={INPUT_CLASS} placeholder={tIx("sequencePlaceholder")}
                            value={sequenceName} onChange={e => setSequenceName(e.target.value)}
                        />
                    </Field>
                ) : (
                    <div className="grid md:grid-cols-2 gap-6">
                        <Field label={tMol("companyIdLabel")} hint={tMol("companyNameHint")}>
                            <input className={INPUT_CLASS} value={companyName} onChange={e => setCompanyName(e.target.value)} />
                        </Field>
                        <Field label={tMol("documentSetIdLabel")} hint={tMol("documentSetNameHint")}>
                            <input className={INPUT_CLASS} value={documentSetName} onChange={e => setDocumentSetName(e.target.value)} />
                        </Field>
                    </div>
                )}

                <div className="space-y-2.5">
                    <Eyebrow>{tIx("docType")}</Eyebrow>
                    <div className="flex gap-2">
                        {(["invoice_receipt", "invoice"] as const).map(dt => (
                            <button
                                key={dt} type="button" onClick={() => setDocumentType(dt)}
                                aria-pressed={documentType === dt}
                                className={cn(
                                    "flex-1 min-h-[3rem] rounded-xl py-3.5 font-mono text-[10px] uppercase tracking-[0.18em] transition-all duration-300",
                                    documentType === dt
                                        ? "bg-accent-hot text-surface"
                                        : "bg-surface-2/50 text-fg-40 ring-1 ring-inset ring-hairline hover:text-fg",
                                )}
                            >
                                {dt === "invoice" ? tIx("docTypeInvoiceShort") : tIx("docTypeReceiptShort")}
                            </button>
                        ))}
                    </div>
                    <p className="text-[11px] text-fg-40 ml-1">
                        {documentType === "invoice" ? tIx("docTypeInvoice") : tIx("docTypeReceipt")}
                    </p>
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                    <Switch
                        checked={vatIncluded} onChange={setVatIncluded}
                        label={tIx("vatIncluded")}
                        hint={vatIncluded ? tIx("vatIncludedOn") : tIx("vatIncludedOff")}
                    />
                    <Switch
                        checked={autoFinalize} onChange={setAutoFinalize}
                        label={tIx("autoFinalize")} hint={tIx("autoFinalizeDesc")}
                    />
                    {!isIx && (
                        <>
                            <Switch
                                checked={sendEmail} onChange={setSendEmail}
                                label={tMol("sendEmail")}
                                hint={!autoFinalize ? tMol("sendEmailNeedsFinalize") : sendEmail ? tMol("sendEmailOn") : tMol("sendEmailOff")}
                            />
                            <Switch
                                checked={partialInvoicing} onChange={setPartialInvoicing}
                                label={t("settings.partialLabel")} hint={t("settings.partialHint")}
                            />
                        </>
                    )}
                </div>

                {!isIx && (
                    <Field label={tMol("defaultVatRateLabel")} hint={tMol("defaultVatRateHint")}>
                        <input
                            inputMode="decimal" placeholder="6" className={cn(INPUT_CLASS, "font-mono")}
                            value={defaultVatRate} onChange={e => setDefaultVatRate(e.target.value)}
                        />
                    </Field>
                )}

                <Field label={tIx("exemptionTitle")} hint={tIx("exemptionDesc")}>
                    <select className={INPUT_CLASS} value={exemptionReason} onChange={e => setExemptionReason(e.target.value)}>
                        {VAT_EXEMPTION_OPTIONS.map(o => (
                            <option key={o.value} value={o.value}>{o.value} · {o.label}</option>
                        ))}
                    </select>
                </Field>

                <Notice tone="info"><p>{t("settings.vatNote")}</p></Notice>

                {settingsError && <Notice tone="bad"><p>{settingsError}</p></Notice>}

                <PrimaryButton onClick={saveSettings} busy={busy === "settings"}>
                    {t("settings.finish")} <ArrowRight className="w-4 h-4" aria-hidden />
                </PrimaryButton>
            </div>
        ),

        subscribe: subActive ? (
            // Nothing to pay: an account that is already subscribed must not be
            // handed a payment form that would open a second subscription.
            <Notice tone="good">
                <p className="font-medium text-fg">{tSub("doneTitle")}</p>
                <p>{tSub("doneBody")}</p>
            </Notice>
        ) : (
            <div className="space-y-5">
                <Notice tone="info"><p>{t("subscribe.body")}</p></Notice>
                {/* An invite that the server would not honour. Said plainly, and
                    the ordinary way to pay stays right below it. */}
                {inviteError && <Notice tone="bad"><p>{t("subscribe.inviteRefused")}</p></Notice>}
                <OnboardingSubscribe
                    source={isIx ? "lodgify-ix" : "lodgify-moloni"}
                    connectionKey={CONNECTION_KEY}
                    returnSlug={RETURN_SLUG}
                    onSubscribed={() => setSubActive(true)}
                />
                <p className="text-[11px] leading-relaxed text-fg-40">{t("subscribe.note")}</p>
            </div>
        ),
    };

    const stepIcon: Record<StepId, typeof UserPlus> = {
        account: UserPlus, company: Building2, lodgify: KeyRound,
        destination: ShieldCheck, settings: Settings2, subscribe: Sparkles,
    };

    if (!clerkLoaded || loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <Loader2 className="w-10 h-10 animate-spin text-accent-ink opacity-50" aria-label={t("loading")} />
            </div>
        );
    }

    return (
        <div className="min-h-screen">
            <header className="sticky top-0 z-30 border-b border-hairline bg-background/85 backdrop-blur-xl">
                <div className="mx-auto max-w-3xl px-5 sm:px-8 h-16 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <ThemedLogo
                            nightSrc="/images/logo-rioko-white.webp"
                            daySrc="/images/logo-rioko-black.webp"
                            alt="Rioko" width={120} height={32} priority className="h-4 sm:h-5 w-auto"
                        />
                        <span className="hidden sm:block h-4 w-px bg-hairline-strong" />
                        <span className="hidden sm:block font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40 truncate">
                            {isIx ? "Lodgify · InvoiceXpress" : "Lodgify · Moloni"}
                        </span>
                    </div>
                    <div className="flex items-center gap-1.5 sm:gap-2">
                        {/* The way out of the wrong account, from anywhere on the
                            page: a merchant who signed up with a personal email
                            notices steps later, when step one is long closed. */}
                        {isSignedIn && (
                            <button
                                type="button"
                                onClick={() => signOut({ redirectUrl: window.location.pathname })}
                                title={t("account.signOut")}
                                aria-label={t("account.signOut")}
                                className="h-9 px-2.5 sm:px-3 rounded-full border border-hairline text-fg-40 hover:text-fg hover:border-rule transition-colors flex items-center gap-2 max-w-[11rem]"
                            >
                                <LogOut className="w-3.5 h-3.5 shrink-0" aria-hidden />
                                <span className="hidden md:block font-mono text-[10px] uppercase tracking-[0.18em] truncate">
                                    {user?.primaryEmailAddress?.emailAddress ?? t("account.signOut")}
                                </span>
                            </button>
                        )}
                        <ThemeToggle />
                        <LangToggle />
                    </div>
                </div>
                <div className="h-[2px] bg-hairline">
                    <motion.div
                        className="h-full bg-accent"
                        initial={false}
                        animate={{ width: `${(doneCount / STEP_IDS.length) * 100}%` }}
                        transition={reduceMotion ? { duration: 0 } : { duration: 0.6, ease: EASE }}
                    />
                </div>
            </header>

            <main className="mx-auto max-w-3xl px-5 sm:px-8 pb-24">
                <section className="pt-14 sm:pt-20 pb-10 space-y-5">
                    <span className="inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.22em] text-accent-ink">
                        <Sparkles className="w-3 h-3" aria-hidden /> {t("eyebrow")}
                    </span>
                    <h1 className="text-[2rem] sm:text-5xl font-medium tracking-tight leading-[1.05]">
                        {isIx ? t("titleIx") : t("titleMoloni")}
                    </h1>
                    <p className="text-base sm:text-lg text-fg-60 leading-relaxed max-w-2xl">{t("subtitle")}</p>
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                        {["trust1", "trust2", "trust3"].map(k => (
                            <span key={k} className="inline-flex items-center gap-2 rounded-full border border-hairline bg-veil px-3 py-1.5 text-[11px] font-medium text-fg-60">
                                <Check className="w-3 h-3 text-accent-hot" aria-hidden /> {t(k)}
                            </span>
                        ))}
                    </div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40 pt-2" aria-live="polite">
                        {allDone ? t("allDone") : t("progress", { current: currentIndex + 1, total: STEP_IDS.length })}
                    </p>
                </section>

                <div className="space-y-4">
                    {STEP_IDS.map((id, index) => {
                        const Icon = stepIcon[id];
                        const isDone = done[id];
                        const isLocked = index > currentIndex;
                        const isOpen = activeStep === id && !isLocked;
                        const titleKey = id === "destination" ? (isIx ? "destination.titleIx" : "destination.titleMoloni") : `${id}.title`;
                        const descKey = id === "destination" ? (isIx ? "destination.descIx" : "destination.descMoloni") : `${id}.desc`;
                        return (
                            <motion.section
                                key={id}
                                layout={!reduceMotion}
                                transition={{ duration: reduceMotion ? 0 : 0.4, ease: EASE }}
                                className={cn(
                                    "glass rounded-[2rem] overflow-hidden transition-opacity duration-500",
                                    isDone && "border-accent-hot/25",
                                    isLocked && "opacity-55",
                                )}
                            >
                                <button
                                    type="button"
                                    disabled={isLocked}
                                    aria-expanded={isOpen}
                                    aria-controls={`step-${id}`}
                                    onClick={() => setOpenStep(isOpen ? null : id)}
                                    className="w-full flex items-center gap-4 px-5 sm:px-8 py-6 text-left disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset"
                                >
                                    <span className={cn(
                                        "w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 ring-1 transition-colors",
                                        isDone
                                            ? "bg-accent-hot/12 text-accent-hot ring-accent-hot/30"
                                            : isLocked
                                                ? "bg-surface-2/60 text-fg-40 ring-hairline"
                                                : "bg-accent/10 text-accent-ink ring-accent/25",
                                    )}>
                                        {isDone ? <Check className="w-5 h-5" aria-hidden /> : isLocked ? <Lock className="w-4 h-4" aria-hidden /> : <Icon className="w-5 h-5" aria-hidden />}
                                    </span>

                                    <span className="flex-1 min-w-0">
                                        <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-fg-40">
                                            {String(index + 1).padStart(2, "0")}
                                            <span className="h-px w-4 bg-hairline-strong" />
                                            {isDone ? t("statusDone") : isLocked ? t("statusLocked") : t("statusNow")}
                                        </span>
                                        <span className="block text-base sm:text-lg font-medium tracking-tight mt-1">{t(titleKey)}</span>
                                        <span className="block text-[12px] text-fg-60 mt-0.5 leading-relaxed">{t(descKey)}</span>
                                    </span>

                                    <ChevronDown className={cn("w-4 h-4 shrink-0 text-fg-40 transition-transform duration-300", isOpen && "rotate-180")} aria-hidden />
                                </button>

                                <AnimatePresence initial={false}>
                                    {isOpen && (
                                        <motion.div
                                            key="body"
                                            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                                            animate={{ height: "auto", opacity: 1 }}
                                            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                                            transition={{ duration: reduceMotion ? 0 : 0.35, ease: EASE }}
                                            className="overflow-hidden"
                                        >
                                            <div id={`step-${id}`} className="border-t border-hairline px-5 sm:px-8 py-7">
                                                {bodies[id]}
                                            </div>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </motion.section>
                        );
                    })}
                </div>

                {allDone && (
                    <motion.div
                        initial={reduceMotion ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                        className="glass rounded-[2rem] border-accent-hot/30 bg-accent-hot/5 p-6 sm:p-8 mt-8 flex flex-col sm:flex-row sm:items-center gap-5"
                    >
                        <span className="w-12 h-12 rounded-2xl bg-accent-hot/15 ring-1 ring-accent-hot/30 flex items-center justify-center shrink-0">
                            <Check className="w-6 h-6 text-accent-hot" aria-hidden />
                        </span>
                        <div className="flex-1 space-y-1">
                            <h2 className="text-xl font-medium tracking-tight">{t("finished.title")}</h2>
                            <p className="text-[13px] text-fg-60 leading-relaxed">{t("finished.body")}</p>
                        </div>
                        <Link
                            href="/dashboard"
                            className="shrink-0 rounded-2xl bg-fg px-6 py-3.5 font-mono text-[10px] uppercase tracking-[0.18em] text-surface flex items-center justify-center gap-2 transition-all hover:bg-accent-hot"
                        >
                            {t("finished.cta")} <ArrowRight className="w-3.5 h-3.5" aria-hidden />
                        </Link>
                    </motion.div>
                )}

                <footer className="mt-12 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-t border-hairline pt-8">
                    <p className="text-[12px] text-fg-60 leading-relaxed">
                        {t("help.body")}{" "}
                        <a href={`mailto:${SUPPORT_EMAIL}`} className="text-accent-ink font-medium hover:text-accent-hover transition-colors">
                            {SUPPORT_EMAIL}
                        </a>
                    </p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-40">
                        <LegalLinks className="hover:text-fg-60 transition-colors" />
                    </div>
                </footer>
            </main>
        </div>
    );
}
