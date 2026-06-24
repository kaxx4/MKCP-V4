-- Migration 021: tally_refresh_commands.days — scoped remote sync window.
--
-- The web "Sync Tally" split-button can now request a narrower window via a
-- dropdown ("Last 7 days" / "Last 30 days"). It inserts `days` (7 or 30); the
-- desktop refreshListener reads it and narrows the Tally date range. NULL keeps
-- the existing full current-FY behaviour. Idempotent.

ALTER TABLE public.tally_refresh_commands
  ADD COLUMN IF NOT EXISTS days int;

-- Refresh PostgREST's schema cache so the new column is visible to the API.
NOTIFY pgrst, 'reload schema';
