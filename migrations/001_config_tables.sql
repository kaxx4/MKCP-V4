-- Discount Rules Table
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

-- Order Groups Table
CREATE TABLE IF NOT EXISTS order_groups (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  color TEXT DEFAULT '#3b82f6',
  tags TEXT[] DEFAULT '{}',
  item_ids TEXT[] DEFAULT '{}',
  lines JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company, id)
);

-- Unit Overrides Table (Alternative Units)
CREATE TABLE IF NOT EXISTS unit_overrides (
  id SERIAL PRIMARY KEY,
  item_id TEXT NOT NULL,
  company TEXT NOT NULL,
  pkg_unit TEXT NOT NULL,
  units_per_pkg DECIMAL(10, 4) NOT NULL,
  source TEXT DEFAULT 'manual',
  confidence DECIMAL(3, 2) DEFAULT 1.0,
  updated_at TIMESTAMP,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company, item_id)
);

-- Rate Overrides Table
CREATE TABLE IF NOT EXISTS rate_overrides (
  id SERIAL PRIMARY KEY,
  item_id TEXT NOT NULL,
  company TEXT NOT NULL,
  unit_rate DECIMAL(15, 4),
  pkg_rate DECIMAL(15, 4),
  updated_at TIMESTAMP,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company, item_id)
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_discount_rules_company ON discount_rules(company);
CREATE INDEX IF NOT EXISTS idx_discount_rules_category ON discount_rules(category);
CREATE INDEX IF NOT EXISTS idx_order_groups_company ON order_groups(company);
CREATE INDEX IF NOT EXISTS idx_unit_overrides_company ON unit_overrides(company);
CREATE INDEX IF NOT EXISTS idx_unit_overrides_item ON unit_overrides(item_id);
CREATE INDEX IF NOT EXISTS idx_rate_overrides_company ON rate_overrides(company);
CREATE INDEX IF NOT EXISTS idx_rate_overrides_item ON rate_overrides(item_id);

-- RLS Policies (allow service role full access)
ALTER TABLE discount_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage discount rules" ON discount_rules
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role can manage order groups" ON order_groups
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role can manage unit overrides" ON unit_overrides
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role can manage rate overrides" ON rate_overrides
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
