-- 012_tally_vouchers_reference.sql
-- Mirror the voucher REFERENCE field into the pulled-voucher table so the push agent's
-- reconciliation can match a created voucher by reference (= idempotency_key) WITHOUT
-- re-pushing. Additive: one nullable column; the pull projection (converters/convert.ts
-- + supabaseSync.ts) is updated to populate it. No change to how vouchers are parsed.

alter table public.tally_vouchers
  add column if not exists reference text;

-- Speeds up reconciliation lookups (reference = idempotency_key).
create index if not exists ix_tally_vouchers_reference
  on public.tally_vouchers (reference)
  where reference is not null;
