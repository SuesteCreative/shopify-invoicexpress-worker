# Newsletter e campanha de convites: o que fica por fazer à mão

Duas funcionalidades novas, cada uma com uma parte que o código não pode ligar
sozinho. Esta é a lista, por ordem.

## 1. Migrações

**Feito a 13/09/2026**: 0056, 0057 e 0058 aplicadas à mão em produção. Nunca
`d1 migrations apply` (o ledger está preso no 0017 e repetiria tudo desde a 0018
por cima de colunas que já existem).

Foi assim, e é assim se alguma vez for preciso repetir noutra base:

```bash
npm run backup
npx wrangler d1 execute rioko-db --remote --file migrations/0056_newsletter.sql
npx wrangler d1 execute rioko-db --remote --file migrations/0057_referrals.sql
npx wrangler d1 execute rioko-db --remote --file migrations/0058_client_code.sql
```

A 0057 foi reescrita antes de correr: a primeira versão trazia uma tabela
`referral_codes`, que nunca existiu em produção e já não existe no ficheiro. O
código de convite é o número de cliente da 0058 mais `users.referral_suffix`.

Confirmar (devolve 6 linhas; menos do que isso é uma migração por aplicar). As
colunas lêem-se do `sql` guardado em `sqlite_master`, que o `ALTER TABLE ... ADD
COLUMN` reescreve, para não depender de pragmas:

```bash
npx wrangler d1 execute rioko-db --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('newsletter_templates','newsletter_campaigns','referrals')
   UNION ALL SELECT 'users.referral_suffix' FROM sqlite_master WHERE type='table' AND name='users' AND sql LIKE '%referral_suffix%'
   UNION ALL SELECT 'users.client_code' FROM sqlite_master WHERE type='table' AND name='users' AND sql LIKE '%client_code%'
   UNION ALL SELECT 'subscriptions.reward_until' FROM sqlite_master WHERE type='table' AND name='subscriptions' AND sql LIKE '%reward_until%'"
```

## 2. O topic da Resend

No dashboard da Resend, criar um topic:

| campo | valor |
|---|---|
| name | `Novidades Rioko` |
| defaultSubscription | `opt_in` |
| visibility | `public` |

`visibility` não existe no SDK instalado, por isso o topic tem mesmo de ser
criado no dashboard (Audience → separador Topics). Copiar o id para
`wrangler.jsonc` → `vars.RESEND_TOPIC_NEWS` e fazer merge; o CI deploya.

**Feito a 13/09/2026**: id `22e21222-c176-40b1-9e3d-23cc684ba99b`. A página de
cancelamento da Resend (Audience → Topics → Page) usa a pele Day: fundo
`#F6F3EE`, texto `#111111`, destaque `#C75C4A`, logo `rioko2-logo-light2.png`.

Se alguma vez voltar a ficar vazio, os broadcasts saem na mesma, mas sem topic:
quem quiser sair só tem a opção grossa de cancelar tudo, em vez de cancelar a
newsletter.

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

**Feito a 13/09/2026 para o `convite`**: carregado de
`Claude outputs/rioko-convite-pt.final.html`, com o campo **Pré-visualização na
caixa de entrada** vazio. De propósito: o HTML traz o seu próprio preheader (o
`div` escondido a seguir ao comentário `<!-- preheader -->`), e preencher também
o campo põe um segundo preheader no email, que a caixa de entrada mostra a
seguir ao primeiro: a mesma frase duas vezes. Regra para os próximos: se o
ficheiro já traz preheader, o campo fica vazio.

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
2. filtros: **só Activa, no grupo Subscrição** (`sub:active`), e mais nada. Não
   **Já pagou** nem **Bloqueada**: uma conta bloqueada, ou que nunca pagou, não
   pode convidar, porque o link só é aceite a quem tem uma subscrição Stripe
   `active` ou `trialing`. O email estaria a oferecer uma coisa que o servidor
   depois lhe recusa. Atenção ao outro chip **Activa**, no grupo Conta
   (`not_inactive`): quer dizer "não parada" e não serve para isto;
   - o limite conhecido: `sub:active` deixa de fora quem paga em trial Stripe
     (convidados ainda nos meses grátis, convidantes com uma recompensa a
     correr). No primeiro envio ainda não há nenhum. Juntar **Em período livre**
     não resolve, porque apanha também os early birds sem subscrição Stripe, que
     não podem convidar;
3. **Simular**, conferir a contagem contra `/admin`;
4. **Enviar teste a mim**, abrir no Gmail e no Outlook. Serve para o aspecto,
   **não para o cancelamento**: o teste sai como email transaccional
   (`/admin/notify`), não como broadcast, e as tags da Resend
   (`{{{RESEND_UNSUBSCRIBE_URL}}}`, `{{{contact.first_name|}}}`) chegam
   literais. Vê-las literais prova que sobreviveram até ao payload; o link de
   cancelamento do teste não leva a lado nenhum;
