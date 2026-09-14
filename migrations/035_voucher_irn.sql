-- Migration 035: the IRP clock's only input.
--
-- APPLIED 14-Sep-2026 as Supabase migration `voucher_irn_columns`.
--
-- An e-invoice must be registered with the IRP within 30 DAYS of its invoice
-- date. Miss that and it can never be registered: the buyer loses their input
-- tax credit, and the first anyone hears is the buyer asking, months later.
-- There is no error and no rejection — the invoice simply sits there
-- unregisterable. It is the most expensive silent failure available here.
--
-- The app NEVER calls the IRP; a person raises the IRN in Tally exactly as they
-- do today. What the app does is NOTICE, and it cannot notice without these.
--
-- Tally emits IRN / IRNACKNO / IRNACKDATE as self-closing EMPTY tags on an
-- unregistered invoice (proven with a NATIVEMETHOD * probe — and note that
-- `<IRN/>` is invisible to a `<TAG[\s>]` matcher, which is how a first probe
-- wrongly concluded the fields were absent). The emptiness IS the signal, so
-- these are nullable and NULL means precisely "no IRN yet".

ALTER TABLE tally_vouchers
  ADD COLUMN IF NOT EXISTS irn          text,
  ADD COLUMN IF NOT EXISTS irn_ack_no   text,
  ADD COLUMN IF NOT EXISTS irn_ack_date date;

-- "Which outward invoices still have no IRN, oldest first" — the only query the
-- clock makes, and it runs on every dashboard.
CREATE INDEX IF NOT EXISTS idx_tally_vouchers_missing_irn
  ON tally_vouchers (company, date)
  WHERE irn IS NULL;
