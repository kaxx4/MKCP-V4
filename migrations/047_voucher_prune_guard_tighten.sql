-- Migration 047: tighten the per-day voucher prune guard (follows 026).
--
-- Why: 026 only guarded batches of MORE than 3 days. A single day (or 2-3
-- days) could still be pruned at 100%, which is the same shape as the
-- 2026-09-07/08 incident (an empty but valid Tally answer read as "every
-- voucher on these days was deleted"). See 026's header for that incident.
--
-- What changes in delete_voucher_orphans_for_days. The 3-argument overload
-- from 026 is dropped explicitly so the two signatures cannot collide.
--   1. An EMPTY p_valid_guids while the days hold rows is refused, for any
--      day count (returns -1, deletes nothing).
--   2. A single day that would lose more than 20% of its rows is refused.
--   3. 2 or 3 days that would lose more than 40% are refused (026 let these
--      through at any percentage).
--   4. More than 3 days: 40% rule unchanged.
--   5. New parameter p_force boolean DEFAULT false. When true the guard is
--      skipped. The Supabase caller sets it only when MKCP_ALLOW_BIG_PRUNE=1
--      is set on the operator's machine.
--
-- Shared company name warning: sandbox and production share one company
-- name, so both write the same rows. Apply only after a backup of
-- tally_vouchers (count and export). The owner applies this; it is NOT applied.
--
-- Self-test: migrations/selftests/047_prune_guard_selftest.sql (owner, on a COPY, before apply).
-- The transaction below is one BEGIN ... COMMIT so the drop and the create land together.


BEGIN;

DROP FUNCTION IF EXISTS delete_voucher_orphans_for_days(text, text[], text[]);

CREATE OR REPLACE FUNCTION delete_voucher_orphans_for_days(
  p_company     text,
  p_days        text[],
  p_valid_guids text[],
  p_force       boolean DEFAULT false
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count  integer;
  existing_count integer;
  would_delete   integer;
  removal_pct    numeric;
  day_count      integer;
  cap_pct        numeric;
BEGIN
  IF p_days IS NULL OR array_length(p_days, 1) IS NULL THEN
    RETURN 0;
  END IF;

  day_count := array_length(p_days, 1);

  SELECT count(*) INTO existing_count
  FROM tally_vouchers v
  WHERE v.company = p_company AND v.date = ANY(p_days);

  IF existing_count = 0 THEN
    RETURN 0;
  END IF;

  -- Rule 1: an empty answer for days that hold rows is the incident shape.
  IF NOT p_force AND (p_valid_guids IS NULL OR array_length(p_valid_guids, 1) IS NULL) THEN
    RAISE WARNING
      'delete_voucher_orphans_for_days: refused for company "%": empty valid-guid list over % row(s) on % day(s)',
      p_company, existing_count, day_count;
    RETURN -1;
  END IF;

  SELECT count(*) INTO would_delete
  FROM tally_vouchers v
  WHERE v.company = p_company
    AND v.date = ANY(p_days)
    AND v.guid <> ALL(COALESCE(p_valid_guids, ARRAY[]::text[]));

  removal_pct := (would_delete::numeric / existing_count::numeric) * 100;

  -- Rules 2-4: percentage caps by batch size.
  IF day_count = 1 THEN
    cap_pct := 20;
  ELSE
    cap_pct := 40;
  END IF;

  IF NOT p_force AND removal_pct > cap_pct THEN
    RAISE WARNING
      'delete_voucher_orphans_for_days: refused for company "%": % day(s) would remove % of % row(s) (% percent), cap % percent',
      p_company, day_count, would_delete, existing_count, round(removal_pct)::integer, cap_pct;
    RETURN -1;
  END IF;

  DELETE FROM tally_vouchers v
  WHERE v.company = p_company
    AND v.date = ANY(p_days)
    AND v.guid <> ALL(COALESCE(p_valid_guids, ARRAY[]::text[]));

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION delete_voucher_orphans_for_days(text, text[], text[], boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION delete_voucher_orphans_for_days(text, text[], text[], boolean) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION delete_voucher_orphans_for_days(text, text[], text[], boolean) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
