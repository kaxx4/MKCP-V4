-- Migration 023: enable Realtime + public read on discount_rules,
-- category_colors, and item_category_overrides.
--
-- The web dashboard now subscribes to postgres_changes on these three tables
-- (src/App.tsx, useRealtimeSyncAll) so an edit made on one device/tab shows
-- up live on any other already-open tab — same reasoning as migration 022
-- for tally_sync_history. Without being added to the supabase_realtime
-- publication, Postgres never emits change events for them and the
-- subscription is a silent no-op: the write lands fine, but nobody already
-- viewing the Discounts page sees it until they manually reload.
--
-- Separately: migrations 001/003/004/006 only ever granted these tables a
-- `FOR ALL USING (auth.role() = 'service_role')` policy — no anon/authenticated
-- SELECT was ever added, unlike the tally_* tables (migration 018's "public
-- read" loop). The web dashboard's fetchDiscountRulesFromSupabase() reads
-- with the browser's anon key, so if that's genuinely the live policy set
-- (as opposed to a public-read grant made ad hoc via the dashboard and never
-- captured in a migration), every read has been silently returning zero rows
-- — the actual reason rules don't sync across devices, with the previous
-- one-shot-fetch-on-mount design just masking it. Add explicit public read
-- policies so this works regardless of which case is true.
--
-- Idempotent — safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'discount_rules' AND policyname = 'discount_rules_public_read'
  ) THEN
    CREATE POLICY "discount_rules_public_read" ON public.discount_rules FOR SELECT TO anon, authenticated USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'category_colors' AND policyname = 'category_colors_public_read'
  ) THEN
    CREATE POLICY "category_colors_public_read" ON public.category_colors FOR SELECT TO anon, authenticated USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'item_category_overrides' AND policyname = 'item_category_overrides_public_read'
  ) THEN
    CREATE POLICY "item_category_overrides_public_read" ON public.item_category_overrides FOR SELECT TO anon, authenticated USING (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      AND tablename = 'discount_rules'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.discount_rules;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      AND tablename = 'category_colors'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.category_colors;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      AND tablename = 'item_category_overrides'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.item_category_overrides;
  END IF;
END $$;
