-- Migration 009: gst_overrides — user-edited GST % per item
-- Lets the dashboard override the Tally-master gst_rate (or the
-- voucher-inferred rate) on a per-item basis. PriceList page makes the
-- GST cell click-to-edit and writes here; sync runs through the standard
-- /api/supabase/sync-config pipeline.

CREATE TABLE IF NOT EXISTS gst_overrides (
  id SERIAL PRIMARY KEY,
  item_id TEXT NOT NULL,
  company TEXT NOT NULL,
  gst_pct DECIMAL(5, 2) NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company, item_id)
);

CREATE INDEX IF NOT EXISTS idx_gst_overrides_company ON gst_overrides(company);
CREATE INDEX IF NOT EXISTS idx_gst_overrides_item ON gst_overrides(item_id);

ALTER TABLE gst_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage gst overrides" ON gst_overrides;
CREATE POLICY "Service role can manage gst overrides" ON gst_overrides
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

NOTIFY pgrst, 'reload schema';
