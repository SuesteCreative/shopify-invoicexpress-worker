// The standing knowledge taught to the triage model. This text is sent in the
// (prompt-cached) `system` block of every diagnosis / pattern call, so it is the
// single place that teaches Claude everything about the Rioko integrator. Edit
// here to make the AI smarter — it costs ~nothing per call once cached.
//
// Rules: domain knowledge ONLY. No secrets, no API keys, no customer data, no
// per-merchant specifics. European Portuguese (the diagnoses are in PT).

export const RIOKO_DOMAIN_KNOWLEDGE = `## O que é o Rioko
O Rioko é um integrador de faturação: recebe webhooks de vendas (Shopify e Stripe),
normaliza a encomenda e emite o documento fiscal num sistema de faturação português —
InvoiceXpress (IX, principal), Moloni ou Vendus. Fluxo: webhook → fila (queue) →
normalização → IxBuilder constrói as linhas → criação do documento → finalização.

## Invariante sagrada: total = pago (reconcile guard)
Antes de emitir, o "reconcile guard" calcula o total esperado a partir das linhas e
compara-o com o valor REALMENTE pago (Shopify total_price / Stripe amount_received). Se
divergir mais de 1 cêntimo, ABORTA a emissão (kind=reconcile_drift) — nunca emitir um
documento com valor errado. A fonte de verdade do valor é o processador de pagamento,
nunca a soma de linhas. Logo um drift NÃO se corrige "forçando" o total a bater; corrige-se
a causa-raiz (configuração de IVA, taxa, inclusão) e reemite-se.

## IVA incluído vs excluído (a causa nº1 de drift)
O preço Shopify pode ter o IVA "incluído" (taxes_included=true; o preço já é bruto/com IVA)
ou "excluído" (preço líquido, IVA somado à parte). Se a emissão tratar um preço bruto como
líquido, soma IVA por cima e o total fica alto. Assinatura típica: expected ≈ pago × (1 + taxa/100)
⇒ IVA somado em cima de um preço que já o continha (loja com taxes_included=true).

Regra do effectiveRate: a taxa usada na MATEMÁTICA de extração do IVA do bruto TEM de ser a
MESMA taxa stampada na linha. Precedência: override por SKU > force_tax_rate (taxa fixa da
conta) > taxa que a Shopify realmente cobrou (tax_lines). Um bug clássico: a loja tem
taxes_included=true e force_tax_rate=6, mas a Shopify não cobrou IVA (tax_lines vazias) —
se a matemática usar 0 e stampar 6, soma 6% por cima ⇒ drift = pago × 6%. Diagnóstico: a
taxa fixa não está a alimentar a extração do IVA incluído.

## Overrides por SKU (a correção mais comum)
Em Integrações → InvoiceXpress → Gerir overrides define-se, por SKU (ou variante/produto/portes):
- tax_rate: força a taxa de IVA da linha (ex.: bilhetes a 6%).
- vat_inclusion: "inc" (o preço já inclui IVA) ou "exc" (somar IVA).
Depois do override, reemitir a encomenda em Dev Mode. Alternativa à raiz: corrigir as
definições de impostos da própria loja Shopify.

## Cliente, NIF e país (especificidades do IX)
- O IX exige o NOME COMPLETO do país em inglês ("Portugal", "Spain"), não o código ISO.
  Enviar "PT" dá 422 "Country PT was not found", que o IX devolve como o erro em cascata
  "Client is invalid / Fiscal is invalid". Por isso "Fiscal is invalid" é, muitas vezes, um
  problema de PAÍS e não do NIF.
- fiscal_id vazio é aceite (cai em "Consumidor Final"). Nunca stampar um número de 9 dígitos
  aleatório como NIF: o IX valida-o contra PT e rejeita o cliente todo.
- NIF PT é validado pelo algoritmo do dígito de controlo. NIFs estrangeiros (UE) só entram via
  reverse charge.
- DOC010 "Cliente/Fiscal não é válido" pode ser um cliente IX já existente e partido,
  encontrado pelo "code" (id do cliente), e não o payload atual. A correção é recriar um cliente
  Consumidor Final limpo (há um fallback automático na criação).
- Morada da fatura: usa primeiro billing_address, depois shipping como recurso. (A determinação
  de IVA OSS, essa, segue a morada de ENVIO — é distinto.)

## Reverse charge / B2B intra-UE / OSS
Comprador B2B noutro Estado-Membro com VAT válido ⇒ autoliquidação (reverse charge), IVA 0%,
menção M16 (art. 196.º Directiva IVA). Requer VIES confirmado + flags da conta
(b2b_reverse_charge, oss_enabled, vat_included). Se o VIES não responder, fica "deferred"
(vies_unconfirmed) à espera de validação manual.

## Destinos e como ler os erros
- destination_reject / queue_retry_exhausted trazem o erro CRU do destino. Distingue:
  • Permanente (4xx determinístico): NIF/cliente inválido, campo obrigatório em falta, série sem
    permissões, documento inválido. Não resolve com retry — exige correção dos dados.
  • Transitório (5xx / 502 Bad Gateway / timeout): o proxy/IX está lento ou em baixo. Resolve
    sozinho com retry; se persistir, é outage do destino.
  • Autenticação (401 / "autenticação" / token): a chave/sessão expirou — reconectar a conta.
- IX: honra desconto por linha em PERCENTAGEM (campo discount), ignora discount_amount no POST.
  Tipos de documento: "invoice" (fatura) e "invoice_receipt" (fatura-recibo, típico de venda paga).
- Moloni: corpo form-urlencoded com chaves estilo PHP (brackets); product_id é OBRIGATÓRIO nas
  linhas (usa-se um produto placeholder); atenção que os nomes gross_value/net_value estão
  invertidos face ao intuitivo.
- Vendus: semelhante, certificado PT.

## Datas e série
O IX rejeita finalizar um documento com data ANTERIOR à última data já finalizada da série. A
estratégia correta preserva a data da encomenda Shopify quando possível e só "empurra" para a
data da última finalizada quando a série obriga (acrescentando uma observação a indicar a data
real da encomenda). Nunca fixar silenciosamente em "hoje".

## Moeda
currency_not_supported: a contabilidade PT exige EUR. Pagamento noutra moeda não é faturado
(ainda não há conversão cambial).

## Fluxo de recuperação (o que o operador faz)
1. Corrigir a causa-raiz: override por SKU (tax_rate/vat_inclusion), corrigir dados do cliente,
   reconectar conta, ou corrigir definições da loja.
2. Reemitir a encomenda em Dev Mode (cria um rascunho/draft).
3. Finalizar (finalize-drafts) com a estratégia de datas correta.
Documentos JÁ emitidos (finalizados) são irreversíveis — corrigem-se com nota de crédito, nunca
apagando.`;
