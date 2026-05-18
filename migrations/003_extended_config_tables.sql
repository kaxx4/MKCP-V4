-- Migration 003: Extended config tables for complete dashboard sync
-- Adds tables for: item category overrides, category colors, vendor groups, item notes, calling list, tally price list imports

-- ── Item Category Overrides ──────────────────────────────────────────────
-- Stores user overrides for which discount category an item belongs to
CREATE TABLE IF NOT EXISTS item_category_overrides (
  id SERIAL PRIMARY KEY,
  item_id TEXT NOT NULL,
  company TEXT NOT NULL,
  category_id TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company, item_id)
);

-- ── Category Colors ──────────────────────────────────────────────────────
-- Stores custom hex colors for each discount category
CREATE TABLE IF NOT EXISTS category_colors (
  id SERIAL PRIMARY KEY,
  category_id TEXT NOT NULL,
  company TEXT NOT NULL,
  color TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company, category_id)
);

-- ── Vendor Group Assignments ─────────────────────────────────────────────
-- Stores which vendor group each item is assigned to
CREATE TABLE IF NOT EXISTS vendor_group_assignments (
  id SERIAL PRIMARY KEY,
  item_id TEXT NOT NULL,
  company TEXT NOT NULL,
  vendor_group_id TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company, item_id)
);

-- ── Item Notes ───────────────────────────────────────────────────────────
-- Stores user notes for each item
CREATE TABLE IF NOT EXISTS item_notes (
  id SERIAL PRIMARY KEY,
  item_id TEXT NOT NULL,
  company TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMP,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company, item_id)
);

-- ── Calling List Entries ─────────────────────────────────────────────────
-- Stores outreach calling list (party + items to call about)
CREATE TABLE IF NOT EXISTS calling_list_entries (
  id SERIAL PRIMARY KEY,
  party_ledger_id TEXT NOT NULL,
  company TEXT NOT NULL,
  party_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  items JSONB DEFAULT '[]'::jsonb,
  note TEXT,
  called BOOLEAN DEFAULT FALSE,
  called_at TIMESTAMP,
  added_at TIMESTAMP,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company, party_ledger_id)
);

-- ── Tally Price List Imports ─────────────────────────────────────────────
-- Stores imported Tally price list data (from JSON uploads)
CREATE TABLE IF NOT EXISTS tally_price_list_imports (
  id SERIAL PRIMARY KEY,
  item_name TEXT NOT NULL,
  company TEXT NOT NULL,
  selling_rate DECIMAL(15, 4),
  cost_price DECIMAL(15, 4),
  unit TEXT,
  imported_at TIMESTAMP,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company, item_name)
);

-- ── Indexes ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_item_category_overrides_company ON item_category_overrides(company);
CREATE INDEX IF NOT EXISTS idx_item_category_overrides_item ON item_category_overrides(item_id);
CREATE INDEX IF NOT EXISTS idx_category_colors_company ON category_colors(company);
CREATE INDEX IF NOT EXISTS idx_vendor_group_assignments_company ON vendor_group_assignments(company);
CREATE INDEX IF NOT EXISTS idx_vendor_group_assignments_item ON vendor_group_assignments(item_id);
CREATE INDEX IF NOT EXISTS idx_vendor_group_assignments_group ON vendor_group_assignments(vendor_group_id);
CREATE INDEX IF NOT EXISTS idx_item_notes_company ON item_notes(company);
CREATE INDEX IF NOT EXISTS idx_calling_list_company ON calling_list_entries(company);
CREATE INDEX IF NOT EXISTS idx_calling_list_called ON calling_list_entries(called);
CREATE INDEX IF NOT EXISTS idx_tally_price_list_imports_company ON tally_price_list_imports(company);

-- ── RLS Policies (service_role only) ─────────────────────────────────────
ALTER TABLE item_category_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_colors ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_group_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE calling_list_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_price_list_imports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage item category overrides" ON item_category_overrides
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role can manage category colors" ON category_colors
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role can manage vendor group assignments" ON vendor_group_assignments
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role can manage item notes" ON item_notes
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role can manage calling list" ON calling_list_entries
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role can manage tally price list imports" ON tally_price_list_imports
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
