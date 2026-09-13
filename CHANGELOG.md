# 📜 Rioko — Registo de versões

Cada entrada é uma versão do produto. O cabeçalho é lido por `backoffice/scripts/sync-version.mjs`,
que gera `src/lib/version.ts` e `src/lib/changelog.generated.ts` — o rodapé do painel e a página
`/changelog` saem daqui. O comentário `<!-- release: sha -->` marca o último commit incluído na
versão, e é o ponto de partida de `npm run release` para a versão seguinte.

## ✨ Version 8.7.0 — A customer number that outlives the account it named — September 13, 2026

<!-- release: ccf985b -->

### Para o comerciante

- Convida quem quiser e ganha 2 meses por cada pessoa que ligar uma integração. O teu link está em Convidar, no menu.
- Nada. Correcção de ferramentas internas.
- Tem uma página Conta nova, com o seu código de cliente e os seus dados. Pode corrigir nome, telefone, website e morada; o NIF e o nome fiscal ficam em leitura, com um botão para nos pedir a alteração — são o que sai impresso nas faturas que já lhe emitimos.

### Novo

- **clientes** — a customer number that outlives the account it named
- **admin** — one page that is the whole customer
- **conta** — the merchant reads their own record, and asks for the rest
- **admin** — the name and the number open the record, and the operator can act on it
- **admin** — grant a fiscal change request in one click

### Corrigido

- **release** — stop a release going out silent to the people it is for

### Documentação

- **changelog** — v8.6.0 — Convide um amigo, ganhe 2 meses
- **ficha** — say where the work landed and what is still owed

## ✨ Version 8.6.0 — Convide um amigo, ganhe 2 meses — September 13, 2026

<!-- release: 9cd2d1e -->

### Para o comerciante

- Convida quem quiser: por cada pessoa que entrar pelo teu link e ligar uma integração, ganhas 2 meses. Quem entra tem o primeiro mês grátis, sem cartão. O teu link está em **Convidar**, no menu.
- O cartão da subscrição passa a mostrar o preço que pagas mesmo. Quem está no plano antigo via 75 €/ano no painel e pagava 50 €.
- Uma ligação deixa de poder ficar activa sem as credenciais do destino. Havia contas subscritas, com tudo verde, que não emitiam nada e não davam sinal.
- Nos assistentes de integração, a explicação da opção de IVA passa a dizer o que ela faz mesmo. Prometia somar 23% em sete dos nove sítios onde nem sequer era lida.

### Novo

- **audit** — a check for the regime, not just the total
- **audit** — say which rule set each rate, not just the rate
- **audit** — check the exemption code against where the zero lines went
- **admin** — sort integrations by date, newest first, with an order toggle
- **shopify** — give the legacy integrations an invoice cutoff
- **admin** — replace a wrong Kapta service invoice, by its number
- **invoicexpress** — let a connection hold its own credentials
- **verify** — say so when a document's exemption code contradicts its buyer
- **billing** — one catalogue, every sellable pair, at the price it should be
- **billing** — the catalogue tool also fixes the products it skips
- **billing** — the seat product gets the template too
- **newsletter** — write to the client list, and let them leave
- **referral** — convide um amigo, ganhe 2 meses

### Corrigido

- **audit** — stop reporting the normal rate on shipping as a deviation
- **onboarding** — put the finish panel under the last step, not above the first
- **connections** — stop a connection going live without credentials, and say so when it does
- **admin** — read the Kapta number the way the document prints it
- **billing** — match a payment on who the account is, not on the price alone
- **billing** — match the Kapta document on Stripe's invoice number
- **api** — stop shipping connection credentials to the browser
- **api** — keep the legacy integration credentials on the server
- **billing** — never match a payment to a cancelled Kapta document
- **wizards** — the InvoiceXpress credentials go on the connection, not on Shopify's row
- **wizards** — stop promising that the VAT toggle adds 23%
- **seats** — the pool is the record, and the money is checked before the seat
- **subscriptions** — the panel and the gate stop disagreeing about the last day
- **billing** — a lookup key beats an id in the price book
- **billing** — serve the product image from a path nothing has 404ed
- **billing** — move the default price before archiving the one it replaces
- **billing** — the card says what the client pays, and a pair needs one list less
- **referral** — put the free month where the gate will look for it
- **marketing** — the eight defects an adversarial review confirmed

### Arquitectura

- **admin** — the subscription gate as one expression, not three

### Documentação

- **changelog** — v8.5.0 — A version ladder, and patch notes for two audiences
- **architecture** — the credential rule, next to the two tables that hold them
- **marketing** — the parts nobody can ship for you
- **referral** — how to undo a credit when a refund is made by hand

## ✨ Version 8.5.0 — A version ladder, and patch notes for two audiences — September 12, 2026

<!-- release: 9e047dd -->

### Para o comerciante

- A versão no fundo do menu lateral passa a abrir as notas de versão, com o que mudou para ti em cada uma.

### Novo

- **changelog** — a version ladder, and patch notes for two audiences

### Manutenção

- close the gitignore holes, and a backfill for the credentials already logged

## ✨ Version 8.4.0 — Consola financeira, fim do preço antigo e OAuth Shopify — September 12, 2026

<!-- release: 3d66552 -->

### Para o comerciante

- **O preço antigo (5 €/50 €) termina numa data marcada.** Quem está nele continua a ser cotado e cobrado por esse preço até lá, e é avisado antes de a data chegar.
- **Ligar a Shopify deixa de exigir copiar um token** — a autorização volta para a Rioko e os webhooks instalam-se sozinhos.
- O aviso de facturação parada passa a ter um botão que leva directamente ao pagamento.
- Convites de onboarding com o pagamento já tratado, para quem é trazido por nós.

### Novo

- **Secção financeira no `/admin`** — o que está contratado ao lado do que foi pago, com a lista de valores em aberto a dizer a que respeita cada factura.
- **Plano do cliente passa a ser um facto guardado**, não uma derivação; os preços em falta podem ser criados a partir da consola.
- **Fim do preço legacy** — a data vive na Stripe, o preço antigo é nomeado e contado, e o convite emitido nesse preço marca o cliente como estando nele.
- **Método 2 de onboarding da Shopify** documentado por inteiro no helper, cada método na sua dobra.
- **Email quando um build do worker falha**, que antes não tinha quem o lesse.

### Corrigido

- O upsert de subscrição passa a ligar a ligação que lhe foi dada.
- O MRR deixa de avaliar nove subscrições activas a zero, e a lista de falhados deixa de chamar delinquentes a clientes que pagaram.
- Um early bird expirado deixa de ser tratado como early bird.
- `read_all_orders` não pode ser pedido, por isso deixámos de o pedir.
- O aviso de conta suspensa chega a todas as páginas, não só às quatro que se lembravam dele.
- No helper: o Método 1 deixa de culpar um scope que não existe, e o App URL do runbook deixa de apontar para um erro de certificado.

### Arquitectura

- Um único `cn()` em vez de quinze cópias.
- O poller de reservas Lodgify sai do entrypoint do worker.
- O catálogo de plataformas deixa de importar `lucide-react`, e o worker volta a poder ser deployado.
- Removidos `rioko-next` e `src/.old`; o CI passa a correr numa versão de Node suficiente para os testes.

## 🌐 Version 8.3.0 — Superfície pública e painel /admin — September 11, 2026

<!-- release: 823b8a3 -->

**Destaque:** o produto passa a ter uma cara pública por vertical e um painel de administração fora da árvore de rotas do comerciante. Onde havia uma landing genérica e páginas de admin misturadas com as do cliente, passa a haver uma landing por plataforma de origem, uma entrada única de onboarding, e `rioko.online/admin` com visão de frota.

### Para o comerciante

- O site público passa a ter uma página por plataforma (Shopify, Stripe, Lodgify), uma página de preços e uma comparação entre InvoiceXpress, Moloni e Vendus.
- Ligar uma integração nova faz-se a partir de um único link de onboarding, que pergunta o que queres ligar.
- Nada muda na facturação de quem já está ligado.

### Novo — Público

- **Uma landing por vertical** — `/shopify`, `/stripe` e `/lodgify`, cada uma com a sua promessa, em vez de uma landing a tentar falar para todos.
- **Página de preços própria** (`/pricing`) em vez de uma âncora na home.
- **Comparação InvoiceXpress vs Moloni vs Vendus** — página de conteúdo para quem ainda está a escolher facturador.
- **Onboarding público unificado** — uma entrada que pergunta o que o cliente vem ligar e encaminha para o par certo, incluindo Stripe Connect → InvoiceXpress e as páginas guiadas da Lodgify (para IX e para Moloni).
- **Saída da conta errada** — quem chega a um link de onboarding já autenticado noutra conta tem por onde sair, em todas as páginas guiadas.

### Novo — Administração

- **`rioko.online/admin`** — os painéis de administração saem da árvore de rotas do comerciante e passam a ter superfície própria.
- **Visão de frota** — vista geral do que a frota facturou, todas as integrações (incluindo as que ninguém terminou), e impersonação directa para dentro de uma integração.
- **Gestão de legado** — integrações antigas podem ser arrumadas, e apagar um utilizador deixa de deixar canos pendurados.

### Novo — Fiscal e legal

- **Registos fiscais declarados no wizard** — o comerciante diz para que está registado (OSS, autoliquidação, isenção) em vez de se inferir.
- **Política alinhada com a Kapta** — entidade, NIPC e cláusulas revistas; links legais em todos os rodapés.

### Corrigido

- SEO: `robots.txt` com regras que batem certo com os URLs servidos, canónicos nas páginas legais, `noindex` na autenticação, artigos PT deixam de ser anunciados como ingleses, e as páginas de conteúdo deixam de ser órfãs.
- O selo Rioko nas páginas de onboarding é um asset, não uma rota — o build do Cloudflare Pages volta a passar.
- Barras invisíveis nos gráficos da vista geral, e a vista geral deixa de afirmar mais do que sabe.
- Arredondamento numa linha de portes dividida deixa de declarar uma isenção que não existe.
- Cada par Lodgify factura o seu preço, e o cartão do painel deixa de adivinhar.
- A etiqueta de analítica reporta de todos os documentos, não de um em três.

## 🌗 Version 8.2.0 — Motor de IVA unificado, Day Mode e checkout embutido — September 10, 2026

<!-- release: b84d7ad -->

**Destaque:** uma só decisão fiscal passa a servir todos os destinos, e o painel ganha uma segunda pele — Day Mode — que também veste os emails.

### Para o comerciante

