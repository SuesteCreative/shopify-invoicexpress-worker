-- "Convida 1 amigo, recebem os dois 2 meses grátis."
--
-- REESCRITA. A primeira versão deste ficheiro desenhava outra campanha (2 meses
-- para quem convida, 1 mês sem cartão para quem é convidado) e trazia uma tabela
-- `referral_codes` com um token próprio. Nunca correu em lado nenhum: confirmado
-- contra produção a 13/09/2026, onde `referrals` e `referral_codes` não existiam.
-- Uma migração que nunca foi aplicada e cuja funcionalidade mudou corrige-se; a
-- alternativa era criar duas tabelas para as deitar fora na semana seguinte.
--
-- Antes de aplicar, confirmar que continua a ser verdade:
--   SELECT name FROM sqlite_master WHERE name IN ('referrals','referral_codes');
-- Se devolver alguma coisa, PARAR: esta versão já não serve e é preciso uma 0059
-- com ALTER em vez desta reescrita.
--
-- O CÓDIGO DE CONVITE NÃO É UMA TABELA. É o número de cliente da 0058
-- (`RIO-1A2B3C`) mais um sufixo aleatório: `RIO-1A2B3C-9F2B41`. Assim há UM só
-- número por cliente — o mesmo que ele dita ao telefone, que aparece na ficha e
-- que a newsletter usa — e mesmo assim a 0058 continua a ser respeitada, porque
-- ela escreveu que o número nunca abre uma página pública sem um sufixo próprio,
-- como o token de convite da 0051 já leva. O sufixo vive em `users`, não numa
-- tabela: é um campo por conta, cunhado à primeira visita.
--
-- AS REGRAS SÃO CONSTRAINTS, não verificações espalhadas pelo código:
--   * PRIMARY KEY (invitee_user_id)         uma conta é convidada uma vez, para sempre
--   * CHECK (inviter <> invitee)            ninguém se convida a si próprio
--   * UNIQUE (invitee_subscription_id)      uma recompensa por subscrição
-- O tecto de 3 recompensas não é constraint: é uma contagem, porque depende do
-- estado das outras linhas e não desta.
--
-- A RECOMPENSA NÃO É UM CRÉDITO NEM UM CUPÃO. São dois meses acrescentados à
-- subscrição que já corre, empurrando `trial_end` e, com ele, o
-- `billing_cycle_anchor`. É a única forma que trata o plano anual como foi
-- prometido: a renovação passa a ser dois meses mais tarde. Um cupão de 100%
-- num plano anual daria um ano grátis, e um crédito no saldo daria 1/6 de uma
-- fatura anual, que não são dois meses de calendário.
--
-- `subscriptions.reward_until` existe por causa do rótulo, não do acesso: durante
-- a recompensa o Stripe põe a subscrição em `trialing`, e sem esta coluna o
-- painel diria "período de teste" a um cliente que paga há um ano.
--
-- Apply by hand:
--   npx wrangler d1 execute rioko-db --remote --file migrations/0057_referrals.sql
-- NEVER `d1 migrations apply` on this database: its ledger is stuck at 0017 and
-- it would replay 0018+ onto columns that already exist.

ALTER TABLE users ADD COLUMN referral_suffix TEXT;

CREATE TABLE referrals (
  invitee_user_id         TEXT PRIMARY KEY,
  inviter_user_id         TEXT NOT NULL,
  -- Denormalizado de propósito: é a referência que se mostra no admin e nos
  -- relatórios, e tem de sobreviver à conta de quem convidou ser apagada.
  inviter_client_code     TEXT NOT NULL,
  state                   TEXT NOT NULL DEFAULT 'pending', -- pending|subscribed|rewarded|void
  claimed_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  invitee_subscription_id TEXT,      -- o sub_ do convidado que disparou a recompensa
  invitee_subscribed_at   TEXT,
  reward_months           INTEGER,
  reward_until            TEXT,      -- o trial_end para onde a subscrição foi empurrada
  rewarded_at             TEXT,
  void_reason             TEXT,      -- porque é que uma recompensa foi recusada ou revertida
  note                    TEXT,
  CHECK (inviter_user_id <> invitee_user_id)
);

CREATE UNIQUE INDEX idx_referrals_invitee_sub ON referrals(invitee_subscription_id);
CREATE INDEX        idx_referrals_inviter     ON referrals(inviter_user_id, state);

ALTER TABLE subscriptions ADD COLUMN reward_until TEXT;
