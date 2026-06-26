"use client";

import { useMemo, useState } from "react";
import { Link } from "@/i18n/navigation";
import {
    ArrowLeft, Wrench, ShieldAlert, AlertTriangle, Info,
    KeyRound, Link2, Settings2, CheckCircle2, LifeBuoy,
    Copy, Check, ExternalLink,
} from "lucide-react";

const SCOPES = "read_customers,read_discounts,read_order_edits,read_orders,read_all_orders,read_products";
// Versão da API REST usada nos testes. Manter numa versão SUPORTADA (rever anualmente) —
// versões retiradas devolvem 404 {"errors":"Not Found"} mesmo com token válido.
const API_VERSION = "2026-04";

const WEBHOOK_BASE = "https://shopify-invoicexpress-worker.pedrotovarporto.workers.dev/webhooks/shopify";

function cleanShop(raw: string) {
    if (!raw) return "";
    return raw
        .trim()
        .replace(/^https?:\/\//i, "")
        .replace(/\/admin.*$/i, "")
        .replace(/\/+$/, "");
}

// ─── Shared building blocks ────────────────────────────────────────────────

type Accent = "sky" | "emerald" | "amber" | "rose";

const ACCENT_TEXT: Record<Accent, string> = {
    sky: "text-accent",
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
                    <h2 className="text-2xl font-black text-white">{title}</h2>
                </div>
            </div>
            <div className="ml-0 sm:ml-16 space-y-5">{children}</div>
        </section>
    );
}

function InfoBox({ children }: { children: React.ReactNode }) {
    return (
        <div className="bg-[rgba(2,141,196,0.05)] border border-[rgba(2,141,196,0.20)] rounded-2xl p-4 flex items-start gap-3">
            <Info className="w-5 h-5 text-accent shrink-0 mt-0.5" />
            <div className="text-accent text-sm leading-relaxed">{children}</div>
        </div>
    );
}

function WarnBox({ children }: { children: React.ReactNode }) {
    return (
        <div className="bg-[rgba(245,158,11,0.05)] border border-[rgba(245,158,11,0.20)] rounded-2xl p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-soon shrink-0 mt-0.5" />
            <div className="text-soon text-sm leading-relaxed">{children}</div>
        </div>
    );
}

