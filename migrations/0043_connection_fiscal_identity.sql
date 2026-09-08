-- Give every non-Shopify InvoiceXpress connection its own fiscal identity.
--
-- Series, exemption code and document type lived on the shared `integrations`
-- row and nowhere else. One row, one of each — so an account invoicing into the
-- same InvoiceXpress account from two places could not file them in two series,
-- and whichever setup wizard was saved last silently rewrote the other's.
-- Measured on Wim Hof Method (08/09/2026): the Stripe wizard had already put
-- `FR-ROW` where the shop's `WH-25-1` used to be.
--
-- The worker now reads these off the connection when it states them
-- (projectConnectionBehaviour), falling back to the legacy row when it does not.
-- This seeds each connection with what its documents are being filed under
-- TODAY, so nothing changes on the next invoice, and the legacy row is free to
-- go back to being the Shopify shop's.
--
-- Blank is meaningful: it means "inherit the legacy row". Seeding blanks is
-- therefore a no-op for behaviour, and the guard below keeps a connection that
-- already states a series from being overwritten.
UPDATE connections
   SET destination_config_json = json_patch(
         COALESCE(destination_config_json, '{}'),
         (SELECT json_object(
                   'ix_sequence_name',    COALESCE(i.ix_sequence_name, ''),
                   'ix_exemption_reason', COALESCE(i.ix_exemption_reason, ''),
                   'ix_document_type',    COALESCE(i.ix_document_type, '')
                 )
            FROM integrations i
           WHERE i.user_id = connections.user_id
           LIMIT 1)
       ),
       updated_at = CURRENT_TIMESTAMP
 WHERE destination_kind = 'invoicexpress'
   AND source_kind <> 'shopify'
   AND json_extract(COALESCE(destination_config_json, '{}'), '$.ix_sequence_name') IS NULL
   AND EXISTS (SELECT 1 FROM integrations i WHERE i.user_id = connections.user_id);
