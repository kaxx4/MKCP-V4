-- Migration 008: app_settings (UI/Tally prefs) + order_draft_lines (current draft)
-- Closes the last gaps in "everything user edits syncs to Supabase".

-- ════════════════════════════════════════════════════════════════════
-- app_settings — key/value bag of user preferences
-- (unitMode, fyYear, coverMonths, leadTimeMonths, defaultCreditDays,
--  proxyUrl, autoSyncMinutes, fyFromDate, fyToDate, syncMode, etc.)
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS app_settings (
  id SERIAL PRIMARY KEY,
  company TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company, key)
);

CREATE INDEX IF NOT EXISTS idx_app_settings_company ON app_settings(company);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage app settings" ON app_settings;
CREATE POLICY "Service role can manage app settings" ON app_settings
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════
-- order_draft_lines — the current in-progress order (Orders page)
-- This is the user's typed quantities BEFORE saving to an order_groups row.
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS order_draft_lines (
  id SERIAL PRIMARY KEY,
  company TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_name TEXT,
  base_unit TEXT,
  pkg_unit TEXT,
  units_per_pkg DECIMAL(10, 4) DEFAULT 1,
  qty_base DECIMAL(15, 4),
  rate_per_base DECIMAL(15, 4),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company, item_id)
);

CREATE INDEX IF NOT EXISTS idx_order_draft_lines_company ON order_draft_lines(company);

ALTER TABLE order_draft_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage order draft lines" ON order_draft_lines;
CREATE POLICY "Service role can manage order draft lines" ON order_draft_lines
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

NOTIFY pgrst, 'reload schema';