5. **Enviar a N**. O servidor resolve a audiência outra vez e **recusa (409) um
   envio cuja contagem não seja a da simulação**: alguém registou-se ou cancelou
   entre Simular e Enviar. Simular de novo, conferir, enviar;
6. o contrato de cancelamento verifica-se na **cópia real do broadcast**, numa
   caixa nossa que esteja na lista simulada: clicar no link de cancelamento,
   confirmar que abre a página da Resend com o topic **Novidades Rioko**, e
   confirmar que depois disso ainda chega um email de incidente a essa conta. É o
   contrato inteiro.

O botão de enviar só acende depois de uma simulação feita para exactamente o
texto e os filtros que estão no ecrã. Mudar um caracter deita a simulação fora,
de propósito: uma contagem de antes de uma edição não é uma contagem. O botão é
só a metade do browser; a recusa do passo 5 é a metade que o servidor garante.

## 5. Campanha de convites

**Regras**: convida 1 amigo, recebem os dois 2 meses grátis.

- **Quem convida** precisa de conta activa **e** de subscrição activa: `active`,
  ou um trial Stripe pago (`trialing` com subscrição Stripe por trás). O código
  só verifica a **subscrição**, quando o link é resgatado e outra vez quando a
  recompensa é dada. A conta activa não é verificada automaticamente (uma conta
  parada com subscrição viva convida e é paga): fica à decisão da Kapta.
- **Quem é convidado** tem de ser cliente novo (conta criada há 7 dias ou menos,
  nunca teve subscrição Stripe), concluir o onboarding e deixar cartão. A
  subscrição nasce com um trial Stripe de 2 meses de calendário e é cobrada
  sozinha no fim do 2.º mês.
- **A recompensa de quem convida** são 2 meses empurrados na subscrição que já
  corre (a próxima cobrança passa 2 meses para a frente, também no anual), dada
  quando a subscrição do convidado é criada.
- Convites ilimitados, **máximo 3 recompensas = 6 meses** por conta.
- A campanha acaba a **31/10/2026** (`CAMPAIGN_END` em
  `backoffice/src/lib/referral.ts`): a subscrição do convidado tem de ser criada
  até lá. Termos em `/pt/campanha-convites`.

**Não precisa de nada no Stripe.** Não há cupões. Os dois meses do convidado são
um trial nativo (`trial_end` absoluto na Checkout Session, e a subscrição leva
`metadata.referral_role = invitee`); os do convidante são o mesmo `trial_end`,
empurrado na subscrição que já corre. Isso move o `billing_cycle_anchor` com
ele, que é o que faz a próxima cobrança acontecer dois meses mais tarde e o que
trata o plano anual como foi prometido. O webhook só paga o convidante numa
subscrição criada com esse `referral_role`.

**O link** é `RIO-XXXXXX-YYYYYY`: o número de cliente da ficha, mais um sufixo
aleatório que o torna não-adivinhável. Um número por cliente, e o sufixo é o que
mantém a regra da 0058 de que o número nunca abre uma página pública nu. Cada
conta vê o seu no cartão de convites, em **Faturação** e em **Conta**.

### Antes de lançar: avisar a contabilidade

**Os meses de recompensa não têm fatura nenhuma.** Não há linha de desconto nem
nota de crédito: o Stripe não cobra nada nesses meses, por isso não há pagamento
a facturar nem documento Kapta a associar. É só receita que não entra. O mesmo
vale para os 2 meses do convidado: o Stripe regista uma invoice de 0 € no início
do trial, sem pagamento, e ela não gera documento na Kapta. A cláusula 10 dos
termos enquadra isto como desconto excluído do valor tributável (art. 16.º,
n.º 6, al. b) do CIVA). A contabilidade tem de o saber, e concordar, antes de o
email sair.

### O que vigiar, em `/admin/financeiro` → cartão Convites

O cartão é o `ReferralsCard`, montado no `FinancePanel`. Estados das linhas:
`inscreveu-se` (pending), `subscreveu, por pagar` (subscribed), `creditado`
(rewarded, com `até dd/mm/aaaa`) e `anulado` (void).

A coluna que interessa é **se o convidado já pagou**: a recompensa é dada quando
a subscrição do convidado é criada, o que acontece **antes de ter entrado
dinheiro nenhum** (a invoice de 0 € do trial não conta). Foi uma decisão
deliberada, e o cartão torna-a visível: a linha diz `convidado ainda não pagou`
e o cabeçalho conta `N creditados a quem nunca pagou`. Uma linha creditada há
meses cujo convidado nunca pagou é a forma que o abuso tem.

