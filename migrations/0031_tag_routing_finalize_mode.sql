-- Tag routing: make the draft/finalize decision an explicit field.
--
-- Until now a rule expressed "leave it as a draft" by suffixing the document
-- type ('invoice_receipt_draft'). That conflated two orthogonal choices, only
-- ever worked on the Moloni branch, and silently degraded to a finalized
-- 'invoice' on InvoiceXpress. finalize_mode separates them:
--   'finalize' -> force auto_finalize = 1
--   'draft'    -> force auto_finalize = 0
--   NULL       -> inherit the connection's auto_finalize
ALTER TABLE tag_routing_rules ADD COLUMN finalize_mode TEXT;

-- Fold the legacy suffix into the new column. The underscore is escaped so it
-- is matched literally rather than as LIKE's single-character wildcard.
UPDATE tag_routing_rules
   SET finalize_mode = 'draft',
       document_type = REPLACE(document_type, '_draft', '')
 WHERE document_type LIKE '%\_draft' ESCAPE '\';

-- A non-draft type previously forced auto_finalize = 1 on the Moloni branch.
-- Preserve that so existing rules keep their current behaviour. Series-only
-- rules (document_type NULL) inherited auto_finalize and still should.
UPDATE tag_routing_rules
   SET finalize_mode = 'finalize'
 WHERE finalize_mode IS NULL
   AND document_type IS NOT NULL
   AND document_type <> '';

-- Remember which route a document was created under. The rule is matched on the
-- `created` webhook, but `paid` (finalize) and `refund` (credit note) arrive
-- later with a fresh context and no order tags of their own. Without this, a
-- draft routed to invoice_receipt / series B is finalized against the
-- connection default — for Moloni that means /invoices/update/ missing an id
-- that lives in /invoiceReceipts/, and credit notes landing in the wrong set.
-- JSON payload: {"docType":…,"finalize":…,"series":…}; NULL = no rule matched.
ALTER TABLE processed_orders ADD COLUMN routed_json TEXT;
