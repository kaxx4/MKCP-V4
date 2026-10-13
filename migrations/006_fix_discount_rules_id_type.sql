-- Migration 006: Fix discount_rules.id column type (UUID → TEXT)
--
-- The user's discount_rules table was originally created with id as UUID.
-- The app sends text ids like "CHAIN_FREEWHEEL_TOGO_DLR", so upserts fail with:
--   "invalid input syntax for type uuid: 'CHAIN_FREEWHEEL_TOGO_DLR'"
--
-- #118 (2026-10-13): this file used to DROP TABLE unconditionally and recreate
-- it. A re-run after the owner had populated the rules destroyed them, and the
-- second CREATE POLICY errored. It is now re-run safe:
--   - a table that already has a TEXT id is left alone (no drop, no data touched);
--   - a UUID-id table is dropped ONLY when it is empty, which is the case this
--     migration was written for;
--   - a UUID-id table that holds rows stops the migration with an error, so the
--     rules are converted by hand instead of being lost.
--   - the CREATE POLICY is preceded by DROP POLICY IF EXISTS.
--
-- The PRIMARY KEY shape of the recreated table is the one written below. The live
-- shape (c51435a made the PK `(id)` alone) is still an OWNER QUESTION (Q4): paste
-- the live definition before this file is run against a fresh database.
-- The owner applies this; it is NOT applied by the builder.
--
-- Shared company name warning: see migration 026's header.

DO $$
BEGIN
  IF to_regclass('public.discount_rules') IS NOT NULL
     AND (SELECT data_type FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'discount_rules' AND column_name = 'id') = 'uuid'
  THEN
    IF (SELECT count(*) FROM public.discount_rules) = 0 THEN
      DROP TABLE public.discount_rules CASCADE;
    ELSE
      RAISE EXCEPTION 'discount_rules has a uuid id and holds rows: convert it by hand (migration 006 will not drop data)';
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS discount_rules (
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

DROP POLICY IF EXISTS "Service role can manage discount rules" ON discount_rules;
CREATE POLICY "Service role can manage discount rules" ON discount_rules
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- Force PostgREST to refresh its schema cache
NOTIFY pgrst, 'reload schema';
