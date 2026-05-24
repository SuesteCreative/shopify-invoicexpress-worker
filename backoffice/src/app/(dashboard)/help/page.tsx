"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
    ArrowLeft, Mail, BookOpen, Store, Key, Webhook, Globe, FileText,
    Percent, Zap, Tag, Info, X, Search, Settings2, Copy, CreditCard,
    ClipboardList, ChevronDown, Calendar
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export const runtime = "edge";

// ─── Shared building blocks ───────────────────────────────────────────────

function Section({ id, icon, title, step, children, accent = "rose" }: {
    id: string;
    icon: React.ReactNode;
    title: string;
    step?: string;
    children: React.ReactNode;
    accent?: "rose" | "sky" | "violet" | "emerald" | "amber";
}) {
    const accentText = {
        rose: "text-rose-500", sky: "text-sky-400", violet: "text-violet-400",
        emerald: "text-emerald-400", amber: "text-amber-400",
    }[accent];
    return (
        <section id={id} className="scroll-mt-28">
            <div className="flex items-start gap-4 mb-6">
                <div className={`w-12 h-12 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center shrink-0 ${accentText}`}>
                    {icon}
                </div>
                <div>
                    {step && (
                        <div className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-1">{step}</div>
                    )}
                    <h2 className="text-2xl font-black text-white">{title}</h2>
                </div>
            </div>
            <div className="ml-16 space-y-6">{children}</div>
        </section>
    );
}

function Steps({ items, accent = "rose" }: { items: string[]; accent?: "rose" | "sky" | "violet" | "emerald" | "amber" }) {
    const pill = {
        rose: "bg-rose-500/10 border-rose-500/20 text-rose-400",
        sky: "bg-sky-500/10 border-sky-500/20 text-sky-400",
        violet: "bg-violet-500/10 border-violet-500/20 text-violet-400",
        emerald: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
        amber: "bg-amber-500/10 border-amber-500/20 text-amber-400",
    }[accent];
    return (
        <ol className="space-y-3">
            {items.map((item, i) => (
                <li key={i} className="flex items-start gap-3">
                    <span className={`w-6 h-6 rounded-full border text-[10px] font-black flex items-center justify-center shrink-0 mt-0.5 ${pill}`}>
                        {i + 1}
                    </span>
                    <span className="text-slate-300 text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: item }} />
                </li>
            ))}
        </ol>
    );
}

function Placeholder({ src, alt, description, onZoom }: { src: string; alt: string; description: string; onZoom: (src: string) => void }) {
    return (
        <div className="rounded-2xl overflow-hidden border border-slate-800/60 bg-slate-900/40 cursor-zoom-in group relative" onClick={() => onZoom(src)}>
            <div className="relative w-full aspect-video bg-slate-950 transition-transform duration-500 group-hover:scale-[1.02]">
                <Image src={src} alt={alt} fill className="object-contain p-4" />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <div className="bg-white/10 backdrop-blur-md p-3 rounded-2xl border border-white/20">
                        <Search className="w-6 h-6 text-white" />
                    </div>
                </div>
                <div className="absolute bottom-3 left-3 right-3 bg-black/70 backdrop-blur-sm rounded-xl px-3 py-2 flex items-center gap-2">
                    <span className="text-amber-400 text-[10px] font-black uppercase tracking-widest">Visualização</span>
                    <span className="text-[11px] text-slate-300 font-medium truncate">{description}</span>
                </div>
            </div>
        </div>
    );
}

function InfoBox({ children }: { children: React.ReactNode }) {
    return (
        <div className="bg-sky-500/5 border border-sky-500/20 rounded-2xl p-4 flex items-start gap-3">
            <Info className="w-5 h-5 text-sky-400 shrink-0 mt-0.5" />
            <p className="text-sky-300 text-sm leading-relaxed">{children}</p>
        </div>
    );
}

function WarningBox({ children }: { children: React.ReactNode }) {
    return (
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-4">
            <p className="text-amber-300 text-sm leading-relaxed">{children}</p>
        </div>
    );
}

// ─── Contact + Calendly box for steps Kapta runs for you ──────────────────
function ContactBox({ subject = "Rioko - Suporte" }: { subject?: string }) {
    const mail = `mailto:pedro@kapta.pt?subject=${encodeURIComponent(subject)}`;
    return (
        <div className="bg-rose-500/5 border border-rose-500/20 rounded-2xl p-6 flex flex-col gap-4">
            <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center shrink-0">
                    <Mail className="w-5 h-5 text-rose-400" />
                </div>
                <div className="flex-1">
                    <p className="text-white font-bold text-sm">Este passo é feito pela Kapta</p>
                    <p className="text-slate-400 text-sm mt-1">
                        O Access Token da Shopify é gerado e instalado pela equipa técnica da Kapta durante a configuração inicial.
                        Não partilhes este token com ninguém além da Kapta.
                    </p>
                </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-2 sm:ml-16">
                <a
                    href="https://calendly.com/pedro-kapta/apoio-kapta"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 bg-sky-500 text-white px-5 py-3 rounded-2xl font-black text-[11px] uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-sky-400 transition-all active:scale-95"
                >
                    <Calendar className="w-4 h-4" /> Agendar Reunião
                </a>
                <a
                    href={mail}
                    className="flex-1 bg-rose-500 text-white px-5 py-3 rounded-2xl font-black text-[11px] uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-rose-400 transition-all active:scale-95"
                >
                    <Mail className="w-4 h-4" /> pedro@kapta.pt
                </a>
            </div>
        </div>
    );
}

