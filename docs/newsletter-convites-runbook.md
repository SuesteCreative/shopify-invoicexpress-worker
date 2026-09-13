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

**Regras**: convida 1 amigo, recebem os dois 2 meses. Quem convida precisa de
subscrição activa; quem é convidado conclui o onboarding, deixa cartão e é
cobrado ao fim do 2.º mês. Máximo 3 recompensas por conta, 6 meses. Resgates até
31/10/2026.

**Não precisa de nada no Stripe.** Não há cupões. Os dois meses do convidado são
um trial nativo (`trial_end` na Checkout Session); os do convidante são o mesmo
`trial_end`, empurrado na subscrição que já corre. Isso move o
`billing_cycle_anchor` com ele, que é o que faz a próxima cobrança acontecer dois
meses mais tarde e o que trata o plano anual como foi prometido.

**O link** é `RIO-XXXXXX-YYYYYY`: o número de cliente da ficha, mais um sufixo
aleatório que o torna não-adivinhável. Um número por cliente, e o sufixo é o que
mantém a regra da 0058 de que o número nunca abre uma página pública nu.

### O que vigiar, em `/admin/financeiro` → Convites

A coluna que interessa é **`invitee_paid`**: a recompensa é dada quando a
subscrição do convidado é criada, o que acontece **antes de ter entrado dinheiro
nenhum**. Foi uma decisão deliberada, e é isto que a torna visível. Uma linha
creditada há meses cujo convidado nunca pagou é a forma que o abuso tem.

Estados e notas possíveis:

- `subscribed` — o convidado subscreveu e a recompensa não foi dada. A nota diz
  porquê. O botão **Creditar** volta a tentar;
- `inviter_no_live_subscription` — quem convidou não tinha subscrição activa
  nessa altura. Fica em espera, e é decisão humana quando passar a ter;
- `same_fiscal_id` — os dois lados têm o mesmo NIF. **Não é creditado de
  propósito**: os termos dizem uma vez por empresa, e um mês pago a comprar dois
  creditados seria lucrativo se nada o travasse;
- `cap_reached` — a 4.ª recompensa daquela conta. Registada, não paga.

### Reembolsos

**Um reembolso não reverte a recompensa automaticamente**, e isso é decisão: os
reembolsos são feitos à mão no nosso Stripe, portanto quem os faz já lá está.

O passo que falta, quando se reembolsa a **primeira** factura de alguém:

1. em `/admin/financeiro` → **Convites**, procurar a linha em que essa pessoa é a
   convidada. Se não existir, ou estiver em `inscreveu-se`, acabou;
2. se estiver em `creditado`, a linha diz até quando a subscrição de quem
   convidou foi empurrada. No Stripe, nessa subscrição, encurtar o `trial_end`
   para a data que tinha antes. A cláusula 9 dos termos guarda-nos esse direito.

Não mexer na linha da base de dados para a pôr outra vez a `pending`: isso faz a
subscrição seguinte do convidado creditar tudo de novo.


## 6. O que ficou deliberadamente de fora

- **Tracking de aberturas e cliques nosso.** A Resend já o dá, e por
  `GET /broadcasts/{id}/recipients` e `/clicked-links`. Não duplicar.
- **Listas frias.** `rioko-cold-pt.html` continua por enviar: a audiência são
  contas registadas em D1, e mandar para uma lista comprada é outra tabela, um
  importador e um risco de RGPD diferente.
- **Link pessoal dentro do email.** O convite leva um link só, para a página de
  Faturação, onde cada um encontra o seu. Um link pessoal colado no corpo de um
  email é reencaminhado, e um link pessoal reencaminhado credita a conta errada.
- **Reversão automática de recompensa num reembolso.** Ver a secção 5.
- **Uma tabela de destinatários por campanha.** A lista resolvida fica em
  `newsletter_campaigns.recipients_json`, o que chega para uma frota desta
  dimensão. Parte-se em tabela quando alguém quiser cruzar aberturas com contas.
