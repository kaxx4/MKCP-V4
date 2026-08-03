-- Migration 022: enable Realtime on tally_sync_history.
--
-- Bug: the web dashboard subscribes to postgres_changes INSERT on
-- tally_sync_history (src/App.tsx, useRealtimeSyncAll) to auto-refresh the
-- in-memory dataset the instant a sync completes — this is the ONLY thing
-- that calls refreshDataset() for a nightly/unattended sync. But unlike
-- tally_refresh_commands (migration 020) and push_queue (migration 011),
-- tally_sync_history was never added to the supabase_realtime publication,
-- so Postgres never emits change events for it and the subscription is a
-- silent no-op — the desktop sync completes and writes the row, but no
-- browser tab ever hears about it. Symptom: pages showing live stock/dispatch
-- readiness (e.g. Dispatch/Pending Orders) keep rendering stale data after a
-- sync until the user manually reloads the app.
--
-- Idempotent — safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      AND tablename = 'tally_sync_history'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tally_sync_history;
  END IF;
END $$;
