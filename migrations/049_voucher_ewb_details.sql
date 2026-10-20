-- 049 — the rest of the e-way bill block, as one jsonb column (phase 2 W2, owner 20-Oct-2026:
-- "you're not pulling the e-label details from tally… just pulling IRN number").
--
-- Probed 21-Oct-2026 on the dummy Tally (scripts/probe-ewaybill-fields.ts, EWB_DUMP=1):
-- EWAYBILLDETAILS carries BILLDATE, UPDATEDDATE (Part-B time = the print's "valid from"),
-- VALIDUPTO with its time, TRANSPORTERNAME/ID, DOCUMENTNUMBER/DATE (LR), ISPARTBUPDATED,
-- ISCANCELLED/CANCELDATE/REASON, CONSIGNORPLACE/PINCODE, VEHICLETYPE. ewb_number,
-- ewb_valid_until, vehicle_number, transport_mode, transport_distance_km already have columns (025).
--
-- Additive and nullable: no existing reader changes. Must be applied BEFORE the agent build that
-- writes it (PostgREST rejects an upsert naming a column the table lacks).
alter table public.tally_vouchers add column if not exists ewb_details jsonb;

-- Verify: select count(*) filter (where ewb_details is not null) from public.tally_vouchers;