- **Tema claro** — o painel passa a abrir em modo claro, e podes trocar a qualquer momento. Os emails seguem o tema que escolheres.
- **IVA pela morada do comprador** — quando a plataforma de origem não cobra imposto, a taxa passa a ser decidida pelo país do comprador, com as taxas dos Açores e da Madeira a seguirem o domicílio.
- **Todos os códigos de isenção da AT** ficam disponíveis para escolha, não só os mais comuns.

### Novo — Fiscalidade

- **Decisão única de IVA** — um motor decide o regime (interno, OSS, autoliquidação, isenção) e o resultado chega igual a InvoiceXpress, Moloni e Vendus.
- **IVA pela morada do comprador** quando a origem não cobra imposto nenhum.
- **Taxas regionais** — Açores e Madeira seguem o domicílio do cliente.
- **Tabela AT completa** — todos os códigos de isenção são seleccionáveis, não só os cinco habituais.

### Novo — Interface

- **Day Mode** — pele clara de administração Kapta ao lado do chrome escuro, e passa a ser o defeito.
- **Emails com a mesma pele** — o comerciante recebe emails no skin que escolheu, não um email escuro pintado de claro.
- **Checkout embutido** — o formulário de cartão vive na página de onboarding em vez de saltar para a Stripe.

### Alterado

- A integração Stripe original passa a chamar-se **Stripe Legacy**; o caminho novo é Stripe Connect.
- Stripe Connect ganha wizard para InvoiceXpress e pode ser exercitado em modo de teste, com eventos de teste proibidos de gerar documento.

### Corrigido

- Overrides de taxa, série e tipo de documento passam a pertencer à integração, não à conta.
- Uma consulta com âmbito de loja deixa de devolver linhas de outra integração, e gravar um wizard deixa de apagar as definições de outro.
- Um pagamento activa a ligação que o comerciante tem de facto.
- Um id de analítica do comprador deixa de ser carimbado como número de contribuinte.
- O callback do Moloni é o mesmo para todos, por isso coincide sempre; e gravar definições deixa de sobrepor um token que rodou a meio do pedido.
- Títulos com gradiente deixam de cortar os descendentes; o botão dos emails Day fica centrado.

## 🔌 Version 8.1.0 — Stripe Connect e isolamento entre integrações — September 9, 2026

<!-- release: 78922d8 -->

Segunda porta de entrada na Stripe, por OAuth dos dois lados, e o fim da fuga de configuração fiscal entre integrações da mesma conta.

### Para o comerciante

- **Stripe Connect** — podes ligar a Stripe autorizando a Rioko na tua conta, sem copiar chaves nem partilhar passwords. O mesmo para o Moloni.
- Integrações que ficaram a meio aparecem no painel e podem ser apagadas.

### Novo

- **Stripe Connect → Moloni** — ligação por OAuth em ambos os lados; a Rioko nunca guarda uma password do comerciante.
- **Integrações inacabadas visíveis** — uma integração a meio aparece no painel, e qualquer uma pode ser apagada.
- **Cartões de superadmin por ligação** — um cartão é uma ligação, não uma conta.

### Corrigido

- As definições fiscais de uma integração deixam de chegar a outra, e a taxa de IVA de uma ligação deixa de ser derrubada pela da vizinha.
- Uma ligação Connect sem password pode mesmo assim ser activada; uma ligação abandonada deixa de fazer sombra a uma que funciona; as rotas de recuperação sabem encontrar uma ligação Connect.
- A cura noturna da Stripe corre com a configuração real do comerciante.
- Cinco países que a InvoiceXpress escreve à sua maneira; a guarda da nota de crédito lia a resposta um nível acima do certo.
- Um early bird com data já passada é recusado, não gravado; renomear faz-se clicando no nome; o caixote do lixo do cartão diz que apaga a conta.

## 🚀 Version 8.0.0 — Proxy IX próprio, série e subscrição por ligação — September 8, 2026

<!-- release: a709520 -->

**Destaque:** o transporte para a InvoiceXpress passa a ser nosso, e a unidade de facturação da plataforma deixa de ser a conta e passa a ser a ligação.

### Para o comerciante

- **A subscrição passa a ser por integração.** Cada integração ligada paga o seu plano; quem tem duas passa a ver duas linhas. Se tens uma só, nada muda no valor.
- Cada integração arquiva os documentos na sua própria série, definida por ti.
- Vendas noutra moeda são facturadas em euros, convertidas à taxa do dia da venda.
- Se a facturação parar por falta de pagamento, recebes um aviso a dizer quantas facturas estão à espera. São emitidas assim que regularizares.

### Novo

- **Proxy IX reconstruído** — todos os documentos passam por um proxy que podemos alterar (`ix.rioko.online`), com paridade de comportamento verificada antes do corte.
- **Série por ligação** — cada ligação arquiva os seus documentos na sua série.
- **Subscrição por ligação** — uma subscrição paga uma integração, não a conta inteira; uma cobrança falhada gera email para quem a pode resolver.
- **Regra de etiqueta em todos os caminhos** — a etiqueta decide documento e série em qualquer rota que emita, não só no webhook principal.
- **Encomendas a prazo** — uma encomenda grossista a prazo é facturada quando é colocada.
- **Aviso de facturação parada** — o comerciante é informado de que parou, e de quantas facturas estão à espera.

### Corrigido

- **O host de conta que chamávamos em produção não existe** — a escolha de série nunca chegava a acontecer.
- Moeda estrangeira: uma venda que o processador nunca converteu é facturada em euros à taxa do dia, e a guarda de moeda deixa de travar a emissão.
- A finalização pela Stripe pergunta o que foi realmente pago antes de certificar; uma ligação demasiado grande para um pedido é percorrida em lotes.
- Uma nota de crédito tem de desfazer a factura, e só o diz quando o fez; um reembolso parcial produz uma nota de crédito por reembolso; um documento pode ter um desconto que as linhas não têm.
- Uma venda Stripe não é transporte, e deixa de ser facturada como tal.
- Uma edição a uma encomenda já certificada não é uma falha; o wizard voltou a oferecer séries; uma referência vazia responde "não encontrado", não "pedido inválido".
- O cartão de early bird mostra a data de trial de cada conta; dois formatos de data faziam toda a atribuição cair para o mesmo lado.

## 🪑 Version 7.6.0 — Lugares de utilizador e séries por fluxo Stripe — September 5, 2026

<!-- release: cf0601c -->

Contas com mais do que uma pessoa, e contas Stripe com mais do que um fluxo de receita.

### Para o comerciante

- **Utilizadores extra** — podes dar acesso à tua conta a outras pessoas (contabilista, equipa). O primeiro lugar é gratuito.
- Na Lodgify, o recibo passa a ser emitido sozinho quando registas o pagamento.

### Novo

- **Utilizadores extra** — lugares que a conta possui: desbloqueia-se um lugar, depois preenche-se, com checkout próprio e convite entregue por nós (não pela Clerk), na mesma pele dos restantes emails.
- **Séries por fluxo Stripe** — cada fluxo de uma conta Stripe arquiva na sua série, e o dinheiro que nunca passou pela Stripe também é facturado.
- **Recibos automáticos na Lodgify** — o Recibo emite-se quando o comerciante regista o pagamento, e o poll pode emiti-los sozinho.
- **Sonda de dinheiro** — leitura só de consulta do que o dinheiro de uma reserva diz realmente, incluindo o campo `transactions`.
- **Extras da v2** — a discriminação que decide a taxa de IVA da limpeza.

### Corrigido

- Uma estadia OTA não regista dinheiro, e isso não é excesso de liquidação.
- A factura de um lugar tem de facturar mesmo alguma coisa; o lugar grátis é um lugar; o cartão tem de ser encontrável.
- Activar uma ligação Stripe deixa de apagar a chave que a autoriza; as definições de facturação deixam de desaparecer assim que a InvoiceXpress liga; a taxa de IVA da linha tem de ser uma que o facturador tenha.

## 🛰️ Version 7.5.0 — Relé de saída Lodgify e fatura + recibos — September 3, 2026

<!-- release: 122fd5b -->

A Lodgify só confia num IP fixo, por isso o tráfego passa a sair por uma porta só. E uma estadia meio paga passa a ser facturada por inteiro, com recibo por pagamento.

### Para o comerciante

- Na Lodgify, uma estadia parcialmente paga passa a ser facturada por inteiro, com um recibo por cada pagamento recebido.
- O recibo é arquivado na série de recibos da tua conta e indica o método de pagamento do canal que cobrou.

### Novo

- **Relé de saída com IP fixo** — uma porta de saída única para a Lodgify, com forma de saber quando morre, e corte gradual (modo directo primeiro, relé depois).
- **Fatura + Recibos** — uma estadia parcialmente paga é facturada por inteiro e cada pagamento gera um Recibo, sem partir quem já estava em prestações.
- **Série de recibos no Moloni** — o Recibo é arquivado na série que a conta usa para recibos, e o método de pagamento vem do canal que cobrou, com recurso ao configurado.
- **Documentação de subcontratantes** — quem toca nos dados, e o registo da decisão.

### Corrigido

- `/admin/version` responde mesmo depois do deploy de outra pessoa; o script de deploy corre dentro dos Workers Builds.
- Gravar definições deixa de apagar o que o formulário nunca conheceu.

## 🔐 Version 7.4.1 — Chaves fora do D1, curas limitadas — September 2, 2026

<!-- release: f97a5d2 -->

### Para o comerciante

- Melhorias de segurança no tratamento das credenciais que nos confias. Não é preciso fazer nada.

### Corrigido

- **Chaves de API dos comerciantes deixam de ser escritas no D1 e em emails**, e fecham-se os dois caminhos por onde ainda podiam sair.
- O healer passa a ser limitado: uma avaria prolongada deixa de poder matar a própria rede de segurança.
- Silêncio não é prova de que a factura foi emitida; a conciliação deixa de reportar "sem factura" para encomendas que ninguém conseguiu consultar.
- Desistir de uma encomenda em vez de perder o lote por causa dela; uma chamada que retorna vale mais do que uma que acaba tudo.
- O claim da encomenda passa a existir também no caminho de backfill, e o Vendus deixa de falhar em aberto.
- A conciliação diz quando está a mostrar um máximo, não uma contagem.
- Duas chamadas lentas ao proxy saem do caminho quente e passam a ter prazo.

## 📋 Version 7.4.0 — Registo por documento e consola de operações — August 18, 2026

<!-- release: 3a94d65 -->

**Destaque:** deixa de haver documento emitido às cegas. Cada documento é lido de volta no destino e o que lhe aconteceu fica escrito; e as operações do dia deixam de viver na cabeça de quem as faz.

### Para o comerciante

