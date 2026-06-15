-- Migration 005: Add missing synced_at columns
-- Bug in migration 004: synced_at was only in CREATE TABLE blocks, not as ALTER.
-- Since tables already existed, CREATE was skipped and synced_at never got added.
-- This migration adds it explicitly to every config table. Safe to re-run.

ALTER TABLE discount_rules            ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE order_groups              ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE unit_overrides            ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE rate_overrides            ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE item_category_overrides   ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE category_colors           ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE vendor_group_assignments  ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE item_notes                ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE calling_list_entries      ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE tally_price_list_imports  ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Force PostgREST to refresh its schema cache so the new columns are visible
NOTIFY pgrst, 'reload schema';
