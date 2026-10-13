-- SELF-TEST for migration 047 (delete_voucher_orphans_for_days guard).
--
-- RUN ONLY ON A COPY OF THE DATABASE, NEVER ON LIVE. Not a migration: the
-- migration runner must not pick this up (it lives in migrations/selftests/).
-- The whole script runs in one transaction and ends in ROLLBACK, so nothing
-- persists even on the copy.
--
-- Before running: the INSERT below must list the NOT NULL columns of the copy's
-- tally_vouchers (the builder could not read the live schema). Add them there.
-- Run AFTER 047 has been applied to the copy. Success = the DO block finishes
-- without RAISE EXCEPTION and the final ROLLBACK runs.

BEGIN;

INSERT INTO tally_vouchers (company, date, guid)
SELECT 'SELFTEST', '2099-01-01', 'g' || i FROM generate_series(1, 10) AS i;
-- ^ add the copy's NOT NULL columns to this INSERT if it errors.

DO $$
DECLARE
  r integer;
BEGIN
  -- Case 1: one day, 9 of 10 would go (90% > 20% cap): refused.
  r := delete_voucher_orphans_for_days('SELFTEST', ARRAY['2099-01-01'], ARRAY['g1']);
  IF r <> -1 THEN RAISE EXCEPTION 'case 1: expected -1 (refused), got %', r; END IF;

  -- Case 2: empty valid-guid list while rows exist: refused for any day count.
  r := delete_voucher_orphans_for_days('SELFTEST', ARRAY['2099-01-01'], ARRAY[]::text[]);
  IF r <> -1 THEN RAISE EXCEPTION 'case 2: expected -1 (empty guids refused), got %', r; END IF;

  -- Case 3: the same 9-of-10 prune with the explicit override: allowed.
  r := delete_voucher_orphans_for_days('SELFTEST', ARRAY['2099-01-01'], ARRAY['g1'], true);
  IF r <> 9 THEN RAISE EXCEPTION 'case 3: expected 9 deleted with p_force, got %', r; END IF;

  -- Case 4: after the forced prune only g1 remains.
  PERFORM 1 FROM tally_vouchers WHERE company = 'SELFTEST';
  IF (SELECT count(*) FROM tally_vouchers WHERE company = 'SELFTEST') <> 1 THEN
    RAISE EXCEPTION 'case 4: expected 1 row left';
  END IF;

  RAISE NOTICE 'migration 047 self-test: all cases pass (rolling back)';
END $$;

ROLLBACK;