function DangerBox({ children }: { children: React.ReactNode }) {
    return (
        <div className="bg-[rgba(244,63,94,0.05)] border border-[rgba(244,63,94,0.20)] rounded-2xl p-4 flex items-start gap-3">
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
                    ? "border-[rgba(94,234,212,0.40)] text-accent-hot bg-[rgba(94,234,212,0.08)]"
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

const WEBHOOKS = [
    { event: "Order creation", note: "orders/create", key: "orders-created" },
    { event: "Order edit", note: "orders/updated", key: "orders-updated" },
    { event: "Order payment", note: "orders/paid", key: "orders-paid" },
    { event: "Refund create", note: "refunds/create", key: "refunds-create" },
];

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

                <div className="flex flex-wrap gap-2 pt-2">
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
            </div>

            {/* Parte A */}
            <Section id="parte-a" icon={<Settings2 className="w-5 h-5" />} title="Criar App no Shopify Dev Dashboard" eyebrow="Parte A" accent="sky">
                <p className="text-sm text-fg-60">
                    Aceder a <a href="https://partners.shopify.com/" target="_blank" rel="noopener noreferrer" className="text-accent underline">partners.shopify.com</a> → <strong>Apps</strong> → <strong>Create app</strong> → manualmente.
                </p>
                <DataTable
                    headers={["Campo", "Valor"]}
                    rows={[
                        ["App name", <>Nome do cliente (ex: <Code>Rioko — NomeDoCliente</Code>)</>],
                        ["App URL", <>Link da empresa no Konnector (ex: <Code>https://kapta-teste.konnector.pt/</Code>)</>],
                        ["Embed app in Shopify admin", <strong key="embed" className="text-destructive">DESLIGADO</strong>],
                        ["Allowed redirection URL(s)", <Code key="redirect">https://example.com/</Code>],
                        ["Scopes (Admin API)", <Code key="scopes">{SCOPES}</Code>],
                    ]}
                />
                <WarnBox>
                    Os scopes <Code>write_webhooks</Code> / <Code>read_webhooks</Code> <strong>não são pedidos</strong> — webhooks serão criados manualmente no Passo 2 do integrador.
                </WarnBox>
                <div>
                    <h3 className="text-sm font-bold text-white mb-2">Versão e Release</h3>
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
                        className="inline-flex items-center gap-2 rounded-xl bg-accent text-white px-4 py-2.5 text-[12px] font-bold uppercase tracking-wide hover:bg-accent/85 transition-all active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed"
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
                    <h3 className="text-sm font-bold text-white mb-2">Verificar token (recomendado)</h3>
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
                    Abrir <a href="https://rioko.online/integrations/shopify-ix" target="_blank" rel="noopener noreferrer" className="text-accent underline">rioko.online/integrations/shopify-ix</a> com a conta do cliente.
                </p>

                <div>
                    <h3 className="text-sm font-bold text-white mb-2">1 · Ligação Shopify</h3>
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
                    <h3 className="text-sm font-bold text-white mb-2">2 · Webhooks (instalação manual)</h3>
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
                    <p className="text-xs text-fg-40">Clicar <strong className="text-fg-60">Confirmar Instalação Manual</strong> (não usar &quot;Instalar Webhooks&quot; — o token não tem <Code>write_webhooks</Code>).</p>
                </div>

                <div>
                    <h3 className="text-sm font-bold text-white mb-2">3 · Conexão InvoiceXpress</h3>
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
                    <h3 className="text-sm font-bold text-white mb-2">4 · Definições de Integração</h3>
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
                    <h3 className="text-sm font-bold text-white mb-2">Checklist resumido</h3>
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
                    <h3 className="text-sm font-bold text-white mb-1.5">Sem code no redirect</h3>
                    <ul className="space-y-1 text-sm text-fg-60 list-disc list-inside">
                        <li>Redirect URI aponta para servidor que força login → usar <Code>https://example.com/</Code>.</li>
                        <li><strong className="text-fg">Embed app in Shopify admin</strong> activo consome o code → desligar.</li>
                        <li>Redirect URI tem de ser exactamente o que está em Allowed redirection URL(s), incluindo barra final.</li>
                    </ul>
                </div>
                <div>
                    <h3 className="text-sm font-bold text-white mb-1.5">Erro ao trocar code por token</h3>
                    <ul className="space-y-1 text-sm text-fg-60 list-disc list-inside">
                        <li><Code>code expirado</Code> → repetir Parte B para obter novo.</li>
                        <li><Code>code já usado</Code> → cada code só pode ser trocado uma vez.</li>
                        <li>Verificar que client_id, client_secret e shop correspondem à mesma app/loja.</li>
                    </ul>
                </div>
                <div>
                    <h3 className="text-sm font-bold text-white mb-1.5">Token parece inválido no integrador, mas funciona no curl</h3>
                    <ul className="space-y-1 text-sm text-fg-60 list-disc list-inside">
                        <li>Header tem de ser <Code>X-Shopify-Access-Token</Code> (Admin API).</li>
                        <li>Host tem de ser <Code>{"{shop}"}.myshopify.com</Code>.</li>
                        <li>Validar por request real e HTTP 200, não por prefixo do token.</li>
                    </ul>
                </div>
                <div>
                    <h3 className="text-sm font-bold text-white mb-1.5"><Code>{`404 {"errors":"Not Found"}`}</Code> numa loja e token corretos</h3>
                    <ul className="space-y-1 text-sm text-fg-60 list-disc list-inside">
                        <li>Causa habitual: a versão da API no URL foi retirada (suporte ~12 meses). Não é a loja nem o token.</li>
                        <li>Trocar a versão (ex: <Code>/admin/api/2024-04/</Code> → <Code>/admin/api/{API_VERSION}/</Code>) no teste, no integrador e nos webhooks.</li>
                        <li>Confirmar também que o domínio é o .myshopify.com nativo da loja (não o domínio público).</li>
                    </ul>
                </div>
                <div>
                    <h3 className="text-sm font-bold text-white mb-1.5"><Code>401 [API] Invalid API key or access token</Code></h3>
                    <ul className="space-y-1 text-sm text-fg-60 list-disc list-inside">
                        <li>Token revogado ou inválido: app desinstalada/reinstalada, credenciais rotacionadas, ou token de outra loja.</li>
                        <li>Re-emitir: repetir Partes B–C para um novo <Code>shpat_…</Code> e atualizar onde o token está guardado.</li>
                        <li>Um token bogus (formato irreconhecível) dá 404; um token reconhecido mas inválido dá 401 — usar isto para distinguir.</li>
                    </ul>
                </div>
                <div>
                    <h3 className="text-sm font-bold text-white mb-1.5">Webhooks não disparam</h3>
                    <ul className="space-y-1 text-sm text-fg-60 list-disc list-inside">
                        <li>Confirmar que os 4 webhooks estão criados em Settings → Notifications → Webhooks.</li>
                        <li>Confirmar Format = JSON.</li>
                        <li>Confirmar URL exacto (sem espaços, sem trailing slash extra).</li>
                        <li>Webhook Signing Secret no integrador tem de bater com o &quot;Your webhooks will be signed with: ...&quot; do Shopify.</li>
                    </ul>
                </div>
            </Section>

            <p className="text-center text-[11px] text-fg-40 font-bold uppercase tracking-widest pb-4">
                Rioko 2.0 Engine — Onboarding interno · API {API_VERSION}
            </p>
        </div>
    );
}
