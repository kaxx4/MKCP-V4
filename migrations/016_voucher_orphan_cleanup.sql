-- Migration 016: Delete orphaned tally_vouchers when a full sync runs.
--
-- Previously, syncVouchers() only upserted rows — vouchers deleted or
-- converted in Tally remained in Supabase forever.  This migration:
--
--   1. Extends delete_orphans() to also allow tally_vouchers / guid.
--   2. Adds cleanup_orphan_voucher_entries(company) which removes rows
--      from tally_voucher_ledger_entries and tally_voucher_inventory_entries
--      whose parent voucher no longer exists in tally_vouchers.
--
-- Both functions are called from supabaseSync.syncVouchers() after every
-- full-voucher push so the cloud mirrors the current Tally state exactly.

-- 1. Re-create delete_orphans with the new allowlist entries.
CREATE OR REPLACE FUNCTION delete_orphans(
  p_table     text,
  p_company   text,
  p_key_col   text,
  p_valid_keys text[]
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF p_table NOT IN (
    'discount_rules',
    'order_groups',
    'unit_overrides',
    'rate_overrides',
    'gst_overrides',
    'item_category_overrides',
    'category_colors',
    'vendor_group_assignments',
    'item_notes',
    'calling_list_entries',
    'tally_price_list_imports',
    'voucher_overrides',
    'tally_vouchers'
  ) THEN
    RAISE EXCEPTION 'delete_orphans: table % is not in the allowlist', p_table;
  END IF;

  IF p_key_col NOT IN (
    'id', 'item_id', 'category_id', 'party_ledger_id',
    'voucher_id', 'item_name', 'guid'
  ) THEN
    RAISE EXCEPTION 'delete_orphans: key column % is not in the allowlist', p_key_col;
  END IF;

  IF p_valid_keys IS NULL OR array_length(p_valid_keys, 1) IS NULL THEN
    RETURN 0;
  END IF;

  EXECUTE format(
    'DELETE FROM %I WHERE company = $1 AND %I <> ALL($2)',
    p_table, p_key_col
  ) USING p_company, p_valid_keys;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION delete_orphans(text, text, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_orphans(text, text, text, text[]) TO service_role;

-- 2. New function: clean up child-table rows for vouchers no longer present.
CREATE OR REPLACE FUNCTION cleanup_orphan_voucher_entries(p_company text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
  total integer := 0;
BEGIN
  DELETE FROM tally_voucher_ledger_entries le
  WHERE le.company = p_company
    AND NOT EXISTS (
      SELECT 1 FROM tally_vouchers v
      WHERE v.guid = le.voucher_guid AND v.company = p_company
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  total := total + n;

  DELETE FROM tally_voucher_inventory_entries ie
  WHERE ie.company = p_company
    AND NOT EXISTS (
      SELECT 1 FROM tally_vouchers v
      WHERE v.guid = ie.voucher_guid AND v.company = p_company
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  total := total + n;

  RETURN total;
END;
$$;

REVOKE ALL ON FUNCTION cleanup_orphan_voucher_entries(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cleanup_orphan_voucher_entries(text) TO service_role;

NOTIFY pgrst, 'reload schema';