**Os botões.** **Tentar de novo** e **Anular** só aparecem nas linhas em
`subscreveu, por pagar`. **Tentar de novo** põe a linha outra vez em `pending` e
passa-a pela mesma função que o webhook usa (`rewardInviter`), que volta a
verificar todas as regras; se não pagar, o cartão mostra `Não foi pago: <razão>`.
**Anular** fecha a linha com a razão `admin`, e só enquanto não foi paga.

**Razões que ficam na linha**, todas escritas por `rewardInviter` em
`backoffice/src/lib/referral-reward.ts`:

Anulada (`anulado`, final, sem botões):

- `after_campaign` — a subscrição do convidado foi criada depois de 31/10/2026.
  Lida da data guardada na linha, não do dia da tentativa;
- `cap_reached` — quem convidou já tem 3 recompensas. Registada, não paga;
- `same_fiscal_id` — os dois lados têm o mesmo NIF. **Não é creditado de
  propósito**: os termos dizem uma vez por empresa, e um mês pago a comprar dois
  creditados seria lucrativo se nada o travasse;
- `admin` — anulada à mão no botão **Anular** (escrita pela rota de admin, não
  por `rewardInviter`).

Em espera (`subscreveu, por pagar`, com a razão a vermelho e os dois botões):

- `inviter_no_live_subscription` — quem convidou não tinha, em D1, subscrição
  Stripe `active` ou `trialing` quando a do convidado foi criada. **Nada volta a
  tentar sozinho.** A cláusula 7 é uma revisão manual: se a subscrição de quem
  convidou voltar a ficar activa antes do fim da campanha, a pessoa pede o
  prémio para pedro@kapta.pt, decide-se, e carrega-se em **Tentar de novo** (ou
  **Anular**);
- `inviter_subscription_dead` — a D1 dizia activa, mas o Stripe diz `canceled`,
  `unpaid` ou `incomplete_expired`;
- `no_period_end` — o Stripe não devolveu data de fim de período. Não se
  adivinha;
- `inviter_subscription_ending` — a subscrição tem `cancel_at` ou
  `cancel_at_period_end`. O Stripe acaba-a nessa data digam o que disserem os
  dois meses, que ficariam prometidos e nunca dados (fim do preço legacy, cliente
  de saída);
- qualquer outro texto — a mensagem de erro do Stripe na chamada, cortada a 200
  caracteres. Perceber o erro antes de tentar de novo.

Creditada, com nota (`creditado`, com texto a vermelho ao lado):

- `fiscal_id_lookup_failed: <mensagem do Stripe>` — a recompensa **foi paga**,
  mas a verificação do mesmo NIF não conseguiu ler o NIF do Checkout do
  convidado e só comparou o que estava guardado na D1. Comparar à mão, no
  Stripe, o campo `nif` da Checkout Session do convidado com o NIF de quem
  convidou. Se forem iguais, desfazer pelos passos das **Reversões** abaixo:
  **Anular** não mexe numa linha já paga.

A mesma nota pode vir colada a uma razão de espera
(`inviter_no_live_subscription; fiscal_id_lookup_failed: …`): a linha ficou em
espera e a verificação do NIF correu sem o Checkout. **Tentar de novo** volta a
verificar tudo, NIF incluído.

`missing_input`, `no_inviter` e `not_pending` nunca ficam na linha: só aparecem
nos logs do Pages (`[referral]`, `[admin/referrals]`) e na mensagem do botão.
`not_pending` é o normal numa re-entrega do mesmo evento, e o webhook nem o
regista.

### Reversões: cancelamento, falha, reembolso, estorno

**Nada reverte uma recompensa automaticamente**, e isso é decisão: os
reembolsos são feitos à mão no nosso Stripe, portanto quem os faz já lá está. A
cláusula 9 reverte a recompensa quando o convidado cancela nos 2 meses grátis,
ou quando o primeiro pagamento falha de vez, é reembolsado, anulado ou estornado
nos 60 dias seguintes.

1. em `/admin/financeiro` → **Convites**, procurar a linha em que essa pessoa é a
   convidada. Se não existir, ou não estiver em `creditado`, acabou;
2. a linha diz até quando a subscrição de quem convidou foi empurrada. No Stripe,
   nessa subscrição, pôr o `trial_end` na data que tinha antes (dois meses
   antes; com recompensas empilhadas, o `até` da recompensa anterior), sem
   prorrata. **Nunca `trial_end = now`**: acaba o trial já, cobra um período
   inteiro hoje e muda o dia de cobrança para hoje. Tirar também o
   `rioko_reward_until` do metadata;
