-- Migration 033: publish WHICH mirror rows moved, not just THAT something did.
--
-- APPLIED 14-Sep-2026 as Supabase migration `mirror_change_signal`.
-- Verified end to end in a live browser: a single inserted signal patched one
-- voucher and fetched TWO tables instead of five.
--
-- Before: the agent inserts one row into tally_sync_history and every open
-- browser reloads five tables — 2,792 vouchers, 8,703 ledger entries, 11,924
-- inventory entries — plus a transform/index/margins pass. Measured boot cost
-- ~2.4 s of network, roughly 17 times a session, to learn that one voucher
-- moved.
--
-- Why a signal table rather than publishing tally_vouchers itself: a full sync
-- rewrites every voucher, so every connected browser would receive 2,792 row
-- events in a burst, each carrying a whole row. The signal describes the change
-- instead of containing it, and the client decides whether to patch or reload.
--
-- It is an append-only log of HINTS and never a source of truth. A missed
-- signal, a signal for a row the client does not hold, an unparseable one — all
-- degrade to a full reload, which is exactly today's behaviour. Nothing here
-- can produce a wrong number; the worst case is the status quo.

CREATE TABLE IF NOT EXISTS mirror_change_signal (
  id          bigserial PRIMARY KEY,
  company     text NOT NULL,
  table_name  text NOT NULL,
  pk          text NOT NULL,
  op          text NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
  version     bigint,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mirror_change_signal_company_id
  ON mirror_change_signal (company, id DESC);
CREATE INDEX IF NOT EXISTS idx_mirror_change_signal_created
  ON mirror_change_signal (created_at);

ALTER TABLE mirror_change_signal ENABLE ROW LEVEL SECURITY;

-- Readable by the app: a table name, a key and an op. No business data.
DROP POLICY IF EXISTS mirror_change_signal_read ON mirror_change_signal;
CREATE POLICY mirror_change_signal_read ON mirror_change_signal
  FOR SELECT USING (true);
-- No INSERT policy on purpose — a browser has no business claiming the mirror
-- changed. Only the agent writes, with the service-role key.

ALTER PUBLICATION supabase_realtime ADD TABLE mirror_change_signal;
