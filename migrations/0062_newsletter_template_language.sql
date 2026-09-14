-- A campanha deixa de ser uma linha por língua e passa a ser uma família de
-- versões: `family` diz a que campanha a linha pertence, `language` diz em que
-- língua está escrita.
--
-- Porquê: o painel mostrava duas campanhas separadas no topo e nada obrigava a
-- que a escolhida casasse com a audiência. A 14/09/2026 faltou um clique para a
-- versão portuguesa sair para os quatro clientes ingleses — o chip de língua
-- filtra QUEM recebe e nunca mudou O QUE é enviado.
--
-- Com estas duas colunas, o envio passa a impor `lang:<language>` no servidor, a
-- partir da versão escolhida, e o par errado deixa de ser possível.
--
-- 'pt' é o valor de quem já lá está: é a língua em que todas as campanhas foram
-- escritas até hoje. `family` fica igual ao próprio slug, que é o que uma
-- campanha sem traduções significa.
--
-- Aplicar à mão:
--   npx wrangler d1 execute rioko-db --remote --file migrations/0062_newsletter_template_language.sql
-- NUNCA `d1 migrations apply` nesta base: o registo está parado no 0017 e
-- reaplicaria tudo a partir do 0018 sobre colunas que já existem.
ALTER TABLE newsletter_templates ADD COLUMN language TEXT NOT NULL DEFAULT 'pt';
ALTER TABLE newsletter_templates ADD COLUMN family TEXT;

UPDATE newsletter_templates SET family = slug WHERE family IS NULL;

-- A versão inglesa da campanha de convites, criada a 14/09 como campanha à
-- parte, passa a ser a versão EN da portuguesa.
UPDATE newsletter_templates
   SET language = 'en', family = 'convites-2-meses-gratis'
 WHERE slug = 'convites-2-meses-gratis-en';
