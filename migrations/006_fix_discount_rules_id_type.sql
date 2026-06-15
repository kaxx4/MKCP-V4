-- Migration 006: Fix discount_rules.id column type (UUID → TEXT)
--
-- The user's discount_rules table was originally created with id as UUID.
-- The app sends text ids like "CHAIN_FREEWHEEL_TOGO_DLR", so upserts fail with:
--   "invalid input syntax for type uuid: 'CHAIN_FREEWHEEL_TOGO_DLR'"
--
-- The discount_rules table is empty (per user report), so dropping is safe.

DROP TABLE IF EXISTS discount_rules CASCADE;

CREATE TABLE discount_rules (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  discount_type TEXT,
  discount_value DECIMAL(10, 4),
  conditions JSONB DEFAULT '{}'::jsonb,
  priority INT DEFAULT 0,
  enabled BOOLEAN DEFAULT TRUE,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company, id)
);

CREATE INDEX IF NOT EXISTS idx_discount_rules_company ON discount_rules(company);
CREATE INDEX IF NOT EXISTS idx_discount_rules_category ON discount_rules(category);

ALTER TABLE discount_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage discount rules" ON discount_rules
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- Force PostgREST to refresh its schema cache
NOTIFY pgrst, 'reload schema';
