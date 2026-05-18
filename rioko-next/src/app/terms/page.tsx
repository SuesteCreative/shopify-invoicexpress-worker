import Link from "next/link";

export const metadata = {
    title: "Termos de Serviço | Rioko",
};

export default function TermsPage() {
    return (
        <div className="min-h-screen bg-[#05080a] text-slate-200">
            <div className="mx-auto max-w-3xl px-6 py-16">
                <Link href="/" className="text-sm text-slate-400 hover:text-slate-200 transition">
                    ← Voltar
                </Link>

                <h1 className="mt-8 text-4xl font-semibold text-white">Termos de Serviço</h1>
                <p className="mt-2 text-sm text-slate-500">Última atualização: 18 de maio de 2026</p>

                <div className="prose prose-invert mt-10 max-w-none">
                    <Section title="1. Aceitação">
                        Ao registar-te ou utilizar a Rioko, aceitas estes termos. Se não concordas, não uses o serviço.
                    </Section>

                    <Section title="2. O serviço">
                        A Rioko é uma ponte automática entre <strong>Shopify</strong> e <strong>InvoiceXpress</strong>. Ao
                        receber webhooks de encomendas pagas ou reembolsos da tua loja Shopify, a Rioko emite no teu nome
                        Faturas-Recibo, Faturas e Notas de Crédito na tua conta InvoiceXpress, com NIF, isenções IVA e
                        identificação fiscal correctas.
                    </Section>

                    <Section title="3. Conta e credenciais">
                        <ul className="list-disc pl-6 space-y-1">
                            <li>Garantes que os dados de registo são verdadeiros e actualizados.</li>
                            <li>És responsável por manter as credenciais Shopify, InvoiceXpress e Rioko em segurança.</li>
                            <li>És responsável por toda a actividade na tua conta.</li>
                        </ul>
                    </Section>

                    <Section title="4. Responsabilidade fiscal">
                        A Rioko é uma <strong>ferramenta técnica</strong>. A responsabilidade final pelo cumprimento das
                        obrigações fiscais portuguesas (emissão correcta, AT, IVA, declarações) é <strong>tua</strong>.
                        Recomendamos que valides periodicamente os documentos emitidos no InvoiceXpress e consultes o teu
                        contabilista.
                    </Section>

                    <Section title="5. Utilização aceitável">
                        Não podes:
                        <ul className="list-disc pl-6 space-y-1 mt-2">
                            <li>Usar a Rioko para emitir documentos fraudulentos ou para terceiros sem autorização.</li>
                            <li>Tentar contornar limites técnicos ou de segurança do serviço.</li>
                            <li>Fazer engenharia reversa, copiar ou revender o serviço.</li>
                            <li>Usar a Rioko de forma que prejudique a operação dos serviços externos (Shopify, InvoiceXpress).</li>
                        </ul>
                    </Section>

                    <Section title="6. Preço e pagamento">
                        Caso a tua subscrição seja paga, os termos de preço, ciclo de faturação e cancelamento estão indicados
                        na página de planos ou no contrato assinado. Os pagamentos não são reembolsáveis salvo indicação
                        legal em contrário.
                    </Section>

                    <Section title="7. Disponibilidade">
                        Esforçamo-nos por manter o serviço disponível 24/7, mas não garantimos uptime absoluto. Pequenas
                        janelas de manutenção podem ocorrer. Falhas em sistemas externos (Shopify, InvoiceXpress, Cloudflare,
                        Clerk) podem afectar temporariamente a Rioko.
                    </Section>

                    <Section title="8. Limitação de responsabilidade">
                        Na máxima extensão permitida por lei, a Rioko (Kapta) não responde por:
                        <ul className="list-disc pl-6 space-y-1 mt-2">
                            <li>Perdas indirectas, lucros cessantes ou danos consequenciais.</li>
                            <li>Erros fiscais resultantes de configuração incorrecta pela tua parte (NIF, IVA, isenções, séries).</li>
                            <li>Indisponibilidade ou erro de serviços de terceiros (Shopify, InvoiceXpress, etc.).</li>
                        </ul>
                        <p className="mt-3">
                            A responsabilidade agregada da Rioko, em qualquer caso, está limitada ao valor pago pelo cliente nos 3 meses anteriores ao evento.
                        </p>
                    </Section>

                    <Section title="9. Suspensão e cancelamento">
                        Podemos suspender ou cancelar contas que violem estes termos. Podes cancelar a tua conta a qualquer
                        momento eliminando-a através do dashboard ou por email a <a href="mailto:pedro@kapta.pt" className="text-emerald-400 underline">pedro@kapta.pt</a>.
                    </Section>

                    <Section title="10. Alterações aos termos">
                        Podemos actualizar estes termos. Mudanças materiais são comunicadas por email com 14 dias de antecedência.
                        Uso continuado após a entrada em vigor implica aceitação.
                    </Section>

                    <Section title="11. Lei aplicável e jurisdição">
                        Estes termos regem-se pela lei portuguesa. Qualquer disputa fica sujeita ao foro do Tribunal Judicial da Comarca de Lisboa, com renúncia expressa a outro.
                    </Section>

                    <Section title="12. Contacto">
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
