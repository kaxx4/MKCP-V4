-- Migration 017: Range-scoped voucher orphan cleanup.
--
-- SUPERSEDES the global tally_vouchers cleanup added in migration 016, which
-- was unsafe: a daybook/range sync pulls only a SUBSET of vouchers, so deleting
-- every GUID not in that subset wiped the entire history outside the range.
--
-- This function deletes only vouchers WITHIN the pulled date window [p_from,
-- p_to] whose GUID is not in the just-pulled set. Vouchers dated outside the
-- window are never touched. Called from supabaseSync.syncVouchers() when the
-- caller passes meta.pruneRange (the orchestrator's range pull).
--
-- Dates are stored as Tally YYYYMMDD strings, so lexicographic >=/<= equals
-- chronological ordering.

CREATE OR REPLACE FUNCTION delete_voucher_orphans_in_range(
  p_company    text,
  p_from       text,
  p_to         text,
  p_valid_guids text[]
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count integer;
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

  DELETE FROM tally_vouchers v
  WHERE v.company = p_company
    AND v.date >= p_from
    AND v.date <= p_to
    AND v.guid <> ALL(p_valid_guids);

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION delete_voucher_orphans_in_range(text, text, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_voucher_orphans_in_range(text, text, text, text[]) TO service_role;

NOTIFY pgrst, 'reload schema';
