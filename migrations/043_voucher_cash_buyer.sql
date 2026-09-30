-- Migration 043: the real buyer on a counter sale (CASH-P1).
--
-- NOT YET APPLIED (written 30-Sep-2026). Apply BEFORE any build carrying the
-- CASH-P1 converter change runs against the shared mirror. The agent survives
-- the reverse order (supabaseSync.upsertVoucherBatch drops buyer_* on PGRST204
-- and logs it), but then mirrors no buyer until it restarts after this lands.
--
-- Numbering: agent ledger highest was 042. The web ledger has an unrelated
-- 0043_pricing_workspace.sql (4-digit series); no object overlap — nothing in
-- either ledger names buyer_* on tally_vouchers.
--
-- Why: 253 of 741 FY26-27 SALES vouchers are posted to the ledger "Cash". Tally
-- records who actually bought in the voucher header — PARTYMAILINGNAME and
-- ADDRESS.LIST (read off live Cash voucher 26-27/0654; BASICBUYERNAME stays
-- "Cash" on every one) — and the agent never fetched them, so the web app saw
-- one giant "Cash" dealer and logistics could not group cash dispatches by area.
--
-- All nullable: NULL means "Tally did not say", never "no buyer". Idempotent.

ALTER TABLE tally_vouchers
  ADD COLUMN IF NOT EXISTS buyer_name           text,
  ADD COLUMN IF NOT EXISTS buyer_address        text,
  ADD COLUMN IF NOT EXISTS buyer_pincode        text,
  ADD COLUMN IF NOT EXISTS buyer_pincode_source text,
  ADD COLUMN IF NOT EXISTS buyer_place          text,
  ADD COLUMN IF NOT EXISTS buyer_state          text;

COMMENT ON COLUMN tally_vouchers.buyer_name IS
  'PARTYMAILINGNAME, else BASICBUYERNAME; NULL when that is just "Cash". The real buyer on a Cash bill.';
COMMENT ON COLUMN tally_vouchers.buyer_address IS
  'Voucher-header ADDRESS.LIST (bill-to), else BASICBUYERADDRESS.LIST (ship-to); lines joined with ", ".';
COMMENT ON COLUMN tally_vouchers.buyer_pincode IS
  'PARTYPINCODE, else a 6-digit PIN parsed from the address lines — see buyer_pincode_source.';
COMMENT ON COLUMN tally_vouchers.buyer_pincode_source IS
  '"tally" = PARTYPINCODE; "address" = parsed from free text (weaker); NULL = none found.';
COMMENT ON COLUMN tally_vouchers.buyer_place IS
  'DERIVED by the agent: last address line that is not a PAN/GSTIN note, PIN removed. For area grouping only.';
COMMENT ON COLUMN tally_vouchers.buyer_state IS
  'Voucher STATENAME.';

-- The one query this exists for: cash bills awaiting dispatch, grouped by area.
CREATE INDEX IF NOT EXISTS idx_tally_vouchers_cash_buyer
  ON tally_vouchers (company, date)
  WHERE party_ledger_name = 'Cash';