- Cada documento emitido passa a ser confirmado directamente no teu facturador, em vez de se assumir que foi emitido.
- **Código de isenção** — documentos cuja data foi alterada podiam perder o código de isenção. Corrigido, e os documentos afectados foram revistos.
- O IVA dos portes passa a ser cobrado apenas sobre a parte que foi tributada.

### Novo

- **Registo por documento** — todo o ciclo de vida é lido de volta e registado nos pontos de estrangulamento, com verificação dirigida e cobertura de histórico. Um achado histórico não confirmado é uma pista, não um veredicto.
- **Consola de regras** — uma página que diz o que a facturação de cada empresa faz realmente.
- **Página de operações** — uma página com o que precisa de atenção hoje.
- **Vigia de webhooks** — ir procurar as lojas que deixaram de falar.
- **Data de arranque da facturação** editável no dev-mode, ao lado do que a preenche.
- **Carimbo de commit no worker** — o worker diz que versão está a correr.

### Corrigido

- **Regressão M99** — o código de isenção perdia-se quando a data do documento mudava.
- Cinco sítios onde uma recusa era registada como sucesso.
- IVA de portes cobrado só sobre a parte que foi tributada.
- Um IVA estrangeiro numa morada portuguesa é um cliente, não uma retenção; uma devolução sobre uma encomenda nunca paga não tem nada a creditar.
- Um rascunho fecha numa data que o Moloni aceita, do mais antigo para o mais recente.
- A página de superadmin passa a perguntar quem está a perguntar; o email de tentativas esgotadas diz o que o destino respondeu.
- O botão que instalava um segundo conjunto de webhooks inutilizáveis foi travado, e a verificação de saúde de webhooks foi revertida onde não consegue ver os webhooks da plataforma.

## 🪪 Version 7.3.1 — Identidade do comprador e saída por IP fixo — August 14, 2026

<!-- release: fc5840c -->

**Destaque:** todas as vendas Stripe partilhavam a referência "Order #0", por isso só a primeira era facturada. Corrigido, com reemissão do que ficou por trás.

### Para o comerciante

- **Vendas Stripe por facturar** — todas as vendas partilhavam a mesma referência interna, por isso só a primeira gerava documento. Corrigido, e as vendas em falta foram reemitidas.
- O comprador deixa de ser facturado como "Consumidor Final" quando o NIF dele é conhecido.
- A factura passa a ter a data em que o pagamento foi feito, não a data em que foi iniciado.

### Corrigido

- **Colisão de referência** — cada venda passa a ter referência própria; a dedup deixa de apagar vendas legítimas.
- O comprador era facturado como "Consumidor Final" com o NIF dele em mãos.
- Um NIF sem morada de facturação é uma factura vulgar, não uma suspeita.
- A factura era datada de quando o comprador decidiu pagar, não de quando pagou.
- Um saldo desactualizado fazia uma reserva totalmente paga parecer parcial.
- Produtos gerados eram facturados em horas porque o Moloni listava horas primeiro.
- A `bun.lock` obsoleta que falhava todos os Workers Builds foi removida.

### Novo

- **Ingestão Lodgify fora do IP bloqueado**, com alarme para o silêncio.
- **Estadias OTA já cobradas pelo canal** podem ser facturadas por ligação.
- **Categoria de produto e condições de pagamento** fixadas por ligação no Moloni; o método configurado pelo comerciante vence o do canal.
- Script para provisionar uma ligação Lodgify sem armar o histórico todo.

## 🧰 Version 7.3.0 — Recuperação genérica por ligação — August 13, 2026

<!-- release: ff1c8dc -->

A caixa de ferramentas de recuperação deixa de assumir Shopify e passa a trabalhar com qualquer ligação.

### Para o comerciante

- Nas regras por etiqueta, o tipo de documento e a decisão de finalizar passam a ser duas escolhas separadas.

### Novo

- **Dev-mode por ligação** — o painel escolhe uma ligação em vez de assumir Shopify, e deixa de dizer InvoiceXpress enquanto fala com o Moloni.
- **Moloni: ler, creditar por inteiro e fechar rascunhos** a partir da mesma consola.
- **Recuperação Lodgify pelo espelho** — uma reserva é desfeita por inteiro.
- **Tipo de documento e finalização são escolhas separadas** no encaminhamento por etiqueta (fim do sufixo `_draft`).

### Corrigido

- **O cookie de impersonação não é prova de ser admin.**
- Linhas escritas para uma origem baseada em ligação não pertenciam a ninguém.
- Um saldo zero não é um pagamento; um reembolso não é uma venda à espera de factura.
- O formulário de registo grava no utilizador impersonado; um comerciante coberto deixa de ser avisado de que o sistema está suspenso.

## ✉️ Version 7.2.0 — Email ao comprador e uma encomenda, um documento — August 7, 2026

<!-- release: 10f3c3f -->

**Destaque:** duas entregas do mesmo `orders/created` produziam dois documentos. A encomenda passa a ser reclamada antes de ser criada.

### Para o comerciante

- **Email da factura ao comprador** — opcional, activado a pedido, para Shopify, Moloni e Vendus.
- Uma encomenda deixa de poder gerar dois documentos quando a plataforma repete o envio.
- Facturas antigas recuperadas nunca são enviadas por email ao comprador.

### Novo

- **Email da factura ao comprador** (Shopify→IX), com opção equivalente para Moloni e Vendus, e um NIF apanhado numa linha de morada mantém o documento em rascunho.

### Corrigido

- **Um claim por encomenda** — uma reclamação perdida repete, não confirma.
- Finalização retroactiva mantém a data da transacção, e uma loja bloqueada pára antes de rascunhar.
- A rejeição de cronologia de série da IX é reconhecida, e finaliza-se do mais antigo para o mais recente, com uma repetição antes de abandonar.
- Uma falha de envio escondida dentro de um envelope 200 deixa de contar como enviada.
- Nunca enviar ao comprador a factura de uma venda de há meses: a trava é a data da venda, não a data para onde movemos o documento.
- Uma taxa que não resolve é um erro, não uma isenção.
- Todos os rascunhos retidos são reportados, e a flag de email tem um nome honesto.

## 🏨 Version 7.1.0 — Lodgify OTA e diagnóstico de bloqueio — August 3, 2026

<!-- release: a973695 -->

### Para o comerciante

- Reservas vindas de canais externos (Booking, Airbnb) passam a ser facturadas, em vez de ficarem de fora.

### Corrigido

- Reservas OTA nunca eram facturadas em regime de facturação progressiva.
- Um bloqueio permanente de IP deixa de ser confundido com um limite de pedidos.
- Uma leitura falhada de reservas deixa de ser tratada como conta vazia.
- A facturação progressiva nunca enviava `data.bookingId`.
- Os incidentes escalam de severidade dentro do mesmo balde em vez de perderem o alerta.

### Novo

- Alerta quando reservas liquidadas se acumulam por facturar.
- Poll a pedido em `/admin/lodgify/poll`, com reservas fornecidas pelo chamador e âmbito de uma só ligação.

## 💳 Version 7.0.1 — Nome do comprador e endpoint de finalização — July 14, 2026

<!-- release: 2588539 -->

### Para o comerciante

- As facturas de vendas Stripe passam a levar o nome do comprador em vez de "Consumidor Final".

### Corrigido

- O nome do comprador é recuperado de `billing_details` da cobrança Stripe (fim do "Consumidor Final" indevido).
- A finalização no Moloni usa o endpoint do tipo de documento certo (`invoiceReceipts` e não `invoices`).

## 🚀 Version 7.0.0 — Preço por integração e auto-cura noturna — July 10, 2026

<!-- release: b89963f -->

**Destaque:** o modelo de preço deixa de ser por conta e passa a ser por integração, e a rede de segurança passa a correr sozinha todas as noites.

### Para o comerciante

- **Preço por integração** — cada integração tem o seu preço e a sua subscrição, em vez de um preço por conta.
- **Fim dos períodos de teste** — quem ligou antes mantém as condições de early bird até à data comunicada; as integrações novas pagam desde o início.
- **Portal de facturação** — passas a gerir cartão, facturas e cancelamento directamente, sem nos pedir.
- Sem pagamento, a facturação é suspensa e retomada automaticamente quando regularizas. Nada se perde pelo caminho.

### Novo

- **Preço por integração**, sem trials, com early bird unificado e portal Stripe para o cliente gerir o cartão.
- **Suspensão por não pagamento**, com retoma automática, cartões de pagamento de cortesia e lembrete de fim de early bird.
- **Ligação manual de uma subscrição Stripe** a uma conta Rioko, pelo admin.
- **Auto-cura** — cura noturna guiada por incidentes, varrimento de janela curta, e auto-cura de pagamentos Stripe→Moloni órfãos, limitada ao arranque da ligação.
- **Regra de livro (ISBN)** — SKU com ISBN aplica taxa reduzida.
- **Digest a pedido**, com pré-visualização e comerciantes em pausa ignorados.

### Corrigido

- Fim do sobre-relato de "facturas por emitir", com cura do atraso acima de 7 dias.
- A auto-cura respeita "não necessária" e correspondências manuais.
- Correspondência Kapta↔IX com paginação, cache, NIF e código postal normalizados e `paid_at` real.
- Integrações montadas mas não pagas aparecem como "Incompletas"; o preço do plano no cartão passa a ser dinâmico.

## 🌍 Version 6.8.0 — Moloni multi-moeda, multi-taxa e créditos — July 7, 2026

<!-- release: c58efb2 -->

### Para o comerciante

- **Moloni em várias moedas** — uma venda noutra moeda é emitida nessa moeda.
- O IVA passa a vir do que a Stripe cobrou de facto, em vez de zero.
- Reembolsos parciais geram uma nota de crédito do valor exacto, com o IVA original.
- A conciliação passa a mostrar reembolsos, cancelamentos e as notas de crédito associadas.

### Novo

- **Multi-moeda no Moloni** — a venda é emitida na moeda paga, com campos nativos.
- **Taxa da linha vinda do produto mapeado**, com taxa de recurso quando o pagamento não traz imposto.
- **IVA real da Stripe** em vez de zero fixo.
- **Menção de isenção bilingue** carimbada nas observações, por loja.
- **Conciliação de reembolsos** — cancelamentos e notas de crédito associadas ficam visíveis, e as notas de crédito Moloni são ligadas pela tabela de associação da factura.
- **Selector de tipo de documento** (Fatura / Fatura-Recibo) para Stripe→Moloni.
- **Planos de 5 € / 50 €** ligados aos cartões de pagamento, com lembretes de renovação.

### Corrigido