// ─── Platform tabs ────────────────────────────────────────────────────────

type Platform = "shopify" | "stripe" | "invoicexpress" | "moloni";

const PLATFORMS: { id: Platform; label: string; sub: string; icon: React.ComponentType<any>; accent: "emerald" | "violet" | "sky" | "amber" }[] = [
    { id: "shopify", label: "Shopify", sub: "Fonte de encomendas", icon: Store, accent: "emerald" },
    { id: "stripe", label: "Stripe", sub: "Fonte de pagamentos", icon: CreditCard, accent: "violet" },
    { id: "invoicexpress", label: "InvoiceXpress", sub: "Faturação", icon: FileText, accent: "sky" },
    { id: "moloni", label: "Moloni", sub: "Faturação", icon: ClipboardList, accent: "amber" },
];

function PlatformTabs({ tab, onChange }: { tab: Platform; onChange: (p: Platform) => void }) {
    return (
        <div className="glass rounded-[2rem] p-3 border-slate-800/40">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                {PLATFORMS.map(p => {
                    const Icon = p.icon;
                    const active = tab === p.id;
                    const accentText = {
                        emerald: "text-emerald-400 border-emerald-500/40 bg-emerald-500/10",
                        violet: "text-violet-400 border-violet-500/40 bg-violet-500/10",
                        sky: "text-sky-400 border-sky-500/40 bg-sky-500/10",
                        amber: "text-amber-400 border-amber-500/40 bg-amber-500/10",
                    }[p.accent];
                    return (
                        <button
                            key={p.id}
                            onClick={() => onChange(p.id)}
                            className={`relative flex items-center gap-3 px-4 py-3 rounded-2xl border transition-all text-left group ${active ? accentText : "border-slate-800/60 bg-slate-900/40 text-slate-400 hover:border-slate-700 hover:text-white"}`}
                        >
                            <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${active ? "bg-white/5" : "bg-slate-900"}`}>
                                <Icon className="w-4 h-4" />
                            </div>
                            <div className="min-w-0">
                                <div className="text-sm font-black tracking-tight">{p.label}</div>
                                <div className={`text-[9px] uppercase tracking-widest font-bold ${active ? "opacity-80" : "text-slate-600"}`}>{p.sub}</div>
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

// ─── Per-platform guides ──────────────────────────────────────────────────

function ShopifyGuide({ onZoom }: { onZoom: (src: string) => void }) {
    return (
        <div className="space-y-6">
            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="shopify-domain" icon={<Store className="w-5 h-5" />} title="Domínio da Loja Shopify" step="Credencial 1 de 3" accent="emerald">
                    <InfoBox>
                        O domínio da loja é o endereço único atribuído pela Shopify quando registaste a tua conta. Tem sempre o formato <strong>nome-da-loja.myshopify.com</strong>.
                    </InfoBox>
                    <Steps accent="emerald" items={[
                        'Acede ao painel da loja em <code class="bg-slate-800 text-emerald-300 px-1.5 py-0.5 rounded text-xs">admin.shopify.com</code>.',
                        'Abre <strong>Definições</strong> e selecciona <strong>Domínios</strong>.',
                        'Identifica o domínio terminado em <strong>.myshopify.com</strong>.',
                        'Copia o valor (sem o prefixo <code class="bg-slate-800 text-emerald-300 px-1.5 py-0.5 rounded text-xs">https://</code>) e cola-o no campo Domínio do Rioko.',
                    ]} />
                    <Placeholder src="/images/help/shopify-domain.webp" alt="Shopify - Domínio" description="Shopify Admin → Definições → Domínios" onZoom={onZoom} />
                    <WarningBox>
                        ⚠️ Mesmo que tenhas um domínio personalizado (ex: www.minha-loja.pt), usa sempre o <strong>.myshopify.com</strong> aqui. A API da Shopify rejeita o domínio personalizado.
                    </WarningBox>
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="shopify-token" icon={<Key className="w-5 h-5" />} title="Access Token" step="Credencial 2 de 3" accent="emerald">
                    <InfoBox>
                        O Access Token é a chave que permite ao Rioko ler encomendas e instalar webhooks na tua loja. Por segurança, é gerado e instalado pela Kapta — nunca apareces a copiar este valor.
                    </InfoBox>
                    <ContactBox subject="Rioko - Access Token Shopify" />
                    <WarningBox>
                        🔐 Se o token for partilhado por engano, revoga-o de imediato em <strong>Shopify Admin → Apps → Develop apps</strong> e contacta-nos para gerar um novo.
                    </WarningBox>
                    <InfoBox>
                        <strong>Encomendas com mais de 60 dias</strong> — Por defeito, a Admin API só devolve encomendas recentes. Para reemitir faturas antigas em massa, o token tem de incluir o scope <code className="bg-slate-800 px-1 rounded">read_all_orders</code>. Se vires <em>"Order #XXXX not found"</em> para uma encomenda antiga, pede-nos para regenerar o token com esse scope.
                    </InfoBox>
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="shopify-webhook" icon={<Webhook className="w-5 h-5" />} title="Webhook Signing Secret" step="Credencial 3 de 3" accent="emerald">
                    <InfoBox>
                        Chave usada pela Shopify para assinar cada webhook que envia ao Rioko. Permite-nos confirmar que cada notificação veio mesmo da tua loja e não de um terceiro.
                    </InfoBox>
                    <Steps accent="emerald" items={[
                        'Vai a <strong>Definições → Notificações</strong>.',
                        'Desce até à secção <strong>"Webhooks"</strong>.',
                        'Vais ver a frase <em>"Os seus webhooks serão assinados com:"</em> seguida de uma chave.',
                        'Copia essa chave e cola no campo <strong>Webhook Signing Secret</strong> do Rioko.',
                    ]} />
                    <Placeholder src="/images/help/webhook-secret.webp" alt="Shopify - Webhook Signing Secret" description="Shopify Admin → Definições → Notificações → Webhooks" onZoom={onZoom} />
                    <InfoBox>
                        O Rioko instala automaticamente os webhooks <code className="bg-slate-800 px-1 rounded">orders/paid</code>, <code className="bg-slate-800 px-1 rounded">refunds/create</code> e <code className="bg-slate-800 px-1 rounded">orders/updated</code> quando carregas em "Ativar". Se o token não tiver permissão de webhooks, o Rioko mostra um botão para instalar manualmente.
                    </InfoBox>
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="shopify-api-version" icon={<Globe className="w-5 h-5" />} title="Versão da API" step="Avançado (opcional)" accent="emerald">
                    <InfoBox>
                        O campo "Versão da API" controla qual o release da Admin API a usar. O Rioko preenche por defeito com a versão mais recente (<strong>2026-01</strong>). Só deves alterar se a Kapta te indicar.
                    </InfoBox>
                </Section>
            </div>
        </div>
    );
}

function StripeGuide({ onZoom }: { onZoom: (src: string) => void }) {
    return (
        <div className="space-y-6">
            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="stripe-account-id" icon={<CreditCard className="w-5 h-5" />} title="Stripe Account ID" step="Credencial 1 de 3" accent="violet">
                    <InfoBox>
                        O Account ID identifica a tua conta Stripe (formato <code className="bg-slate-800 px-1 rounded">acct_XXXXXXXXXXXX</code>). O Rioko usa-o para garantir que cada webhook recebido pertence à tua conta.
                    </InfoBox>
                    <Steps accent="violet" items={[
                        'Inicia sessão em <code class="bg-slate-800 text-violet-300 px-1.5 py-0.5 rounded text-xs">dashboard.stripe.com</code>.',
                        'No canto superior esquerdo, abre o seletor de conta (mostra o nome da empresa).',
                        'O Account ID aparece por baixo do nome, começando por <code class="bg-slate-800 text-violet-300 px-1.5 py-0.5 rounded text-xs">acct_</code>.',
                        'Carrega no ícone de copiar e cola-o no campo Account ID do Rioko.',
                    ]} />
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="stripe-restricted-key" icon={<Key className="w-5 h-5" />} title="Restricted Key" step="Credencial 2 de 3" accent="violet">
                    <InfoBox>
                        Usamos uma <strong>Restricted Key</strong> em vez da secret key. Só lê o que o Rioko precisa para emitir faturas — nunca pode fazer pagamentos nem refunds em teu nome.
                    </InfoBox>
                    <Steps accent="violet" items={[
                        'No dashboard Stripe, abre <strong>Developers → API keys</strong>.',
                        'Carrega em <strong>"Create restricted key"</strong>.',
                        'Dá-lhe o nome <code class="bg-slate-800 text-violet-300 px-1.5 py-0.5 rounded text-xs">Rioko</code>.',
                        'Concede <strong>Read</strong> a: <em>Charges, PaymentIntents, Customers, Tax IDs, Balance transactions, Refunds</em>.',
                        'Deixa todos os outros recursos como <strong>None</strong>.',
                        'Carrega em <strong>"Create key"</strong>, copia o valor que começa por <code class="bg-slate-800 text-violet-300 px-1.5 py-0.5 rounded text-xs">rk_live_</code> (ou <code class="bg-slate-800 text-violet-300 px-1.5 py-0.5 rounded text-xs">rk_test_</code> em ambiente de testes) e cola no Rioko.',
                    ]} />
                    <WarningBox>
                        🔐 A chave é mostrada uma única vez. Se a perderes, cria uma nova e revoga a anterior em <em>Developers → API keys → Revoke</em>.
                    </WarningBox>
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="stripe-webhook" icon={<Webhook className="w-5 h-5" />} title="Webhook + Signing Secret" step="Credencial 3 de 3" accent="violet">
                    <InfoBox>
                        O Rioko reage a cada pagamento recebido na Stripe. Para isso, precisas de adicionar um endpoint na Stripe que aponta para o Rioko e copiar o <em>signing secret</em> que a Stripe te dá.
                    </InfoBox>
                    <Steps accent="violet" items={[
                        'Em <strong>Developers → Webhooks</strong>, carrega em <strong>"Add endpoint"</strong>.',
                        '<strong>URL</strong>: <div class="mt-2 flex items-center gap-2"><code class="bg-slate-800 text-violet-300 px-1.5 py-1 rounded text-[10px] break-all flex-1">https://shopify-invoicexpress-worker.pedrotovarporto.workers.dev/webhooks/stripe</code></div>',
                        '<strong>Events</strong>: selecciona <code class="bg-slate-800 text-violet-300 px-1.5 py-0.5 rounded text-xs">payment_intent.succeeded</code>, <code class="bg-slate-800 text-violet-300 px-1.5 py-0.5 rounded text-xs">charge.succeeded</code> e <code class="bg-slate-800 text-violet-300 px-1.5 py-0.5 rounded text-xs">charge.refunded</code>.',
                        'Confirma criação. Na página do endpoint, carrega em <strong>"Reveal"</strong> sobre o <strong>Signing secret</strong>.',
                        'Copia o valor que começa por <code class="bg-slate-800 text-violet-300 px-1.5 py-0.5 rounded text-xs">whsec_</code> e cola no campo Webhook Secret do Rioko.',
                    ]} />
                    <WarningBox>
                        ⚠️ A integração Stripe → Faturação está em fase de pré-lançamento. Se ainda não vires o ecrã de configuração no teu dashboard, contacta-nos para activar o flag.
                    </WarningBox>
                </Section>
            </div>
        </div>
    );
}

function InvoiceXpressGuide({ onZoom }: { onZoom: (src: string) => void }) {
    return (
        <div className="space-y-6">
            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="ix-account" icon={<FileText className="w-5 h-5" />} title="Nome da Conta" step="Credencial 1 de 2" accent="sky">
                    <InfoBox>
                        O nome da conta InvoiceXpress é o subdomínio da tua conta (ex: <code className="bg-slate-800 px-1 rounded">nome-da-empresa</code> em <code className="bg-slate-800 px-1 rounded">nome-da-empresa.app.invoicexpress.com</code>).
                    </InfoBox>
                    <Steps accent="sky" items={[
                        'Entra no Dashboard do InvoiceXpress.',
                        'No canto superior direito, abre o menu da tua conta.',
                        'Selecciona <strong>"Preferências de Conta"</strong>.',
                        'No menu lateral, escolhe <strong>"API"</strong>.',
                        'Se nunca activaste a API, carrega em <strong>"Ativar"</strong>.',
                        'O nome da conta aparece no primeiro campo. Copia e cola no Rioko.',
                    ]} />
                    <Placeholder src="/images/help/ix-account.webp" alt="InvoiceXpress - Nome da conta" description="InvoiceXpress → Preferências → API" onZoom={onZoom} />
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="ix-api-key" icon={<Key className="w-5 h-5" />} title="Chave API" step="Credencial 2 de 2" accent="sky">
                    <InfoBox>
                        A Chave API autentica o Rioko quando criamos faturas e recibos em teu nome. É a única credencial sensível desta integração.
                    </InfoBox>
                    <Steps accent="sky" items={[
                        'No mesmo ecrã <strong>Preferências de Conta → API</strong>, copia o valor do campo <strong>Chave API</strong> (segundo campo).',
                        'Cola no campo correspondente no Rioko.',
                    ]} />
                    <Placeholder src="/images/help/ix-api-key.webp" alt="InvoiceXpress - Chave API" description="InvoiceXpress → Preferências → API → Chave API" onZoom={onZoom} />
                    <WarningBox>
                        🔐 A Chave API permite criar, finalizar e cancelar documentos na tua conta. Não a partilhes com mais ninguém além da Kapta.
                    </WarningBox>
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="ix-environment" icon={<Globe className="w-5 h-5" />} title="Ambiente — Produção vs Sandbox" accent="sky">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-2xl p-5">
                            <div className="text-emerald-400 font-black text-sm mb-2">✅ Produção</div>
                            <p className="text-slate-400 text-sm">Faturas reais, com valor fiscal e comunicadas à AT. Usa quando a loja já está ao vivo.</p>
                        </div>
                        <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-5">
                            <div className="text-amber-400 font-black text-sm mb-2">🧪 Sandbox</div>
                            <p className="text-slate-400 text-sm">Ambiente de testes, sem valor fiscal. Apenas para validação técnica antes do go-live.</p>
                        </div>
                    </div>
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="ix-doc-type" icon={<FileText className="w-5 h-5" />} title="Tipo de Documento" accent="sky">
                    <InfoBox>
                        Escolhe se o Rioko deve emitir <strong>Faturas-Recibo</strong> (recomendado para e-commerce — venda e pagamento no mesmo momento) ou <strong>Faturas</strong> simples (venda agora, pagamento depois — útil para B2B com prazo).
                    </InfoBox>
                    <WarningBox>
                        ⚠️ Se escolheres apenas <strong>Fatura</strong>, o documento fica em aberto até emitires o <strong>Recibo</strong> manualmente quando o cliente pagar.
                    </WarningBox>
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="ix-sequence" icon={<Settings2 className="w-5 h-5" />} title="Série de Faturação" accent="sky">
                    <InfoBox>
                        As séries permitem separar documentos em "pastas" numeradas (ex: Série WEB, Série Loja Física). Se deixares em branco, o Rioko usa a série Pré-definida da tua conta.
                    </InfoBox>
                    <Steps accent="sky" items={[
                        'Em <strong>InvoiceXpress → Definições → Comunicação com o Estado → Séries de Faturação / ATCUD</strong>, identifica a série a usar.',
                        'Escreve o nome exacto da série no Rioko (case-sensitive).',
                        'Se o nome estiver incorrecto, o Rioko emite na <strong>Pré-definida</strong> para evitar falhar.',
                    ]} />
                </Section>
            </div>
        </div>
    );
}

function MoloniGuide({ onZoom }: { onZoom: (src: string) => void }) {
    return (
        <div className="space-y-6">
            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="moloni-dev-account" icon={<Key className="w-5 h-5" />} title="Conta de Programador" step="Credencial 1 de 3" accent="amber">
                    <InfoBox>
                        A Moloni só permite acesso à API através de uma conta de programador (developer account). É gratuita e leva 2 minutos a criar.
                    </InfoBox>
                    <Steps accent="amber" items={[
                        'Acede a <code class="bg-slate-800 text-amber-300 px-1.5 py-0.5 rounded text-xs">www.moloni.pt/dev</code>.',
                        'Carrega em <strong>"Registar"</strong> e usa um email diferente do da conta principal (recomendado).',
                        'Confirma o email e inicia sessão no painel de programador.',
                    ]} />
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="moloni-app" icon={<Settings2 className="w-5 h-5" />} title="Criar Aplicação" step="Credencial 2 de 3" accent="amber">
                    <InfoBox>
                        Cada integração precisa de uma "aplicação" associada à tua conta. A Moloni dá-te um <strong>Client ID</strong> e um <strong>Client Secret</strong> que o Rioko usa para autenticar.
                    </InfoBox>
                    <Steps accent="amber" items={[
                        'No painel de programador, abre <strong>"As minhas aplicações"</strong>.',
                        'Carrega em <strong>"Adicionar aplicação"</strong>.',
                        '<strong>Nome</strong>: <code class="bg-slate-800 text-amber-300 px-1.5 py-0.5 rounded text-xs">Rioko</code>.',
                        '<strong>Descrição</strong>: <em>Automatização de faturação a partir de Shopify / Stripe</em>.',
                        'Guarda. Vais ver o <strong>Client ID</strong> e o <strong>Client Secret</strong> no detalhe da aplicação.',
                        'Copia ambos os valores para o Rioko (campos <em>Moloni Client ID</em> e <em>Moloni Client Secret</em>).',
                    ]} />
                    <WarningBox>
                        🔐 O Client Secret só é mostrado uma vez. Se o perderes, cria uma nova aplicação e elimina a anterior.
                    </WarningBox>
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="moloni-credentials" icon={<Globe className="w-5 h-5" />} title="Credenciais da Conta Principal" step="Credencial 3 de 3" accent="amber">
                    <InfoBox>
                        A Moloni usa o fluxo <strong>password grant</strong>: além das credenciais da aplicação, precisas de fornecer o utilizador e password da conta Moloni onde queres que as faturas sejam criadas. O Rioko encripta estas credenciais em repouso e usa-as apenas para gerar tokens de acesso.
                    </InfoBox>
                    <Steps accent="amber" items={[
                        '<strong>Username</strong>: o email com que entras em <code class="bg-slate-800 text-amber-300 px-1.5 py-0.5 rounded text-xs">moloni.pt</code> (não o do developer).',
                        '<strong>Password</strong>: a password dessa conta.',
                        '<strong>Empresa (Company ID)</strong>: dentro da Moloni, vai a <strong>Definições → Empresa</strong>. O ID aparece no canto superior. Cola no Rioko.',
                    ]} />
                    <WarningBox>
                        ⚠️ <strong>Recomendado:</strong> cria um utilizador dedicado na Moloni para o Rioko (ex: <code className="bg-slate-800 px-1 rounded">rioko@nome-empresa.pt</code>) com permissões só de <em>faturação</em>. Assim podes revogar a integração sem mexer na tua conta pessoal.
                    </WarningBox>
                </Section>
            </div>

            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="moloni-document-types" icon={<FileText className="w-5 h-5" />} title="Tipos de Documento" accent="amber">
                    <InfoBox>
                        Tal como no InvoiceXpress, podes escolher entre <strong>Fatura-Recibo</strong> (padrão para e-commerce) e <strong>Fatura</strong> simples. A escolha é feita no ecrã da integração depois de validares as credenciais.
                    </InfoBox>
                    <WarningBox>
                        ⚠️ A integração Moloni está em fase final de testes. Se ainda não vires a opção no teu dashboard, contacta-nos.
                    </WarningBox>
                </Section>
            </div>
        </div>
    );
}

// ─── FAQ ──────────────────────────────────────────────────────────────────

type FAQItem = { q: string; a: string };

const FAQS: Record<Platform, FAQItem[]> = {
    shopify: [
        {
            q: "O Rioko emite faturas no momento do pagamento ou da criação da encomenda?",
            a: "Por defeito, o Rioko emite no momento do pagamento (evento <code>orders/paid</code> da Shopify). Assim a fatura corresponde sempre a um valor que entrou efectivamente. Encomendas criadas mas não pagas não geram documento.",
        },
        {
            q: "Como faço para reemitir uma fatura de uma encomenda antiga (mais de 60 dias)?",
            a: "Precisas que o Access Token tenha o scope <code>read_all_orders</code>. Contacta a Kapta para regenerar o token com esse scope; depois usa a opção <strong>Conciliação</strong> no dashboard para reemitir.",
        },
        {
            q: "O Rioko sincroniza alterações feitas à encomenda depois do pagamento?",
            a: "Sim — eventos <code>orders/updated</code> são tratados e, se a fatura ainda estiver em rascunho, é actualizada. Após finalização (auto-finalize) o documento fica imutável por imposição fiscal.",
        },
        {
            q: "E se um cliente pedir um reembolso na Shopify?",
            a: "O webhook <code>refunds/create</code> é interceptado e o Rioko emite automaticamente uma <strong>Nota de Crédito</strong> no software de faturação, ligando-a à fatura original.",
        },
        {
            q: "Posso pausar a integração temporariamente?",
            a: "Sim. Na página da integração, no topo, existe um toggle <strong>Integração ativa / em pausa</strong>. Quando em pausa, os webhooks continuam a chegar mas nenhum documento é emitido até reactivares.",
        },
        {
            q: "O Access Token tem de ser renovado periodicamente?",
            a: "Não. Os Custom App tokens da Shopify não expiram — só são invalidados se forem revogados manualmente ou se a app for desinstalada.",
        },
    ],
    stripe: [
        {
            q: "Porque é que o Rioko usa uma Restricted Key e não a Secret Key?",
            a: "Princípio de menor privilégio. A Restricted Key só permite leitura dos recursos necessários (Charges, PaymentIntents, Customers, Tax IDs, Balance transactions, Refunds). Mesmo que fosse comprometida, ninguém poderia mover dinheiro nem alterar dados.",
        },
        {
            q: "O que acontece se um pagamento Stripe falhar?",
            a: "Pagamentos falhados (<code>payment_intent.payment_failed</code>) não geram documento. Só <code>payment_intent.succeeded</code> e <code>charge.succeeded</code> disparam a emissão de fatura.",
        },
        {
            q: "O Rioko consegue extrair o NIF do cliente Stripe?",
            a: "Sim, se o cliente tiver <strong>Tax IDs</strong> associados no Stripe Customer. A Restricted Key inclui leitura desse recurso. Se não houver Tax ID, a fatura é emitida como <em>Consumidor Final</em>.",
        },
        {
            q: "E refunds parciais?",
            a: "<code>charge.refunded</code> com <code>amount_refunded &lt; amount</code> gera uma Nota de Crédito proporcional ao valor reembolsado.",
        },
        {
            q: "Posso ter Stripe como fonte principal e InvoiceXpress como destino?",
            a: "Sim. O Rioko trata cada par (fonte, destino) como uma <em>connection</em> independente. Podes ter Shopify→IX, Stripe→IX, e Stripe→Moloni a correr em paralelo na mesma conta.",
        },
    ],
    invoicexpress: [
        {
            q: "O Rioko comunica as faturas à Autoridade Tributária?",
            a: "Sim, indirectamente. O InvoiceXpress está integrado com a AT e comunica automaticamente todos os documentos finalizados em ambiente de Produção. O Rioko emite os documentos e o InvoiceXpress trata da comunicação fiscal.",
        },
        {
            q: "O que faz a opção <em>Finalizar automaticamente</em>?",
            a: "Quando ligada, o Rioko finaliza (certifica) cada fatura imediatamente após a criar — fica imediatamente válida e comunicada à AT. Quando desligada, a fatura fica em <strong>rascunho</strong> para revisão manual no InvoiceXpress.",
        },
        {
            q: "Como configuro a retenção na fonte (IRS/IRC)?",
            a: "Na integração, activa <em>Retenção</em> e indica a percentagem (0–99,99). O Rioko inclui o campo <code>retention</code> em cada documento criado. Se desligares, a percentagem fica guardada para reactivar sem perder a configuração.",
        },
        {
            q: "Posso ter mais que uma série de faturação?",
            a: "Sim. Para alternar entre séries, podes editar o campo <em>Série</em> na integração antes de cada lote de emissões. Para volume contínuo, recomenda-se manter uma série única dedicada ao Rioko.",
        },
        {
            q: "O que acontece se a Chave API expirar ou for revogada?",
            a: "O Rioko começa a registar erros 401 nos logs e marca a integração como <em>não autorizada</em>. Gera nova chave em <strong>Preferências de Conta → API</strong> e cola no Rioko — sem precisar reconfigurar mais nada.",
        },
    ],
    moloni: [
        {
            q: "A Moloni também comunica à AT como o InvoiceXpress?",
            a: "Sim. A Moloni é software de faturação certificado pela AT e comunica automaticamente todos os documentos finalizados em ambiente de Produção.",
        },
        {
            q: "Porque preciso de uma conta de developer Moloni separada?",
            a: "É como a Moloni organiza o acesso à API: a conta principal contém os dados da empresa, e a conta de developer contém as <em>aplicações</em> (Client ID/Secret) que podem aceder a essa conta via API. Uma divisão de segurança.",
        },
        {
            q: "É seguro guardar a minha password Moloni no Rioko?",
            a: "A password fica encriptada em repouso e é usada apenas pelo Rioko para trocar por tokens de acesso de curta duração. Mesmo assim, recomendamos criar um utilizador Moloni dedicado ao Rioko (com permissões só de faturação) para reduzir o risco em caso de incidente.",
        },
        {
            q: "Posso usar o Moloni para B2B com reverse charge intracomunitário?",
            a: "Sim. Quando o Rioko detecta um cliente B2B com VAT ID válido fora de Portugal e o reverse charge está activo na integração, o documento é emitido com isenção <code>M16</code> (Artigo 14.º do RITI) na Moloni.",
        },
        {
            q: "Quanto tempo demora a configuração Moloni do princípio ao fim?",
            a: "Em média 10-15 minutos: 2 min para criar conta de developer, 5 min para criar a aplicação e copiar credenciais, 5 min para validar e fazer um teste de emissão.",
        },
    ],
};

function FAQ({ tab }: { tab: Platform }) {
    const [open, setOpen] = useState<number | null>(null);
    const items = FAQS[tab];
    return (
        <div className="glass rounded-[2.5rem] p-8 lg:p-10 border-slate-800/40 space-y-6">
            <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center shrink-0 text-amber-400">
                    <BookOpen className="w-5 h-5" />
                </div>
                <div>
                    <div className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-1">Perguntas Frequentes</div>
                    <h2 className="text-2xl font-black text-white">FAQ — {PLATFORMS.find(p => p.id === tab)?.label}</h2>
                </div>
            </div>
            <div className="ml-0 lg:ml-16 space-y-2">
                {items.map((it, i) => {
                    const isOpen = open === i;
                    return (
                        <div key={i} className="rounded-2xl border border-slate-800/60 bg-slate-900/30 overflow-hidden">
                            <button
                                onClick={() => setOpen(isOpen ? null : i)}
                                aria-expanded={isOpen}
                                className="w-full flex items-center justify-between gap-4 px-5 py-4 text-left hover:bg-slate-900/50 transition-colors"
                            >
                                <span className="text-sm font-bold text-white">{it.q}</span>
                                <ChevronDown className={`w-4 h-4 text-slate-500 shrink-0 transition-transform duration-300 ${isOpen ? "rotate-180 text-amber-400" : ""}`} />
                            </button>
                            <AnimatePresence initial={false}>
                                {isOpen && (
                                    <motion.div
                                        initial={{ height: 0, opacity: 0 }}
                                        animate={{ height: "auto", opacity: 1 }}
                                        exit={{ height: 0, opacity: 0 }}
                                        transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
                                        className="overflow-hidden"
                                    >
                                        <div className="px-5 pb-5 text-sm text-slate-400 leading-relaxed" dangerouslySetInnerHTML={{ __html: it.a }} />
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// Strip HTML tags so JSON-LD answers stay plain text — search engines render
// the FAQ rich result from this field literally.
function stripHtml(s: string): string {
    return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function FAQJsonLd({ tab }: { tab: Platform }) {
    const items = FAQS[tab];
    const data = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: items.map(it => ({
            "@type": "Question",
            name: it.q,
            acceptedAnswer: {
                "@type": "Answer",
                text: stripHtml(it.a),
            },
        })),
    };
    return (
        <script
            type="application/ld+json"
            // Static JSON we built ourselves — safe to inline. Stripped of HTML
            // tags above so the structured data validators accept it.
            dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
        />
    );
}

// ─── Footer ───────────────────────────────────────────────────────────────

function HelpFooter() {
    return (
        <div className="bg-slate-900/50 border border-slate-800/60 rounded-[2.5rem] p-12 lg:p-20 relative overflow-hidden flex flex-col items-center text-center gap-8">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-amber-500/20 to-transparent" />
            <div className="w-20 h-20 bg-amber-500/10 rounded-3xl flex items-center justify-center border border-amber-500/20 shadow-[0_0_40px_rgba(245,158,11,0.1)]">
                <BookOpen className="w-10 h-10 text-amber-500" />
            </div>
            <div className="space-y-4 max-w-2xl">
                <h2 className="text-4xl font-black tracking-tight text-white">Precisas de mais ajuda?</h2>
                <p className="text-slate-400 font-medium leading-relaxed">
                    Se ainda tens dúvidas sobre a configuração do Rioko, a nossa equipa está disponível para te ajudar — por email ou em chamada agendada.
                </p>
            </div>
            <div className="flex flex-col sm:flex-row items-center gap-4">
                <a
                    href="https://calendly.com/pedro-kapta/apoio-kapta"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-sky-500 text-white px-10 py-4 rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-sky-400 transition-all transform active:scale-95 shadow-xl flex items-center gap-3"
                >
                    <Calendar className="w-4 h-4" /> Agendar Reunião
                </a>
                <a href="mailto:pedro@kapta.pt" className="bg-white text-black px-10 py-4 rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-amber-500 hover:text-white transition-all transform active:scale-95 shadow-xl">
                    Contactar Suporte
                </a>
                <button
                    onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
                    className="bg-slate-800/50 text-slate-400 px-4 py-4 rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-slate-800 hover:text-white transition-all border border-slate-700/50"
                >
                    Topo
                </button>
            </div>
        </div>
    );
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function HelpPage() {
    const [zoomImage, setZoomImage] = useState<string | null>(null);
    const [tab, setTab] = useState<Platform>("shopify");

    return (
        <div className="max-w-3xl mx-auto space-y-6 animate-in fade-in duration-700">
            <Link href="/dashboard" className="inline-flex items-center gap-2 text-slate-500 hover:text-white text-sm font-bold transition-all group">
                <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
                Voltar ao Dashboard
            </Link>

            {/* Page Header */}
            <div className="glass rounded-[2rem] p-10 border-slate-800/40">
                <div className="flex items-center gap-4 mb-4">
                    <div className="w-14 h-14 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center">
                        <BookOpen className="w-7 h-7 text-amber-400" />
                    </div>
                    <div>
                        <h1 className="text-4xl font-black tracking-tight bg-gradient-to-r from-white via-white to-slate-500 bg-clip-text text-transparent">
                            Guias de Integração
                        </h1>
                        <p className="text-slate-400 font-semibold mt-1">Rioko 2.0 · Como obter as credenciais de cada plataforma</p>
                    </div>
                </div>
                <p className="text-slate-400 text-sm leading-relaxed">
                    Selecciona a plataforma para veres como obter as credenciais necessárias. O Rioko liga uma <strong>fonte</strong> (Shopify ou Stripe) a um <strong>destino</strong> de faturação (InvoiceXpress ou Moloni). Cada plataforma tem credenciais próprias — abre a tab correspondente.
                </p>
            </div>

            <PlatformTabs tab={tab} onChange={setTab} />

            {/* Active platform guide */}
            <AnimatePresence mode="wait">
                <motion.div
                    key={tab}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
                    className="space-y-6"
                >
                    {tab === "shopify" && <ShopifyGuide onZoom={setZoomImage} />}
                    {tab === "stripe" && <StripeGuide onZoom={setZoomImage} />}
                    {tab === "invoicexpress" && <InvoiceXpressGuide onZoom={setZoomImage} />}
                    {tab === "moloni" && <MoloniGuide onZoom={setZoomImage} />}
                </motion.div>
            </AnimatePresence>

            <FAQ tab={tab} />
            <FAQJsonLd tab={tab} />

            {/* Image Zoom Modal */}
            <AnimatePresence>
                {zoomImage && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-10 bg-slate-950/90 backdrop-blur-xl cursor-zoom-out"
                        onClick={() => setZoomImage(null)}
                    >
                        <motion.button
                            initial={{ scale: 0.5, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            className="absolute top-6 right-6 w-12 h-12 rounded-full bg-white/10 flex items-center justify-center text-white hover:bg-white/20 transition-colors border border-white/10"
                        >
                            <X className="w-6 h-6" />
                        </motion.button>
                        <motion.div
                            initial={{ scale: 0.9, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.9, opacity: 0 }}
                            className="relative w-full h-full flex items-center justify-center lg:max-w-6xl"
                        >
                            <Image src={zoomImage} alt="Zoom View" fill className="object-contain" priority />
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            <HelpFooter />
        </div>
    );
}
