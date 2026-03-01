import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Mail, BookOpen, Store, Key, Webhook, Globe, FileText, Percent, Zap, Tag } from "lucide-react";

export const runtime = "edge";

export const metadata = {
    title: "Ajuda & Guia de Configuração | Rioko",
    description: "Guia passo a passo para configurar a integração Shopify ↔ InvoiceXpress com o Rioko.",
};

function Section({ id, icon, title, step, children }: {
    id: string;
    icon: React.ReactNode;
    title: string;
    step?: string;
    children: React.ReactNode;
}) {
    return (
        <section id={id} className="scroll-mt-28">
            <div className="flex items-start gap-4 mb-6">
                <div className="w-12 h-12 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center shrink-0 text-rose-500">
                    {icon}
                </div>
                <div>
                    {step && (
                        <div className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-1">{step}</div>
                    )}
                    <h2 className="text-2xl font-black text-white">{title}</h2>
                </div>
            </div>
            <div className="ml-16 space-y-6">
                {children}
            </div>
        </section>
    );
}

function Steps({ items }: { items: string[] }) {
    return (
        <ol className="space-y-3">
            {items.map((item, i) => (
                <li key={i} className="flex items-start gap-3">
                    <span className="w-6 h-6 rounded-full bg-rose-500/10 border border-rose-500/20 text-rose-400 text-[10px] font-black flex items-center justify-center shrink-0 mt-0.5">
                        {i + 1}
                    </span>
                    <span className="text-slate-300 text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: item }} />
                </li>
            ))}
        </ol>
    );
}

function Placeholder({ src, alt, description }: { src: string; alt: string; description: string }) {
    return (
        <div className="rounded-2xl overflow-hidden border border-slate-800/60 bg-slate-900/40">
            <div className="relative w-full aspect-video bg-slate-900">
                <Image
                    src={src}
                    alt={alt}
                    fill
                    className="object-cover"
                />
                {/* Placeholder overlay label */}
                <div className="absolute bottom-3 left-3 right-3 bg-black/70 backdrop-blur-sm rounded-xl px-3 py-2 flex items-center gap-2">
                    <span className="text-amber-400 text-lg">📸</span>
                    <span className="text-[11px] text-amber-200/90 font-semibold">
                        Screenshot a substituir: <span className="font-black">{description}</span>
                    </span>
                </div>
            </div>
        </div>
    );
}