3. na D1, com os ids inteiros:

   ```bash
   npx wrangler d1 execute rioko-db --remote --command \
     "UPDATE subscriptions SET reward_until = (SELECT MAX(reward_until) FROM referrals WHERE inviter_user_id = 'user_DO_CONVIDANTE' AND state = 'rewarded' AND invitee_user_id <> 'user_DO_CONVIDADO') WHERE stripe_subscription_id = 'sub_DO_CONVIDANTE'"
   npx wrangler d1 execute rioko-db --remote --command \
     "UPDATE referrals SET state = 'void', void_reason = 'reversed' WHERE invitee_user_id = 'user_DO_CONVIDADO'"
   ```

   Sem o primeiro, o cartão de subscrição continua a dizer "meses grátis até"
   uma data que já não é verdade. Não é um `NULL` às cegas: repõe o `até` da
   recompensa anterior de quem convidou (a mesma data que o passo 2 pôs no
   `trial_end`) e só dá `NULL` quando esta era a única. Com `NULL` e o trial
   anterior ainda a correr no Stripe, o painel chamava trial a um cliente que
   paga. O segundo liberta a vaga no limite de 3 (que
   conta só `rewarded`). O contador `meses dados` do cartão soma `reward_months`
   de todas as linhas, anuladas incluídas.

**Não pôr a linha outra vez a `pending`**: o Checkout seguinte do convidado
voltava a abrir com 2 meses grátis e a creditar quem convidou de novo.

### Teste ao vivo, sem estragar nada

As chaves Stripe são só live. Cada passo mexe em subscrições reais, por isso o
teste tem de acabar desfeito.

1. **Convidante**: uma conta interna com uma subscrição Stripe activa que se
   aceita empurrar dois meses. Antes de começar, anotar no Stripe o fim de
   período actual dessa subscrição (a data da próxima fatura): é a data a repor
   no fim.
2. Nessa conta, em **Faturação**, copiar o link do cartão de convites.
3. **Convidado**: abrir o link numa janela privada e, nesse browser, criar uma
   conta nova com um email novo, no mesmo separador ou noutro (o código fica em
   `localStorage` 7 dias, e a verificação do email pode abrir outro separador).
   Depois do registo aparece um aviso: `Convite registado nesta conta…` quando
   foi aceite, ou `Não foi possível usar o convite` com a razão (conta com mais
   de 7 dias, conta que já tem subscrição, o próprio link, quem convidou sem
   subscrição activa, campanha terminada, conta já convidada por outra pessoa).
   Conferir a linha `inscreveu-se` no cartão Convites.
4. Concluir o onboarding do convidado com **um NIF diferente** do da conta
   convidante (o mesmo NIF anula com `same_fiscal_id`) e um cartão real. O
   Checkout tem de mostrar os 2 meses grátis e 0 € hoje. Se mostrar o preço
   cheio, a linha não estava em `pending`: parar e não pagar.
5. Conferir: a linha passa a `creditado · até dd/mm/aaaa`; no Stripe, a
   subscrição do convidante fica `trialing` com `trial_end` nessa data e
   `rioko_reward_until` no metadata; a do convidado fica `trialing` com
   `referral_role = invitee`.
6. Desfazer, por esta ordem:
   1. no Stripe, **cancelar a subscrição do convidado já, antes do fim do
      trial**. Nada é cobrado;
   2. no Stripe, repor o `trial_end` da subscrição do convidante na data anotada
      no passo 1, sem prorrata e nunca `now`, e tirar o `rioko_reward_until` do
      metadata;
   3. na D1, os dois `UPDATE` das reversões acima, com `void_reason = 'test'` em
      vez de `'reversed'`.

## 6. O que ficou deliberadamente de fora

- **Tracking de aberturas e cliques nosso.** A Resend já o dá, e por
  `GET /broadcasts/{id}/recipients` e `/clicked-links`. Não duplicar.
- **Listas frias.** `rioko-cold-pt.html` continua por enviar: a audiência são
  contas registadas em D1, e mandar para uma lista comprada é outra tabela, um
  importador e um risco de RGPD diferente.
- **Link pessoal dentro do email.** O convite leva um link só, para a página de
  Faturação, onde cada um encontra o seu. Um link pessoal colado no corpo de um
  email é reencaminhado, e um link pessoal reencaminhado credita a conta errada.
- **Reversão automática de uma recompensa** (cancelamento no período grátis,
  reembolso, estorno). Ver a secção 5.
- **Nova tentativa automática de uma recompensa suspensa.** A cláusula 7 diz que
  é pedida por email e revista; o botão **Tentar de novo** é o caminho.
- **Uma tabela de destinatários por campanha.** A lista resolvida fica em
  `newsletter_campaigns.recipients_json`, o que chega para uma frota desta
  dimensão. Parte-se em tabela quando alguém quiser cruzar aberturas com contas.
