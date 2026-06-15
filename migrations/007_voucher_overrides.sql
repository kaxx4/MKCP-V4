-- Migration 007: voucher_overrides for Calendar page user edits
-- Calendar lets users set status / scheduledDate / notes / followUps per voucher.
-- Previously localStorage-only. Now synced to Supabase via /api/supabase/sync-config.

CREATE TABLE IF NOT EXISTS voucher_overrides (
  id SERIAL PRIMARY KEY,
  voucher_id TEXT NOT NULL,
  company TEXT NOT NULL,
  status TEXT,
  scheduled_date DATE,
  notes TEXT,
  follow_ups JSONB DEFAULT '[]'::jsonb,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company, voucher_id)
);

CREATE INDEX IF NOT EXISTS idx_voucher_overrides_company ON voucher_overrides(company);
CREATE INDEX IF NOT EXISTS idx_voucher_overrides_voucher ON voucher_overrides(voucher_id);
CREATE INDEX IF NOT EXISTS idx_voucher_overrides_status ON voucher_overrides(status);

ALTER TABLE voucher_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage voucher overrides" ON voucher_overrides;
CREATE POLICY "Service role can manage voucher overrides" ON voucher_overrides
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

NOTIFY pgrst, 'reload schema';
