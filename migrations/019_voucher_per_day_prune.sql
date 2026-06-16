-- Migration 019: Per-day voucher orphan prune.
--
-- The whole-window prune (017) only ran when EVERY chunk of a sync succeeded, so
-- the FY-wide daily sync (which usually has a few timed-out days) never pruned —
-- old deleted/converted vouchers (e.g. Delivery Notes) lingered forever.
--
-- This prunes per successfully-pulled day instead: delete vouchers whose date is
-- one of the cleanly-pulled days AND whose GUID wasn't in that pull. Each clean
-- day clears its own deletions even when other days failed. An empty pulled set
-- means those days are empty in Tally now, so their stale rows are removed.
--
-- Dates are stored as Tally YYYYMMDD strings.

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
  deleted_count integer;
BEGIN
  -- No authoritative days → nothing to prune.
  IF p_days IS NULL OR array_length(p_days, 1) IS NULL THEN
    RETURN 0;
  END IF;

  -- NOTE: p_valid_guids MAY be empty — that means the listed days are empty in
  -- Tally, so every voucher on those days should be removed. `guid <> ALL('{}')`
  -- is vacuously true, which is exactly what we want here. Safe because p_days is
  -- restricted to days we pulled successfully.
  DELETE FROM tally_vouchers v
  WHERE v.company = p_company
    AND v.date = ANY(p_days)
    AND v.guid <> ALL(COALESCE(p_valid_guids, ARRAY[]::text[]));

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION delete_voucher_orphans_for_days(text, text[], text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION delete_voucher_orphans_for_days(text, text[], text[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION delete_voucher_orphans_for_days(text, text[], text[]) TO service_role;

NOTIFY pgrst, 'reload schema';