function InfoBox({ children }: { children: React.ReactNode }) {
    return (
        <div className="bg-sky-500/5 border border-sky-500/20 rounded-2xl p-4">
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

function ContactBox() {
    return (
        <div className="bg-rose-500/5 border border-rose-500/20 rounded-2xl p-6 flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center shrink-0">
                <Mail className="w-5 h-5 text-rose-400" />
            </div>
            <div className="flex-1">
                <p className="text-white font-bold text-sm">Este passo é feito pela Kapta</p>
                <p className="text-slate-400 text-sm mt-1">
                    O Access Token da Shopify é gerado e instalado pela equipa técnica da Kapta durante a configuração inicial.
                    Não partilhe este token com ninguém além da Kapta.
                </p>
            </div>
            <a
                href="mailto:pedro@kapta.pt?subject=Rioko - Access Token Shopify"
                className="bg-rose-500 text-white px-5 py-3 rounded-2xl font-black text-[11px] uppercase tracking-widest flex items-center gap-2 hover:bg-rose-400 transition-all active:scale-95 shrink-0"
            >
                <Mail className="w-4 h-4" />
                pedro@kapta.pt
            </a>
        </div>
    );
}

export default function HelpPage() {
    return (
        <div className="max-w-3xl mx-auto space-y-6 animate-in fade-in duration-700">

            {/* Back button */}
            <Link href="/dashboard" className="inline-flex items-center gap-2 text-slate-500 hover:text-white text-sm font-bold transition-all group">
                <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
                Voltar às Integrações
            </Link>

            {/* Page Header */}
            <div className="glass rounded-[2rem] p-10 border-slate-800/40">
                <div className="flex items-center gap-4 mb-4">
                    <div className="w-14 h-14 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center">
                        <BookOpen className="w-7 h-7 text-rose-500" />
                    </div>
                    <div>
                        <h1 className="text-4xl font-black tracking-tight bg-gradient-to-r from-white via-white to-slate-500 bg-clip-text text-transparent">
                            Guia de Configuração
                        </h1>
                        <p className="text-slate-400 font-semibold mt-1">Rioko 2.0 · Shopify ↔ InvoiceXpress</p>
                    </div>
                </div>
                <p className="text-slate-400 text-sm leading-relaxed">
                    Este guia explica onde encontrar cada dado necessário para ligar a tua loja Shopify ao InvoiceXpress através do Rioko.
                    Segue os passos pela ordem apresentada — cada secção corresponde a um passo do processo de configuração.
                </p>
            </div>

            {/* Quick Nav */}
            <div className="glass rounded-[2rem] p-6 border-slate-800/40">
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-4">Índice</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {[
                        { href: "#dominio-shopify", label: "Domínio da Loja Shopify", step: "Passo 1" },
                        { href: "#access-token", label: "Access Token Shopify", step: "Passo 1" },
                        { href: "#api-version", label: "Versão da API", step: "Passo 1" },
                        { href: "#webhook-secret", label: "Webhook Signing Secret", step: "Passo 2" },
                        { href: "#ix-account", label: "Nome da Conta InvoiceXpress", step: "Passo 3" },
                        { href: "#ix-api-key", label: "Chave API InvoiceXpress", step: "Passo 3" },
                        { href: "#ix-environment", label: "Ambiente (Produção / Sandbox)", step: "Passo 3" },
                        { href: "#vat", label: "IVA Incluído nos Preços", step: "Passo 4" },
                        { href: "#auto-finalize", label: "Finalizar Automaticamente", step: "Passo 4" },
                        { href: "#exemption", label: "Razão de Isenção de IVA", step: "Passo 4" },
                    ].map(item => (
                        <a
                            key={item.href}
                            href={item.href}
                            className="flex items-center justify-between px-4 py-3 rounded-xl bg-slate-900/50 border border-slate-800/40 hover:border-rose-500/30 hover:bg-rose-500/5 transition-all group"
                        >
                            <span className="text-sm text-slate-300 font-medium group-hover:text-white transition-colors">{item.label}</span>
                            <span className="text-[9px] font-black text-slate-600 uppercase tracking-widest">{item.step}</span>
                        </a>
                    ))}
                </div>
            </div>

            {/* Divider */}
            <div className="border-t border-slate-800/60" />

            {/* ===== SECÇÃO 1: DOMÍNIO ===== */}
            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="dominio-shopify" icon={<Store className="w-5 h-5" />} title="Domínio da Loja Shopify" step="Passo 1 — Ligação Shopify">
                    <InfoBox>
                        O domínio da loja é o endereço único que a Shopify atribuiu à tua loja quando fizeste o registo.
                        Tem sempre o formato <strong>nome-da-loja.myshopify.com</strong>.
                    </InfoBox>

                    <Steps items={[
                        'Acede ao painel de administração da tua loja Shopify em <code class="bg-slate-800 text-rose-300 px-1.5 py-0.5 rounded text-xs">admin.shopify.com</code>',
                        'Olha para o <strong>endereço do browser</strong>. O URL terá o formato <code class="bg-slate-800 text-rose-300 px-1.5 py-0.5 rounded text-xs">https://admin.shopify.com/store/nome-da-loja</code>',
                        'Alternativamente, vai a <strong>Definições</strong> (ícone ⚙️ no canto inferior esquerdo) → o domínio nativo aparece no topo da página.',
                        'O domínio a inserir no Rioko é apenas a parte <code class="bg-slate-800 text-rose-300 px-1.5 py-0.5 rounded text-xs">nome-da-loja.myshopify.com</code> (sem "https://").',
                    ]} />

                    <Placeholder
                        src="/images/help/shopify-domain.png"
                        alt="Shopify Admin - Domínio da loja"
                        description="Shopify Admin → Definições → domínio .myshopify.com visível na barra de endereço e nas definições"
                    />

                    <WarningBox>
                        ⚠️ Usa sempre o domínio <strong>.myshopify.com</strong> nativo, mesmo que a loja tenha um domínio personalizado (ex: www.minha-loja.pt). O domínio personalizado não funciona na API.
                    </WarningBox>
                </Section>
            </div>

            {/* ===== SECÇÃO 2: ACCESS TOKEN ===== */}
            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="access-token" icon={<Key className="w-5 h-5" />} title="Access Token da Shopify" step="Passo 1 — Ligação Shopify">
                    <InfoBox>
                        O Access Token é uma chave de autenticação que permite ao Rioko aceder à API da Shopify em nome da tua loja.
                        Por motivos de segurança, este token é gerado e instalado exclusivamente pela equipa técnica da Kapta.
                    </InfoBox>

                    <ContactBox />

                    <WarningBox>
                        🔐 Nunca partilhes o Access Token publicamente. Quem tiver este token tem acesso total à API da tua loja.
                        Se acidentalmente o expuseres, revoga-o imediatamente em Shopify Admin → Apps → Develop Apps.
                    </WarningBox>
                </Section>
            </div>

            {/* ===== SECÇÃO 3: API VERSION ===== */}
            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="api-version" icon={<Globe className="w-5 h-5" />} title="Versão da API Shopify" step="Passo 1 — Ligação Shopify">
                    <InfoBox>
                        A versão da API Shopify determina qual o conjunto de funcionalidades disponíveis. O Rioko usa sempre a versão mais recente para garantir compatibilidade e acesso às últimas melhorias.
                    </InfoBox>

                    <Steps items={[
                        'Por omissão, o Rioko já preenche automaticamente com a versão mais recente (<strong>2026-01</strong>).',
                        'Não alteres este valor a menos que a Kapta te indique especificamente para o fazer.',
                        'A Shopify lança novas versões de API trimestralmente (ex: 2026-01, 2026-04, 2026-07...).',
                    ]} />
                </Section>
            </div>

            {/* ===== SECÇÃO 4: WEBHOOK SECRET ===== */}
            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="webhook-secret" icon={<Webhook className="w-5 h-5" />} title="Webhook Signing Secret" step="Passo 2 — Criação de Webhooks">
                    <InfoBox>
                        O Webhook Signing Secret é uma chave de segurança que a Shopify usa para assinar (verificar) as notificações que envia ao Rioko quando ocorre uma compra ou reembolso. O Rioko usa-a para confirmar que as notificações são legítimas e não foram adulteradas.
                    </InfoBox>

                    <WarningBox>
                        💡 Esta chave é <strong>partilhada por todos os webhooks da loja</strong>. Se já tens outros webhooks configurados, a chave é exactamente a mesma.
                    </WarningBox>

                    <Steps items={[
                        'No painel Shopify, clica em <strong>Definições</strong> (ícone ⚙️ no canto inferior esquerdo do menu).',
                        'No menu lateral das definições, selecciona <strong>Notificações</strong>.',
                        'Faz scroll até ao fundo da página até encontrar a secção <strong>"Webhooks"</strong>.',
                        'Encontrarás o texto: <em>"Os seus webhooks serão assinados com: [chave]"</em>',
                        'Copia essa chave e cola-a no campo <strong>"Webhook Signing Secret"</strong> do Rioko.',
                    ]} />

                    <Placeholder
                        src="/images/help/webhook-secret.png"
                        alt="Shopify Admin - Webhook Signing Secret"
                        description="Shopify Admin → Definições → Notificações → secção Webhooks → chave de assinatura"
                    />
                </Section>
            </div>

            {/* ===== SECÇÃO 5: IX ACCOUNT ===== */}
            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="ix-account" icon={<FileText className="w-5 h-5" />} title="Nome da Conta InvoiceXpress" step="Passo 3 — Conexão InvoiceXpress">
                    <InfoBox>
                        O nome da conta InvoiceXpress é o subdomínio único da tua conta, visível no endereço do browser quando estás no painel do InvoiceXpress.
                    </InfoBox>

                    <Steps items={[
                        'Acede ao teu painel InvoiceXpress em <code class="bg-slate-800 text-rose-300 px-1.5 py-0.5 rounded text-xs">app.invoicexpress.com</code> (ou o endereço que usas habitualmente).',
                        'Olha para o <strong>endereço do browser</strong>. O URL terá o formato: <code class="bg-slate-800 text-rose-300 px-1.5 py-0.5 rounded text-xs">https://NOME-DA-CONTA.app.invoicexpress.com</code>',
                        'A parte <code class="bg-slate-800 text-rose-300 px-1.5 py-0.5 rounded text-xs">NOME-DA-CONTA</code> é o que deves inserir no Rioko (apenas o subdomínio, sem ".app.invoicexpress.com").',
                        'Exemplo: se o URL for <code class="bg-slate-800 text-rose-300 px-1.5 py-0.5 rounded text-xs">saltedbooks.app.invoicexpress.com</code>, insereres apenas <code class="bg-slate-800 text-rose-300 px-1.5 py-0.5 rounded text-xs">saltedbooks</code>.',
                    ]} />

                    <Placeholder
                        src="/images/help/ix-account.png"
                        alt="InvoiceXpress - Nome da conta no URL"
                        description="InvoiceXpress → URL da conta → subdomínio 'nome-da-conta' antes de .app.invoicexpress.com"
                    />
                </Section>
            </div>

            {/* ===== SECÇÃO 6: IX API KEY ===== */}
            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="ix-api-key" icon={<Key className="w-5 h-5" />} title="Chave API InvoiceXpress" step="Passo 3 — Conexão InvoiceXpress">
                    <InfoBox>
                        A Chave API (API Key) autentica o Rioko na tua conta InvoiceXpress, permitindo criar faturas automaticamente após cada venda na Shopify.
                    </InfoBox>

                    <Steps items={[
                        'No painel InvoiceXpress, clica no teu <strong>nome ou avatar</strong> no canto superior direito.',
                        'Selecciona <strong>"A Minha Conta"</strong> no menu.',
                        'No menu lateral, encontra e clica em <strong>"API"</strong> ou <strong>"Integrações"</strong>.',
                        'A <strong>Chave API</strong> aparece nesta página. Clica em "Mostrar" se estiver oculta.',
                        'Copia a chave e cola-a no campo <strong>"Chave API"</strong> do Rioko.',
                    ]} />

                    <Placeholder
                        src="/images/help/ix-api-key.png"
                        alt="InvoiceXpress - Chave API"
                        description="InvoiceXpress → A Minha Conta → API → campo Chave API"
                    />

                    <WarningBox>
                        🔐 A Chave API dá acesso total à tua conta InvoiceXpress (criar, editar e apagar documentos). Não a partilhes com ninguém além da Kapta.
                    </WarningBox>
                </Section>
            </div>

            {/* ===== SECÇÃO 7: AMBIENTE ===== */}
            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="ix-environment" icon={<Globe className="w-5 h-5" />} title="Ambiente — Produção ou Sandbox" step="Passo 3 — Conexão InvoiceXpress">
                    <InfoBox>
                        O InvoiceXpress oferece dois ambientes: <strong>Produção</strong> (faturas reais, com valor legal) e <strong>Sandbox</strong> (ambiente de testes, sem valor fiscal).
                    </InfoBox>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-2xl p-5">
                            <div className="text-emerald-400 font-black text-sm mb-2">✅ Produção</div>
                            <p className="text-slate-400 text-sm">Faturas com valor legal. As faturas criadas são comunicadas à AT. Usa quando a loja já está ao vivo e a vender.</p>
                        </div>
                        <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-5">
                            <div className="text-amber-400 font-black text-sm mb-2">🧪 Sandbox</div>
                            <p className="text-slate-400 text-sm">Ambiente de testes. As faturas criadas não têm valor fiscal. Usa apenas para testes técnicos antes de ir a produção.</p>
                        </div>
                    </div>

                    <Steps items={[
                        'Na grande maioria dos casos, selecciona <strong>Produção</strong>.',
                        'Usa Sandbox apenas se a Kapta te indicar especificamente durante a fase de testes.',
                        'Para verificar em que ambiente estás no InvoiceXpress: acede ao Dashboard e verifica se existe um banner/aviso de "modo de teste" no topo.',
                    ]} />
                </Section>
            </div>

            {/* ===== SECÇÃO 8: VAT ===== */}
            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="vat" icon={<Percent className="w-5 h-5" />} title="IVA Incluído nos Preços" step="Passo 4 — Definições de Integração">
                    <InfoBox>
                        Esta definição indica ao Rioko se os preços configurados na Shopify já incluem IVA, ou se o IVA é adicionado por cima durante o checkout.
                    </InfoBox>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
                            <div className="text-white font-black text-sm mb-2">✅ IVA Incluído (activado)</div>
                            <p className="text-slate-400 text-sm">O preço do produto na Shopify já inclui IVA. O Rioko calcula o valor líquido automaticamente por retroacção fiscal.</p>
                            <p className="text-slate-600 text-xs mt-2">Exemplo: produto a 10,00€ → fatura com 8,13€ + IVA 23% (1,87€)</p>
                        </div>
                        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
                            <div className="text-white font-black text-sm mb-2">⬜ IVA Não Incluído (desactivado)</div>
                            <p className="text-slate-400 text-sm">O preço do produto na Shopify é o preço líquido, e o IVA é adicionado separadamente no checkout.</p>
                            <p className="text-slate-600 text-xs mt-2">Exemplo: produto a 8,13€ + IVA 23% no checkout = 10,00€</p>
                        </div>
                    </div>

                    <Steps items={[
                        'No painel Shopify, vai a <strong>Definições → Impostos e deveres</strong>.',
                        'Verifica o campo <strong>"Mostrar todos os preços com imposto incluído"</strong>.',
                        'Se estiver marcado → activa "IVA Incluído" no Rioko.',
                        'Se não estiver marcado → mantém "IVA Incluído" desactivado no Rioko.',
                    ]} />
                </Section>
            </div>

            {/* ===== SECÇÃO 9: AUTO FINALIZE ===== */}
            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="auto-finalize" icon={<Zap className="w-5 h-5" />} title="Finalizar Automaticamente" step="Passo 4 — Definições de Integração">
                    <InfoBox>
                        Quando activado, o Rioko finaliza e certifica a fatura imediatamente após a sua criação. Quando desactivado, a fatura fica em <strong>rascunho</strong> no InvoiceXpress, permitindo revisão manual antes de finalizar.
                    </InfoBox>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-2xl p-5">
                            <div className="text-emerald-400 font-black text-sm mb-2">⚡ Auto Finalizar (activado)</div>
                            <p className="text-slate-400 text-sm">Recomendado para lojas com volume de vendas. Fatura criada e enviada automaticamente. Não é possível editar após finalização.</p>
                        </div>
                        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
                            <div className="text-white font-black text-sm mb-2">📝 Rascunho (desactivado)</div>
                            <p className="text-slate-400 text-sm">A fatura fica em rascunho. Podes verificar e editar antes de finalizar manualmente no InvoiceXpress.</p>
                        </div>
                    </div>
                </Section>
            </div>

            {/* ===== SECÇÃO 10: EXEMPTION REASON ===== */}
            <div className="glass rounded-[2rem] p-8 border-slate-800/40 space-y-6">
                <Section id="exemption" icon={<Tag className="w-5 h-5" />} title="Razão de Isenção de IVA" step="Passo 4 — Definições de Integração">
                    <InfoBox>
                        Quando um produto tem taxa de IVA 0%, a legislação fiscal portuguesa exige que a fatura indique a razão legal da isenção. Este campo define qual o motivo padrão a usar nesses casos.
                    </InfoBox>

                    <p className="text-slate-400 text-sm">
                        A razão mais comum para pequenas lojas e serviços is <strong>M99</strong> (Não sujeito). No entanto, a razão correcta depende da natureza do teu negócio. Se tiveres dúvidas, consulta o teu contabilista.
                    </p>

                    <div className="overflow-auto rounded-2xl border border-slate-800/60">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="bg-slate-900/80 border-b border-slate-800">
                                    <th className="px-4 py-3 text-left text-[10px] font-black text-slate-500 uppercase tracking-widest">Código</th>
                                    <th className="px-4 py-3 text-left text-[10px] font-black text-slate-500 uppercase tracking-widest">Base Legal</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/40">
                                {[
                                    ["M01", "Artigo 16.º, n.º 6 do CIVA"],
                                    ["M02", "Artigo 6.º do DL n.º 198/90, de 19 de junho"],
                                    ["M04", "Isento — Artigo 13.º do CIVA"],
                                    ["M05", "Isento — Artigo 14.º do CIVA"],
                                    ["M06", "Isento — Artigo 15.º do CIVA"],
                                    ["M07", "Isento — Artigo 9.º do CIVA"],
                                    ["M09", "IVA — Não confere direito a dedução"],
                                    ["M10", "IVA — Regime de isenção (Artigo 57.º do CIVA)"],
                                    ["M11", "Regime particular — Agências de viagens"],
                                    ["M12", "Regime particular — Bens em segunda mão"],
                                    ["M13", "Regime particular — Objectos de arte"],
                                    ["M14", "Regime particular — Objectos de colecção ou antiguidades"],
                                    ["M15", "Regime particular — Ouro para investimento"],
                                    ["M16", "Isento — Art. 14.º do RITI"],
                                    ["M19", "Outras isenções temporárias"],
                                    ["M20", "IVA — Regime forfetário agrícola"],
                                    ["M25", "Mercadorias à consignação"],
                                    ["M30", "IVA — Autoliquidação por aquisição de serviços"],
                                    ["M31", "IVA — Autoliquidação na construção civil"],
                                    ["M32", "IVA — Autoliquidação em sucatas e materiais recicláveis"],
                                    ["M33", "IVA — Autoliquidação em gases de efeito estufa"],
                                    ["M40", "IVA — Autoliquidação noutros casos"],
                                    ["M41", "IVA — Não liquidado por inversão do sujeito passivo"],
                                    ["M42", "IVA — Não liquidado por transferência de bens no âmbito de fusões"],
                                    ["M43", "IVA — Não liquidado por IVA incluído no preço"],
                                    ["M99", "Não sujeito / Não tributado (outros casos)"],
                                ].map(([code, desc]) => (
                                    <tr key={code} className="hover:bg-slate-900/40 transition-colors">
                                        <td className="px-4 py-2.5">
                                            <code className="bg-slate-800 text-rose-300 px-2 py-0.5 rounded text-xs font-bold">{code}</code>
                                        </td>
                                        <td className="px-4 py-2.5 text-slate-400 text-xs">{desc}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </Section>
            </div>

            {/* Footer CTA */}
            <div className="glass rounded-[2rem] p-8 border-slate-800/40 text-center space-y-4">
                <p className="text-slate-400 text-sm">Ainda tens dúvidas? A equipa da Kapta está disponível para ajudar.</p>
                <a
                    href="mailto:pedro@kapta.pt?subject=Dúvida Rioko - Configuração"
                    className="inline-flex items-center gap-2 bg-white text-black px-6 py-3 rounded-2xl font-black text-sm hover:bg-rose-500 hover:text-white transition-all duration-300 active:scale-95"
                >
                    <Mail className="w-4 h-4" />
                    pedro@kapta.pt
                </a>
            </div>

        </div>
    );
}
