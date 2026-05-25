"use client";

export const runtime = "edge";

import { useState, useEffect } from "react";
import { Wallet, ClipboardList, Loader2, Check, AlertTriangle, ArrowLeft, Lock, Copy, Info } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import Image from "next/image";

type ConnectionStatus = "draft" | "active" | "paused" | "error" | "";

export default function EuPagoIxIntegration() {
    const t = useTranslations("eupagoIxSetup");
    const tCommon = useTranslations("integrationsIndex");

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState(false);

    const [ixConnected, setIxConnected] = useState<boolean | null>(null);

    const [hmacSecret, setHmacSecret] = useState("");
    const [apiKey, setApiKey] = useState("");
    const [hasSavedSecret, setHasSavedSecret] = useState(false);
    const [hasSavedApiKey, setHasSavedApiKey] = useState(false);
    const [status, setStatus] = useState<ConnectionStatus>("");
    const [webhookUrl, setWebhookUrl] = useState("");
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [integRes, eupagoRes] = await Promise.all([
                    fetch("/api/integrations"),
                    fetch("/api/integrations/eupago-source"),
                ]);
                if (cancelled) return;

                if (integRes.ok) {
                    const data = await integRes.json() as { ix_account_name?: string; ix_authorized?: number };
                    setIxConnected(!!data.ix_account_name && data.ix_authorized === 1);
                } else {
                    setIxConnected(false);
                }

                if (eupagoRes.ok) {
                    const data = await eupagoRes.json() as {
                        connection?: { status: ConnectionStatus; source_config: { has_hmac_secret: boolean; api_key_masked: string | null }; webhook_url?: string } | null
                    };
                    if (data.connection) {
                        setHasSavedSecret(data.connection.source_config.has_hmac_secret);
                        setHasSavedApiKey(!!data.connection.source_config.api_key_masked);
                        setStatus(data.connection.status);
                        if (data.connection.webhook_url) setWebhookUrl(data.connection.webhook_url);
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
            const body: Record<string, unknown> = {
                destination_kind: "invoicexpress",
                status: targetStatus,
            };
            if (hmacSecret) body.hmac_secret = hmacSecret;
            if (apiKey) body.api_key = apiKey;
            if (targetStatus === "active") {
                if (!hmacSecret && !hasSavedSecret) throw new Error(t("errorMissingHmac"));
            }

            const res = await fetch("/api/integrations/eupago-source", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const json = await res.json().catch(() => ({})) as { error?: string };
                throw new Error(json.error ?? `HTTP ${res.status}`);
            }
            const json = await res.json() as { webhook_url?: string };
            if (json.webhook_url) setWebhookUrl(json.webhook_url);
            setSuccess(true);
            setStatus(targetStatus);
            if (hmacSecret) setHasSavedSecret(true);
            if (apiKey) setHasSavedApiKey(true);
            setHmacSecret("");
            setApiKey("");
        } catch (e: any) {
            setError(e?.message ?? "Unknown error");
        } finally {
            setSaving(false);
        }
    }

    function copyWebhookUrl() {
        if (!webhookUrl) return;
        navigator.clipboard.writeText(webhookUrl).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
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
                        <div className="w-14 h-14 rounded-2xl bg-white/5 border border-hairline flex items-center justify-center backdrop-blur-xl ring-4 ring-surface p-3">
                            <Wallet className="w-7 h-7 text-accent" />
                        </div>
                        <div className="w-14 h-14 rounded-2xl bg-white/5 border border-hairline flex items-center justify-center backdrop-blur-xl ring-4 ring-surface p-3">
                            <Image src="/images/invoicexpress_logo2.png" alt="InvoiceXpress" width={30} height={30} className="object-contain" />
                        </div>
                    </div>
                    <div>
                        <h1 className="text-3xl font-medium tracking-tight">{t("title")}</h1>
                        <p className="text-fg-60 text-sm mt-1">{t("subtitle")}</p>
                    </div>
                </div>
            </header>

            <div className="glass p-5 sm:p-6 rounded-2xl border border-[rgba(245,158,11,0.30)] bg-[rgba(245,158,11,0.05)] flex items-start gap-3 sm:gap-4">
                <Info className="w-5 h-5 text-soon flex-shrink-0 mt-0.5" />
                <div className="space-y-2 min-w-0">
                    <p className="text-sm font-medium text-fg">{t("noteTitle")}</p>
                    <p className="text-xs text-fg-60 leading-relaxed">{t("noteBody")}</p>
                </div>
            </div>

            {!ixConnected && (
                <div className="glass p-5 sm:p-6 rounded-2xl border border-[rgba(244,63,94,0.30)] bg-[rgba(244,63,94,0.05)] flex items-start gap-4">
                    <AlertTriangle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
                    <div className="space-y-3">
                        <p className="text-sm text-fg">{t("ixMissingTitle")}</p>
                        <p className="text-xs text-fg-60">{t("ixMissingBody")}</p>
                        <Link href="/integrations/shopify-ix" className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-hairline hover:border-rule text-xs font-mono uppercase tracking-[0.18em]">
                            {t("configureIx")}
                        </Link>
                    </div>
                </div>
            )}

            <section className="space-y-5">
                <h2 className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{t("credentialsSection")}</h2>

                <Field label={t("hmacLabel")} hint={hasSavedSecret ? t("hmacStoredHint") : t("hmacHint")}>
                    <input
                        type="password"
                        value={hmacSecret}
                        onChange={(e) => setHmacSecret(e.target.value)}
                        placeholder={hasSavedSecret ? "••••••••••••" : ""}
                        className="w-full bg-surface-2 border border-hairline rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-accent transition-colors font-mono"
                    />
                </Field>

                <Field label={t("apiKeyLabel")} hint={hasSavedApiKey ? t("apiKeyStoredHint") : t("apiKeyHint")}>
                    <input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={hasSavedApiKey ? "••••••••••••" : ""}
                        className="w-full bg-surface-2 border border-hairline rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-accent transition-colors font-mono"
                    />
                </Field>
            </section>

            {webhookUrl && (
                <section className="space-y-3">
                    <h2 className="font-mono text-[10px] text-fg-40 uppercase tracking-[0.22em]">{t("webhookSection")}</h2>
                    <p className="text-xs text-fg-60">{t("webhookBody")}</p>
                    <div className="flex items-center gap-2 bg-surface-2 border border-hairline rounded-xl px-4 py-3">
                        <code className="flex-1 text-xs text-fg font-mono break-all">{webhookUrl}</code>
                        <button
                            type="button"
                            onClick={copyWebhookUrl}
                            className="p-2 rounded-lg hover:bg-surface transition-colors flex-shrink-0"
                            aria-label={t("copy")}
                        >
                            {copied ? <Check className="w-4 h-4 text-accent-hot" /> : <Copy className="w-4 h-4 text-fg-60" />}
                        </button>
                    </div>
                </section>
            )}

            {error && (
                <div className="glass p-4 rounded-xl border border-[rgba(239,68,68,0.30)] bg-[rgba(239,68,68,0.05)] flex items-start gap-3">
                    <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-red-400">{error}</p>
                </div>
            )}

            {success && (
                <div className="glass p-4 rounded-xl border border-[rgba(94,234,212,0.30)] bg-[rgba(94,234,212,0.05)] flex items-start gap-3">
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
                    disabled={saving || !ixConnected}
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
