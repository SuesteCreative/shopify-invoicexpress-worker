-- Two things superadmin could not say before.
--
-- 1. A dormant client (Fabrica Coffee Roasters, OPH Van de Ven) is not a fault.
--    Their subscription is over, nothing is being invoiced on purpose, and every
--    warning email we send them is noise we taught ourselves to ignore. Mark the
--    account inactive and the warning senders skip it; newsletters still go out.
--
-- 2. A card in superadmin is a CONNECTION, not an account: WHM runs Shopify→IX
--    and Stripe→IX from one user row, and `users.admin_label` could only name
--    both at once. Connections get their own label so they can be told apart
--    ("WHM - Shopify" / "WHM - Stripe"). Identification only, never fiscal.
ALTER TABLE users ADD COLUMN is_inactive INTEGER NOT NULL DEFAULT 0;
ALTER TABLE connections ADD COLUMN admin_label TEXT;
