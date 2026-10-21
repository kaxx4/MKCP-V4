-- 050 — tally_vouchers.irn_qr: the e-invoice's SIGNED QR (phase 2 W3, 21-Oct-2026).
--
-- Tally stores the IRP's signed JWT as IRNQRCODE (944 and 948 characters on the two
-- e-invoiced samples in server/data/native-shape, 23-Sep-2026). The web app draws it on
-- the printed A5 invoice. Twin of web migration 0098 (same statement).
--
-- Additive and nullable. Must be applied BEFORE the agent build that writes it
-- (PostgREST rejects an upsert naming a column the table lacks, failing every batch).
alter table public.tally_vouchers add column if not exists irn_qr text;

-- Verify: select count(*) filter (where irn_qr is not null) from public.tally_vouchers;