- `charge.succeeded` é deduplicado para o seu PaymentIntent (fim da factura dupla).
- Reembolsos parciais creditam o valor exacto com o IVA original; `related_id` obrigatório nas linhas de nota de crédito.
- Documentos atrasados são redatados para o mínimo da série em vez de falharem.
- Série em branco usa o conjunto de documentos por defeito da conta.
- Um erro de leitura da idempotência em KV deixa de impedir a facturação.
- Configuração Stripe sintetizada para clientes só-Moloni, e o fail-fast global do segredo de webhook deixa de bloquear todos os eventos.

## 🗝️ Version 6.7.0 — Lodgify, encaminhamento por etiqueta e pipeline por ligação — July 3, 2026

<!-- release: 14bfc36 -->

**Destaque:** entra uma vertical nova (alojamento local, via Lodgify) e a plataforma deixa de assumir Shopify em qualquer ponto: o pipeline, a conciliação e o painel passam a ser conduzidos pela ligação.

### Para o comerciante

- **Lodgify** — as reservas passam a poder ser facturadas para InvoiceXpress, Moloni ou Vendus.
- **Séries por etiqueta** — a etiqueta da encomenda pode decidir em que série a factura é emitida.
- **Facturação progressiva** — uma reserva paga em prestações pode ser facturada em prestações.

### Novo

- **Lodgify como origem** — adaptador próprio, com wizards para InvoiceXpress, Moloni e Vendus, registo de webhooks que nunca bloqueia o passo 1, e enriquecimento do hóspede pela API v1.
- **Espelho de reservas em D1** — a conciliação deixa de bater na API da Lodgify e de apanhar 429; sincronização incremental para não repetir o arranque de 120 dias.
- **Facturação progressiva** (prestações) com conciliação multi-documento, sem refacturar reservas já facturadas.
- **Encaminhamento por etiqueta** — série de facturação escolhida pela etiqueta da encomenda, estendido a conjuntos de documentos Moloni e a tipo de documento com controlo de rascunho/finalização.
- **Conciliação dinâmica por ligação** — a página deixa de ser Shopify fixo.
- **Cartões de integração dinâmicos** no painel e no superadmin, por tipo de ligação.
- **Gate de subscrição para a Lodgify**, com CTA na facturação e redireccionamentos de checkout cientes da origem.
- **Moloni**: cache de token, `country_id` dinâmico, `tax_id` configurável, e resolução tardia de nomes para IDs.

### Corrigido

- Reembolsos Lodgify via `booking_status_change_declined`; pagamento em falta impede a emissão.
- `findByReference` consulta o mesmo tipo de documento que o `createDraft`.
- Documentos Moloni finalizados de qualquer tipo ou série são lidos na conciliação (fim do rascunho fantasma).
- `auto_finalize` lido do contexto e não da configuração desestruturada.

## 🏷️ Version 6.6.1 — Onboarding do token Shopify e códigos de isenção — June 29, 2026

<!-- release: b17cedb -->

### Para o comerciante

- **Códigos de isenção corrigidos** — o M10 e o M11 estavam trocados, e outros códigos tinham a descrição errada. Se emitiste documentos isentos antes desta data, vale a pena confirmá-los com a tua contabilidade.

### Novo

- **Página de onboarding do token Shopify** dentro da Rioko, com preenchimento automático do domínio e botões de cópia dos webhooks.
- **Paridade de dev-mode para a Stripe**, com armazenamento por utilizador.

### Corrigido

- **M10 e M11 estavam trocados**, e os restantes rótulos de isenção (M08, M19 a M43) estavam errados.

## 💶 Version 6.6.0 — Fatura só depois de paga — June 17, 2026

<!-- release: ec43dfc -->

### Para o comerciante

- **A factura passa a ser emitida só depois de a encomenda estar paga.** Encomendas à espera de pagamento aparecem como pendentes na conciliação, e são facturadas assim que o pagamento é confirmado.

### Alterado

- **A factura só é emitida quando a Shopify confirma o pagamento** (`financial_status=paid`). As encomendas à espera aparecem como pendentes na conciliação em vez de desaparecerem.

## 🔭 Version 6.5.0 — Conciliação fiável, triagem e /shopify — June 11, 2026

<!-- release: 3224e28 -->

### Para o comerciante

- Passas a receber um email quando uma encomenda falha a facturação, em vez de dares por isso mais tarde.
- A conciliação deixa de mostrar como "sem factura" documentos que foram emitidos.
- Facturas emitidas à mão ou fora da Rioko passam a ser reconhecidas pela referência.

### Novo

- **Alertas em tempo real** quando uma encomenda falha a facturação, e quando o total reconciliado diverge.
- **Triagem assistida** — diagnóstico consultivo do incidente dentro do email de alerta, mais relatório semanal de padrões.
- **Recuperação por referência IX** — facturas manuais ou com mapeamento perdido voltam a ser reconhecidas.
- **Cache em KV dos metadados IX** para a conciliação, que tira carga ao proxy.
- **Nome de loja editável** no superadmin, visível por baixo do nome do utilizador.
- **Landing `/shopify`** dedicada, com três escalões de preço, e correcção do middleware que dava 404 a crawlers.

### Corrigido

- Facturas já emitidas apareciam como "Sem factura" na conciliação.
- A razão de falha da criação IX passa a ser persistida em vez de ficar só na consola; repetição da criação e recurso a cliente sanitizado no DOC010.
- `force_tax_rate` passa a comandar a matemática de IVA incluído, não só a taxa carimbada.
- Portes com taxas mistas são divididos; os totais das notas de crédito de reembolso reconciliam.
- Reconciliação contra o total arredondado uma só vez pela IX, que é como a IX conta.
- A conciliação nunca devolve 500 com o proxy lento; morada de cliente à prova de nulos; código postal enviado e apelido colhido das moradas de checkout.
- Ecrãs de autenticação com logo Rioko 2.0, links legais e alinhamento corrigido.

## 🍪 Version 6.4.1 — Consentimento, GEO e encaminhamento de alertas — June 3, 2026

<!-- release: c045d7c -->

### Para o comerciante

- Banner de cookies e consentimento no site, conforme o RGPD.

### Novo

- **GA4 com Consent Mode v2** e banner de cookies conforme o RGPD.
- **Dados estruturados GEO**, FAQ, `llms-full.txt` e acesso controlado a crawlers de IA.
- **Open Graph e Twitter cards** para `rioko.online`.
- **Grupos de contas no superadmin** (admins, integrados, sem integração) e registo da primeira origem de cada inscrição.
- **Alertas em tempo real só para operações**, com digest semanal para o comerciante.

### Corrigido

- Fiabilidade do webhook Stripe, com falha rápida nas repetições Shopify e ferramentas de recuperação.
- **A InvoiceXpress quer o nome do país, não o código ISO.**
- Auto-cura do `orders/paid` para o erro "Invoice not found", e resiliência ao SPOF do normalize.
- Pagamentos Stripe Connect alheios deixam de criar utilizadores fantasma.
- Correspondência determinística IX pela referência `#stripe_`, com permalink público e ciclo de vida da factura agrupado na página de facturação.

## 🛡️ Version 6.4.0 — Mapeamentos, overrides por SKU e endurecimento — May 28, 2026

<!-- release: 4767259 -->

### Para o comerciante

- **Regras por produto** — podes definir taxa de IVA, isenção, inclusão de IVA e nome por SKU, para os casos que fogem à regra geral.

### Novo

- **Mapeamentos de produto explícitos** (Stripe e Shopify → Moloni), com o catálogo Moloni a espelhar a origem por SKU.
- **Overrides por SKU na InvoiceXpress** — taxa, inclusão de IVA, isenção e nome, com harness de teste ponta a ponta contra a sandbox real.
- **Quatro sprints de endurecimento** — idempotência, protecção contra replay, moeda, desvio de totais, sanitização de erros, redacção de segredos, limites de pedidos, TTLs, dedup de reembolsos verificado, VIES ligado, alertas de DLQ, e corte do volume de emails de webhook na origem.

### Corrigido

- **O adaptador Moloni tem de enviar `form-urlencoded`, não JSON**, e as linhas precisam de um `product_id` existente.
- Encomendas Shopify em autoliquidação (`tax_lines.price = 0`) deixam de partir a emissão.
- Simulador IX exacto ao cêntimo, estado preso do webhook e ruído das heurísticas.
- `ADMIN_API_KEY` movida para secret do Cloudflare.

## 🌍 Version 6.3.0 — Hub multi-plataforma: Moloni, Vendus, EuPago e PT/EN — May 25, 2026

<!-- release: e4fb11b -->

**Destaque:** a Rioko deixa de ser "Shopify → InvoiceXpress" e passa a ser um hub. Dois destinos novos, uma origem nova, interface bilingue e o painel inteiro repintado na marca.

### Para o comerciante

- **Moloni e Vendus** como destinos de facturação, além do InvoiceXpress.
- **EuPago** como origem de pagamentos.
- O painel e o guia passam a estar em português e inglês.
- **Pausa** — podes suspender a facturação automática a qualquer momento e retomá-la num clique.

### Novo

- **Destinos Moloni e Vendus**, com `destinationConfig` no pipeline e combinações completas para ambos.
- **EuPago como origem** de pagamentos.
- **Shopify → Moloni** pelo pipeline, de forma aditiva, sem tocar no caminho IX legado.
- **Bilingue PT/EN** com prefixo `/pt` e `/en`, incluindo landing, autenticação e todo o chrome do painel.
- **Guia `/help` reescrito** em quatro plataformas, com separadores de Pagamento e Facturação e FAQ para SEO.
- **Blog** em `/blog` com quatro artigos e MDX.
- **Interruptor de pausa** controlado pelo comerciante, com banner e retoma num clique na conciliação.
- **Feeds de actividade** no painel, em vez de cartões de estatística de enfeite.
- **GA4** na landing e no painel.

### Alterado

- Tokens de marca extraídos e fontes Geist levantadas até ao chrome do painel; acento cyan único na navegação; painel, formulários, tabelas e fluxos de integração repintados.
- Varrimento mobile completo: viewport, espaçamentos e tamanhos de letra abaixo de 12px.

### Corrigido

- Encomendas de valor zero são ignoradas, e os erros reais aparecem na conciliação.
- `/help` movido para dentro de `[locale]` para `/pt/help` e `/en/help` resolverem.

## 💳 Version 6.2.0 — Stripe como origem e totais ao cêntimo — May 21, 2026

<!-- release: 3985177 -->

### Para o comerciante

- **Stripe** como origem: pagamentos Stripe passam a gerar factura, com o webhook instalado automaticamente.
- O NIF preenchido no checkout passa a chegar à factura.
- **Totais ao cêntimo** — encomendas com descontos deixam de sair com desvios de arredondamento.

### Novo

