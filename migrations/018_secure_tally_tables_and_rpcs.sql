-- Migration 018: Secure the tally_* sync tables + push_queue with RLS, and lock
-- down the SECURITY DEFINER maintenance RPCs.
--
-- BEFORE: the 12 tally_* tables had RLS disabled (Supabase ERROR-level advisory) —
-- the publishable/anon key bundled in the distributed Electron + mobile apps could
-- read AND write/delete all business data. The delete_orphans / *_in_range /
-- cleanup_orphan_voucher_entries SECURITY DEFINER functions were also callable by
-- anon, allowing data deletion via /rest/v1/rpc.
--
-- AFTER: permissive public SELECT (mirrors push_sync_log) keeps the dashboard
-- renderer's reads AND the mobile app's reads working, but there are NO write
-- policies — so anon/authenticated can no longer INSERT/UPDATE/DELETE. The
-- dashboard server writes with the service-role key, which bypasses RLS, so sync
-- is unaffected. The maintenance RPCs are revoked from anon/authenticated
-- (service-role retains EXECUTE; the server calls them with that key).
--
-- Verified post-apply: anon SELECT → 200; anon INSERT/RPC → 401; service-role
-- masters + voucher syncs succeed; Supabase security advisors return zero lints.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tally_companies','tally_stock_groups','tally_units','tally_godowns',
    'tally_cost_centres','tally_stock_items','tally_ledgers','tally_price_lists',
    'tally_vouchers','tally_sync_history','tally_voucher_ledger_entries',
    'tally_voucher_inventory_entries','push_queue'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'public read '||t, t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (true)', 'public read '||t, t);
  END LOOP;
END $$;

REVOKE EXECUTE ON FUNCTION public.delete_orphans(text, text, text, text[]) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_voucher_orphans_in_range(text, text, text, text[]) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_orphan_voucher_entries(text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_push_jobs(text, integer, integer) FROM anon, authenticated;

ALTER FUNCTION public.claim_push_jobs(text, integer, integer) SET search_path = public, pg_temp;
