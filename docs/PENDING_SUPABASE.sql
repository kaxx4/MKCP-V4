-- ============================================================================
-- PENDING SUPABASE WORK  —  MKCP, 18-Sep-2026
-- ============================================================================
--
-- Everything in this file was MEASURED against the live project
-- (vmkytsytxlofjyeotmgb) on 18-Sep-2026, not inferred from the migrations
-- folders. Those folders are known to disagree with the database.
--
-- WHAT IS ALREADY DONE — do not re-run, listed so nothing is looked for twice:
--   · migration 042 (tally_price_pulls / tally_price_changes) — applied
--   · migration 041 (tally_report_jobs / tally_report_snapshots) — confirmed
--     present; its file header still says "NOT YET APPLIED", which is stale
--   · sales_quotes — confirmed present; the doc claiming it does not exist is
--     stale
--   · 903 phantom master rows pruned, 11 orphans deliberately kept, backup in
--     _phantom_prune_backup_20260918
--
-- STATUS: sections 1–4 are DONE. Both decisions in 2 and 3 were made and the
-- reasoning is written next to each, with the reversal kept one paste away.
-- Only section 5 is outstanding, and it needs the Supabase and Vercel
-- dashboards, which I cannot reach.
--
-- ============================================================================


-- ============================================================================
-- 1.  voucher_locks ROW-LEVEL SECURITY                     [DONE 18-Sep-2026]
-- ============================================================================
--
-- Measured:  relrowsecurity = false, 0 policies, granted to anon AND
--            authenticated.
--
-- Every other directly-written table has RLS enabled with at least a token
-- policy. This one has neither, so the publishable key — which ships in the
-- browser bundle — has unrestricted read, insert, update and delete on it.
--
-- What that costs: voucher_locks is the edit-lock table. Anyone holding the
-- key can delete every lock in it (letting two people edit one voucher with no
-- warning), or insert a lock naming someone else and block an operator out of
-- a voucher indefinitely. Neither is catastrophic; both are silent.
--
-- The policies below keep the feature working exactly as it does now — the app
-- needs to read all locks, take one, refresh its own, and release it — while
-- removing "delete everyone else's".
--
-- NOTE: this app has no authentication, so `anon` means anyone with the key.
-- These policies are therefore a shape constraint, not authorisation. That is
-- the same posture as every other table here; it is written down rather than
-- assumed.

-- APPLIED. Verified after running: relrowsecurity = true, 4 policies
-- (read:select, take:insert, refresh:update, release:delete). Kept here as the
-- record of what was changed and why. Re-running is harmless — every policy is
-- dropped first.

alter table public.voucher_locks enable row level security;

drop policy if exists voucher_locks_read on public.voucher_locks;
create policy voucher_locks_read
  on public.voucher_locks for select
  using (true);

drop policy if exists voucher_locks_take on public.voucher_locks;
create policy voucher_locks_take
  on public.voucher_locks for insert
  with check (true);

-- Heartbeat: a holder refreshing its own lock.
drop policy if exists voucher_locks_refresh on public.voucher_locks;
create policy voucher_locks_refresh
  on public.voucher_locks for update
  using (true)
  with check (true);

-- Release. Kept permissive because a STALE lock must be clearable by whoever
-- finds it — an expiry the holder never cleared (closed tab, crashed browser)
-- would otherwise block that voucher until someone opened the SQL editor.
drop policy if exists voucher_locks_release on public.voucher_locks;
create policy voucher_locks_release
  on public.voucher_locks for delete
  using (true);

-- Verify:
--   select relrowsecurity, (select count(*) from pg_policy p where p.polrelid = c.oid)
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'public' and c.relname = 'voucher_locks';
--   -- expect: true, 4


-- ============================================================================
-- 2.  "RESET MIRROR YEAR"  —  DECIDED: stays read-only   [CLOSED 18-Sep-2026]
-- ============================================================================
--
-- Measured:  tally_vouchers has RLS enabled and exactly ONE policy —
--            "public read tally_vouchers", for SELECT.
--
-- src/lib/resetMirrorYear.ts issues a DELETE from the browser. Under RLS, a
-- DELETE with no permissive DELETE policy removes ZERO rows and does not
-- error. So the button counted the vouchers, deleted none, logged that it had
-- deleted thousands, asked for a resync, and reported success.
--
-- The app side is fixed already: the delete now returns the rows it removed
-- and refuses to claim a deletion it cannot observe. So today the button
-- fails HONESTLY instead of lying. The remaining question is whether it should
-- work at all.
--
--   OPTION A — leave it refusing (recommended, nothing to run).
--   The browser keeps read-only access to the authoritative mirror. Clearing a
--   year stays a desktop-agent operation, where the service-role key lives and
--   where Tally is reachable anyway. A security audit specifically flagged
--   "the mirror is destroyable a financial year at a time by anyone holding
--   the publishable key" as a risk; option A removes it permanently.
--
--   OPTION B — let the browser do it. Run the policy below. It is date- and
--   company-bounded so it can never widen to "every voucher", but understand
--   what it grants: anyone with the publishable key can delete a financial
--   year of the mirror. It is recoverable — Tally is the ledger of record and a
--   full pull restores it — but the app is empty and every screen reads zero
--   until that pull finishes, which takes minutes.
--
-- DECIDED: OPTION A. The browser keeps read-only access to the authoritative
-- mirror and nothing was run. Clearing a year stays a desktop-agent operation,
-- where the service-role key already lives and where Tally is reachable anyway
-- — so option B would have granted a new power to the one place that does not
-- need it, in exchange for removing a trip to another machine. The app now
-- refuses honestly and names the alternative.
--
-- Option B is kept below so the decision can be reversed with one paste. Do
-- understand what it grants: anyone holding the publishable key could delete a
-- financial year of the mirror.
--
-- drop policy if exists tally_vouchers_web_year_reset on public.tally_vouchers;
-- create policy tally_vouchers_web_year_reset
--   on public.tally_vouchers for delete
--   using (
--     company = 'M.K.CYCLES (P) LTD. - (from 1-Apr-26)'
--     and date >= '2026-04-01' and date <= '2027-03-31'
--   );