- **Stripe como origem**, com configurador próprio e instalação automática do webhook por chave restrita.
- **Retenção na fonte** como opção no passo de InvoiceXpress.
- **NIF e VAT extraídos** dos `custom_fields` do Checkout e dos `tax_ids` do Customer.
- **Finalização de rascunhos** com estratégia de data e filtros por número de encomenda e intervalo.
- **Landing responsiva** em mobile.

### Corrigido

- **Totais exactos ao cêntimo** — os itens passam a ser calculados directamente do Shopify em bruto, com preços sempre sem IVA e desconto por linha em percentagem (a IX ignora `discount_amount` no POST).
- `closest_available` preserva a data original em vez de a encostar a hoje.
- Os quatro webhooks são registados e validados na activação.
- Ligação obsoleta em `processed_orders` quando a factura IX foi apagada.

## 💎 Version 6.1.0 — Landing Redesign & Brand System — May 18, 2026

Reposicionamento visual da landing pública de "Shopify + InvoiceXpress" para **Hub de Integrações multi-plataforma**, com sistema de marca unificado (logo Rioko 2.0, paleta brand-cyan, tipografia Geist) e preço público.

### Novo — Landing page (`/`)

- **Pivô de mensagem** — produto deixa de ser apresentado como integração ponto-a-ponto Shopify↔IX e passa a "Hub de Integrações": carrossel ao vivo mostra Shopify → Stripe → Easypay → EuPago → Ifthenpay no lado origem, e InvoiceXpress → Moloni → Vendus no destino, em torno do motor Rioko central.
- **Identidade visual** — re-skin tonal completo no eixo Stripe Apps / Raycast: charcoal `#0E1116` com radial washes cyan, tipografia Geist Sans + Geist Mono, sem serif italic, sem glow halos.
- **Logo Rioko 2.0** — novo lockup SVG (variante branca + preta) substitui o antigo "RIOKO" com pill `2.0` hardcoded em JSX. O pill cyan vive agora dentro do SVG, e a cor do pill (`#028DC4`) é o acento singular da marca.
- **Favicon** — novo `icon.svg` + `apple-icon.svg` (Next 15 app-router auto-injected); legacy `favicon.ico` removido.
- **Pricing público** — secção `#preco` com 3 planos: Standard mensal 7,50 €/mês, Standard anual 75 €/ano (recomendado, com chip "Poupa 15 €/ano"), Personalizada → redirect `https://kapta.pt/`.
- **Carrossel duplo com animações** — origem e destino rotam de forma offset (half-period), AnimatePresence crossfade w/ y+blur enter, opacity-only exit rápido (sem blank entre slots), progress-dots cyan abaixo de cada cartão, conector animado (CSS keyframe `rk-flow-down`).
- **Engine card sincronizado** — pills NIF / IVA / Cliente / M99 dentro do cartão `Rioko 2.0 · Hub de Integrações` fazem spring-stagger reentry em cada rotação do destino (re-key on `destIdx`).
- **Logos das plataformas** — 7 SVGs reais em `backoffice/public/images/` (Stripe, EuPago, Easypay, Ifthenpay, InvoiceXpress, Moloni, Vendus). Renderizados transparentes em cartões de "paper" `#EAEAE4` para contraste com fills mistos (sem chips brancos pelo meio).
- **Headline gradient** — `linear-gradient(135deg, #06B6D4, #028DC4, #0369A1)` aplicado consistentemente nos substantivos-chave de todas as section heads (`fatura`, `encomenda`, `plataforma`, `Rioko`, `Uma vez.`, `Por integração.`, `quatro`, `Não`).
- **Body chrome local** — landing override do background dark do root layout via `useEffect` (set + restore), sem tocar no chrome global do dashboard.

### Arquitectura

- `backoffice/src/app/page.tsx` reduzido a server shell (auth redirect + edge runtime + font-vars wrapper) → `backoffice/src/components/landing/Landing.tsx` cliente.
- Rotation state lifted ao `HeroShowcase` parent (RotatingFlowCard agora controlado via `idx` prop) para sincronizar engine pulse com destination cycle.
- `RotatingFlowCard` memoizado (`React.memo`), interval isolado — perpetual motion não dispara re-renders no parent.
- `BrandLogo` shared component com fallback monogram para integrações futuras sem SVG.

### Documentação

- **Novo: `docs/brand-guideline.md`** — referência completa de tokens, tipografia, motion, surfaces, componentes e padrões proibidos. Ponto de partida para qualquer trabalho visual futuro no projecto.

### Removido / depreciado

- Antigo `backoffice/src/app/favicon.ico` (visual outdated).
- Imports de `Instrument_Serif` em `fonts.ts` (cozy-editorial variant rejeitado pelo cliente — feedback "looks like slop / not techy enough").
- Helper `Mono color={ACCENT_HOT}` deixou de ser usado em headlines (substituído por `Gradient`). Mantido no ficheiro para emphasis de copy futuro.

### Dependências

Nenhuma nova. `framer-motion 12`, `lucide-react`, `next/font/google` (Geist, Geist Mono) já presentes.

### Mobile

- Hero collapsa para single-column abaixo de `md:` (768px).
- Carrossel mantém-se funcional mas mais compacto.
- `min-h-[100dvh]` em vez de `h-screen` para evitar viewport jumping no iOS Safari.

## 💎 Version 6.0.0 — Stripe Subscription Billing — May 18, 2026

Monetização do integrador: Kapta cobra subscrição mensal/anual pelo uso, com gate automático nas integrações Shopify→IX quando inativa.

### Novo

- **Stripe Subscription Layer** — Checkout integrado em `/integrations/shopify-ix` com 2 planos: **7,50€/mês** ou **75€/ano** (-17%), ambos +IVA 23% fixo (via Stripe Tax rate estático, não automático — força 23% PT independente de geografia).
- **Página `/faturação`** — Histórico de cobranças, gestão de subscrição (mudar cartão, cancelar/reativar), links diretos para faturas/notas de crédito IX correspondentes na conta Kapta.
- **Card de Subscrição** em `/integrations/shopify-ix` com 6 estados visuais: `active` (verde), `trialing_earlybird` (amarelo), `trialing` (azul), `blocked` (vermelho), `exempt` (roxo, admins), `none`.
- **Early Bird Trial** — Todos os utilizadores existentes à data do deploy receberam trial gratuito até **1 Agosto 2026**. Novos utilizadores criados antes do cutoff também recebem trial automaticamente via Clerk webhook. Botão "Adicionar Pagamento" permite registar cartão antes do trial expirar — cobrança automática a partir de 1 Ago.
- **Gate Automático no Worker** — `src/handlers/orders-paid.ts` verifica subscrição no D1 antes de emitir fatura InvoiceXpress. Se subscrição inativa (`canceled`, `past_due`, `unpaid`, trial expirado sem cartão), o webhook Shopify retorna 200 mas **não emite fatura**. Restabelece automaticamente quando subscrição volta a `active`.
- **Admin Exemption** — Utilizadores com role `superadmin`/`hiperadmin` ficam isentos do gate. Integração corre sempre, sem necessidade de subscrição.
- **Superadmin Subscription Controls** — Novo painel em `/superadmin/users/[id]/dev-mode` permite definir manualmente `early_bird` e `trial_end` para qualquer utilizador.
- **NIF Custom Field** no Stripe Checkout — Validado (9 dígitos), guardado como `fiscal_id` na metadata Stripe + DB. Skip se vazio.
- **IX Invoice Matching** — Automação Stripe→IX da Kapta gera faturas com referência `pi_xxx`. O webhook backoffice procura essa fatura por referência exata (primário) ou heurística (fallback: NIF + email + valor + nome + data proximity), guardando link permalink em `billing_events.ix_invoice_permalink`.
- **Refund Handling** — Webhook `charge.refunded` cria linha laranja em `/faturação` com link para a nota de crédito IX correspondente. Mesma lógica de matching (referência + heurística).
- **Cron Diário de Retry** — Worker scheduled handler (`0 8 * * *` UTC) chama `/api/cron/ix-match` para re-tentar matching IX de eventos pendentes nos últimos 30 dias.

### Endpoints novos (backoffice edge runtime)

- `POST /api/billing/checkout` — cria Stripe Checkout Session (com impersonation support)
- `GET /api/billing/subscription` — estado actual (exempt para admins)
- `GET /api/billing/invoices` — histórico billing_events
- `POST /api/billing/cancel`, `/reactivate`, `/update-card`
- `POST /api/webhooks/stripe` — 8 eventos: `checkout.session.completed`, `customer.subscription.{created,updated,deleted,trial_will_end}`, `invoice.{paid,payment_failed}`, `charge.refunded`
- `POST /api/admin/subscription` — superadmin set early_bird + trial_end
- `GET /api/internal/subscription-check` — gate API (auth via `INTERNAL_GATE_API_KEY`)
- `GET /api/cron/ix-match` — retry pending IX matches (auth via `CRON_SECRET`)

### Schema

- Migration `0005_stripe_subscriptions.sql` — tabelas `subscriptions` + `billing_events`
- Migration `0005b_early_bird_backfill.sql` — backfill idempotente (todos `users` → trial até 2026-08-01)
- Migration `0006_subscription_indexes.sql` — index em `subscriptions(stripe_customer_id)`

### Hardening pré-prod

- **Webhook retry storm prevention** — handler retorna 200 após registar event_id em `billing_events` (idempotente); falhas internas (IX, etc.) não causam Stripe retries em loop.
- **Trial-end gate baseado em status** — confia no Stripe para transitar `trialing → active|past_due`, elimina race condition à meia-noite do trial.
- **Price validation** — checkout rejeita preços inactivos ou em moeda errada.
- **NIF validation** — apenas 9 dígitos aceites no webhook.
- **`tax_id_collection` desactivado** quando `STRIPE_TAX_RATE_ID` está definido — evita confusão B2B EU sobre reverse-charge.
- **Cron auth restrito** — apenas `CRON_SECRET` (sem fallback para `ADMIN_API_KEY`).
- **Heuristic IX matching** com date proximity scoring para desambiguar clientes recorrentes com mesmo valor.

### Env vars novas (CF Pages backoffice)

```
STRIPE_SECRET_KEY, STRIPE_PUBLIC_KEY, STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_MONTHLY_LOOKUP, STRIPE_PRICE_YEARLY_LOOKUP
STRIPE_TAX_RATE_ID
KAPTA_IX_ACCOUNT_NAME, KAPTA_IX_API_KEY, KAPTA_IX_ENV
EARLY_BIRD_TRIAL_END
SUCCESS_REDIRECT_URL, CANCEL_REDIRECT_URL
INTERNAL_GATE_API_KEY, CRON_SECRET
```

CF Worker: adicionado `CRON_SECRET` (secret) + `BACKOFFICE_URL` (var).

