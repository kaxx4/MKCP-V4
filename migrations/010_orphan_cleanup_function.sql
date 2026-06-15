-- Migration 010: delete_orphans() — propagate local deletes to Supabase.
--
-- Each /api/supabase/sync-config push currently UPSERTs the rows the client
-- has, but never deletes rows in the cloud that the client has dropped.
-- That meant: delete an order group / reset a voucher override / clear a
-- note locally → cloud retains a stale row forever.
--
-- This function is called from supabaseSync.ts after every config-channel
-- upsert. It removes rows for (company, table) whose unique key is NOT in
-- the list of keys the client just pushed. SECURITY DEFINER so the
-- service-role-only RLS policies don't block it; dynamic SQL is safe because
-- the table name comes from a server-side allowlist (see supabaseSync.ts).

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
  -- Allowlist check — only tables we explicitly sync. Prevents any caller
  -- with EXECUTE on this function from deleting from arbitrary tables.
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
    'voucher_overrides'
  ) THEN
    RAISE EXCEPTION 'delete_orphans: table % is not in the allowlist', p_table;
  END IF;

  -- Same allowlist for key_col — single-column unique keys only.
  IF p_key_col NOT IN (
    'id', 'item_id', 'category_id', 'party_ledger_id', 'voucher_id', 'item_name'
  ) THEN
    RAISE EXCEPTION 'delete_orphans: key column % is not in the allowlist', p_key_col;
  END IF;

  -- Safety: refuse to wipe when the caller sent an empty key set.
  -- The Node helper also guards against this, but defense-in-depth: an
  -- empty array would otherwise delete ALL rows for the company.
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

-- service_role only — never callable from anon
REVOKE ALL ON FUNCTION delete_orphans(text, text, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_orphans(text, text, text, text[]) TO service_role;

NOTIFY pgrst, 'reload schema';
