import Link from "next/link";

export const metadata = {
    title: "Política de Privacidade | Rioko",
};

export default function PrivacyPage() {
    return (
        <div className="min-h-screen bg-[#05080a] text-slate-200">
            <div className="mx-auto max-w-3xl px-6 py-16">
                <Link href="/" className="text-sm text-slate-400 hover:text-slate-200 transition">
                    ← Voltar
                </Link>

                <h1 className="mt-8 text-4xl font-semibold text-white">Política de Privacidade</h1>
                <p className="mt-2 text-sm text-slate-500">Última atualização: 18 de maio de 2026</p>

                <div className="prose prose-invert mt-10 max-w-none">
                    <Section title="1. Quem somos">
                        A Rioko é um serviço operado pela <strong>Kapta</strong>, com sede em Portugal, que automatiza a
                        faturação de lojas Shopify através do InvoiceXpress. Para questões de privacidade, contacta-nos
                        em <a href="mailto:pedro@kapta.pt" className="text-emerald-400 underline">pedro@kapta.pt</a>.
                    </Section>

                    <Section title="2. Dados que recolhemos">
                        <ul className="list-disc pl-6 space-y-1">
                            <li><strong>Conta</strong>: nome, email e identificador único (via Clerk autenticação).</li>
                            <li><strong>Credenciais de integração</strong>: token Shopify, chave API InvoiceXpress, webhook secrets — usados apenas para emitir documentos fiscais em teu nome.</li>
                            <li><strong>Dados de encomendas</strong>: ID, cliente, NIF, valores, produtos — processados em tempo real para criar a fatura ou nota de crédito.</li>
                            <li><strong>Logs técnicos</strong>: timestamps, IDs de pedido, respostas das APIs externas, para auditoria e diagnóstico.</li>
                        </ul>
                    </Section>

                    <Section title="3. Para que usamos">
                        Os dados são usados exclusivamente para:
                        <ul className="list-disc pl-6 space-y-1 mt-2">
                            <li>Criar Faturas-Recibo e Notas de Crédito no InvoiceXpress automaticamente.</li>
                            <li>Garantir conformidade fiscal (regras AT, isenções IVA M01–M99, NIF).</li>
                            <li>Apresentar o histórico no dashboard.</li>
                            <li>Suporte técnico quando o solicitas.</li>
                        </ul>
                        <p className="mt-3">Não vendemos nem partilhamos os teus dados com terceiros para fins de marketing.</p>
                    </Section>

                    <Section title="4. Subprocessadores">
                        Para operar o serviço, recorremos a:
                        <ul className="list-disc pl-6 space-y-1 mt-2">
                            <li><strong>Cloudflare</strong> (hosting, DNS, D1, KV, Workers) — EU/global.</li>
                            <li><strong>Clerk</strong> (autenticação) — EU/US.</li>
                            <li><strong>Shopify</strong> (origem das encomendas) — conforme a configuração da tua loja.</li>
                            <li><strong>InvoiceXpress</strong> (emissor fiscal) — Portugal.</li>
                            <li><strong>Vercel</strong> (logging suplementar) — EU/US.</li>
                        </ul>
                    </Section>

                    <Section title="5. Retenção">
                        Mantemos os teus dados enquanto a tua conta estiver activa. Eliminada a conta, os dados pessoais
                        são removidos da nossa base de dados em até 30 dias. Logs anonimizados podem ser retidos até 12 meses
                        para diagnóstico e prevenção de fraude.
                    </Section>

                    <Section title="6. Os teus direitos (RGPD)">
                        Tens direito a:
                        <ul className="list-disc pl-6 space-y-1 mt-2">
                            <li>Aceder aos teus dados pessoais.</li>
                            <li>Corrigir dados imprecisos.</li>
                            <li>Solicitar eliminação ("direito ao esquecimento").</li>
                            <li>Portabilidade dos dados.</li>
                            <li>Retirar consentimento a qualquer momento.</li>
                            <li>Apresentar queixa à <strong>CNPD</strong> (Comissão Nacional de Proteção de Dados).</li>
                        </ul>
                        <p className="mt-3">Para exercer qualquer direito, envia email para <a href="mailto:pedro@kapta.pt" className="text-emerald-400 underline">pedro@kapta.pt</a>.</p>
                    </Section>

                    <Section title="7. Segurança">
                        Todos os tokens e chaves API são armazenados encriptados. As comunicações entre Rioko e serviços
                        externos (Shopify, InvoiceXpress, Clerk) usam exclusivamente HTTPS/TLS. Webhooks Shopify são verificados
                        com HMAC-SHA256 antes de qualquer processamento.
                    </Section>

                    <Section title="8. Cookies">
                        Usamos apenas cookies essenciais à autenticação (Clerk session). Não usamos cookies de marketing
                        nem tracking de terceiros.
                    </Section>

                    <Section title="9. Alterações">
                        Esta política pode ser actualizada. Alterações materiais serão comunicadas por email aos utilizadores
                        registados pelo menos 14 dias antes de entrarem em vigor.
                    </Section>

                    <Section title="10. Contacto">
                        Kapta — <a href="mailto:pedro@kapta.pt" className="text-emerald-400 underline">pedro@kapta.pt</a><br />
                        Site: <a href="https://kapta.pt" className="text-emerald-400 underline">kapta.pt</a>
                    </Section>
                </div>
            </div>
        </div>
    );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="mt-8">
            <h2 className="text-xl font-semibold text-white">{title}</h2>
            <div className="mt-3 text-slate-300 leading-relaxed text-[15px]">{children}</div>
        </section>
    );
}