## 💎 Version 5.0.0 — Invoices Hub & Premium Dashboard — March 2, 2026

- **New: Rioko Invoices Hub** – Dashboard premium construído com **Tailwind CSS e Framer Motion** para uma experiência fluida de gestão fiscal.
- **New: Document Cards Expansíveis** – Listagem de documentos com animações de expansão que revelam o **Audit Trail** (Logs) de cada transação, permitindo ver exatamente como e quando o documento foi processado.
- **New: PDF Interactive Proxy** – Visualização e download de PDFs diretamente do dashboard. O sistema interage com a API do InvoiceXpress, converte o stream base64 em PDF e serve o ficheiro de forma segura.
- **New: Cross-Reference Intelligence** – Algoritmo que cruza os IDs de documentos da IX com os logs de Webhooks da Cloudflare D1 através de padrões de `payload` e `response`.
- **New: Admin Impersonation Support** – Hiperadmins e Superadmins podem agora visualizar o histórico de faturas de qualquer cliente através do sistema de impersonificação.
- **Melhoria: Filtros de Estado Dinâmicos** – Filtragem instantânea por documentos pagos, rascunhos ou notas de crédito.

## 💎 Version 4.2.1 — Aggressive Client Sync & Refund Logic — March 2, 2026

- **New: Client Mirroring Engine** – Implementação do modo `CLIENT_SYNC=1` que força a ficha do cliente no InvoiceXpress a ser um espelho exato da encomenda Shopify (incluindo a limpeza de campos vazios como Email ou Morada).
- **New: Credit Note Linking** – Lógica avançada para reembolsos no Shopify dispararem automaticamente Notas de Crédito no IX, garantindo o "link" técnico entre o documento original e o reembolso.
- **Melhoria: "Consumidor Final" Logic** – Proteção contra nomes genéricos; se uma encomenda não tiver NIF e o nome for vago (ex: "Client"), o sistema assume automaticamente "Consumidor Final" para evitar poluição fiscal.

## 💎 Version 4.2.0 — Mandatory Onboarding & Admin Visibility — March 2, 2026

- **New: Mandatory Registration Flow** – Bloqueio de integrações até que o utilizador preencha os dados fiscais obrigatórios (NIF, Morada Fiscal, CAE/Empresa).
- **New: NIF-Type Logic** – Formulário inteligente que detecta se o NIF é de Empresa (Individual/Colectiva) ou Civil, ajustando os campos de nome necessários.
- **New: Superadmin Profile Visibility** – Admin agora consegue visualizar todos os detalhes fiscais dos utilizadores registados diretamente na sua lista de gestão.

## 💎 Version 4.1.9 — Clerk Webhook Sync — March 2, 2026

- **New**: Implementado endpoint de webhooks para o Clerk em `/api/webhooks/clerk`.
- **Fix**: Rota de webhook tornada pública no `middleware.ts` para evitar bloqueios de autenticação (causava 404/Redirect).
- **Melhoria**: Sincronização automática de utilizadores (criação, atualização e remoção) assim que o evento ocorre no Clerk, sem necessidade de login inicial.
- **Segurança**: Verificação de assinaturas Svix para garantir a autenticidade dos webhooks do Clerk.

## 💎 Version 4.1.8 — Client Sync Fix: Update Before Invoice — March 2, 2026

- **Fix**: O `PUT` de actualização de cliente no InvoiceXpress agora inclui sempre o campo `name` (obrigatório na API IX). Era este o motivo pelo qual o NIF não era guardado na ficha.
- **Melhoria (CLIENT_SYNC)**: Quando "Sincronizar Fichas" está activo, a ficha é actualizada com NIF, email e morada **antes** da fatura ser criada.
- **Melhoria**: Sem o modo Limpeza, o NIF é preenchido passivamente apenas se a ficha estiver vazia.

## 💎 Version 4.1.7 — Restore fiscal_id/email in Document Creation — March 2, 2026

- **Fix**: Restaurado o envio de `fiscal_id` e `email` no corpo da criação do documento IX. A remoção anterior estava a fazer o Contribuinte aparecer sempre como "Consumidor Final".

## 💎 Version 4.1.6 — CLIENT_SYNC: Always Patch NIF/Email — March 2, 2026

- **Fix**: Com `CLIENT_SYNC` activo, o NIF é agora sempre actualizado na ficha (mesmo que já tivesse um NIF anterior).
- **Melhoria**: Email também sincronizado se a ficha estiver sem email.

## 💎 Version 4.1.5 — Tax & NIF Extraction Fixes — March 2, 2026

- **Fix**: Honoring the `taxable` flag from Shopify to ensure non-taxable products are mapped to "Isento" (0% VAT).
- **Fix**: Refined NIF extraction from order notes to be more aggressive and pick up standalone 9-digit numbers.
- **Fix**: Reverted default 23% VAT mapping to `PT23` to match the account's existing configuration.

## 💎 Version 4.1.4 — VAT Mapping & Diagnostics — March 2, 2026

- **Fix**: Changed default 23% VAT mapping from `PT23` to `IVA23` for better compatibility.
- **Diagnostic**: Added detailed logging for product VAT calculation to debug "Isento" logic.

## 💎 Version 4.1.3 — Final Sync & NIF Fixes — March 2, 2026

- **Fix**: Expanded NIF validation to accept digits starting with 4 or 7.
- **Fix**: Simplified client object in document creation to avoid redundant validation.
- **Fix**: Aggressive whitespace removal for all tokens in DB.

## 💎 Version 4.1.1 — Active Client Sync & Cleanup — March 2, 2026

### 🧹 Client Identity Cleanup
- **New `client_sync` Rule**: Introduced an opt-in rule to automatically clean up "generic" names in InvoiceXpress (e.g., "Client", "Consumidor Final").
- **Active Patching**: If enabled, the worker will issue a `PUT` request to update the client's name and NIF in IX if the current record is a placeholder and better data is available from Shopify.
- **Safe Updates**: Only acts on identified generic names to prevent over-writing manual edits in the InvoiceXpress dashboard.
- **Hiperadmin Control**: Added the "Sincronizar Fichas (Limpeza)" toggle to the "Regras de Clientes" page.

---

## 💎 Version 3.7.4 — Diagnostic UX & Safety Rails — March 1, 2026

### 🛡️ Diagnostic Panel (Hiperadmin)
- **Click-to-Open**: The diagnostic bubble no longer closes when moving the mouse. It now stays open upon clicking the "Pendente" badge, allowing for steady interaction.
- **Safety Rails (2-Step Force)**: The "Forçar Autorização" action now requires two clicks:
    1. First click reveals a red "Tens a certeza? Clica para confirmar" state.
    2. Second click executes the override.
- **Close Action**: Added a dedicated "X" button and an easy-access "Cancelar" link to the diagnostic panel.
- **Visual Feedback**: The help icon now rotates when the panel is open, providing clear state feedback.

### 🎨 Visual & UI Polish
- **Branding Excellence**: Refilled the "Rioko 2.0" version badge for better visual symmetry in the sidebar.
- **Layout Robustness**: Ensured the diagnostic panel stays correctly layered over other UI elements using a high z-index and `AnimatePresence`.

## 💎 Version 3.7.2 — Help Visibility Milestone — March 1, 2026

### 🖥️ Sidebar Navigation
- **Persistent Help Access**: Added the "Ajuda" (Help) link to the main sidebar, making the configuration guide accessible to all users at any time, not just via contextual links.
- **Visual Integration**: Used the standard `BookOpen` icon with a custom amber-themed active state to match the dashboard's design system.

---

## 💎 Version 3.7.1 — Cloudflare Pages Hotfix — March 1, 2026

### 🔧 Fixes
- **Route `/help` hotfix**: Added `export const runtime = 'edge'` to the help page. Cloudflare Pages requires edge runtime for all dynamic or non-static-prerendered routes.
- **Syntax Correction**: Fixed the metadata export on the help page which was accidentally broken during the last deploy.

---

## 💎 Version 3.7.0 — Help Guide & "Onde Encontrar" — March 1, 2026

### 📖 "Guia de Configuração" (/help)
- **New Help Page created**: Step-by-step documentation for all configuration fields (Shopify domain, Access Token, API version, IX Account, API Key, etc.).
- **Visual Placeholders**: Included identified placeholders for real screenshots that will be uploaded by the user to `/public/images/help/`.
- **Anchor Navigation**: Supports direct scrolling to specific fields via hash links (e.g., `/help#ix-api-key`).

### 🗺️ Dashboard UI Improvements
- **"Onde Encontrar" links**: Added a subtle "Onde Encontrar" link next to every configuration field in the 4-step integration process.
- **Contextual Help**: Each link opens the relevant section of the help guide in a new tab.

---

## 💎 Version 3.6.3 — Hiperadmin Visibility & Impersonation-Aware Roles — March 1, 2026

### 🛡️ Security / Role Visibility
- **Hiperadmin is invisible to all other roles**: Superadmins (and below) can no longer see the hiperadmin account in the user list — even when the real logged-in user is a hiperadmin impersonating a superadmin.
- **Impersonation-aware callerRole**: The users API now reads the impersonation cookie to determine filtering rules from the *viewer's* perspective (the impersonated user), not the real admin's. This prevents role escalation through impersonation.
- **Sidebar is impersonation-aware**: The "Regras de Clientes" link (hiperadmin-only) is hidden in the sidebar when a hiperadmin impersonates a non-hiperadmin account.
- **`isSelf` is impersonation-aware**: The "A Sua Conta" badge and action restrictions in the superadmin page now correctly identify the impersonated account as "self", not the real admin.

---

## 💎 Version 3.6.2 — Per-Client POS Mode & Client Rules Page — March 1, 2026

### 🏪 POS Mode (Per-Client Flag)
- **`pos_mode` column added to `integrations` table**: Boolean flag (default `0`) that activates the NIF-matrix name resolution for specific clients.
- **Standard mode (all clients by default)**: Name resolution is now safe and simple — real name or "Consumidor Final". No email-username or NIF-as-name derivations. Eliminates cross-contamination in InvoiceXpress.
- **POS mode (opt-in per client)**: Enables the full fiscal name matrix: name → `NIF XXXXXXXXX` → email username → "Consumidor Final". Configured at the account level, not globally.
- **Benedita Homem de Gouveia**: `pos_mode = 1` activated in production DB. Her POS orders (Shopify POS, no customer names) will correctly create unique IX clients such as "NIF 534174213".

### 👑 Hiperadmin Role
- **New `hiperadmin` role** (top of hierarchy: hiperadmin > superadmin > admin > user).
- **Hiperadmin can**: promote users to superadmin or admin, revoke any role, delete any account, see all users.
- **`isHiperadmin()` helper** added to `admin.ts`.
- **`getRole()` helper** added — returns the user's role string for flexible comparisons.
- **Pedro Porto** promoted to `hiperadmin` in production DB.

