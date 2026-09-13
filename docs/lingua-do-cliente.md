# A língua de cada cliente

Cada conta tem uma língua — `users.language`, `'pt'` ou `'en'` — e é nela que
tudo o que fala com o cliente é escrito: o painel, os avisos que aparecem lá
dentro, os emails que lhe enviamos e as páginas que a Stripe lhe mostra.

Migração `0061_user_language.sql`, aplicada à mão a 13/09/2026. As 42 contas
ficaram em `pt`, que é a língua em que sempre lhes escrevemos; as inglesas
marcam-se uma a uma na ficha.

## Onde se muda

| Quem | Onde |
|---|---|
| Operador | Ficha do cliente → separador **Identidade** → **Língua** |
| Cliente | Página **Conta** → **Língua** (é a mesma pílula PT/EN do cabeçalho) |

Quem mexer por último ganha. É uma preferência, não um NIF: por isso o seletor
da ficha aceita qualquer operador (`isAdmin`), enquanto o NIF e o nome fiscal
continuam a exigir hiperadmin.

**A impersonação não escreve.** Um operador a ler o painel de um cliente fica na
língua dele próprio e a pílula não grava nada — senão bastava ler uma conta
inglesa em português para lhe trocar a preferência.

## Como o painel acaba na língua certa

O `middleware.ts` decide isto uma vez, antes da página existir: se o URL diz
`/pt/...` e a ficha diz `en`, redirige para `/en/...`. Só na superfície com
sessão — as páginas de marketing continuam a ser lidas na língua que o visitante
escolher, que é para isso que a pílula lá está.

Um **utilizador convidado lê a língua da CONTA**, não a sua: uma empresa fala uma
língua só. É o `readAccountLanguage` (`backoffice/src/lib/user-language.ts`) que
faz esse `JOIN`, numa consulta só, porque corre em cada página.

Falha aberto: se a D1 não responder, ou antes de a 0061 estar aplicada, abre em
português. Um painel na língua errada é um defeito; um painel que não abre é uma
avaria.

## Como os emails acabam na língua certa

Igual ao tema (`users.theme`), e de propósito:

```ts
const theme = await getUserTheme(env, userId);       // ler ANTES
const language = await getUserLanguage(env, userId); // ler ANTES
const tpl = renderInLang(language, () => renderInTheme(theme, () => tplX({ … })));
```

`renderInLang` põe a língua ambiente durante um render **síncrono**. Nunca meter
um `await` dentro do callback: é isso que deixaria outro pedido ver a língua
deste. Dentro dos templates, cada frase escreve-se com `T("português", "english")`
— os dois lados na mesma linha, para que uma tradução não fique para trás quando
a outra é editada. Para blocos que mudam de forma (datas, dinheiro, links com
`/pt`) há o `lang()`.

Emails cobertos: ação necessária (NIF inválido, rascunho, nota de crédito),
resumo diário, resumo semanal de faturas por emitir, limite do plano
InvoiceXpress, verificação de arranque, fim do Early Bird, renovação, faturação
parada, pagamento falhado, preço antigo e convite de utilizador.

Os emails **para ops** (alertas críticos, relatório de padrões, erros do
varrimento) continuam em português: nunca passam por `renderInLang`, portanto
saem na língua por omissão.

## Stripe

A Stripe escreve aos nossos clientes por conta própria — recibos, aviso de cartão
a expirar, página da fatura, portal — e lê a língua do `preferred_locales` do
Customer. Por isso:

- ao gravar a preferência (nos dois sítios) é empurrada para todos os Customers
  da conta, best effort (`syncAccountStripeLocale`);
- um Customer novo já nasce com ela;
- as sessões de portal e de checkout levam `locale`.

## Newsletter

Uma campanha é um HTML numa língua. Não há emparelhamento automático: há um grupo
de filtros **Língua** (`lang:pt` / `lang:en`) na audiência, e é ticá-lo que
impede uma campanha portuguesa de cair numa caixa inglesa. A página de cancelar
subscrição resolve a língua pelo endereço.

## O que fica de fora, e porquê

- **Emails da InvoiceXpress / Moloni / Vendus ao comprador final.** A língua do
  comprador não é a do comerciante; quem escolhe o assunto e o corpo é o
  comerciante, nas definições da ligação.
- **Emails da Clerk** (código de acesso, recuperação de palavra-passe). São
  configurados na consola da Clerk, por instância. O ecrã de login já segue o URL
  (`ClerkProvider localization`), o email não.
- **Relatórios do Dev Mode.** Já eram em inglês e vão para operadores.
- **Contas novas** nascem em `pt`, mesmo que se registem em `/en`. Marcam-se à
  mão, que foi a decisão para este arranque.

Ver também: `docs/ficha-cliente.md`.
