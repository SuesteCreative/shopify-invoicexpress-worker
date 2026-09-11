"use client";

import { useEffect, useMemo, useState } from "react";
import { Link } from "@/i18n/navigation";
import { guidedOnboardings, platformName } from "@/lib/platforms";
import { RIOKO_CONFIG } from "@/lib/config";
import {
    ArrowLeft, Wrench, ShieldAlert, AlertTriangle, Info,
    KeyRound, Link2, Settings2, CheckCircle2, LifeBuoy,
    Copy, Check, ExternalLink, ChevronDown, Zap, Loader2,
} from "lucide-react";
import {
    SHOPIFY_SCOPES as SCOPES,
    SHOPIFY_API_VERSION as API_VERSION,
    SHOPIFY_WEBHOOK_BASE as WEBHOOK_BASE,
    cleanShopDomain as cleanShop,
    shopifyCallbackUri,
} from "@/lib/shopify-oauth";

// Páginas públicas de onboarding (link que se manda ao cliente antes de ele ter
// conta). A lista das guiadas vem de src/lib/platforms.ts, que é onde o próprio
// onboarding geral decide para onde encaminha: acrescentar um par lá faz o link
// aparecer aqui sozinho.
const GENERAL_ONBOARDING = {
    href: "/onboarding",
    label: "Onboarding geral (qualquer cliente novo)",
    hint: "Dados da empresa, escolha das duas plataformas e encaminhamento para o guia do par escolhido.",
};

const ONBOARDING_LINKS: { href: string; label: string; hint: string }[] = [
    GENERAL_ONBOARDING,
    ...guidedOnboardings().map(entry => ({
        href: entry.path,
        label: `${platformName(entry.source)} → ${platformName(entry.destination)}`,
        hint: "Seis passos: conta, dados da empresa, origem, destino, definições de faturação e subscrição.",
    })),
];

// ─── Shared building blocks ────────────────────────────────────────────────

type Accent = "sky" | "emerald" | "amber" | "rose";

const ACCENT_TEXT: Record<Accent, string> = {
    sky: "text-accent-ink",
    emerald: "text-accent-hot",
    amber: "text-soon",
    rose: "text-destructive",
};

function Section({ id, icon, title, eyebrow, accent = "sky", children }: {
    id: string;
    icon: React.ReactNode;
    title: string;
    eyebrow?: string;
    accent?: Accent;
    children: React.ReactNode;
}) {
    return (
        <section id={id} className="glass rounded-[2rem] p-5 sm:p-8 border-hairline space-y-6 scroll-mt-28">
            <div className="flex items-start gap-4">
                <div className={`w-12 h-12 rounded-2xl bg-surface-2 border border-hairline flex items-center justify-center shrink-0 ${ACCENT_TEXT[accent]}`}>
                    {icon}
                </div>
                <div>
                    {eyebrow && (
                        <div className="text-[10px] font-black text-fg-40 uppercase tracking-[0.2em] mb-1">{eyebrow}</div>
                    )}
                    <h2 className="text-2xl font-black text-fg">{title}</h2>
                </div>
            </div>
            <div className="ml-0 sm:ml-16 space-y-5">{children}</div>
        </section>
    );
}

/**
 * One of the two ways to onboard a store, in a fold.
 *
 * `<details open>`: open by default and collapsible is exactly what the element
 * does on its own, and an operator who works one method never has to scroll past
 * the other. No state, no library, and it survives a re-render mid-onboarding.
 */
function Method({ eyebrow, title, subtitle, accent = "sky", children }: {
    eyebrow: string;
    title: string;
    subtitle: string;
    accent?: Accent;
    children: React.ReactNode;
}) {
    return (
        <details open className="group glass rounded-[2rem] border-hairline overflow-hidden">
            <summary className="flex items-center gap-4 p-5 sm:p-6 cursor-pointer list-none [&::-webkit-details-marker]:hidden hover:bg-surface-2/40 transition-colors">
                <div className={`w-12 h-12 rounded-2xl bg-surface-2 border border-hairline flex items-center justify-center shrink-0 ${ACCENT_TEXT[accent]}`}>
                    <Zap className="w-5 h-5" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-black text-fg-40 uppercase tracking-[0.2em] mb-1">{eyebrow}</div>
                    <h2 className="text-xl sm:text-2xl font-black text-fg">{title}</h2>
                    <p className="text-xs text-fg-60 mt-1">{subtitle}</p>
                </div>
                <ChevronDown className="w-5 h-5 text-fg-40 shrink-0 transition-transform group-open:rotate-180" />
            </summary>
            <div className="px-2 pb-2 sm:px-3 sm:pb-3 space-y-6">{children}</div>
        </details>
    );
}

function InfoBox({ children }: { children: React.ReactNode }) {
    return (
        <div className="bg-accent/5 border border-accent/20 rounded-2xl p-4 flex items-start gap-3">
            <Info className="w-5 h-5 text-accent-ink shrink-0 mt-0.5" />
            <div className="text-accent-ink text-sm leading-relaxed">{children}</div>
        </div>
    );
}

function WarnBox({ children }: { children: React.ReactNode }) {
    return (
        <div className="bg-soon/5 border border-soon/20 rounded-2xl p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-soon shrink-0 mt-0.5" />
            <div className="text-soon text-sm leading-relaxed">{children}</div>
        </div>
    );
}

function DangerBox({ children }: { children: React.ReactNode }) {
    return (
        <div className="bg-destructive/5 border border-destructive/20 rounded-2xl p-4 flex items-start gap-3">
            <ShieldAlert className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div className="text-destructive text-sm leading-relaxed">{children}</div>
        </div>
    );
}

function Code({ children }: { children: React.ReactNode }) {
    return (
        <code className="font-mono text-[12px] bg-surface-2 border border-hairline rounded px-1.5 py-0.5 text-accent-hot break-all">
            {children}
        </code>
    );
}

