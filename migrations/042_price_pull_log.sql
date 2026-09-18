-- A log of every price-list pull, and what each one brought.
--
-- ── Why this exists when engine/priceChanges.ts already answers "what moved"
--
-- It answers a DIFFERENT question, and the difference is the owner's workflow.
--
-- `priceChanges.ts` reads Tally's dated history and reports which rates moved
-- BY EFFECTIVE DATE. It needs no storage and works retroactively, and for
-- "when did this item's price change" it is the right tool and stays.
--
-- But the owner's question is: "I just changed some prices in Tally, I pulled,
-- what did that pull bring?" The dated history cannot answer it. Tally stamps
-- revisions with a business effective date — in this company overwhelmingly
-- 1-Apr — not with when somebody typed them, and it REBASES existing history
-- in place when a tax rate moves. So a price edited this afternoon can appear
-- in the history under last April, where a by-date view files it among
-- hundreds of others and it is effectively invisible.
--
-- A pull is the only event that corresponds to the owner's action, so the log
-- is keyed on pulls.
--
-- ── The objection this design had to answer
--
-- The header of `priceChanges.ts` argues against exactly this table: "a second
-- pull of the same data reports 'nothing changed' and destroys the first
-- answer." That is true of a design that keeps ONE snapshot and overwrites it.
-- It is not true here: every pull gets its own immutable row with its own set
-- of changes, so pulling twice records a second pull with zero changes and
-- leaves the first pull's list exactly as it was.
--
-- ── Never deleted, like the price list itself
--
-- `tally_price_list` never deletes, for the reason given in its sync: a row
-- missing from today's pull means Tally stopped reporting that revision, not
-- that it never existed. The same applies here — this is a log, and a log that
-- rewrites itself is not one.

create table if not exists tally_price_pulls (
  id            bigserial primary key,
  company       text        not null,
  pulled_at     timestamptz not null default now(),
  -- "manual", "web-price-list", "scheduled" — whatever asked for the pull, so
  -- an unattended refresh is distinguishable from the owner pressing the button.
  origin        text,
  row_count     integer     not null default 0,
  item_count    integer     not null default 0,
  changed_count integer     not null default 0,
  added_count   integer     not null default 0,
  -- The first pull for a company has nothing to diff against. It is recorded so
  -- the log is complete, but its thousands of "added" rows are not, because a
  -- list where everything is new says nothing.
  is_first_pull boolean     not null default false,
  -- Set when a pull rewrites a large share of the catalogue at once. Tally
  -- re-bases price history in place when a GST rate moves, which can change
  -- hundreds of stored rates without anybody editing a price. Flagged so that
  -- is never mistaken for an afternoon's manual work.
  is_bulk_shift boolean     not null default false
);

create index if not exists tally_price_pulls_company_time
  on tally_price_pulls (company, pulled_at desc);

create table if not exists tally_price_changes (
  id             bigserial primary key,
  pull_id        bigint      not null references tally_price_pulls(id) on delete cascade,
  company        text        not null,
  item_name      text        not null,
  price_level    text        not null,
  -- null on an 'added' row: there was no rate before.
  old_rate       numeric,
  new_rate       numeric,
  -- The effective date Tally gives the new rate, kept because it is frequently
  -- NOT the pull date and the difference is the whole reason this table exists.
  effective_from date,
  -- 'changed' — the effective rate for this item/level moved
  -- 'added'   — this item/level had no price before
  kind           text        not null check (kind in ('changed', 'added'))
);

create index if not exists tally_price_changes_pull on tally_price_changes (pull_id);
create index if not exists tally_price_changes_item on tally_price_changes (company, item_name);

alter table tally_price_pulls   enable row level security;
alter table tally_price_changes enable row level security;

-- Read-only from the browser. Only the desktop agent writes here, through its
-- service-role client, at the moment it performs the pull — there is no
-- meaningful way for a user action to author one of these rows.
drop policy if exists tally_price_pulls_read on tally_price_pulls;
create policy tally_price_pulls_read on tally_price_pulls for select using (true);

drop policy if exists tally_price_changes_read on tally_price_changes;
create policy tally_price_changes_read on tally_price_changes for select using (true);
