-- 025 — Carry Tally's e-way bill / transport fields through to tally_vouchers.
--
-- Why this exists
-- ---------------
-- Tally already holds all of this on every dispatched Sales voucher. It has
-- always been in the Day Book XML export (verified 2026-08-27 against
-- "MKCP SALES 2526.json": 603 of 1,432 vouchers carry EWAYBILLDETAILS, 586 of
-- those carry a vehicle number and 591 a road distance). The sync simply threw
-- the block away — convert.ts mapped ten voucher fields and stopped.
--
-- The cost of that was invisible and large: with no vehicle number there is no
-- way to tell which invoices travelled together, so the dashboard could not see
-- a single truck trip. The 505 trips reconstructed in the 2026-08-27 analysis
-- came from hand-parsing these exports offline; nothing in the app could reach
-- them.
--
-- `transport_distance_km` is worth calling out separately: it is the distance
-- the e-way bill portal itself computed between the two pincodes. That is a
-- better road-distance source than the app's 73-town station model, and it
-- arrives for free on ~40% of vouchers.
--
-- Every column is NULLABLE with no default. Vouchers that never had an e-way
-- bill (cash counter sales, journals, receipts) simply carry NULLs, and any
-- older Tally build that omits the block degrades to the same NULLs rather than
-- failing the sync. Nothing existing reads these columns yet, so this migration
-- cannot change any current behaviour.

alter table public.tally_vouchers
  add column if not exists ewb_number            text,
  add column if not exists ewb_valid_until       text,
  add column if not exists vehicle_number        text,
  add column if not exists transport_mode        text,
  add column if not exists transport_distance_km numeric,
  add column if not exists consignee_pincode     text,
  add column if not exists consignee_place       text,
  add column if not exists consignee_state       text,
  add column if not exists ship_to_place         text,
  add column if not exists dispatch_from_place   text,
  add column if not exists party_gstin           text,
  add column if not exists place_of_supply       text;

comment on column public.tally_vouchers.vehicle_number is
  'E-way bill Part-B vehicle registration, e.g. WB03D3840. A trip is (vehicle_number, date) — this is ground truth, not inference.';
comment on column public.tally_vouchers.transport_distance_km is
  'Road distance in km as computed by the e-way bill portal between consignor and consignee pincodes. Prefer over the app station model where present.';
comment on column public.tally_vouchers.ewb_number is
  'E-way bill number (Tally EWAYBILLDETAILS.BILLNUMBER), 12 digits. Absent on exempt/local vouchers.';

-- A trip lookup is (vehicle, date); the partial index keeps it to the ~40% of
-- rows that actually carry a vehicle rather than indexing thousands of NULLs.
create index if not exists tally_vouchers_vehicle_date_idx
  on public.tally_vouchers (company, vehicle_number, date)
  where vehicle_number is not null;
