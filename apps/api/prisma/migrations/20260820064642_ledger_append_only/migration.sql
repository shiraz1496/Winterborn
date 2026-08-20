-- LedgerEvent is append-only. Nothing may UPDATE or DELETE a row once
-- written: the whole no-permanent-drift guarantee rests on the schema
-- having nowhere else to store a balance, and on-hand being a live SUM
-- over these rows. A row mutated in place would silently change every
-- past and future derivation with no trace in the event stream itself.
--
-- This was previously enforced only by convention (LedgerService being the
-- sole writer, and never issuing UPDATE/DELETE). This trigger makes it a
-- database-level guarantee instead, so a migration, a console session, or
-- a future service that forgets the rule cannot violate it.
--
-- TRUNCATE is unaffected: it does not fire row-level triggers, so
-- seedDevCatalog's TRUNCATE ... RESTART IDENTITY CASCADE continues to work.
CREATE OR REPLACE FUNCTION ledger_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LedgerEvent is append-only; correct a mistake by appending a CORRECTION event, not by % (id=%)',
    TG_OP,
    COALESCE(OLD."id", 'unknown');
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_event_append_only
  BEFORE UPDATE OR DELETE ON "LedgerEvent"
  FOR EACH ROW
  EXECUTE FUNCTION ledger_event_append_only();
