-- Migration 020: tally_refresh_commands — remote "Sync Tally" trigger.
--
-- The web dashboard (FIX 2a) inserts a row {company, status:'pending'} when the
-- user clicks "Sync Tally". The desktop server (FIX 2b, refreshListener.ts)
-- listens via Supabase Realtime, sets status='ack', and fires /api/tally/sync.
--
-- This is the DB backing for that flow. Idempotent — safe to re-run, and FIX 2a's
-- migration (if any) can be skipped or made IF NOT EXISTS to avoid conflicts.

CREATE TABLE IF NOT EXISTS public.tally_refresh_commands (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company     text NOT NULL,
  status      text NOT NULL DEFAULT 'pending',  -- pending | ack | error
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tally_refresh_commands_company_idx
  ON public.tally_refresh_commands (company, created_at DESC);

ALTER TABLE public.tally_refresh_commands ENABLE ROW LEVEL SECURITY;

-- Web (anon/authenticated) creates commands and polls their status.
-- The desktop uses the service-role key, which bypasses RLS, to update status.
DROP POLICY IF EXISTS "refresh_insert" ON public.tally_refresh_commands;
CREATE POLICY "refresh_insert" ON public.tally_refresh_commands
  FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "refresh_read" ON public.tally_refresh_commands;
CREATE POLICY "refresh_read" ON public.tally_refresh_commands
  FOR SELECT TO anon, authenticated USING (true);

-- Add to the realtime publication so the desktop listener receives INSERT events.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      AND tablename = 'tally_refresh_commands'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tally_refresh_commands;
  END IF;
END $$;
