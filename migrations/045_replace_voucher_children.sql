-- APPLIED 18-Oct-2026 (owner: "Yes, fix, apply, release"); applied as agent_045_replace_voucher_children, verified read-only after.
-- Migration 045: replace a chunk of vouchers' child rows in ONE transaction (#112).
--
-- Why: the sync used to DELETE ledger + inventory entries for a chunk and only
-- then INSERT the new rows from the client. A crash or insert error in between
-- left those vouchers with no child rows (zero-line vouchers; revenue and stock
-- silently dropped). This function does the delete and the insert together, so
-- a failure leaves the chunk either fully old or fully new.
--
-- Column lists are the ones the client already writes (supabaseSync.ts); types
-- and defaults come from the live tables via jsonb_populate_recordset, so no
-- column is guessed. The client's rows are passed as JSON arrays.
--
-- Shared company name warning: sandbox and production share one company name
-- and write the same rows. The function only touches rows for p_guids within
-- p_company. Owner applies this after a backup of both child tables; it is NOT
-- applied by the builder.
--
-- Self-test (owner, on a COPY, in a transaction): replace two vouchers' rows with
-- new ones, check counts before and after, then ROLLBACK.

CREATE OR REPLACE FUNCTION replace_voucher_children(
  p_company   text,
  p_guids     text[],
  p_ledger    jsonb,
  p_inventory jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  l_n integer := 0;
  i_n integer := 0;
BEGIN
  IF p_guids IS NULL OR array_length(p_guids, 1) IS NULL THEN
    RETURN jsonb_build_object('ledger', 0, 'inventory', 0);
  END IF;

  DELETE FROM tally_voucher_ledger_entries
  WHERE company = p_company AND voucher_guid = ANY(p_guids);
  DELETE FROM tally_voucher_inventory_entries
  WHERE company = p_company AND voucher_guid = ANY(p_guids);

  INSERT INTO tally_voucher_ledger_entries (
    voucher_guid, company, ledger_name, is_debit, is_party_ledger, amount, bill_allocations, synced_at
  )
  SELECT voucher_guid, company, ledger_name, is_debit, is_party_ledger, amount, bill_allocations, synced_at
  FROM jsonb_populate_recordset(null::tally_voucher_ledger_entries, COALESCE(p_ledger, '[]'::jsonb))
  WHERE company = p_company AND voucher_guid = ANY(p_guids);
  GET DIAGNOSTICS l_n = ROW_COUNT;

  INSERT INTO tally_voucher_inventory_entries (
    voucher_guid, company, stock_item_name, actual_qty, billed_qty, rate, amount, is_deemed_positive,
    godown_name, batch_name, destination_godown_name, batch_allocations, is_split_across_godowns, synced_at
  )
  SELECT voucher_guid, company, stock_item_name, actual_qty, billed_qty, rate, amount, is_deemed_positive,
         godown_name, batch_name, destination_godown_name, batch_allocations, is_split_across_godowns, synced_at
  FROM jsonb_populate_recordset(null::tally_voucher_inventory_entries, COALESCE(p_inventory, '[]'::jsonb))
  WHERE company = p_company AND voucher_guid = ANY(p_guids);
  GET DIAGNOSTICS i_n = ROW_COUNT;

  RETURN jsonb_build_object('ledger', l_n, 'inventory', i_n);
END;
$$;

REVOKE ALL ON FUNCTION replace_voucher_children(text, text[], jsonb, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION replace_voucher_children(text, text[], jsonb, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION replace_voucher_children(text, text[], jsonb, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
