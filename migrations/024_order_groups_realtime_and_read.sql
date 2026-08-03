-- Migration 024: enable Realtime + public read on order_groups.
--
-- Same reasoning as migration 023 for the discount tables:
--   1. order_groups was never added to the supabase_realtime publication, so
--      the web dashboard's new postgres_changes subscription (src/App.tsx,
--      useRealtimeSyncAll) would otherwise be a silent no-op — an item-group
--      assignment made on one device/tab wouldn't show up live on another.
--   2. Every RLS policy this table has ever gotten (migrations 001/004) only
--      grants `service_role`, with no anon/authenticated SELECT — the web
--      dashboard's fetchOrderGroupsFromSupabase() reads with the browser's
--      anon key, so if that's genuinely the live policy set, every read has
--      been silently returning zero rows.
--
-- Separately (fixed in application code, not here): the web app was writing/
-- reading a generic `data` column that was never part of this table's schema
-- at all (the table has real typed columns — name, description, color, tags,
-- item_ids, lines) — so upserts have been failing outright with a "column
-- not found" error this whole time, independent of RLS/Realtime. That's why
-- this migration matters now: fixing the column mismatch makes the writes
-- start actually landing, which only matters if reads/Realtime can then see
-- them too.
--
-- Idempotent — safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      AND tablename = 'order_groups'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.order_groups;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'order_groups' AND policyname = 'order_groups_public_read'
  ) THEN
    CREATE POLICY "order_groups_public_read" ON public.order_groups FOR SELECT TO anon, authenticated USING (true);
  END IF;
END $$;
