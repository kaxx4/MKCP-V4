-- Migration 026: Mass-deletion sanity guard for the per-day and range voucher
-- prunes (019, 017).
--
-- Incident (2026-09-07/08): the nightly full-FY sync (server/src/services/
-- nightlySync.ts) fired at its scheduled midnight-local hour and got back a
-- CLEAN BUT EMPTY response from Tally for every one of ~160 daily chunks in
-- the financial year — Tally wasn't reachable/ready in a way that answered
-- with valid, empty XML instead of throwing a connection error. Every chunk
-- was therefore recorded as "succeeded" with 0 vouchers, all ~160 days landed
-- in `succeededDays`, and delete_voucher_orphans_for_days (019) did exactly
-- what its own comment says it's meant to: treated an empty p_valid_guids as
-- "these days are confirmed empty in Tally now" and deleted every voucher on
-- every one of those 160 days. The sync then computed hasData = false and
-- reported itself as a FAILURE (see tally_sync_history: 65 consecutive
-- "nightly" failures, "Tally returned zero data") — by which point the whole
-- financial year was already gone from tally_vouchers. It retried every ~10
-- minutes for 10+ hours; the app's own client-side store
-- (src/store/dataStore.ts's applyDailyPull) already has exactly this kind of
-- guard (MASS_DELETE_THRESHOLD_PCT) protecting the desktop's LOCAL view, but
-- nothing equivalent existed on the server side that actually writes Supabase
-- — the source of truth the web dashboard reads.
--
-- This migration adds that guard at the one place both the per-day and
-- range prunes must pass through: a prune spanning MORE THAN 3 days that
-- would remove more than 40% of what's already on file for those days is
-- refused (returns -1, deletes nothing) instead of executed. A single day
-- (or a couple of days) still prunes at up to 100% removal exactly as
-- before — that's the normal, desired case for clearing a real Tally
-- deletion/conversion and is untouched by this guard. Only a wide, mostly-
-- or-entirely-empty batch — the actual shape of this incident — gets
-- stopped. 40% mirrors the existing client-side MASS_DELETE_THRESHOLD_PCT.

CREATE OR REPLACE FUNCTION delete_voucher_orphans_for_days(
  p_company     text,
  p_days        text[],
  p_valid_guids text[]
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
BEGIN
  -- No authoritative days → nothing to prune.
  IF p_days IS NULL OR array_length(p_days, 1) IS NULL THEN
    RETURN 0;
  END IF;

  SELECT count(*) INTO existing_count
  FROM tally_vouchers v
  WHERE v.company = p_company AND v.date = ANY(p_days);

  -- Nothing on file for these days — no mass-deletion risk either way.
  IF existing_count = 0 THEN
    RETURN 0;
  END IF;

  SELECT count(*) INTO would_delete
  FROM tally_vouchers v
  WHERE v.company = p_company
    AND v.date = ANY(p_days)
    AND v.guid <> ALL(COALESCE(p_valid_guids, ARRAY[]::text[]));

  removal_pct := (would_delete::numeric / existing_count::numeric) * 100;

  -- Mass-deletion guard — only for multi-day batches (single/couple-day
  -- pruning, e.g. "Today", keeps its original 100%-removal-is-fine behavior;
  -- see header). array_length > 3 deliberately excludes narrow, frequently-
  -- run schedules and only engages for wide sweeps (Last 7 days, This FY,
  -- the nightly full-FY sync) where an all-empty response is much more
  -- likely to mean "Tally didn't actually answer" than "every voucher on
  -- every one of these days was really deleted".
  IF array_length(p_days, 1) > 3 AND removal_pct > 40 THEN
    RAISE WARNING
      'delete_voucher_orphans_for_days: refused for company "%": % day(s) would remove %/% (%.0f%%) — over the mass-deletion threshold',
      p_company, array_length(p_days, 1), would_delete, existing_count, removal_pct;
    RETURN -1; -- sentinel: guard tripped, nothing deleted — see supabaseSync.ts caller
  END IF;

  DELETE FROM tally_vouchers v
  WHERE v.company = p_company
    AND v.date = ANY(p_days)
    AND v.guid <> ALL(COALESCE(p_valid_guids, ARRAY[]::text[]));

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- Same guard for the whole-window range prune (017). Currently unreachable
-- from any production caller (every current sync uses chunkStrategy:
-- "daily", which only ever sets meta.pruneDays — see syncOrchestrator.ts),
-- but it already had its own weaker guard (refuse only on a fully-empty
-- p_valid_guids) — bringing it in line closes the same gap for any future
-- or legacy caller that does reach it.
CREATE OR REPLACE FUNCTION delete_voucher_orphans_in_range(
  p_company     text,
  p_from        text,
  p_to          text,
  p_valid_guids text[]
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
BEGIN
  -- Refuse to wipe a whole range when the caller sent no GUIDs. An empty pull
  -- is ambiguous (genuinely-empty range vs failed/timed-out fetch); deleting
  -- everything in range on a failed fetch would be catastrophic.
  IF p_valid_guids IS NULL OR array_length(p_valid_guids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  IF p_from IS NULL OR p_to IS NULL OR p_from = '' OR p_to = '' THEN
    RETURN 0;
  END IF;

  SELECT count(*) INTO existing_count
  FROM tally_vouchers v
  WHERE v.company = p_company AND v.date >= p_from AND v.date <= p_to;

  IF existing_count = 0 THEN
    RETURN 0;
  END IF;

  SELECT count(*) INTO would_delete
  FROM tally_vouchers v
  WHERE v.company = p_company
    AND v.date >= p_from AND v.date <= p_to
    AND v.guid <> ALL(p_valid_guids);

  removal_pct := (would_delete::numeric / existing_count::numeric) * 100;

  -- A date range is inherently multi-day by nature, so the day-count
  -- condition from the per-day guard doesn't apply here — any range prune
  -- over the removal threshold is refused.
  IF removal_pct > 40 THEN
    RAISE WARNING
      'delete_voucher_orphans_in_range: refused for company "%" [% .. %]: would remove %/% (%.0f%%) — over the mass-deletion threshold',
      p_company, p_from, p_to, would_delete, existing_count, removal_pct;
    RETURN -1;
  END IF;

  DELETE FROM tally_vouchers v
  WHERE v.company = p_company
    AND v.date >= p_from
    AND v.date <= p_to
    AND v.guid <> ALL(p_valid_guids);

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION delete_voucher_orphans_for_days(text, text[], text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION delete_voucher_orphans_for_days(text, text[], text[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION delete_voucher_orphans_for_days(text, text[], text[]) TO service_role;

REVOKE ALL ON FUNCTION delete_voucher_orphans_in_range(text, text, text, text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION delete_voucher_orphans_in_range(text, text, text, text[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION delete_voucher_orphans_in_range(text, text, text, text[]) TO service_role;

NOTIFY pgrst, 'reload schema';
