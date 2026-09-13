-- Migration 029: voucher identity — master_id, alter_id, remote_id, version.
--
-- APPLIED 13-Sep-2026 as Supabase migration `voucher_identity_columns`
-- (version 20260913175635). Confirmed against the live schema after applying.
--
-- ── What Tally will and will not give back ─────────────────────────────────
--
-- Probed on 13-Sep-2026, four vouchers, two of which this app had pushed hours
-- earlier WITH an explicit REMOTEID:
--
--   MASTERID   readable. Stable across an Alter — a voucher altered in place
--              kept 249387 while its ALTERID moved.
--   ALTERID    readable. Bumps on every edit.
--   REMOTEID   came back on 0 of 4. Tally does not export the one it was given.
--
-- So the mirror can never LEARN our identity by reading; remote_id is written
-- when we push, and backfilled from push_queue. That matters because REMOTEID
-- is the ONLY handle Tally accepts for Alter, Cancel or Delete — GUID and
-- VCHKEY both fail — and editability is currently inferred from push_queue,
-- so it is lost the moment the queue is pruned.
--
-- ALTERID's absence is why incremental sync has never run: there was no
-- watermark to ask "changed since". After backfilling one month the watermark
-- is 355528, and that mode is reachable for the first time.

ALTER TABLE tally_vouchers
  ADD COLUMN IF NOT EXISTS master_id bigint,
  ADD COLUMN IF NOT EXISTS alter_id  bigint,
  ADD COLUMN IF NOT EXISTS remote_id text,
  ADD COLUMN IF NOT EXISTS version   integer NOT NULL DEFAULT 1;

-- The incremental-sync watermark query: max(alter_id) per company.
CREATE INDEX IF NOT EXISTS idx_tally_vouchers_company_alter_id
  ON tally_vouchers (company, alter_id DESC);

-- "Can I still alter this voucher" resolves through remote_id.
CREATE INDEX IF NOT EXISTS idx_tally_vouchers_company_remote_id
  ON tally_vouchers (company, remote_id);

COMMENT ON COLUMN tally_vouchers.remote_id IS
  'The caller-assigned REMOTEID — the only handle Tally accepts for Alter/Cancel/Delete. NEVER learned by reading: Tally does not export it (0 of 4 probed). Written on push, backfilled from push_queue.';
COMMENT ON COLUMN tally_vouchers.alter_id IS
  'Tally ALTERID, monotonic per edit. The incremental-sync watermark.';