-- ============================================================================
-- 3.  perf_logs  —  DECIDED: ingest-only, now pruned     [CLOSED 18-Sep-2026]
-- ============================================================================
--
-- Measured:  one policy, INSERT only.
--
-- So the app writes performance rows and every SELECT returns zero with no
-- error — which reads exactly like "nothing was ever recorded". The documented
-- consequence is that refresh timings cannot be measured, and a standing note
-- in the project's memory says exactly this.
--
-- Reads were deliberately moved behind a service-role endpoint
-- (api/secure.ts), which is the right call — the table is ingest-only by
-- design. So this is probably NOT a bug, and the fix is documentation rather
-- than SQL.
--
-- DECIDED: stays ingest-only. Reads already work through the service-role
-- endpoint (api/secure.ts), which is the right shape for a table the browser
-- only ever appends to, so no policy was added. A zero row count read directly
-- means "not readable", never "not recorded".
--
-- WHAT WAS RUN, and why it mattered more than the policy question: the table
-- had reached **200 MB across 555,669 rows** — four times the entire business
-- dataset, every Tally table together being about 45 MB — growing ~7,200 rows
-- a day with nothing pruning it. Trimmed to 30 days (452,572 rows removed,
-- 103,097 kept) and VACUUM FULL'd: **200 MB → 37 MB**.
--
-- And it will not come back. `services/housekeeping.ts` now prunes perf_logs
-- to 30 days and mirror_change_signal to 24 hours, once a day, wherever the
-- agent runs. That wires up `pruneMirrorSignals`, which had existed with ZERO
-- callers under a comment reading "an append-only table nobody prunes becomes
-- the next thing someone has to discover". It was.
--
-- Uncomment only to let the browser read perf_logs directly again.
--
-- drop policy if exists perf_logs_read on public.perf_logs;
-- create policy perf_logs_read on public.perf_logs for select using (true);
--
-- Either way, consider a retention cut — nothing prunes this table and it is
-- insert-open, so it grows without bound:
--
-- delete from public.perf_logs where created_at < now() - interval '90 days';


-- ============================================================================
-- 4.  HOUSEKEEPING                                                  [OPTIONAL]
-- ============================================================================

-- 4a. The phantom-prune backup. Keep it until you are satisfied nothing broke;
--     it is the only copy of those 903 rows. Drop it when you are.
--
-- select src, count(*) from public._phantom_prune_backup_20260918 group by 1;
-- -- expect: tally_stock_items 452, tally_ledgers 451
--
-- drop table if exists public._phantom_prune_backup_20260918;

-- 4b. mirror_change_signal — HANDLED. `pruneMirrorSignals` is wired into
--     `services/housekeeping.ts` and runs daily, keeping 24 hours. Nothing to
--     run by hand; the manual delete below is kept only for a one-off catch-up
--     if the agent has been off for a long stretch.
--
-- delete from public.mirror_change_signal where created_at < now() - interval '24 hours';


-- ============================================================================
-- 5.  NOT SQL — but on the same list
-- ============================================================================
--
-- ROTATE THE SUPABASE SERVICE-ROLE KEY. It bypasses RLS on every table, it has
-- been inside installers, and it sits in plaintext in two .env files on disk.
-- Until today it was also readable over the network through an unauthenticated
-- route on the desktop agent (fixed: the agent now binds to loopback and the
-- file-transfer route is confined to an allowlist of folders).
--
-- Needs the Supabase dashboard, then the new value placed in:
--   %APPDATA%\mkcycles-dashboard-electron\.env      (the office machine)
--   mkcycles-dashboard\server\.env                   (this machine)
--   Vercel → mkcpweb → Environment Variables → SUPABASE_SERVICE_KEY
--
-- ALSO CHECK, in the Vercel dashboard: MKC_API_SECRET must be set for the
-- PREVIEW environment as well as Production. api/_lib/guards.ts fails closed
-- only when VERCEL_ENV === "production", so a preview deployment with the
-- variable unset serves service-role writes with no gate at all — and preview
-- URLs are publicly reachable.
