# Newsletter e campanha de convites: o que fica por fazer à mão

Duas funcionalidades novas, cada uma com uma parte que o código não pode ligar
sozinho. Esta é a lista, por ordem.

## 1. Migrações

Aplicar à mão, nunca `d1 migrations apply` (o ledger está preso no 0017 e
repetiria tudo desde a 0018 por cima de colunas que já existem).

```bash
npm run backup
npx wrangler d1 execute rioko-db --remote --file migrations/0056_newsletter.sql
npx wrangler d1 execute rioko-db --remote --file migrations/0057_referrals.sql
```

Confirmar:

```bash
npx wrangler d1 execute rioko-db --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('newsletter_templates','newsletter_campaigns','referral_codes','referrals')"
```

## 2. O topic da Resend

No dashboard da Resend, criar um topic:

| campo | valor |
|---|---|
| name | `Novidades Rioko` |
| defaultSubscription | `opt_in` |
| visibility | `public` |

`visibility` não existe no SDK instalado, por isso o topic tem mesmo de ser
criado no dashboard. Copiar o id para `wrangler.jsonc` → `vars.RESEND_TOPIC_NEWS`
e fazer merge; o CI deploya.

Enquanto estiver vazio os broadcasts saem na mesma, mas sem topic: quem quiser
sair só tem a opção grossa de cancelar tudo, em vez de cancelar a newsletter.

**O que isto não afecta**: emails de incidente, de dunning, de renovação e de
quota. Esses saem por `sendEmail()` → `POST /emails`, que não consulta o flag
`unsubscribed`. É por isso que o rodapé pode prometer, com verdade, que "avisos
de facturação e de serviço continuam a chegar mesmo que cancele estas
comunicações", e é o mesmo contrato que a migração 0046 já faz sobre contas
paradas.

## 3. Carregar os templates

Em `/admin/newsletter`, para cada ficheiro em `Claude outputs/`:

1. escrever o slug (`convite`, `clientes`, `frios`) e o nome;
2. colar o assunto e o HTML;
3. **Gravar template**.

O que o HTML tem de trazer, senão o botão de enviar fica morto e diz porquê:

- `{{{RESEND_UNSUBSCRIBE_URL}}}` — obrigatório, é o que dá saída a quem recebe;
- a empresa e o NIF (vêm de `{{SENDER_COMPANY}}` e `{{SENDER_NIF}}`);
- uma ligação para `rioko.online/pt/privacy`.

Duas sintaxes convivem no mesmo ficheiro e não são a mesma coisa:

| forma | de quem | quando resolve |
|---|---|---|
| `{{VAR}}` | nossa | no envio, igual para toda a gente |
| `{{{VAR}}}` | da Resend | na entrega, por destinatário |

`{{GREETING_NAME}}` é o ponto onde as duas se tocam: resolve para
`{{{contact.first_name|}}}`, que é como cada pessoa é tratada pelo nome sem
existir um ciclo de envio nosso.

## 4. O primeiro envio

1. escolher o template `convite`;
2. filtros: **Já pagou** ou **Bloqueada** (clientes a sério, sem contas de teste);
3. **Simular**, conferir a contagem contra `/admin`;
4. **Enviar teste a mim**, abrir no Gmail e no Outlook;
5. clicar no link de cancelamento do email de teste e confirmar que depois disso
   ainda chega um email de incidente a essa conta. É o contrato inteiro;
6. **Enviar a N**.

O botão de enviar só acende depois de uma simulação feita para exactamente o
texto e os filtros que estão no ecrã. Mudar um caracter deita a simulação fora,
de propósito: uma contagem de antes de uma edição não é uma contagem.

## 5. Campanha de convites

Não precisa de nada no Stripe. O mês grátis do convidado é `early_bird = 1` com
`trial_end` a 30 dias na própria linha de `subscriptions`, que é o que o gate já
lê; não há cupões para criar nem nada para configurar.

Uma subtileza que vale a pena saber, se algum dia parecer que o mês grátis não
apareceu: a linha é por par `(conta, ligação)` desde a 0044, e quem chega por um
link de convite ainda não tem ligação nenhuma. Por isso a graça é reaplicada a
partir de `/api/auth/sync`, que todas as páginas de integração já chamam: seja o
que for que o convidado ligue, o mês grátis assenta lá na visita seguinte. A data
está ancorada no resgate, nunca em "agora", senão cada visita empurrava o fim
mais 30 dias para a frente.

O que convém vigiar, em `/admin/financeiro` → **Convites**:

- **a pagar** — o convidado pagou e o convidante ainda não foi creditado. O
  webhook tenta sozinho em dois momentos (quando o convidado paga, e quando o
  convidante faz um checkout seu). O que ficar aqui tem uma razão, e a razão
  está na nota da linha;
- `no_stripe_customer` — convidante que ainda nunca pagou. Fica em espera e é
  creditado sozinho no primeiro checkout dele. Não é preciso fazer nada;
- `no_ledger_amount` — tem cliente Stripe mas nunca foi facturado, por isso não
  há valor para dobrar. Esse precisa de decisão humana;
- `same_fiscal_id` — as duas contas têm o mesmo NIF. Não é creditado de propósito:
  a copy diz "uma vez por empresa convidada", e um mês pago a comprar dois
  creditados seria lucrativo se nada o travasse;
- `reconciled_from_stripe` — o crédito já estava no Stripe e a linha é que tinha
  ficado para trás. Não é erro, é a linha a apanhar a realidade.

### Reembolsos

**Um reembolso não reverte o crédito**, e isso é decisão, não esquecimento: os
reembolsos são feitos à mão no nosso Stripe, portanto quem os faz já lá está, com
o saldo do convidante a um clique. Automatizar a reversão custava mais do que o
risco.

O passo que falta, quando se reembolsa a **primeira** factura de alguém:

1. em `/admin/financeiro` → **Convites**, procurar a linha em que essa pessoa é a
   convidada. Se não existir nenhuma, ou se estiver em `inscreveu-se`, acabou:
   ninguém foi creditado por ela;
2. se estiver em `creditado`, a linha diz o valor. No Stripe, no cliente do
   **convidante** → *Balance* → *Adjust balance*, lançar esse valor **positivo**
   (o crédito é negativo, logo o simétrico anula-o), com uma descrição a dizer
   porquê.

Não mexer na linha da base de dados: ela é o registo do que aconteceu, e pô-la de
novo a `paid` faz o próximo pagamento do convidante creditar tudo outra vez.

A data de fim (31/10/2026) vive em `CAMPAIGN_END`, em
`backoffice/src/lib/referral.ts`. Fecha o **resgate**, nunca o **crédito**: quem
convidou dentro do prazo recebe, mesmo que o convidado só pague em Novembro. É o
que a copy promete.

## 6. O que ficou deliberadamente de fora

- **Tracking de aberturas e cliques nosso.** A Resend já o dá, e por
  `GET /broadcasts/{id}/recipients` e `/clicked-links`. Não duplicar.
- **Listas frias.** `rioko-cold-pt.html` continua por enviar: a audiência são
  contas registadas em D1, e mandar para uma lista comprada é outra tabela, um
  importador e um risco de RGPD diferente.
- **Link pessoal dentro do email.** O convite leva um link só, para
  `rioko.online/pt/convidar`. Um link pessoal colado no corpo de um email é
  reencaminhado, e um link pessoal reencaminhado credita a conta errada.
- **Uma tabela de destinatários por campanha.** A lista resolvida fica em
  `newsletter_campaigns.recipients_json`, o que chega para uma frota desta
  dimensão. Parte-se em tabela quando alguém quiser cruzar aberturas com contas.
