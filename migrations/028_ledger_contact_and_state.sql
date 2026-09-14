-- Migration 028: party state, address, phone, email, pincode on tally_ledgers.
--
-- APPLIED 13-Sep-2026 as Supabase migration `ledger_contact_and_state`
-- (version 20260913175452). Confirmed against the live schema after applying.
--
-- ── Why this was the most urgent gap in the mirror ─────────────────────────
--
-- Tally was ALREADY being asked for every one of these fields — they sit in
-- the Ledger fetch list at config/collections.ts:67 — and convertLedgers threw
-- them away without reading them. So the app paid the full cost of fetching
-- them and got none of the benefit.
--
-- STATE is the one that matters. It decides CGST+SGST against IGST on every
-- outward voucher, and pushGuard rule 27 checks the tax head against it. The
-- guard was therefore checking a field the mirror could not see. A voucher
-- with the wrong tax head BALANCES, verifies, and reads back byte-identical —
-- and lands in a GSTR exception bucket. This is the one failure safePush's
-- read-back diff cannot detect (P7).
--
-- Result after backfill: 399 of 488 ledgers carry a state. It also surfaced
-- four transporters marked West Bengal while holding UP / Maharashtra / Punjab
-- GSTINs — a real data problem in Tally, not a code problem, and one nothing
-- could have noticed while the field was being discarded.

ALTER TABLE tally_ledgers
  ADD COLUMN IF NOT EXISTS state        text,
  ADD COLUMN IF NOT EXISTS country      text,
  ADD COLUMN IF NOT EXISTS pincode      text,
  ADD COLUMN IF NOT EXISTS mailing_name text,
  ADD COLUMN IF NOT EXISTS address      text,
  ADD COLUMN IF NOT EXISTS phone        text,
  ADD COLUMN IF NOT EXISTS email        text;

-- The push guard asks "what state is this party in" on every outward voucher.
CREATE INDEX IF NOT EXISTS idx_tally_ledgers_company_state
  ON tally_ledgers (company, state);

COMMENT ON COLUMN tally_ledgers.state IS
  'LEDSTATENAME from Tally. Decides CGST+SGST vs IGST — pushGuard rule 27 depends on it. NULL means Tally has no state on the party, which is itself a GSTR exception cause.';