### 🖥️ "Regras de Clientes" Page (Hiperadmin Only)
- New page at `/client-rules` visible only to hiperadmin in the sidebar.
- Shows all client accounts with their integration flags as interactive toggles:
  - 🏪 Modo POS (NIF Matrix)
  - 💰 IVA Incluído
  - ⚡ Auto Finalizar
  - 🔗 Webhooks Confirmados
- Changes are saved immediately via `PATCH /api/admin/client-rules`.

### 🎭 Superadmin Page Improvements
- **Role badges** for all tiers: 👑 Hiperadmin (violet), 🔴 Superadmin (rose), 🟡 Admin (amber).
- **Dynamic role buttons**: Hiperadmin sees "Superadmin + Admin" options; Superadmin sees "Admin" only.
- **Avatar icons** change by role.
- **Delete with 2-step confirmation** per user card.

---

## 💎 Version 3.6.1 — Dynamic Greeting, User Delete, Admin Roles — March 1, 2026

### 🙋 Dynamic Dashboard Greeting
- **"Olá, Pedro" was hardcoded**: Now reads first name from the Clerk session (`useUser()`).
- **DB name for impersonation**: Integrations GET now returns `_user_name` from the `users` table so the greeting shows the *impersonated* user's name correctly.

### 🗑️ User Delete (Safe)
- Hiperadmin and superadmin can delete client accounts from D1 (users, integrations, logs).
- **Clerk account is intentionally NOT deleted**: The user can re-register with the same email/Google and will get a fresh D1 record via the `/api/auth/sync` endpoint.
- 2-step confirmation UI (click trash → confirm → cancel).
- Protections: hiperadmin cannot be deleted; admins cannot delete other admins.

---

## 💎 Version 3.6.0 — Superadmin Dashboard Improvements — March 1, 2026

### 🛡️ Role System
- **3-tier system (superadmin > admin > user)** introduced (later expanded to 4 in v3.6.2).
- Role badges in user cards.
- Superadmin can promote/demote users to admin.

---

## 💎 Version 3.5.6 — Fiscal Client Name Matrix — March 1, 2026

### 👤 Client Name Resolution
- **"Consumidor Final" is now reserved for truly anonymous sales** (no name, no email, no NIF).
- **NIF-only sales**: If a client provides only a NIF (common in POS), the system creates an IX client named `"NIF XXXXXXXXX"` — unique, fiscally traceable, and re-usable across purchases.
- **Matrix** (in priority order): Real name → `NIF XXXXXXXXX` → Email username → "Consumidor Final".

*(Note: In v3.6.2+, this matrix is scoped to `pos_mode = 1` clients only.)*

---

## 💎 Version 3.5.5 — NIF as Primary Client Key — March 1, 2026

### 🔍 InvoiceXpress Client Lookup
- **NIF is now the primary client matching key** (moved before code/email in `isExactMatch`).
- **Step 0 lookup**: Before any name-based search, if a NIF is present, the system calls `GET /clients.json?fiscal_id=XXXXXXXXX` directly. This is the most reliable path for POS orders where email and billing name are absent.
- **Email guard**: Empty emails (`""`) no longer incorrectly match existing clients.

---

## 💎 Version 3.5.0 — Client Identity & NIF Engine — March 1, 2026

### 🪪 NIF / Fiscal ID
- **NIF Patch on Existing Clients**: When an order's note contains a valid NIF but the matching InvoiceXpress client was created without one, the system now automatically issues a `PUT /clients/{id}.json` to update their fiscal ID before creating the invoice.
- **No-NIF tolerance**: The patch is non-blocking — if the IX API rejects the update, the invoice is still created correctly.

### 👤 Client Identity (Guest Checkout Fix)
- **Resolved "Client Portugal" cross-contamination**: Guest checkouts with no Shopify account name caused the fallback `"Client"` to match a generic IX record by email, creating invoices in the wrong name.
- **New name resolution chain** (in priority order):
  1. `customer.first_name + last_name` (account checkout)
  2. `billing_address.name` (guest checkout)
  3. Email username, capitalized (e.g. `benedita.gouveia@mail.pt` → `Benedita Gouveia`)
  4. `"Consumidor Final"` — Portuguese fiscal standard for anonymous buyers

### 🔗 Webhook Management
- **Manual Webhook Confirmation**: New `POST /api/integrations/webhooks-confirm` route. Marks `webhooks_active = 1` in D1 without requiring `write_webhooks` scope — for cases where webhooks were installed manually in Shopify Admin.
- **Confirm button in Passo 2**: The dashboard now shows a secondary amber "Confirmar Instalação Manual" button in the Webhooks step, allowing clients with limited-scope tokens to confirm manual installation.
- **No re-validation on every login**: `webhooks_active` is now preserved correctly in D1 and only updated when the token actually has read access to the webhooks list.

---

## 💎 Version 3.4.0 — 4-Step Onboarding Flow — March 1, 2026

### 🗺️ Dashboard Redesign
- **4-Step Guided Flow**: Split the original 3-step flow into 4 dedicated, focused steps:
  - **Passo 1**: Ligação Shopify (domain + token + API version)
  - **Passo 2**: Criação de Webhooks (webhook secret + install/confirm)
  - **Passo 3**: Conexão InvoiceXpress

### 🪪 NIF / Fiscal ID
- **NIF Patch on Existing Clients**: When an order's note contains a valid NIF but the matching InvoiceXpress client was created without one, the system now automatically issues a `PUT /clients/{id}.json` to update their fiscal ID before creating the invoice.
- **No-NIF tolerance**: The patch is non-blocking — if the IX API rejects the update, the invoice is still created correctly.

### 👤 Client Identity (Guest Checkout Fix)
- **Resolved "Client Portugal" cross-contamination**: Guest checkouts with no Shopify account name caused the fallback `"Client"` to match a generic IX record by email, creating invoices in the wrong name.
- **New name resolution chain** (in priority order):
  1. `customer.first_name + last_name` (account checkout)
  2. `billing_address.name` (guest checkout)
  3. Email username, capitalized (e.g. `benedita.gouveia@mail.pt` → `Benedita Gouveia`)
  4. `"Consumidor Final"` — Portuguese fiscal standard for anonymous buyers

### 🔗 Webhook Management
- **Manual Webhook Confirmation**: New `POST /api/integrations/webhooks-confirm` route. Marks `webhooks_active = 1` in D1 without requiring `write_webhooks` scope — for cases where webhooks were installed manually in Shopify Admin.
- **Confirm button in Passo 2**: The dashboard now shows a secondary amber "Confirmar Instalação Manual" button in the Webhooks step, allowing clients with limited-scope tokens to confirm manual installation.
- **No re-validation on every login**: `webhooks_active` is now preserved correctly in D1 and only updated when the token actually has read access to the webhooks list.

---

## 💎 Version 3.4.0 — 4-Step Onboarding Flow — March 1, 2026

### 🗺️ Dashboard Redesign
- **4-Step Guided Flow**: Split the original 3-step flow into 4 dedicated, focused steps:
  - **Passo 1**: Ligação Shopify (domain + token + API version)
  - **Passo 2**: Criação de Webhooks (webhook secret + install/confirm)
  - **Passo 3**: Conexão InvoiceXpress
  - **Passo 4**: Definições de Integração (save button)
- **Dedicated handlers**: Each step has its own isolated async handler (`handleShopifyConnect`, `handleWebhooksInstall`, `handleIxConnect`, `handleSaveSettings`), replacing the previous monolithic `handleConnect`.
- **Step sealing**: Each step collapses (seals) upon successful completion. Passo 4 seals via `setStep(5)` after save.
- **Smart resume**: On page load, the dashboard intelligently resumes from the correct step based on DB state (`shopify_authorized`, `ix_authorized`, `ix_api_key`).
- **"Integração Concluída" card**: Final green card only appears when all 3 integrations are verified (`shopifyAuthorized && ixAuthorized && webhooksActive`).

### 🔍 Webhook Diagnostics
- **3-pill status panel**: The completion card now shows individual status pills for Shopify, Webhooks, and InvoiceXpress.
- **Preserve-on-error logic**: If `webhooks.json` returns 403/401 (token lacks `read_webhooks`), the system now preserves the existing `webhooks_active` DB value instead of overwriting it with `0`.
- **`webhooks_active` in validate response**: The Shopify validate API now returns `webhooks_active` in its JSON response so the frontend can sync state accurately.

---

## 💎 Version 3.3.0 — Webhook Detection & Diagnostic Panel — March 1, 2026

### 🕵️ Webhook Health Detection
- **Active Shopify Webhook Verification**: The validate route now queries `GET /admin/api/{version}/webhooks.json` to check if the Rioko endpoints (`orders/paid`, `refunds/create`) are registered and pointing to the correct worker URL.
- **Selective Matching**: Only webhooks pointing to the Rioko worker URL are counted as valid — other integrations (e.g. Vendus, Mailchimp) are correctly ignored.
- **`webhooks_active` column**: Added to the `integrations` D1 table. Updated by both the activate route (on install) and validate route (on read).
- **Centralized config**: `RIOKO_CONFIG.workerUrl` and `webhookTopics` moved to `backoffice/src/lib/config.ts` for a single source of truth.

### 🖥️ Dashboard
- **Webhook status state**: `webhooksActive` state added to the dashboard, loaded from DB on mount.
- **Diagnostic pill in status bar**: Added a "Webhooks Shopify" status pill alongside Shopify and InvoiceXpress, with distinct red warning if not installed.
- **Warning banner**: If webhooks are missing, a red banner with actionable instructions appears below the diagnostic row.

---

## 💎 Version 3.2.0 (The Bulletproof Engine) - March 1, 2026

### 🛡️ Core Reliability & Security
- **Strict D1 Idempotency**: Implemented a transactional SQL-backed layer (`processed_orders` table) to prevent duplicate invoice creation. This solves the "Multiple Invoice" issue caused by eventually consistent KV lookups during high-frequency webhooks.
- **Atomic Operations**: Each order/refund event is now registered atomically, ensuring exactly one document per Shopify ID.

### ⚖️ Fiscal & Compliance
- **Full Exemption Descriptions**: Document observations now include the complete descriptive text for tax exemptions (e.g., "M01 - Artigo 16.º, n.º 6 do CIVA") instead of just the code.
- **Enhanced Document Metadata**: Improved layout of observations for better readability on generated PDFs.

## 💎 Version 3.1.0 (The Professional Rebranding) - March 1, 2026

