-- Migration 004: Idempotent schema fix for partial/missing migrations
-- Run this in Supabase SQL Editor to patch any missing columns or tables
-- WITHOUT destroying existing data. Safe to re-run multiple times.

-- ════════════════════════════════════════════════════════════════════
-- discount_rules
-- Adds any columns that might be missing on an older table
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS discount_rules (
  id TEXT PRIMARY KEY,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE discount_rules ADD COLUMN IF NOT EXISTS company TEXT;
ALTER TABLE discount_rules ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE discount_rules ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE discount_rules ADD COLUMN IF NOT EXISTS discount_type TEXT;
ALTER TABLE discount_rules ADD COLUMN IF NOT EXISTS discount_value DECIMAL(10, 4);
ALTER TABLE discount_rules ADD COLUMN IF NOT EXISTS conditions JSONB DEFAULT '{}'::jsonb;
ALTER TABLE discount_rules ADD COLUMN IF NOT EXISTS priority INT DEFAULT 0;
ALTER TABLE discount_rules ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE;

-- ════════════════════════════════════════════════════════════════════
-- order_groups
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS order_groups (
  id TEXT PRIMARY KEY,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE order_groups ADD COLUMN IF NOT EXISTS company TEXT;
ALTER TABLE order_groups ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE order_groups ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
ALTER TABLE order_groups ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#3b82f6';
ALTER TABLE order_groups ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';
ALTER TABLE order_groups ADD COLUMN IF NOT EXISTS item_ids TEXT[] DEFAULT '{}';
ALTER TABLE order_groups ADD COLUMN IF NOT EXISTS lines JSONB DEFAULT '{}'::jsonb;
ALTER TABLE order_groups ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE order_groups ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- ════════════════════════════════════════════════════════════════════
-- unit_overrides
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS unit_overrides (
  id SERIAL PRIMARY KEY,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE unit_overrides ADD COLUMN IF NOT EXISTS item_id TEXT;
ALTER TABLE unit_overrides ADD COLUMN IF NOT EXISTS company TEXT;
ALTER TABLE unit_overrides ADD COLUMN IF NOT EXISTS pkg_unit TEXT;
ALTER TABLE unit_overrides ADD COLUMN IF NOT EXISTS units_per_pkg DECIMAL(10, 4);
ALTER TABLE unit_overrides ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';
ALTER TABLE unit_overrides ADD COLUMN IF NOT EXISTS confidence DECIMAL(3, 2) DEFAULT 1.0;
ALTER TABLE unit_overrides ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- Add UNIQUE constraint for upsert (only if missing)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unit_overrides_company_item_id_key'
  ) THEN
    BEGIN
      ALTER TABLE unit_overrides ADD CONSTRAINT unit_overrides_company_item_id_key UNIQUE (company, item_id);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- rate_overrides
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS rate_overrides (
  id SERIAL PRIMARY KEY,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE rate_overrides ADD COLUMN IF NOT EXISTS item_id TEXT;
ALTER TABLE rate_overrides ADD COLUMN IF NOT EXISTS company TEXT;
ALTER TABLE rate_overrides ADD COLUMN IF NOT EXISTS unit_rate DECIMAL(15, 4);
ALTER TABLE rate_overrides ADD COLUMN IF NOT EXISTS pkg_rate DECIMAL(15, 4);
ALTER TABLE rate_overrides ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rate_overrides_company_item_id_key'
  ) THEN
    BEGIN
      ALTER TABLE rate_overrides ADD CONSTRAINT rate_overrides_company_item_id_key UNIQUE (company, item_id);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- item_category_overrides (from 003)
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS item_category_overrides (
  id SERIAL PRIMARY KEY,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE item_category_overrides ADD COLUMN IF NOT EXISTS item_id TEXT;
ALTER TABLE item_category_overrides ADD COLUMN IF NOT EXISTS company TEXT;
ALTER TABLE item_category_overrides ADD COLUMN IF NOT EXISTS category_id TEXT;
ALTER TABLE item_category_overrides ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'item_category_overrides_company_item_id_key') THEN
    BEGIN
      ALTER TABLE item_category_overrides ADD CONSTRAINT item_category_overrides_company_item_id_key UNIQUE (company, item_id);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- category_colors
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS category_colors (
  id SERIAL PRIMARY KEY,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE category_colors ADD COLUMN IF NOT EXISTS category_id TEXT;
ALTER TABLE category_colors ADD COLUMN IF NOT EXISTS company TEXT;
ALTER TABLE category_colors ADD COLUMN IF NOT EXISTS color TEXT;
ALTER TABLE category_colors ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'category_colors_company_category_id_key') THEN
    BEGIN
      ALTER TABLE category_colors ADD CONSTRAINT category_colors_company_category_id_key UNIQUE (company, category_id);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- vendor_group_assignments
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vendor_group_assignments (
  id SERIAL PRIMARY KEY,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE vendor_group_assignments ADD COLUMN IF NOT EXISTS item_id TEXT;
ALTER TABLE vendor_group_assignments ADD COLUMN IF NOT EXISTS company TEXT;
ALTER TABLE vendor_group_assignments ADD COLUMN IF NOT EXISTS vendor_group_id TEXT;
ALTER TABLE vendor_group_assignments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_group_assignments_company_item_id_key') THEN
    BEGIN
      ALTER TABLE vendor_group_assignments ADD CONSTRAINT vendor_group_assignments_company_item_id_key UNIQUE (company, item_id);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- item_notes
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS item_notes (
  id SERIAL PRIMARY KEY,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE item_notes ADD COLUMN IF NOT EXISTS item_id TEXT;
ALTER TABLE item_notes ADD COLUMN IF NOT EXISTS company TEXT;
ALTER TABLE item_notes ADD COLUMN IF NOT EXISTS note TEXT DEFAULT '';
ALTER TABLE item_notes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'item_notes_company_item_id_key') THEN
    BEGIN
      ALTER TABLE item_notes ADD CONSTRAINT item_notes_company_item_id_key UNIQUE (company, item_id);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- calling_list_entries
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS calling_list_entries (
  id SERIAL PRIMARY KEY,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE calling_list_entries ADD COLUMN IF NOT EXISTS party_ledger_id TEXT;
ALTER TABLE calling_list_entries ADD COLUMN IF NOT EXISTS company TEXT;
ALTER TABLE calling_list_entries ADD COLUMN IF NOT EXISTS party_name TEXT;
ALTER TABLE calling_list_entries ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE calling_list_entries ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE calling_list_entries ADD COLUMN IF NOT EXISTS items JSONB DEFAULT '[]'::jsonb;
ALTER TABLE calling_list_entries ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE calling_list_entries ADD COLUMN IF NOT EXISTS called BOOLEAN DEFAULT FALSE;
ALTER TABLE calling_list_entries ADD COLUMN IF NOT EXISTS called_at TIMESTAMP;
ALTER TABLE calling_list_entries ADD COLUMN IF NOT EXISTS added_at TIMESTAMP;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calling_list_entries_company_party_ledger_id_key') THEN
    BEGIN
      ALTER TABLE calling_list_entries ADD CONSTRAINT calling_list_entries_company_party_ledger_id_key UNIQUE (company, party_ledger_id);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- tally_price_list_imports
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tally_price_list_imports (
  id SERIAL PRIMARY KEY,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE tally_price_list_imports ADD COLUMN IF NOT EXISTS item_name TEXT;
ALTER TABLE tally_price_list_imports ADD COLUMN IF NOT EXISTS company TEXT;
ALTER TABLE tally_price_list_imports ADD COLUMN IF NOT EXISTS selling_rate DECIMAL(15, 4);
ALTER TABLE tally_price_list_imports ADD COLUMN IF NOT EXISTS cost_price DECIMAL(15, 4);
ALTER TABLE tally_price_list_imports ADD COLUMN IF NOT EXISTS unit TEXT;
ALTER TABLE tally_price_list_imports ADD COLUMN IF NOT EXISTS imported_at TIMESTAMP;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tally_price_list_imports_company_item_name_key') THEN
    BEGIN
      ALTER TABLE tally_price_list_imports ADD CONSTRAINT tally_price_list_imports_company_item_name_key UNIQUE (company, item_name);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- Indexes (idempotent)
-- ════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_discount_rules_company ON discount_rules(company);
CREATE INDEX IF NOT EXISTS idx_order_groups_company ON order_groups(company);
CREATE INDEX IF NOT EXISTS idx_unit_overrides_company ON unit_overrides(company);
CREATE INDEX IF NOT EXISTS idx_rate_overrides_company ON rate_overrides(company);
CREATE INDEX IF NOT EXISTS idx_item_category_overrides_company ON item_category_overrides(company);
CREATE INDEX IF NOT EXISTS idx_category_colors_company ON category_colors(company);
CREATE INDEX IF NOT EXISTS idx_vendor_group_assignments_company ON vendor_group_assignments(company);
CREATE INDEX IF NOT EXISTS idx_item_notes_company ON item_notes(company);
CREATE INDEX IF NOT EXISTS idx_calling_list_company ON calling_list_entries(company);
CREATE INDEX IF NOT EXISTS idx_tally_price_list_imports_company ON tally_price_list_imports(company);

-- ════════════════════════════════════════════════════════════════════
-- RLS Policies (drop existing first, then re-create — keeps service_role access)
-- ════════════════════════════════════════════════════════════════════
ALTER TABLE discount_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_category_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_colors ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_group_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE calling_list_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_price_list_imports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage discount rules" ON discount_rules;
CREATE POLICY "Service role can manage discount rules" ON discount_rules
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role can manage order groups" ON order_groups;
CREATE POLICY "Service role can manage order groups" ON order_groups
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role can manage unit overrides" ON unit_overrides;
CREATE POLICY "Service role can manage unit overrides" ON unit_overrides
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role can manage rate overrides" ON rate_overrides;
CREATE POLICY "Service role can manage rate overrides" ON rate_overrides
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role can manage item category overrides" ON item_category_overrides;
CREATE POLICY "Service role can manage item category overrides" ON item_category_overrides
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role can manage category colors" ON category_colors;
CREATE POLICY "Service role can manage category colors" ON category_colors
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role can manage vendor group assignments" ON vendor_group_assignments;
CREATE POLICY "Service role can manage vendor group assignments" ON vendor_group_assignments
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role can manage item notes" ON item_notes;
CREATE POLICY "Service role can manage item notes" ON item_notes
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role can manage calling list" ON calling_list_entries;
CREATE POLICY "Service role can manage calling list" ON calling_list_entries
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role can manage tally price list imports" ON tally_price_list_imports;
CREATE POLICY "Service role can manage tally price list imports" ON tally_price_list_imports
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════
-- Force PostgREST to refresh its schema cache
-- (Without this, the new columns won't be visible to upsert immediately)
-- ════════════════════════════════════════════════════════════════════
NOTIFY pgrst, 'reload schema';
