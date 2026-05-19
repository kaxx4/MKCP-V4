-- Migration 006: Fix discount_rules.id column type (UUID → TEXT)
--
-- The user's discount_rules table was originally created with id as UUID.
-- The app sends text ids like "CHAIN_FREEWHEEL_TOGO_DLR", so upserts fail with:
--   "invalid input syntax for type uuid: 'CHAIN_FREEWHEEL_TOGO_DLR'"
--
-- The discount_rules table is empty (per user report), so dropping is safe.
-- This migration drops and recreates the table with the correct TEXT id type
-- plus all required columns, indexes, and RLS policies.

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

-- ════════════════════════════════════════════════════════════════════
-- Defensive check: verify other id-keyed tables also have TEXT id
-- (order_groups was created by migration 004, but let's make sure)
-- ════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  bad_count INTEGER;
  table_name TEXT;
BEGIN
  FOR table_name IN
    SELECT t.table_name
    FROM information_schema.tables t
    WHERE t.table_schema = 'public'
      AND t.table_name IN ('order_groups', 'discount_rules')
  LOOP
    SELECT COUNT(*) INTO bad_count
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND information_schema.columns.table_name = table_name
      AND column_name = 'id'
      AND data_type NOT IN ('text', 'character varying');

    IF bad_count > 0 THEN
      RAISE NOTICE 'WARNING: Table % has non-text id column. Sync to it will fail.', table_name;
    END IF;
  END LOOP;
END $$;
