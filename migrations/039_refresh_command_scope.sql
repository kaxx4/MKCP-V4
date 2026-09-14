-- 039_refresh_command_scope.sql
-- Let a refresh command say WHAT to refresh, not just how far back.
--
-- `tally_refresh_commands` has only ever carried `days`, so every request from
-- the web was a whole-plan sync — minutes of work, chunked daily, holding
-- Tally's single-threaded XML port throughout. That is the right shape for
-- "pull the books"; it is absurdly the wrong one for "show me today's rates".
--
-- The dealer price list is ONE Tally request for the entire catalogue: 490
-- items, 1.3 MB, measured at 0.18 seconds against the live company. Scoping the
-- command lets the Price List page ask for exactly that.
--
-- NULL means what it has always meant — a full sync — so every existing
-- producer and the agent's coalescing path are unchanged. Additive: one
-- nullable column.
alter table public.tally_refresh_commands
  add column if not exists scope text;

comment on column public.tally_refresh_commands.scope is
  'What to refresh. NULL or ''full'' = the whole-plan sync the `days` window describes (the historical behaviour). ''price_list'' = the dealer price list only, one Tally request, no date window — `days` is ignored.';

alter table public.tally_refresh_commands
  drop constraint if exists tally_refresh_commands_scope_check;
alter table public.tally_refresh_commands
  add constraint tally_refresh_commands_scope_check
  check (scope is null or scope in ('full', 'price_list'));
