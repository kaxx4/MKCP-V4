-- SELF-TEST for migration 045 (replace_voucher_children).
--
-- RUN ONLY ON A COPY OF THE DATABASE, NEVER ON LIVE. Lives in migrations/selftests/
-- so the migration runner does not pick it up. One transaction, ends in ROLLBACK.
--
-- Before running: the INSERTs below must list the NOT NULL columns of the copy's
-- child tables (the builder could not read the live schema). Add them there.
-- Run AFTER 045 has been applied to the copy.

BEGIN;

-- Old child rows for two vouchers of SELFTEST, plus one row of another company
-- for the same GUID, which the function must leave alone.
INSERT INTO tally_voucher_ledger_entries (voucher_guid, company, ledger_name, amount)
VALUES ('gA', 'SELFTEST', 'OLD', 1), ('gB', 'SELFTEST', 'OLD', 1), ('gA', 'OTHERCO', 'KEEP', 1);

DO $$
DECLARE
  res jsonb;
BEGIN
  res := replace_voucher_children(
    'SELFTEST',
    ARRAY['gA', 'gB'],
    -- one new row for gA, one row for gB that is NOT in p_guids, one row of another company
    '[{"voucher_guid":"gA","company":"SELFTEST","ledger_name":"NEW","amount":5},
      {"voucher_guid":"gX","company":"SELFTEST","ledger_name":"NOT-IN-GUIDS","amount":9},
      {"voucher_guid":"gA","company":"OTHERCO","ledger_name":"WRONG-CO","amount":9}]'::jsonb,
    '[]'::jsonb
  );

  -- Only the in-guid, same-company row may be inserted.
  IF (res->>'ledger')::int <> 1 THEN
    RAISE EXCEPTION 'expected 1 ledger row inserted, got %', res->>'ledger';
  END IF;
  IF EXISTS (SELECT 1 FROM tally_voucher_ledger_entries WHERE ledger_name IN ('NOT-IN-GUIDS','WRONG-CO')) THEN
    RAISE EXCEPTION 'rows outside p_guids or p_company were inserted';
  END IF;
  -- The other company's row for gA survives the delete.
  IF NOT EXISTS (SELECT 1 FROM tally_voucher_ledger_entries WHERE company = 'OTHERCO' AND ledger_name = 'KEEP') THEN
    RAISE EXCEPTION 'another company row was deleted';
  END IF;
  RAISE NOTICE 'migration 045 self-test: all cases pass (rolling back)';
END $$;

ROLLBACK;