function DataTable({ headers, rows }: { headers: string[]; rows: React.ReactNode[][] }) {
    return (
        <div className="rounded-2xl border border-hairline overflow-hidden">
            <table className="w-full text-sm">
                <thead>
                    <tr className="bg-surface-2">
                        {headers.map((h, i) => (
                            <th key={i} className="text-left px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-fg-40">
                                {h}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, i) => (
                        <tr key={i} className="border-t border-hairline/60">
                            {row.map((cell, j) => (
                                <td key={j} className="px-4 py-3 align-top text-fg-60">{cell}</td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
    return (
        <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-fg-40 mb-1.5">{label}</label>
            <input
                {...props}
                className="w-full rounded-xl bg-surface-2 border border-hairline px-3 py-2.5 text-sm font-mono text-fg placeholder:text-fg-40 focus:border-accent outline-none transition-colors"
            />
        </div>
    );
}

function Output({ label, text, onCopy, copied }: { label: string; text: string; onCopy: () => void; copied: boolean }) {
    return (
        <div>
            <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] font-bold uppercase tracking-wider text-fg-40">{label}</span>
                <CopyButton copied={copied} onClick={onCopy} disabled={!text} />
            </div>
            <pre className="rounded-xl bg-surface-2 border border-hairline p-4 font-mono text-[12px] text-fg-60 overflow-x-auto whitespace-pre-wrap break-all">
                {text || "Preencher os campos acima…"}
            </pre>
        </div>
    );
}

function CopyButton({ copied, onClick, disabled, small }: { copied: boolean; onClick: () => void; disabled?: boolean; small?: boolean }) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide transition-colors shrink-0 disabled:opacity-30 disabled:cursor-not-allowed ${
                copied
                    ? "border-accent-hot/40 text-accent-hot bg-accent-hot/8"
                    : "border-hairline bg-surface-2 text-fg-60 hover:text-fg hover:border-accent/40"
            } ${small ? "px-2 py-1" : ""}`}
        >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? "Copiado" : "Copiar"}
        </button>
    );
}

const TOC = [
    { id: "parte-a", label: "A — Criar App" },
    { id: "parte-b", label: "B — Link /authorize" },
    { id: "parte-c", label: "C — Token & Teste" },
    { id: "parte-d", label: "D — Webhook Secret" },
    { id: "parte-e", label: "E — Integrador Rioko" },
    { id: "parte-f", label: "F — Verificação Final" },
    { id: "parte-g", label: "G — Troubleshooting" },
];

const TOC_M2 = [
    { id: "m2-app", label: "A — Criar App" },
    { id: "m2-install", label: "B — Instalar" },
    { id: "m2-done", label: "C — Feito sozinho" },
    { id: "m2-rioko", label: "D — Integrador Rioko" },
    { id: "m2-verify", label: "E — Verificação Final" },
    { id: "m2-trouble", label: "F — Troubleshooting" },
];

const WEBHOOKS = [
    { event: "Order creation", pt: "Criação de encomenda", note: "orders/create", key: "orders-created" },
    { event: "Order edit", pt: "Atualização de encomenda", note: "orders/updated", key: "orders-updated" },
    { event: "Order payment", pt: "Pagamento de encomenda", note: "orders/paid", key: "orders-paid" },
    { event: "Refund create", pt: "Criação de reembolso", note: "refunds/create", key: "refunds-create" },
];

/**
 * The link for one client, with their payment already settled.
 *
 * Creating it writes an intention, nothing else: no Stripe call, no subscription
 * row. When the client signs up through the link, the subscription named here
 * starts paying for the pair chosen here, and the last step of their onboarding
 * says "covered" instead of asking for a card.
 *
 * The first section of this panel that talks to the server. The others are pure
 * string builders.
 */
function InviteBuilder({ copiedKey, copy }: { copiedKey: string | null; copy: (key: string, text: string) => void }) {
    const PAIRS = guidedOnboardings();
    const [label, setLabel] = useState("");
    const [pair, setPair] = useState(`${PAIRS[0]?.source}:${PAIRS[0]?.destination}`);
    const [subscriptionId, setSubscriptionId] = useState("");
    const [validDays, setValidDays] = useState("30");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [url, setUrl] = useState("");
    const [legacy, setLegacy] = useState(false);
    const [invites, setInvites] = useState<any[] | null>(null);

    const load = () => {
        fetch("/api/admin/onboarding-invites")
            .then(r => (r.ok ? r.json() : { invites: [] }))
            .then((d: any) => setInvites(d.invites ?? []))
            .catch(() => setInvites([]));
    };
    useEffect(load, []);

    const create = async () => {
        const [source_kind, destination_kind] = pair.split(":");
        setBusy(true);
        setError("");
        setUrl("");
        try {
            const res = await fetch("/api/admin/onboarding-invites", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    label: label.trim(),
                    source_kind,
                    destination_kind,
                    stripe_subscription_id: subscriptionId.trim(),
                    valid_days: Number(validDays) || 30,
                }),
            });
            const json: any = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(json.error ?? `HTTP ${res.status}`);
                return;
            }
            setUrl(json.url);
            setLegacy(!!json.legacy_price);
            load();
        } catch (e: any) {
            setError(e?.message ?? "Erro de rede");
        } finally {
            setBusy(false);
        }
    };

    return (
        <Section id="convite" icon={<Link2 className="w-5 h-5" />} title="Link para um cliente com subscrição" eyebrow="Links" accent="emerald">
            <WarnBox>
                O cliente que abrir este link não vê o passo do pagamento: a subscrição indicada
                <strong> passa a pagar a ligação escolhida</strong>, e deixa de pagar aquela onde estava.
                Se ele quiser manter as duas ligações a funcionar, isto não serve.
            </WarnBox>

            <div className="grid sm:grid-cols-2 gap-4">
                <Field label="Empresa" value={label} placeholder="Cake Art Magazine" onChange={(e) => setLabel(e.target.value)} />
                <div>
                    <label className="block text-[11px] font-bold uppercase tracking-wider text-fg-40 mb-1.5">Ligação</label>
                    <select
                        value={pair}
                        onChange={(e) => setPair(e.target.value)}
                        className="w-full rounded-xl bg-surface-2 border border-hairline px-3 py-2.5 text-sm font-mono text-fg focus:border-accent outline-none transition-colors"
                    >
                        {PAIRS.map(p => (
                            <option key={`${p.source}:${p.destination}`} value={`${p.source}:${p.destination}`}>
                                {platformName(p.source)} → {platformName(p.destination)}
                            </option>
                        ))}
                    </select>
                </div>
                <Field label="Subscrição Stripe" value={subscriptionId} placeholder="sub_1RPLcL…" onChange={(e) => setSubscriptionId(e.target.value)} />
                <Field label="Validade (dias)" value={validDays} inputMode="numeric" onChange={(e) => setValidDays(e.target.value)} />
            </div>

            <button
                type="button"
                onClick={create}
                disabled={busy || !label.trim() || !subscriptionId.trim()}
                className="w-full rounded-xl bg-fg text-surface py-3 text-[11px] font-black uppercase tracking-[0.18em] transition-all hover:bg-accent-hot disabled:opacity-30 disabled:cursor-not-allowed"
            >
                {busy ? "A gerar…" : "Gerar link"}
            </button>

            {error && <DangerBox>{error}</DangerBox>}

            <Output label="Link a enviar" text={url} copied={copiedKey === "invite"} onCopy={() => copy("invite", url)} />

            {url && legacy && (
                <InfoBox>
                    Esta subscrição está no <strong>preço antigo</strong>. O cliente mantém-no, e a ligação nova
                    fica marcada como legacy assim que ele abrir o link.
                </InfoBox>
            )}

            {invites && invites.length > 0 && (
                <DataTable
                    headers={["Empresa", "Ligação", "Estado", "Validade"]}
                    rows={invites.map((i: any) => [
                        i.label,
                        `${platformName(i.source_kind)} → ${platformName(i.destination_kind)}`,
                        i.claimed_at
                            ? `usado ${i.claimed_company || i.claimed_email || i.claimed_by_user_id}`
                            : new Date(i.expires_at) < new Date() ? "expirado" : "por usar",
                        new Date(i.expires_at).toLocaleDateString("pt-PT"),
                    ])}
                />
            )}
        </Section>
    );
}

export function OnboardingHelperPanel() {
    // Shared across all builders — paste once, autofills everywhere.
    const [shopDomain, setShopDomain] = useState("");
    const [clientId, setClientId] = useState("");

    const [stateParam, setStateParam] = useState("kapta123");
    const [redirectUri, setRedirectUri] = useState("https://example.com/");

    const [clientSecret, setClientSecret] = useState("");
    const [authCode, setAuthCode] = useState("");

    const [accessToken, setAccessToken] = useState("");

    const [copiedKey, setCopiedKey] = useState<string | null>(null);

    // ── Método 2 ────────────────────────────────────────────────────────────
    // The domain, client id and secret above are shared with Método 1 on
    // purpose: they are the same three values either way, and an operator who
    // starts down one path and switches does not retype them.
    const [accounts, setAccounts] = useState<{ id: string; label: string; domain: string | null }[]>([]);
    const [targetUser, setTargetUser] = useState("");
    const [busy, setBusy] = useState(false);
    const [startError, setStartError] = useState<string | null>(null);
    // Shown rather than followed: whoever presses Install has to be signed in to
    // the store's admin, and that is often the client and not the operator. A
    // link can be sent; a redirect cannot.
    const [installUrl, setInstallUrl] = useState("");
    const [outcome, setOutcome] = useState<{ status: string; detail: string } | null>(null);

    useEffect(() => {
        // One card per CONNECTION comes back, so an account with two pipes is
        // listed twice; the picker wants accounts.
        fetch("/api/admin/users")
            .then(r => r.json())
            .then((data: any) => {
                const byId = new Map<string, { id: string; label: string; domain: string | null }>();
                for (const u of (data?.users ?? []) as any[]) {
                    if (!u?.id || byId.has(u.id)) continue;
                    byId.set(u.id, { id: u.id, label: u.account_label ?? u.email ?? u.id, domain: u.shopify_domain ?? null });
                }
                setAccounts([...byId.values()]);
            })
            .catch(() => setAccounts([]));
    }, []);

    // The callback drops the operator back here with the verdict in the URL.
    // Read from location rather than useSearchParams: no Suspense boundary to
    // arrange for one string.
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const status = params.get("shopify");
        if (status) setOutcome({ status, detail: params.get("detail") ?? "" });
    }, []);

    const startMethod2 = async () => {
        setStartError(null);
        setInstallUrl("");
        setBusy(true);
        try {
            const res = await fetch("/api/admin/shopify-oauth/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    user_id: targetUser,
                    shop: shopDomain,
                    client_id: clientId,
                    client_secret: clientSecret,
                }),
            });
            const data: any = await res.json().catch(() => ({}));
            if (!res.ok) {
                setStartError([data?.error, data?.reason].filter(Boolean).join(" ") || `Erro ${res.status}`);
                return;
            }
            setInstallUrl(data.authorize_url);
        } catch (e: any) {
            setStartError(String(e?.message ?? e));
        } finally {
            setBusy(false);
        }
    };

    const copy = (key: string, text: string) => {
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            setCopiedKey(key);
            setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1600);
        });
    };

    const shop = cleanShop(shopDomain);

    const authorizeUrl = useMemo(() => {
        if (!shop || !clientId) return "";
        return `https://${shop}/admin/oauth/authorize`
            + `?client_id=${encodeURIComponent(clientId)}`
            + `&scope=${SCOPES}`
            + `&redirect_uri=${encodeURIComponent(redirectUri || "https://example.com/")}`
            + `&state=${encodeURIComponent(stateParam || "kapta123")}`;
    }, [shop, clientId, redirectUri, stateParam]);

    const curlPs = useMemo(() => {
        if (!shop || !clientId || !clientSecret || !authCode) return "";
        return `curl.exe -X POST "https://${shop}/admin/oauth/access_token" \`
  -H "Content-Type: application/x-www-form-urlencoded" \`
  -H "Accept: application/json" \`
  --data-urlencode "client_id=${clientId}" \`
  --data-urlencode "client_secret=${clientSecret}" \`
  --data-urlencode "code=${authCode}"`;
    }, [shop, clientId, clientSecret, authCode]);

    const curlMac = useMemo(() => {
        if (!shop || !clientId || !clientSecret || !authCode) return "";
        return `curl -X POST "https://${shop}/admin/oauth/access_token" \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -H "Accept: application/json" \\
  --data-urlencode "client_id=${clientId}" \\
  --data-urlencode "client_secret=${clientSecret}" \\
  --data-urlencode "code=${authCode}"`;
    }, [shop, clientId, clientSecret, authCode]);

    const testPs = useMemo(() => {
        if (!shop || !accessToken) return "";
        return `curl.exe -i -X GET "https://${shop}/admin/api/${API_VERSION}/shop.json" \`
  -H "X-Shopify-Access-Token: ${accessToken}" \`
  -H "Accept: application/json"`;
    }, [shop, accessToken]);

    const testMac = useMemo(() => {
        if (!shop || !accessToken) return "";
        return `curl -i -X GET "https://${shop}/admin/api/${API_VERSION}/shop.json" \\
  -H "X-Shopify-Access-Token: ${accessToken}" \\
  -H "Accept: application/json"`;
    }, [shop, accessToken]);

    return (
        <div className="max-w-4xl mx-auto space-y-6 animate-in fade-in duration-700">
            <Link href="/dashboard" className="inline-flex items-center gap-2 text-fg-40 hover:text-fg text-sm font-bold transition-all group">
                <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
                Voltar ao Dashboard
            </Link>

            {/* Links de onboarding público */}
            <div className="glass rounded-[2rem] p-5 sm:p-8 border-hairline space-y-4">
                <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-2xl bg-surface-2 border border-hairline flex items-center justify-center shrink-0 text-accent-hot">
                        <Link2 className="w-5 h-5" />
                    </div>
                    <div>
                        <div className="text-[10px] font-black text-fg-40 uppercase tracking-[0.2em] mb-1">Links de onboarding</div>
                        <h2 className="text-2xl font-black text-fg">Páginas para enviar ao cliente</h2>
                    </div>
                </div>
                <div className="ml-0 sm:ml-16 space-y-3">
                    {ONBOARDING_LINKS.map((item) => (
                        <Link
                            key={item.href}
                            href={item.href}
                            className="flex items-start gap-3 rounded-2xl border border-hairline bg-surface-2 px-4 py-3 hover:border-accent/40 transition-colors group"
                        >
                            <ExternalLink className="w-4 h-4 text-accent-ink shrink-0 mt-0.5" />
                            <div>
                                <div className="text-sm font-bold text-fg group-hover:text-accent-ink transition-colors">{item.label}</div>
                                <div className="text-xs text-fg-60 mt-0.5">{item.hint}</div>
                            </div>
                        </Link>
                    ))}
                </div>
            </div>

            <InviteBuilder copiedKey={copiedKey} copy={copy} />

            {/* Page header */}
            <div className="glass rounded-[2rem] p-6 sm:p-10 border-hairline space-y-4">
                <div className="flex items-center gap-4">
                    <div className="w-14 h-14 rounded-2xl bg-surface-2 border border-hairline flex items-center justify-center">
                        <Wrench className="w-7 h-7 text-soon" />
                    </div>
                    <div>
                        <h1 className="text-3xl sm:text-4xl font-black tracking-tight bg-gradient-to-r from-fg via-fg to-fg-40 bg-clip-text text-transparent">
                            Integração Cliente Novo
                        </h1>
                        <p className="text-fg-60 font-semibold mt-1">Shopify → InvoiceXpress (Rioko) · API <Code>{API_VERSION}</Code></p>
                    </div>
                </div>
                <p className="text-fg-60 text-sm leading-relaxed">
                    Guia completo: criar app no Shopify, obter access token offline (OAuth), e configurar o integrador Rioko.
                </p>
                <DangerBox>
                    <strong>Aviso:</strong> Não partilhar Client Secret, tokens ou authorization codes por chat, email ou screenshots. Tratar como credenciais.
                </DangerBox>
                <WarnBox>
                    <strong>Versões da API envelhecem.</strong> A Shopify suporta cada versão REST ~12 meses; depois o path é removido e devolve <Code>{`404 {"errors":"Not Found"}`}</Code> — mesmo com token e loja válidos. Manter a versão usada (testes, integrador, webhooks) sempre numa versão suportada.
                </WarnBox>

            </div>

            <Method
                eyebrow="Método 1"
                title="Token à mão, webhooks à mão"
                subtitle="O caminho de sempre: o code fica no browser, é trocado por curl, e os 4 webhooks são criados em Settings → Notifications. É o único caminho para as lojas já ligadas."
                accent="sky"
            >
                <div className="flex flex-wrap gap-2 px-3 pt-2">
                    {TOC.map((item) => (
                        <a
                            key={item.id}
                            href={`#${item.id}`}
                            className="text-[11px] font-bold uppercase tracking-wide px-3 py-1.5 rounded-full border border-hairline bg-surface-2 text-fg-60 hover:text-fg hover:border-accent/40 transition-colors"
                        >
                            {item.label}
                        </a>
                    ))}
                </div>

            {/* Parte A */}
            <Section id="parte-a" icon={<Settings2 className="w-5 h-5" />} title="Criar App no Shopify Dev Dashboard" eyebrow="Parte A" accent="sky">
                <p className="text-sm text-fg-60">
                    No admin da Shopify do cliente: <strong className="text-fg">nome da loja</strong> no canto superior direito, ícone <Code>{"</>"}</Code> → <strong className="text-fg">View Dev Dashboard</strong> → <strong className="text-fg">Create app</strong>.
                    <strong className="text-fg"> Não é preciso conta de Partner</strong>, e não é o fluxo de custom app com &quot;Reveal token once&quot;.
                </p>
                <DataTable
                    headers={["Campo", "Valor"]}
                    rows={[
                        ["App name", <>Nome do cliente (ex: <Code>Rioko — NomeDoCliente</Code>)</>],
                        ["App URL", <><Code key="appurl1">{RIOKO_CONFIG.appUrl}</Code> — o link do Konnector que aqui estava está morto (certificado inválido)</>],
                        ["Embed app in Shopify admin", <strong key="embed" className="text-destructive">DESLIGADO</strong>],
                        ["Allowed redirection URL(s)", <Code key="redirect">https://example.com/</Code>],
                        ["Scopes (Admin API)", <Code key="scopes">{SCOPES}</Code>],
                    ]}
                />
                <WarnBox>
                    Os scopes <Code>write_webhooks</Code> / <Code>read_webhooks</Code> <strong>não existem</strong>. Criar uma subscrição exige só o scope do tópico, e o <Code>read_orders</Code> cobre os quatro.
                    Neste método os webhooks são criados à mão <strong>por opção</strong>, não por falta de permissão: quem os cria pela API é o Método 2.
                </WarnBox>
                <div>
                    <h3 className="text-sm font-bold text-fg mb-2">Versão e Release</h3>
                    <ol className="space-y-2 text-sm text-fg-60 list-decimal list-inside">
                        <li>Sempre que alterares scopes ou redirect URLs, criar <strong className="text-fg">nova versão</strong> e fazer <strong className="text-fg">Release</strong>.</li>
                        <li>Versão tem de estar <strong className="text-fg">Active</strong>.</li>
                        <li>
                            Após release: aceder a <strong className="text-fg">Settings</strong> da app e copiar:
                            <ul className="list-disc list-inside mt-1 ml-1">
                                <li><strong className="text-fg">Client ID</strong> (API key)</li>
                                <li><strong className="text-fg">Client Secret</strong></li>
                                <li>Domínio nativo da loja (ex: <Code>quickstart-66f9e5ef.myshopify.com</Code>)</li>
                            </ul>
                        </li>
                    </ol>
                </div>
                <DangerBox>
                    <strong>Não fazer instalação direta da app</strong> pelo botão da lista. Usa o Builder da Parte B para construir o link <Code>/authorize</Code>.
                </DangerBox>
            </Section>

            {/* Parte B */}
            <Section id="parte-b" icon={<Link2 className="w-5 h-5" />} title="Builder do Link /authorize" eyebrow="Parte B" accent="emerald">
                <p className="text-sm text-fg-60">
                    Constrói o URL de autorização. Abrir em nova tab → clicar <strong className="text-fg">Install</strong> → vai redireccionar para uma página de erro (<Code>example.com</Code> não existe) — copiar <Code>code=...</Code> do URL.
                </p>

                <div className="space-y-4">
                    <Field label="Domínio Shopify (.myshopify.com)" placeholder="quickstart-66f9e5ef.myshopify.com" value={shopDomain} onChange={(e) => setShopDomain(e.target.value)} />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <Field label="Client ID" placeholder="abc123def456..." value={clientId} onChange={(e) => setClientId(e.target.value)} />
                        <Field label="State" value={stateParam} onChange={(e) => setStateParam(e.target.value)} />
                    </div>
                    <Field label="Redirect URI" value={redirectUri} onChange={(e) => setRedirectUri(e.target.value)} />

                    <Output label="URL gerado" text={authorizeUrl} copied={copiedKey === "b-output"} onCopy={() => copy("b-output", authorizeUrl)} />

                    <button
                        type="button"
                        disabled={!authorizeUrl}
                        onClick={() => window.open(authorizeUrl, "_blank", "noopener")}
                        className="inline-flex items-center gap-2 rounded-xl bg-accent text-on-accent px-4 py-2.5 text-[12px] font-bold uppercase tracking-wide hover:bg-accent/85 transition-all active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                        <ExternalLink className="w-4 h-4" /> Abrir em nova tab
                    </button>
                </div>

                <InfoBox>
                    <strong>Após clicar Install:</strong> o Shopify redirecciona para <Code>https://example.com/?code=SEU_CODE&hmac=...&shop=...&state=kapta123</Code>. Página vai dar erro DNS (normal) — copiar apenas o valor do <Code>code=</Code> do URL no topo.
                </InfoBox>
                <WarnBox>
                    <strong>Importante:</strong> O <Code>code</Code> expira em poucos minutos e só pode ser usado <strong>uma vez</strong>. Se falhar a troca, repete a Parte B para obter novo code.
                </WarnBox>
            </Section>

            {/* Parte C */}
            <Section id="parte-c" icon={<KeyRound className="w-5 h-5" />} title="Builder do curl — Code → Access Token" eyebrow="Parte C" accent="amber">
                <p className="text-sm text-fg-60">Trocar o <Code>code</Code> por um <strong className="text-fg">access token offline</strong> (longa duração). Domínio e Client ID já vêm preenchidos da Parte B.</p>

                <div className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <Field label="Domínio Shopify" placeholder="quickstart-66f9e5ef.myshopify.com" value={shopDomain} onChange={(e) => setShopDomain(e.target.value)} />
                        <Field label="Client ID" placeholder="abc123def456..." value={clientId} onChange={(e) => setClientId(e.target.value)} />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <Field label="Client Secret" type="password" placeholder="shpss_..." value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
                        <Field label="Authorization Code (da Parte B)" placeholder="886743b39bf5cd4c..." value={authCode} onChange={(e) => setAuthCode(e.target.value)} />
                    </div>

                    <Output label="Windows PowerShell" text={curlPs} copied={copiedKey === "c-ps"} onCopy={() => copy("c-ps", curlPs)} />
                    <Output label="macOS / Linux Terminal" text={curlMac} copied={copiedKey === "c-mac"} onCopy={() => copy("c-mac", curlMac)} />
                </div>

                <InfoBox>
                    Resposta esperada:
                    <pre className="mt-2 rounded-lg bg-surface-2 border border-hairline p-3 font-mono text-[12px] text-fg-60 overflow-x-auto">{`{ "access_token": "shpat_xxxxxxxxxxxxxxxxxxxx", "scope": "read_customers,read_discounts,..." }`}</pre>
                    Copiar o <Code>access_token</Code> — vai ser usado no Passo 1 do integrador (Parte E).
                </InfoBox>

                <div>
                    <h3 className="text-sm font-bold text-fg mb-2">Verificar token (recomendado)</h3>
                    <p className="text-sm text-fg-60 mb-3">Confirmar que o token responde <strong className="text-fg">HTTP 200</strong> antes de o introduzir no integrador. Interpretar o resultado:</p>
                    <DataTable
                        headers={["Resposta", "Significa", "Ação"]}
                        rows={[
                            [<Code key="200">200</Code>, "Token válido", "Continuar"],
                            [<Code key="401">{`401 {"errors":"[API] Invalid API key or access token..."}`}</Code>, "Token revogado / inválido (app reinstalada, code errado, loja diferente)", "Re-emitir token: repetir Partes B–C"],
                            [<Code key="404">{`404 {"errors":"Not Found"}`}</Code>, "(loja e token corretos) Versão da API no URL foi retirada pela Shopify", "Trocar a versão por uma suportada no URL do teste e no integrador"],
                        ]}
                    />
                </div>

                <div className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <Field label="Domínio Shopify" placeholder="quickstart-66f9e5ef.myshopify.com" value={shopDomain} onChange={(e) => setShopDomain(e.target.value)} />
                        <Field label="Access Token (shpat_…)" type="password" placeholder="shpat_..." value={accessToken} onChange={(e) => setAccessToken(e.target.value)} />
                    </div>
                    <Output label="Windows PowerShell — Teste" text={testPs} copied={copiedKey === "t-ps"} onCopy={() => copy("t-ps", testPs)} />
                    <Output label="macOS / Linux — Teste" text={testMac} copied={copiedKey === "t-mac"} onCopy={() => copy("t-mac", testMac)} />
                </div>
            </Section>

            {/* Parte D */}
            <Section id="parte-d" icon={<ShieldAlert className="w-5 h-5" />} title="Webhook Signing Secret" eyebrow="Parte D" accent="rose">
                <ol className="space-y-2 text-sm text-fg-60 list-decimal list-inside">
                    <li>Shopify Admin (loja do cliente) → <strong className="text-fg">Settings</strong> → <strong className="text-fg">Notifications</strong>.</li>
                    <li>Scroll até secção <strong className="text-fg">Webhooks</strong>.</li>
                    <li>Procurar a frase: <em>&quot;Your webhooks will be signed with: ...&quot;</em></li>
                    <li>Copiar o secret.</li>
                </ol>
                <InfoBox>Este secret é <strong>partilhado por todos os webhooks da loja</strong> — se já existirem outros webhooks, o secret é o mesmo.</InfoBox>
            </Section>

            {/* Parte E */}
            <Section id="parte-e" icon={<Settings2 className="w-5 h-5" />} title="Configurar o Integrador Rioko (4 Passos)" eyebrow="Parte E" accent="sky">
                <p className="text-sm text-fg-60">
                    Abrir <a href="https://rioko.online/integrations/shopify-ix" target="_blank" rel="noopener noreferrer" className="text-accent-ink underline">rioko.online/integrations/shopify-ix</a> com a conta do cliente.
                </p>

                <div>
                    <h3 className="text-sm font-bold text-fg mb-2">1 · Ligação Shopify</h3>
                    <DataTable
                        headers={["Campo", "Valor"]}
                        rows={[
                            ["Domínio Shopify", <>Ex: <Code>exemplo.myshopify.com</Code> (sem https://)</>],
                            ["Admin API Access Token", <>O <Code>shpat_…</Code> obtido na Parte C</>],
                            ["Versão da API", <>Usar a mais recente suportada (à data, <Code>{API_VERSION}</Code>) — rever anualmente</>],
                        ]}
                    />
                    <p className="text-xs text-fg-40 mt-2">Clicar <strong className="text-fg-60">Validar e Guardar</strong>. Aguardar badge &quot;Autorizado&quot;.</p>
                </div>

                <div>
                    <h3 className="text-sm font-bold text-fg mb-2">2 · Webhooks (instalação manual)</h3>
                    <p className="text-sm text-fg-60 mb-2"><strong className="text-fg">2.1 — Criar os 4 webhooks no Shopify Admin do cliente:</strong></p>
                    <ol className="space-y-1 text-sm text-fg-60 list-decimal list-inside mb-3">
                        <li>Shopify Admin → Settings → Notifications → secção Webhooks → Create webhook.</li>
                        <li>Criar os 4 webhooks abaixo (Format: <strong className="text-fg">JSON</strong>, Webhook API version: a mais recente do dropdown — à data, <Code>{API_VERSION}</Code>).</li>
                    </ol>
                    <WarnBox>
                        <strong>Qual &quot;Webhook API version&quot; escolher:</strong> selecionar sempre a mais recente oferecida no dropdown. Usar a mesma versão nos 4 webhooks. Não precisa de coincidir com a versão REST do integrador.
                    </WarnBox>

                    <div className="rounded-2xl border border-hairline overflow-hidden mt-3">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="bg-surface-2">
                                    <th className="text-left px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-fg-40">Event</th>
                                    <th className="text-left px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-fg-40">URL</th>
                                </tr>
                            </thead>
                            <tbody>
                                {WEBHOOKS.map((wh) => {
                                    const url = `${WEBHOOK_BASE}/${wh.key}`;
                                    return (
                                        <tr key={wh.key} className="border-t border-hairline/60">
                                            <td className="px-4 py-3 align-top text-fg-60 whitespace-nowrap">
                                                <Code>{wh.event}</Code>
                                                <div className="text-[11px] text-fg-40 mt-1">({wh.note})</div>
                                                <div className="text-[11px] text-fg-40">{wh.pt}</div>
                                            </td>
                                            <td className="px-4 py-3 align-top">
                                                <div className="flex items-center justify-between gap-3">
                                                    <Code>{url}</Code>
                                                    <CopyButton small copied={copiedKey === wh.key} onClick={() => copy(wh.key, url)} />
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    <p className="text-sm text-fg-60 mt-3 mb-2"><strong className="text-fg">2.2 — No integrador Rioko:</strong> introduzir o Webhook Signing Secret copiado na Parte D.</p>
                    <p className="text-xs text-fg-40">
                        Clicar <strong className="text-fg-60">Confirmar Instalação Manual</strong>. O antigo &quot;Instalar Webhooks&quot; responde <Code>410</Code>: criava um segundo conjunto,
                        da app, assinado com outro segredo, e todas as entregas desse conjunto eram rejeitadas. Para ter os webhooks criados pela API, é o Método 2.
                    </p>
                </div>

                <div>
                    <h3 className="text-sm font-bold text-fg mb-2">3 · Conexão InvoiceXpress</h3>
                    <DataTable
                        headers={["Campo", "Valor"]}
                        rows={[
                            ["Nome da Conta", <>Slug antes de <Code>.invoicexpress.com</Code> (ex: <Code>ultramegasonico</Code>)</>],
                            ["Chave API", "IX → Definições da Conta → Integrações / API"],
                            ["Ambiente", <><Code>production</Code> ou <Code>sandbox</Code></>],
                        ]}
                    />
                </div>

                <div>
                    <h3 className="text-sm font-bold text-fg mb-2">4 · Definições de Integração</h3>
                    <DataTable
                        headers={["Definição", "Descrição"]}
                        rows={[
                            ["IVA Incluído", "Toggle ON se preços Shopify já incluem IVA"],
                            ["Auto Finalizar", "Toggle ON = emitir e finalizar documento imediatamente"],
                            ["Tipo de Fatura", <><Code>Fatura-Recibo</Code> (default) ou <Code>Fatura</Code></>],
                            ["Prazo Pagamento (dias)", "Apenas se Tipo = Fatura"],
                            ["Série de Faturação", <>Vazio = série pré-definida no IX (ou ex: <Code>WEB</Code>)</>],
                            ["Razão de Isenção (IVA 0%)", <>Default <Code>M01</Code> — códigos M01 a M99 disponíveis</>],
                        ]}
                    />
                </div>
            </Section>

            {/* Parte F */}
            <Section id="parte-f" icon={<CheckCircle2 className="w-5 h-5" />} title="Verificação Final" eyebrow="Parte F" accent="emerald">
                <ul className="space-y-1.5 text-sm text-fg-60 list-disc list-inside">
                    <li>Badge <strong className="text-fg">Autorizado</strong> no cartão Shopify</li>
                    <li>Badge <strong className="text-fg">Autorizado</strong> no cartão Webhooks</li>
                    <li>Badge <strong className="text-fg">Autorizado</strong> no cartão InvoiceXpress</li>
                    <li>
                        Encomenda de teste paga na loja → verificar:
                        <ul className="list-disc list-inside ml-4 mt-1">
                            <li>Aparece em Logs do dashboard</li>
                            <li>Aparece fatura no Invoices Hub</li>
                            <li>Aparece no InvoiceXpress da conta do cliente</li>
                        </ul>
                    </li>
                </ul>

                <div>
                    <h3 className="text-sm font-bold text-fg mb-2">Checklist resumido</h3>
                    <ul className="space-y-1.5 text-sm text-fg-60 list-disc list-inside">
                        <li>App criada no Dev Dashboard, versão Active.</li>
                        <li>Scopes correctos e mínimos.</li>
                        <li>Authorization code capturado e trocado com sucesso.</li>
                        <li>Token testado com <Code>shop.json</Code> (HTTP 200).</li>
                        <li>Webhooks (orders/create + orders/updated + orders/paid + refunds/create) criados manualmente.</li>
                        <li>Webhook Signing Secret introduzido no integrador.</li>
                        <li>IX conectado e ambiente correcto.</li>
                        <li>Definições fiscais ajustadas ao cliente.</li>
                        <li>Encomenda de teste validada end-to-end.</li>
                    </ul>
                </div>
            </Section>

            {/* Parte G */}
            <Section id="parte-g" icon={<LifeBuoy className="w-5 h-5" />} title="Troubleshooting" eyebrow="Parte G" accent="amber">
                <div>
                    <h3 className="text-sm font-bold text-fg mb-1.5">Sem code no redirect</h3>
                    <ul className="space-y-1 text-sm text-fg-60 list-disc list-inside">
                        <li>Redirect URI aponta para servidor que força login → usar <Code>https://example.com/</Code>.</li>
                        <li><strong className="text-fg">Embed app in Shopify admin</strong> activo consome o code → desligar.</li>
                        <li>Redirect URI tem de ser exactamente o que está em Allowed redirection URL(s), incluindo barra final.</li>
                    </ul>
                </div>
                <div>
                    <h3 className="text-sm font-bold text-fg mb-1.5">Erro ao trocar code por token</h3>
                    <ul className="space-y-1 text-sm text-fg-60 list-disc list-inside">
                        <li><Code>code expirado</Code> → repetir Parte B para obter novo.</li>
                        <li><Code>code já usado</Code> → cada code só pode ser trocado uma vez.</li>
                        <li>Verificar que client_id, client_secret e shop correspondem à mesma app/loja.</li>
                    </ul>
                </div>
                <div>
                    <h3 className="text-sm font-bold text-fg mb-1.5">Token parece inválido no integrador, mas funciona no curl</h3>
                    <ul className="space-y-1 text-sm text-fg-60 list-disc list-inside">
                        <li>Header tem de ser <Code>X-Shopify-Access-Token</Code> (Admin API).</li>
                        <li>Host tem de ser <Code>{"{shop}"}.myshopify.com</Code>.</li>
                        <li>Validar por request real e HTTP 200, não por prefixo do token.</li>
                    </ul>
                </div>
                <div>
                    <h3 className="text-sm font-bold text-fg mb-1.5"><Code>{`404 {"errors":"Not Found"}`}</Code> numa loja e token corretos</h3>
                    <ul className="space-y-1 text-sm text-fg-60 list-disc list-inside">
                        <li>Causa habitual: a versão da API no URL foi retirada (suporte ~12 meses). Não é a loja nem o token.</li>
                        <li>Trocar a versão (ex: <Code>/admin/api/2024-04/</Code> → <Code>/admin/api/{API_VERSION}/</Code>) no teste, no integrador e nos webhooks.</li>
                        <li>Confirmar também que o domínio é o .myshopify.com nativo da loja (não o domínio público).</li>
                    </ul>
                </div>
                <div>
                    <h3 className="text-sm font-bold text-fg mb-1.5"><Code>401 [API] Invalid API key or access token</Code></h3>
                    <ul className="space-y-1 text-sm text-fg-60 list-disc list-inside">
                        <li>Token revogado ou inválido: app desinstalada/reinstalada, credenciais rotacionadas, ou token de outra loja.</li>
                        <li>Re-emitir: repetir Partes B–C para um novo <Code>shpat_…</Code> e atualizar onde o token está guardado.</li>
                        <li>Um token bogus (formato irreconhecível) dá 404; um token reconhecido mas inválido dá 401 — usar isto para distinguir.</li>
                    </ul>
                </div>
                <div>
                    <h3 className="text-sm font-bold text-fg mb-1.5">Webhooks não disparam</h3>
                    <ul className="space-y-1 text-sm text-fg-60 list-disc list-inside">
                        <li>Confirmar que os 4 webhooks estão criados em Settings → Notifications → Webhooks.</li>
                        <li>Confirmar Format = JSON.</li>
                        <li>Confirmar URL exacto (sem espaços, sem trailing slash extra).</li>
                        <li>Webhook Signing Secret no integrador tem de bater com o &quot;Your webhooks will be signed with: ...&quot; do Shopify.</li>
                    </ul>
                </div>
            </Section>

            </Method>

            <Method
                eyebrow="Método 2"
                title="OAuth de volta ao Rioko, webhooks automáticos"
                subtitle="O redirect aponta para nós, por isso o code chega ao servidor: o token é trocado aqui e os 4 webhooks são criados pela Admin API na mesma ida. Só para lojas novas."
                accent="emerald"
            >
                <div className="flex flex-wrap gap-2 px-3 pt-2">
                    {TOC_M2.map((item) => (
                        <a
                            key={item.id}
                            href={`#${item.id}`}
                            className="text-[11px] font-bold uppercase tracking-wide px-3 py-1.5 rounded-full border border-hairline bg-surface-2 text-fg-60 hover:text-fg hover:border-accent/40 transition-colors"
                        >
                            {item.label}
                        </a>
                    ))}
                </div>

                <Section id="m2-app" icon={<Settings2 className="w-5 h-5" />} title="Criar App no Dev Dashboard" eyebrow="Parte A" accent="emerald">
                    <p className="text-sm text-fg-60">
                        A app é criada pelo cliente, no admin da loja dele. <strong className="text-fg">Não é preciso conta de Partner.</strong>
                    </p>
                    <ol className="space-y-2 text-sm text-fg-60 list-decimal list-inside">
                        <li>No admin da Shopify, clicar no <strong className="text-fg">nome da loja</strong> no canto superior direito, ícone <Code>{"</>"}</Code> → <strong className="text-fg">View Dev Dashboard</strong>.</li>
                        <li><strong className="text-fg">Create app</strong> (se pedir, <em>Allow custom app development</em>) → dar nome → <strong className="text-fg">Create app</strong>.</li>
                        <li>Abre o menu <strong className="text-fg">Create Version</strong>. Preencher com os valores da tabela abaixo e deixar tudo o resto como está.</li>
                    </ol>
                    <DataTable
                        headers={["Campo", "Valor"]}
                        rows={[
                            ["App name", <>Nome do cliente (ex: <Code>Rioko — NomeDoCliente</Code>)</>],
                            ["App URL", <><Code key="appurl">{RIOKO_CONFIG.appUrl}</Code> — não é usado pelo fluxo, mas a Shopify exige um URL vivo</>],
                            ["Embed app in Shopify admin", <strong key="embed" className="text-destructive">DESLIGADO</strong>],
                            ["Allowed redirection URL(s)", <Code key="redirect">{shopifyCallbackUri()}</Code>],
                            ["Scopes (Admin API)", <Code key="scopes">{SCOPES}</Code>],
                        ]}
                    />
                    <div>
                        <h3 className="text-sm font-bold text-fg mb-2">Lançar a versão e recolher as credenciais</h3>
                        <ol className="space-y-2 text-sm text-fg-60 list-decimal list-inside">
                            <li>Canto superior/inferior direito → <strong className="text-fg">Launch</strong>. Nome da versão <Code>V1</Code> → <strong className="text-fg">Launch</strong> outra vez.</li>
                            <li>
                                Separador <strong className="text-fg">Settings</strong> da app, copiar:
                                <ul className="list-disc list-inside mt-1 ml-1">
                                    <li><strong className="text-fg">Client ID</strong> (API key)</li>
                                    <li><strong className="text-fg">Client Secret</strong></li>
                                </ul>
                            </li>
                            <li>
                                Domínio nativo da loja: no dashboard normal da Shopify (não no Dev Dashboard) → <strong className="text-fg">Settings</strong> → <strong className="text-fg">Domains</strong> → o <Code>.myshopify.com</Code> (ex: <Code>quickstart-66f9e5ef.myshopify.com</Code>).
                            </li>
                        </ol>
                    </div>
                    <WarnBox>
                        Os scopes <Code>write_webhooks</Code> / <Code>read_webhooks</Code> <strong>não existem e não são precisos</strong>: criar uma subscrição exige só o scope do tópico, e o <Code>read_orders</Code> cobre os quatro.
                    </WarnBox>
                    <DangerBox>
                        <strong>Não instalar a app pelo botão da lista.</strong> A instalação faz-se pelo botão da Parte B, que é o que leva o <Code>state</Code> e traz o code de volta a nós.
                    </DangerBox>
                    <Output
                        label="Allowed redirection URL — colar exactamente assim"
                        text={shopifyCallbackUri()}
                        copied={copiedKey === "m2-redirect"}
                        onCopy={() => copy("m2-redirect", shopifyCallbackUri())}
                    />
                    <InfoBox>
                        Tem de ser <strong>byte a byte</strong> este valor, incluindo a ausência de barra final. A Shopify compara a string e recusa antes do ecrã de consentimento.
                        Depois de mexer em redirect URLs ou scopes: <strong>nova versão</strong> e <strong>Launch</strong>, senão a app continua a correr a versão antiga.
                    </InfoBox>
                </Section>

                <Section id="m2-install" icon={<KeyRound className="w-5 h-5" />} title="Instalar na loja" eyebrow="Parte B" accent="emerald">
                    <p className="text-sm text-fg-60">
                        Os três campos são partilhados com o Método 1: preencher num lado preenche o outro. O que acontece ao carregar no botão:
                    </p>
                    <ol className="space-y-1.5 text-sm text-fg-60 list-decimal list-inside">
                        <li>As credenciais ficam guardadas na conta escolhida, com um <Code>state</Code> válido 15 minutos.</li>
                        <li>Abre o ecrã de consentimento da Shopify. Quem carrega em <strong className="text-fg">Install</strong> tem de estar autenticado no admin <em>dessa</em> loja: pode ser o cliente, no browser dele.</li>
                        <li>A Shopify devolve o code a <Code>{shopifyCallbackUri()}</Code>. Sem página de erro, sem copiar nada da barra de endereço.</li>
                        <li>O servidor troca o code por token, grava-o, e cria os 4 webhooks. A tab onde o link foi aberto volta a esta página com o resultado.</li>
                    </ol>
                    <InfoBox>
                        Por isso o botão <strong>gera um link em vez de saltar logo</strong>: se for o cliente a instalar, copia-se o link e manda-se. A autorização vale à mesma, porque o que liga o code à conta é o <Code>state</Code> e não a sessão de quem carrega.
                    </InfoBox>

                    <DangerBox>
                        <strong>Nunca correr numa loja que já está a facturar pelo Método 1.</strong> Uma app só vê as subscrições da própria app, nunca as que foram criadas à mão,
                        por isso ligar isto por cima criaria um <strong>segundo</strong> conjunto: documentos a dobrar e alertas de assinatura em catadupa, exactamente o que aconteceu
                        a 21/05/2026 na Soul Krave e na Estrela Jewelry Studio e passou três meses sem ninguém notar. O servidor recusa com <Code>409</Code> qualquer conta que já
                        tenha webhook secret ou webhooks activos: para migrar, apagar primeiro os 4 manuais na loja e limpar a ligação.
                    </DangerBox>
                    <WarnBox>
                        A loja de testes <Code>quickstart-66f9e5ef.myshopify.com</Code> <strong>não valida este caminho</strong>: não tem aprovação de protected customer data
                        e usa token <Code>shpua_</Code>, por isso recusa a criação dos webhooks mesmo quando tudo está certo. Dá falso negativo.
                    </WarnBox>

                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-wider text-fg-40 mb-1.5">Conta Rioko de destino</label>
                        <select
                            value={targetUser}
                            onChange={(e) => setTargetUser(e.target.value)}
                            className="w-full rounded-xl bg-surface-2 border border-hairline px-3 py-2.5 text-sm text-fg focus:border-accent outline-none transition-colors"
                        >
                            <option value="">{accounts.length ? "Escolher conta…" : "A carregar contas…"}</option>
                            {accounts.map((a) => (
                                <option key={a.id} value={a.id}>
                                    {a.label}{a.domain ? ` · ${a.domain}` : ""}
                                </option>
                            ))}
                        </select>
                    </div>

                    <Field label="Domínio Shopify (.myshopify.com)" placeholder="quickstart-66f9e5ef.myshopify.com" value={shopDomain} onChange={(e) => setShopDomain(e.target.value)} />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <Field label="Client ID" placeholder="abc123def456..." value={clientId} onChange={(e) => setClientId(e.target.value)} />
                        <Field label="Client Secret" type="password" placeholder="••••••••" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
                    </div>

                    <button
                        type="button"
                        onClick={startMethod2}
                        disabled={busy || !targetUser || !shop || !clientId || !clientSecret}
                        className="inline-flex items-center gap-2 rounded-xl border border-accent-hot/40 bg-accent-hot/10 px-5 py-3 text-sm font-bold text-accent-hot hover:bg-accent-hot/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                        Guardar e gerar link de instalação
                    </button>

                    {startError && <DangerBox>{startError}</DangerBox>}

                    {installUrl && (
                        <div className="space-y-4">
                            <Output
                                label="Link de instalação — abrir ou enviar ao cliente"
                                text={installUrl}
                                copied={copiedKey === "m2-install-url"}
                                onCopy={() => copy("m2-install-url", installUrl)}
                            />
                            <button
                                type="button"
                                onClick={() => window.open(installUrl, "_blank", "noopener")}
                                className="inline-flex items-center gap-2 rounded-xl bg-accent text-on-accent px-4 py-2.5 text-[12px] font-bold uppercase tracking-wide hover:bg-accent/85 transition-all active:scale-95"
                            >
                                <ExternalLink className="w-4 h-4" /> Abrir em nova tab
                            </button>
                            <WarnBox>
                                Válido <strong>15 minutos</strong>. Passado esse tempo o link deixa de servir e há que carregar no botão outra vez.
                            </WarnBox>
                        </div>
                    )}

                    {outcome?.status === "connected" && (
                        <div className="bg-accent-hot/8 border border-accent-hot/30 rounded-2xl p-4 flex items-start gap-3">
                            <CheckCircle2 className="w-5 h-5 text-accent-hot shrink-0 mt-0.5" />
                            <div className="text-accent-hot text-sm leading-relaxed">
                                <strong>Ligado.</strong> Token guardado e os 4 webhooks estão criados. {outcome.detail}
                            </div>
                        </div>
                    )}
                    {outcome?.status === "partial" && (
                        <WarnBox>
                            <strong>Token guardado, webhooks incompletos.</strong> {outcome.detail}
                            <br />Repetir o Método 2 para a mesma conta cria só os que faltam.
                        </WarnBox>
                    )}
                    {(outcome?.status === "error" || outcome?.status === "denied") && (
                        <DangerBox>
                            <strong>{outcome.status === "denied" ? "Autorização recusada na loja." : "Falhou."}</strong> {outcome.detail}
                        </DangerBox>
                    )}
                </Section>

                <Section id="m2-done" icon={<Zap className="w-5 h-5" />} title="O que ficou feito sozinho" eyebrow="Parte C" accent="emerald">
                    <ul className="space-y-1.5 text-sm text-fg-60 list-disc list-inside">
                        <li><Code>shpat_…</Code> guardado na conta, sem ninguém colar nada.</li>
                        <li>Versão da API gravada como <Code>{API_VERSION}</Code>.</li>
                        <li>Os 4 webhooks criados e apontados a <Code>{WEBHOOK_BASE}</Code>:</li>
                    </ul>
                    <div className="rounded-2xl border border-hairline overflow-hidden">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="bg-surface-2">
                                    <th className="text-left px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-fg-40">Tópico</th>
                                    <th className="text-left px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-fg-40">URL</th>
                                </tr>
                            </thead>
                            <tbody>
                                {WEBHOOKS.map((wh) => (
                                    <tr key={wh.key} className="border-t border-hairline/60">
                                        <td className="px-4 py-3 align-top text-fg-60 whitespace-nowrap">
                                            <Code>{wh.note}</Code>
                                            <div className="text-[11px] text-fg-40 mt-1">{wh.pt}</div>
                                        </td>
                                        <td className="px-4 py-3 align-top text-fg-60"><Code>{`${WEBHOOK_BASE}/${wh.key}`}</Code></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <InfoBox>
                        Os <strong>Steps 1 e 2</strong> do integrador ficam feitos: não há token para colar nem webhooks para criar à mão, e o
                        <strong> Webhook Signing Secret da loja não é usado</strong>. Estes webhooks pertencem à app e são assinados com o client secret,
                        que é o que ficou guardado. O cliente entra no integrador já com os dois primeiros passos verdes.
                    </InfoBox>
                </Section>

                <Section id="m2-rioko" icon={<Settings2 className="w-5 h-5" />} title="Configurar o Integrador Rioko (2 passos)" eyebrow="Parte D" accent="emerald">
                    <p className="text-sm text-fg-60">
                        Abrir <a href="https://rioko.online/integrations/shopify-ix" target="_blank" rel="noopener noreferrer" className="text-accent-ink underline">rioko.online/integrations/shopify-ix</a> com a conta do cliente.
                        Os passos 1 e 2 já estão feitos pela Parte B; sobram estes.
                    </p>

                    <div>
                        <h3 className="text-sm font-bold text-fg mb-2">3 · Conexão InvoiceXpress</h3>
                        <DataTable
                            headers={["Campo", "Valor"]}
                            rows={[
                                ["Nome da Conta", <>Slug antes de <Code>.invoicexpress.com</Code> (ex: <Code>ultramegasonico</Code>)</>],
                                ["Chave API", "IX → Definições da Conta → Integrações / API"],
                                ["Ambiente", <><Code>production</Code> ou <Code>sandbox</Code></>],
                            ]}
                        />
                    </div>

                    <div>
                        <h3 className="text-sm font-bold text-fg mb-2">4 · Definições de Integração</h3>
                        <DataTable
                            headers={["Definição", "Descrição"]}
                            rows={[
                                ["IVA Incluído", "Toggle ON se preços Shopify já incluem IVA"],
                                ["Auto Finalizar", <>Recomendado <strong key="off" className="text-fg">DESLIGADO</strong> nas primeiras faturas</>],
                                ["Tipo de Fatura", <><Code>Fatura-Recibo</Code> (default) ou <Code>Fatura</Code></>],
                                ["Prazo Pagamento (dias)", "Apenas se Tipo = Fatura"],
                                ["Série de Faturação", <>Vazio = série pré-definida no IX (ou ex: <Code>WEB</Code>)</>],
                                ["Razão de Isenção (IVA 0%)", <>Default <Code>M01</Code> — códigos M01 a M99 disponíveis</>],
                            ]}
                        />
                    </div>
                </Section>

                <Section id="m2-verify" icon={<CheckCircle2 className="w-5 h-5" />} title="Verificação Final" eyebrow="Parte E" accent="emerald">
                    <ul className="space-y-1.5 text-sm text-fg-60 list-disc list-inside">
                        <li>Badge <strong className="text-fg">Autorizado</strong> nos três cartões: Shopify, Webhooks e InvoiceXpress.</li>
                        <li>
                            O cartão Webhooks tem de ficar verde <strong className="text-fg">sozinho</strong>, sem ninguém carregar em &quot;Confirmar Instalação Manual&quot;
                            nem forçar a flag. É a diferença que prova que os webhooks são da app: a validação lê <Code>webhooks.json</Code>, onde os manuais nunca aparecem
                            e estes aparecem.
                        </li>
                        <li>
                            Encomenda de teste paga na loja → aparece nos Logs, no Invoices Hub, e no InvoiceXpress do cliente.
                            É isto que prova que o HMAC bate com o client secret.
                        </li>
                    </ul>
                </Section>

                <Section id="m2-trouble" icon={<LifeBuoy className="w-5 h-5" />} title="Troubleshooting" eyebrow="Parte F" accent="amber">
                    <div>
                        <h3 className="text-sm font-bold text-fg mb-1.5"><Code>409</Code> ao gerar o link</h3>
                        <p className="text-sm text-fg-60">
                            A conta já tem webhook secret ou webhooks activos, ou seja está a facturar pelo Método 1. É recusa deliberada, não avaria. Ver o aviso na Parte B.
                        </p>
                    </div>
                    <div>
                        <h3 className="text-sm font-bold text-fg mb-1.5">Ecrã de consentimento recusa antes de aparecer</h3>
                        <ul className="space-y-1 text-sm text-fg-60 list-disc list-inside">
                            <li>O redirect na app não é byte a byte <Code>{shopifyCallbackUri()}</Code>.</li>
                            <li>Mexeu-se em redirect URLs ou scopes e não se lançou nova versão: a app continua a correr a antiga.</li>
                            <li><strong className="text-fg">Embed app in Shopify admin</strong> ligado consome o code. Desligar.</li>
                        </ul>
                    </div>
                    <div>
                        <h3 className="text-sm font-bold text-fg mb-1.5">Volta com <Code>Pedido expirado</Code> ou <Code>Pedido desconhecido</Code></h3>
                        <p className="text-sm text-fg-60">O link vale 15 minutos e o <Code>state</Code> é de uso único. Gerar outro na Parte B.</p>
                    </div>
                    <div>
                        <h3 className="text-sm font-bold text-fg mb-1.5">Volta com <Code>Assinatura inválida no regresso</Code></h3>
                        <p className="text-sm text-fg-60">O Client Secret colado não é o da app que está a autorizar. Reconfirmar em Settings da app.</p>
                    </div>
                    <div>
                        <h3 className="text-sm font-bold text-fg mb-1.5">Token guardado mas webhooks incompletos</h3>
                        <p className="text-sm text-fg-60">
                            Repetir a Parte B para a mesma conta: a criação lê primeiro o que já existe e só cria o que falta, por isso repetir nunca duplica.
                            Se falharem sempre os quatro com <em>not approved to subscribe to webhook topics containing protected customer data</em>, a app não tem a aprovação.
                        </p>
                    </div>
                </Section>
            </Method>

            <p className="text-center text-[11px] text-fg-40 font-bold uppercase tracking-widest pb-4">
                Rioko 2.0 Engine — Onboarding interno · API {API_VERSION}
            </p>
        </div>
    );
}