### 🎨 User Experience & Branding
- **Sandbox Rebranding**: Replaced all technical "macewindu" references with the industry-standard "Sandbox" terminology across the entire dashboard and error messages.
- **Dynamic Sidebar Highlighting**: Implemented a new Client-side navigation system that correctly highlights the active menu item (Dashboard vs Superadmin).
- **PT-PT Localization**: Translated integration statuses ("Autorizado", "Pendente") and step titles to European Portuguese for a more natural user experience.
- **Improved Card Ergonomics**: Adjusted the position of the diagnostic card for better visibility and fixed its branding to "Rioko 2.0 Engine" as requested.
- **Dual-Stack IX Support**: Added automatic fallback detection for modern `.app.invoicexpress.com` domains alongside legacy ones.

## 💎 Version 2.9.0 (The Compliance & Tax Engine) - March 1, 2026

### ⚖️ Tax & Compliance
- **Dynamic Tax Exemption Reason**: Added a new configuration in Step 3 to select the legal reason for 0% VAT (e.g., "M01 - Artigo 16.º"). This ensures all invoices with exempt items are legally compliant with Portuguese AT rules.
- **Exemption Dropdown**: Integrated a curated list of all current InvoiceXpress exemption codes (M01 to M99) with full legal descriptions.
- **Worker Intelligence**: The InvoiceXpress worker now dynamically applies the selected exemption reason to both Invoices and Credit Notes when an item is marked as exempt.

### 🛡️ Reliability & UI Polishing
- **Tooltip Clipping Fix**: Re-architected the Dashboard's layering system to prevent diagnostic tooltips from being cut off by container boundaries.
- **Universal Build Version**: Implemented a dynamic versioning system that syncs the sidebar, logo, and metadata across the entire platform.

---

## 💎 Version 2.8.0 (The Visual & Diagnostic Engine) - March 1, 2026

### 🛡️ Diagnostic & Validation Engine
- **Hybrid Shopify Validation**: Re-engineered the connection motor to handle all Shopify store types, including Quickstart/Test stores. The system now performs a 3-way check (API 2024-2026) to ensure "Authorized" status even in evolving test environments.
- **Real-time Error Tooltips**: Introduced a premium diagnostic layer. Hovering over the "Invalid Credentials" badge now reveals a detailed, centered tooltip with the exact technical reason from Shopify/IX (e.g., "Unauthorized 401", "Domain not found").
- **Automatic Token Sanitization**: Added background `.trim()` and sanitization for API tokens to prevent connection failures caused by invisible white spaces.

### 🎨 Dashboard UI/UX Mastery
- **Step 4: Integration Status Bar**: Implemented a global synchronization indicator at the bottom of the dashboard. It provides a final "Shield Check" (Neon Green) when all 3 steps are fully validated and active.
- **Dynamic Versioning System**: Sidebar and badges now reflect the current build (`v2.8.0`) dynamically from a central configuration.
- **Visual Sealing (Step 3)**: Upon successful activation, the Command Center (Step 3) now seals and collapses automatically, matching the elegant "completed" look of the previous stages.
- **Hollow Icon Logic**: Invalid stages now use a distinct "Hollow Circle" icon to visually differentiate "Filled but Error" from "Completed & Authorized".

### 👑 Superadmin Enhancements
- **Global User Search**: Added a real-time search bar to the Superadmin dashboard to filter clients by Name, Email, or Store Domain.
- **Membership Timeline**: Users are now sorted by "Join Date" (Adesão) by default, with an optional toggle to reverse the order.
- **Self-Impersonation Protection**: Implemented a safeguard that prevents Superadmins from impersonating their own account, clearly labeling the primary admin card.
- **Enhanced Status Indicators**: The Admin list now includes mini-diagnostic tooltips for every client's Shopify and IX connection status.

---

## 🏆 Version 2.3.0 (The Integration & Privacy Milestone) - March 1, 2026

### 🔗 Document Connectivity
- **Smart Credit Note Association**: Implemented `owner_invoice_id` mapping. Refunds (Credit Notes) are now legally and visually linked to their original Fatura-Recibo in the InvoiceXpress dashboard.
- **Back-Calculation Engine**: Added a mathematical layer to automatically reverse-calculate Net prices from Gross totals for stores with "VAT Included" active, solving incompatible test environment errors.

### 🧠 Privacy & Intelligence
- **Privacy-First Mapping (KV Memory)**: The Worker now memorizes customer metadata at the moment of purchase. This allows processing refunds without "hitting" the Shopify API again, bypassing 401 permissions errors and the need for sensitive "Protected Customer Data" scopes.
- **Unified Command Center**: Re-architected Step 3 of the onboarding flow. A single "Guardar & Ativar" action now synchronizes all toggles (VAT, Auto-Finalize) before registering webhooks.

### 🛡️ Reliability & Fixes
- **Reference Streamlining**: Simplified document references (e.g., `Order #1278`) to improve searchability and prevent bracket-matching bugs in the IX API.
- **Auto-Finalize Sync**: Fixed a state-desync bug where toggles wouldn't apply to the active session until the next manual save.

---

## 🛡️ Version 2.2.0 (The Stability & Region Release) - March 1, 2026

### 🌍 Global Reach & Localization
- **Smart Country Mapping**: Implemented a mandatory translation layer for country codes. The system now automatically maps `PT` to `Portugal` to satisfy strict InvoiceXpress API requirements.
- **PT-PT Native UI**: The entire Dashboard and onboarding flow is now fully localized in Portuguese (Portugal).

### ⚙️ API Refinements (SaaS Robustness)
- **Universal Payload Protocol**: Cleaned item payloads to remove deprecated fields like `unit_with_tax`, ensuring 100% compatibility across both Production and `macewindu` (Test) environments.
- **Dynamic Connection States**: The UI now accurately reflects real-time connectivity, displaying "A aguardar ligação..." until the Step 3 webhook activation is confirmed.

### 🎨 Visual & UX Polishing
- **Rioko Branding v2.1**: Adjusted "2.0" version badge alignment for perfect visual symmetry.
- **Kapta Logo Integration**: Reinstated the Kapta logo in the sidebar footer with grayscale-to-color interactive hovers and direct links.
- **Icon Balance**: Optimized Shopify and InvoiceXpress partner logos for better visual hierarchy and updated the IX logo to the latest brand assets.

---

## 💎 Version 2.1.8 (SaaS-Ready & Security Build) - March 1, 2026

### 🛡️ Security & Integrity
- **Webhook Signature Verification**: Finalized HMAC-SHA256 validation. The system now rejects unauthorized Shopify signals using a unique `shopify_webhook_secret` per client.
- **Dynamic API Versioning**: Added support for specific Shopify API versions (e.g., `2024-04`, `2026-01`) manageable via the dashboard.

### SaaS-Ready Architecture
- **Environment Multi-Domain Support**: Implemented a smart toggle for **Production** vs **Test (macewindu)** environments. Account names no longer require manual domain suffixes.
- **Dynamic Worker Routing**: Corrected subdomain detection for Workers (e.g., `pedrotovarporto.workers.dev`), ensuring "Activate & Sync" works across different Cloudflare accounts.

### 🔍 Reliability & Observability
- **Real-time Webhook Audit**: Introduced a **D1 Logging System**. Every incoming signal, signature result, and IX response is now logged in the `logs` table for instant debugging.
- **Fallback Configurations**: Improved the `getConfig` utility to prioritize D1 settings while maintaining `wrangler.toml` defaults as a safe fallback.

### 🎨 UI/UX Mastery (Rioko 2.0)
- **Account Dashboard Fixes**: Fixed logo alignment, footer branding ("Developed by Kapta"), and improved sidebar visual hierarchy.
- **Clerk Identity Integration**: Added profile management, logout controls, and inactivity timeouts for enhanced security.
- **Performance**: Optimized all routes with `Edge Runtime` for lightning-fast Cloudflare Pages execution.

---

##  Version 2.0.0 (Global Alpha) - March 1, 2026

### 🚀 Major Breakthroughs (The "Bridge" Era)
- **Dynamic Multi-Client Engine**: The Worker now detects the Shopify `X-Shopify-Shop-Domain` and dynamically pulls integration credentials from Cloudflare D1. 
- **One-Click Activation**: Implemented remote webhook installation. Users can now "Activate & Sync" directly from the dashboard without touching Shopify settings.
- **Persistent Command Center**: Configuration for VAT (Tax-Included) and Auto-Finalize is now saved per user in the database.

### ✨ Visual & UI Refinements
- **Branding Excellence**: Integrated new Rioko and Kapta logos with perfect alignment and scaling.
- **Beta Badge & Stable Branding**: Added "Beta" status and stable versioning (v2.0.0 Stable Build) to the sidebar.
- **Safe Navigation**: Added "Go Back" functionality and "Update" states for completed integration steps.
- **Error Transparency**: Implemented a comprehensive pop-up error system for user-side feedback.

### 🛡️ Under the Hood
- **D1 Nexus**: Migrated from static `wrangler.toml` variables to a persistent SQL-based architecture in Cloudflare D1.
- **Deployment stability**: Optimized Build process (Next.js v15) and synchronized lockfiles for high-speed Cloudflare Pages deployments.
- **Anti-Duplication**: Enhanced idempotency filters that check IX directly before emitting documents.

---

## 📅 Version 1.1.2 - February 28, 2026

### ✨ New Features
- **Official Rioko v2 Branding**: Integrated the official white SVG logo provided by the design team.
- **Hold-on-Draft Refunds**: Implemented a "Hold" system for refunds.
- **Tax-Inclusive Toggle**: Added support for VAT-inclusive pricing via `INVOICEXPRESS_TAX_INCLUDED`.
- **Auto-Finalize Option**: Documents can now be automatically finalized upon creation.

### 🛡️ Bug Fixes & Optimizations
- **VAT Priority Fix**: Re-ordered tax detection to ensure products like "Marcadores" get 23% while "Livros" get 6% (Keywords are now fallbacks).
- **Collision Cleanup**: Re-architected client lookup to use the Direct Name Search API, eliminating "Name already taken" logs and speeding up sync for repeat customers.
- **Tax Mapping Reliability**: Standardized tax names to `IVA6`, `PT23`, and `Isento` to match your IX account precisely.
- **Discount Repair**: Switched from line-item discounts to `global_discount` to fix 422 "Item price must be positive" errors.

---

## 📅 Version 1.1.0 - February 27, 2026
...

### ✨ Initial Core Release
- **Automatic Fatura-Recibo**: Listening to Shopify "Paid" events.
- **Smart Idempotency**: Preventing double-invoicing using KV storage.
- **Workshop Override**: Defaulting workshops to 0% VAT.
- **Basic NIF support**: Extracting from order notes.
