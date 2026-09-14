-- 040_sales_quote_push_state.sql
-- A quote that has reached Tally should say so.
--
-- `sales_quotes` has carried exactly two states — a row exists (draft) or
-- `status = 'closed'` — since the days when the only way into Tally was to
-- download an XML file and import it by hand. Nothing about a quote changed
-- when it was pushed, so the "Open quote" list showed a Sales Order Note that
-- is live in the books as an ordinary unsent draft, indefinitely, and the only
-- way to know which was which was to go and look in Tally.
--
-- Three additive columns and one new value for `status`:
--
--   status = 'pushed'   the Sales Order Note exists in Tally under this
--                       quote's number. Still open — it becomes an invoice
--                       later, by an Alter in place on the same REMOTEID — so
--                       it belongs in the open list, just not disguised as a
--                       draft.
--   pushed_at           when it landed and the read-back agreed. Not when the
--                       button was pressed: a queued push is not a push.
--   push_queue_id       the queue row, so the failure or the diff behind a
--                       push can still be found afterwards.
--   tally_vch_id        Tally's own id for the voucher, as read back.
--
-- No constraint on `status`: the column has never had one, and adding one now
-- would make this migration capable of failing on data it did not write.
alter table public.sales_quotes add column if not exists pushed_at     timestamptz;
alter table public.sales_quotes add column if not exists push_queue_id uuid;
alter table public.sales_quotes add column if not exists tally_vch_id  text;

comment on column public.sales_quotes.status is
  'draft (never sent) | pushed (a Sales Order Note exists in Tally under this number) | closed (taken off the open list by hand). A pushed quote stays open — it is converted to an invoice by altering it in place.';
