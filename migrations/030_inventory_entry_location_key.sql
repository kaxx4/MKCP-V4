-- Migration 030: the location key on inventory entries. Schema now, UI later.
--
-- APPLIED 13-Sep-2026 as Supabase migration `inventory_entry_location_key`
-- (version 20260913183213). Confirmed against the live schema after applying:
-- all five columns and both indexes present on the object.
--
-- ── Why now, when it changes nothing today ─────────────────────────────────
--
-- tally_voucher_inventory_entries had no godown or batch column, while Tally
-- carries both on BATCHALLOCATIONS.LIST for every inventory line. The only
-- godown reference in the entire web app is a hardcoded "Main Location" string
-- in voucher/VoucherLines.tsx.
--
-- Measured on a sampled trading day: 132 batch allocations, every one reading
-- GODOWNNAME "Main Location" and BATCHNAME "Primary Batch", with
-- DESTINATIONGODOWNNAME empty. The company has one godown. So this buys
-- nothing today — and everything on the day a second godown opens, because
-- every row synced before the key existed would be unattributable forever.
--
-- Additive. Existing rows keep NULL, which reads correctly as "this row
-- predates the location key" rather than as a claim about where goods were.

ALTER TABLE tally_voucher_inventory_entries
  ADD COLUMN IF NOT EXISTS godown_name             text,
  ADD COLUMN IF NOT EXISTS batch_name              text,
  ADD COLUMN IF NOT EXISTS destination_godown_name text,
  -- The full BATCHALLOCATIONS.LIST. An inventory line may split across several
  -- godowns; the columns above hold the primary one, and this holds the truth.
  ADD COLUMN IF NOT EXISTS batch_allocations       jsonb,
  -- True when the line really is split — the case the columns cannot express.
  ADD COLUMN IF NOT EXISTS is_split_across_godowns boolean NOT NULL DEFAULT false;

-- "What is in godown X" is the question this exists to answer.
CREATE INDEX IF NOT EXISTS idx_tvie_company_godown
  ON tally_voucher_inventory_entries (company, godown_name);

-- Stock-by-item-by-location, the shape the warehouse page will need.
CREATE INDEX IF NOT EXISTS idx_tvie_company_item_godown
  ON tally_voucher_inventory_entries (company, stock_item_name, godown_name);

COMMENT ON COLUMN tally_voucher_inventory_entries.godown_name IS
  'Primary BATCHALLOCATIONS.LIST/GODOWNNAME. NULL on rows synced before Phase 2.4 — absence of a key, not a claim about location.';
COMMENT ON COLUMN tally_voucher_inventory_entries.batch_allocations IS
  'Full BATCHALLOCATIONS.LIST. Authoritative when a line splits across godowns; the flat columns hold only the primary allocation.';
