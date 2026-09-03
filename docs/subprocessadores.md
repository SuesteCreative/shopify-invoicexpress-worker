# Subprocessadores — registo de trabalho

Quem toca em dados dos clientes e dos clientes deles, derivado do código e não
de memória: cada linha tem a evidência ao lado. Criado a 2026-09-03 porque a
entrada da Fly.io obrigou a ter esta lista, e não havia nenhuma.

**Isto é um documento de trabalho, para revisão, não uma página publicada.** Não
substitui os DPA assinados nem a lista que mostras aos clientes; serve para
saber o que lá tem de estar.

## Plataforma

| Entidade | Papel | Dados | Região | Evidência |
|---|---|---|---|---|
| **Cloudflare** | Workers, D1, KV, Queues, Pages | tudo: encomendas, reservas, hóspedes, configuração, chaves | WEUR (D1 em MAD) | `wrangler.jsonc` |
| **Fly.io Inc** | relay de saída Lodgify (**novo 2026-09-03**) | nomes, moradas, emails e telefones de hóspedes, **em trânsito**; chaves Lodgify dos clientes, em trânsito | máquinas em `cdg`, empresa nos EUA | `lodgify-relay/fly.toml` |
| **Hostinger** (`endpoint-shopify.srv1250352.hstgr.cloud`) | normalização Shopify — só reembolsos e caminho adapter | encomendas Shopify completas, incluindo comprador | desconhecida | `src/shopify.ts:72` |

> **A linha da Hostinger é o problema desta lista.** Está registado desde julho
> que é um VPS que o Pedro não reconhece, e continua no caminho dos reembolsos e
> do adapter Moloni. Um subprocessador de dono desconhecido não é declarável.
> Ver a memória `hostinger-normalize-replaced` para o que falta migrar.

## Destinos de facturação

| Entidade | Papel | Dados | Evidência |
|---|---|---|---|
| **InvoiceXpress** | emissão de documentos | cliente final: nome, NIF, morada, linhas | `web.invoicexpress.com` |
| Kapta (`ix-proxy.kapta.app`) | proxy para o InvoiceXpress | idem, em trânsito | infra própria, não terceiro |
| **Moloni** | emissão de documentos | idem | `api.moloni.pt` |
| **Vendus** | emissão de documentos | idem | `www.vendus.pt` |

## Fontes de venda

| Entidade | Papel | Evidência |
|---|---|---|
| **Shopify** | encomendas e clientes | `src/shopify.ts` |
| **Stripe** | pagamentos (fonte) e subscrições do Rioko | `api.stripe.com` |
| **Lodgify** | reservas e hóspedes | `src/services/lodgify-api.ts` |
| **EuPago** | pagamentos (fonte) | `SourceKind` inclui `eupago` |

## Serviços de apoio

| Entidade | Papel | Dados | Evidência |
|---|---|---|---|
| **Resend** | email transaccional (principal) | emails de comerciantes e de clientes finais | `src/services/email.ts:80` |
| **MailChannels** | email (fallback) | idem | `src/services/email.ts:129` |
| **Anthropic** | diagnóstico de incidentes e relatório de padrões | conteúdo de incidentes, **passado por `redactDeep`** | `api.anthropic.com`, `src/services/anthropic.redact.test.ts` |
| **Clerk** | autenticação do backoffice | identidade dos comerciantes | `@clerk/nextjs` |
| **VIES** (`viesvalidation.com`) | validação de NIF intracomunitário | NIF do comprador | `src/ix/vies.ts` |
| ~~Vercel~~ | *era* o `lodgify-feeder` | — | **desactivado 2026-09-03**, projeto pausado |

## O que falta fazer, e é humano

1. **Assinar o DPA da Fly.io.** Empresa dos EUA, portanto leva cláusulas-tipo
   (SCC) além do DPA. A região está fixada em `cdg`, logo os dados ficam na UE.
2. **Avisar a Origos e a LOSSA** de que passou a haver um novo subprocessador no
   caminho das reservas. São as duas ligações Lodgify activas com dados a
   circular. Rascunho no fim.
3. **Resolver a Hostinger**, que é a linha que não se pode declarar. Ou se
   recupera o acesso, ou se migra o caminho dos reembolsos e do adapter para
   dentro do worker, como já foi feito para o caminho de criação.
4. Confirmar quais destes já têm DPA assinado. Esta coluna está deliberadamente
   ausente da tabela: inventá-la era pior do que não a ter.

## Rascunho do aviso aos clientes

> Assunto: Alteração técnica na integração Lodgify — novo subprocessador
>
> Olá [nome],
>
> Uma nota de transparência sobre a integração das reservas.
>
> Desde 2 de agosto que a Lodgify bloqueava os pedidos da nossa integração, por
> saírem de endereços variáveis da Cloudflare. O suporte deles confirmou que só
> conseguem autorizar por endereço IP fixo, pelo que passámos as chamadas à
> Lodgify por um servidor dedicado com endereço fixo, alojado na Fly.io, em
> França (região `cdg`). Os dados continuam a ser tratados na União Europeia.
>
> Isto significa que os dados das reservas, incluindo nome e contactos dos
> hóspedes, passam agora também por esse servidor. A Fly.io passa a constar da
> nossa lista de subprocessadores. Nada mais mudou: nem os dados recolhidos, nem
> as finalidades, nem os prazos de conservação.
>
> A sincronização das reservas está normalizada desde hoje.
>
> Com os melhores cumprimentos,
> Pedro
