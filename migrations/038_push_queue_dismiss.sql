-- 038_push_queue_dismiss.sql
-- A failed push the operator has dealt with.
--
-- ── Why a new status and not `cancelled` ──────────────────────────────────
--
-- `cancelled` already means one thing in this system: stopped BEFORE it ran,
-- so nothing was attempted and nothing can be in Tally. usePushActivity says
-- so in as many words ("Deliberately stopped. Not a problem, and not progress
-- either."). A row that FAILED and has been read and set aside is a different
-- fact: Tally was asked, Tally refused or the read-back disagreed, and a
-- person decided not to try again. Folding the two together would erase the
-- only record that the push was ever attempted.
--
-- The commonest real case is Tally's silent duplicate-voucher-number refusal
-- (`created=0 errors=0 exceptions=1`, no reason given): the number is already
-- in the books, retrying can only fail the same way, and the row would
-- otherwise sit in the queue as a permanent red mark with no way to clear it.
--
-- ── What dismissing does NOT do ───────────────────────────────────────────
--
-- Nothing in Tally changes, and the row is not deleted. Reconciliation still
-- watches it: `pushAgent.reconcile` now includes `dismissed` in its candidate
-- set, so if the mirror later shows the voucher DID land under this row's
-- idempotency key, it flips back to `succeeded` on its own. Dismissing is the
-- operator saying "I have seen this", never "this did not happen".
--
-- Additive only: one check-constraint value and one RLS policy.

alter table public.push_queue drop constraint if exists push_queue_status_check;
alter table public.push_queue add constraint push_queue_status_check
  check (status in ('pending','claimed','pushing','succeeded','failed','cancelled','dismissed'));

-- The web app may set aside a row that has already failed, and nothing else.
-- USING pins the row it may touch; WITH CHECK pins what it may become — so a
-- browser can never move a row back into 'pending' (a re-push it did not
-- validate) or forge a 'succeeded'.
drop policy if exists "web dismiss failed" on public.push_queue;
create policy "web dismiss failed" on public.push_queue
  for update using (status = 'failed') with check (status = 'dismissed');

-- ── And the delete the app already believed it could do ───────────────────
--
-- `lib/clearPushQueue.ts` has been issuing this DELETE from the browser since
-- it was written. There is no DELETE policy, so under RLS it matched no rows,
-- returned no error, and the function reported `deleted: <the count it meant to
-- delete>` — the "Clear push queue" button said it had cleared N rows and had
-- cleared none. Observed against the live database on 14-Sep-2026: as `anon`,
-- 3 cancelled rows visible, DELETE issued, 3 rows still present afterwards
-- (inside a rolled-back transaction, so nothing was actually removed).
--
-- Finished rows only. `pending` is excluded because cancelling is the right way
-- to stop something that has not run — it leaves a record. `claimed` and
-- `pushing` are excluded because the agent holds a lease on them right now, and
-- deleting one does not stop the push: it removes the app's only handle on
-- something that is still going to happen, which is how the same voucher ends
-- up in Tally twice.
drop policy if exists "web clear finished" on public.push_queue;
create policy "web clear finished" on public.push_queue
  for delete using (status in ('succeeded','failed','cancelled','dismissed'));
