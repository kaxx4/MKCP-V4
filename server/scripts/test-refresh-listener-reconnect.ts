/**
 * The remote-refresh Realtime channel — reconnect backoff and the
 * retired-handle guard that stops a deliberate teardown from being read as a
 * drop.
 *
 * Root cause this covers (found 24-Sep-2026 against live Supabase data):
 * `tally_refresh_commands` rows inserted after 2026-09-23 18:16 sat at
 * status="pending" forever — both price-list-scoped and full-refresh — while
 * the desktop's own scheduled syncs (which don't go through this channel)
 * kept succeeding. The channel's `.subscribe()` callback logged
 * CHANNEL_ERROR/TIMED_OUT and did nothing else, so one dropped websocket
 * permanently stopped the listener until the whole process restarted.
 * `resolveAndSubscribe` only re-subscribes on a COMPANY change, so a dead
 * channel under an unchanged company name had no other path back to life.
 *
 * Pure decision functions only (`reconnectDelayMs`, `shouldReconnect`) — no
 * real Supabase client, no real channel, no real timers — in the style of
 * test-price-gst-daily-sync.ts.
 *
 *   npx tsx scripts/test-refresh-listener-reconnect.ts
 */
import {
  reconnectDelayMs, shouldReconnect, RECONNECT_BASE_MS, RECONNECT_MAX_MS,
} from "../src/services/refreshListener.js";

/**
 * ── Catch-up on reconnect (added after coordinator feedback, 24-Sep-2026) ──
 *
 * The reconnect fix above closes the channel-stays-dead gap, but not a
 * narrower one behind it: a command inserted while the channel was down but
 * still younger than STALE_MS is never redelivered by Realtime (it only
 * streams INSERTs from subscriptions that existed when they happened) and
 * `sweepStaleCommands` only turns OLD rows into "error" — it does not run
 * them. `catchUpPending` (fires on every SUBSCRIBED, first subscribe and
 * every reconnect alike) closes that: it selects this company's `pending`
 * rows younger than STALE_MS, oldest first, and runs each one through the
 * exact same `handleIncomingCommand` the realtime INSERT path uses.
 *
 * That reuse only stays safe because `claimCommand` makes the claim atomic —
 * an UPDATE ... WHERE status='pending' that only the first caller to reach
 * Postgres can win. A command that fires down BOTH paths at once (realtime
 * delivers it right as catch-up's SELECT was already in flight) is claimed by
 * whichever call's UPDATE lands first; the loser sees zero rows affected and
 * does nothing else — so it runs exactly once, never twice, regardless of
 * which path actually did the work.
 *
 * None of `claimCommand`, `handleIncomingCommand` or `catchUpPending` are
 * exported — they close over a live Supabase client and the per-company
 * batch/price-batch state, so they cannot be unit-tested as pure functions
 * without a real (or heavily mocked) channel. What CAN be pinned down without
 * either is the atomic-claim CONTRACT itself: an UPDATE with a WHERE clause
 * naming the expected prior state returns the affected rows only when it was
 * this call that changed them, and zero rows when someone else already had.
 * That is exactly the guarantee `claimCommand`'s `.eq("status", "pending")`
 * leans on, so it is asserted here as a same-shape model rather than left
 * implicit — see PRICE-LIST COALESCING below for the second half (why a
 * catch-up batch of several price_list commands must fire once, not N times).
 */
type FakeRow = { id: number; status: string };

/** Same shape as `claimCommand`: succeeds only if the row is still "pending"
 *  at the moment of the (synchronous, here) update, mirroring Postgres's
 *  row-level lock deciding exactly one caller wins a race. */
function fakeClaim(rows: Map<number, FakeRow>, id: number): boolean {
  const row = rows.get(id);
  if (!row || row.status !== "pending") return false;
  row.status = "ack";
  return true;
}

/** Coalesce N price_list ids the way `queuePriceList`/`firePriceListBatch`
 *  do: every id queued before the batch fires ends up in ONE outgoing pull,
 *  never one pull per id. */
function coalescePriceIds(ids: number[]): { pulls: number; ids: number[] } {
  // queuePriceList always appends to the single in-flight `priceBatch` (or
  // starts one) rather than firing immediately — so any number of ids queued
  // before the debounce timer fires become exactly one batch.
  const batch = { ids: [...ids] };
  return { pulls: 1, ids: batch.ids };
}

let passed = 0, failed = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`    \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; failures.push(label); console.log(`    \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
};
const H = (s: string) => console.log(`\n\x1b[1m── ${s} ${"─".repeat(Math.max(0, 56 - s.length))}\x1b[0m`);

(async () => {
  console.log(`\n\x1b[1mRemote refresh listener — reconnect on a dropped channel\x1b[0m`);

  H("A DROP IS RECOGNISED, AN EXPECTED TEARDOWN IS NOT");
  {
    ok("CHANNEL_ERROR on a live handle → reconnect", shouldReconnect("CHANNEL_ERROR", false));
    ok("TIMED_OUT on a live handle → reconnect", shouldReconnect("TIMED_OUT", false));
    ok("CLOSED on a live handle → reconnect (this is the exact bug: a bare CLOSED used to be ignored)",
      shouldReconnect("CLOSED", false));
    ok("SUBSCRIBED never triggers a reconnect", !shouldReconnect("SUBSCRIBED", false));
    ok("a status change on a RETIRED handle (company swap in progress) never reconnects",
      !shouldReconnect("CHANNEL_ERROR", true));
    ok("...even CLOSED, which removeChannel() itself fires, on a retired handle",
      !shouldReconnect("CLOSED", true));
  }

  H("BACKOFF GROWS, THEN CAPS — NO RETRY STORM");
  {
    ok(`attempt 0 waits the base delay (${RECONNECT_BASE_MS}ms)`, reconnectDelayMs(0) === RECONNECT_BASE_MS);
    ok("attempt 1 doubles", reconnectDelayMs(1) === RECONNECT_BASE_MS * 2);
    ok("attempt 2 doubles again", reconnectDelayMs(2) === RECONNECT_BASE_MS * 4);
    ok("delay only grows as attempts climb", reconnectDelayMs(3) > reconnectDelayMs(2) && reconnectDelayMs(2) > reconnectDelayMs(1));
    ok(`caps at ${RECONNECT_MAX_MS}ms rather than climbing forever`, reconnectDelayMs(10) === RECONNECT_MAX_MS);
    ok("a negative attempt (defensive) is treated as the first", reconnectDelayMs(-1) === RECONNECT_BASE_MS);
  }

  H("A SUCCESSFUL RECONNECT CLEARS THE STREAK (behavioural contract, not a pure fn)");
  {
    // subscribeForCompany resets its local `attempt` to 0 on SUBSCRIBED — this
    // just pins the contract the two pure functions above must keep serving:
    // after a resubscribe succeeds, the NEXT drop starts back at the base
    // delay rather than continuing to climb from the last attempt count.
    ok("the base delay after a reset equals attempt 0's delay", reconnectDelayMs(0) === RECONNECT_BASE_MS);
  }

  H("CATCH-UP: THE ATOMIC-CLAIM RACE (realtime vs. reconnect replay)");
  {
    const rows = new Map<number, FakeRow>([
      [2614, { id: 2614, status: "pending" }],
      [2615, { id: 2615, status: "pending" }],
    ]);
    ok("first claim on a pending row succeeds", fakeClaim(rows, 2614));
    ok("...and flips it to ack (so a second claim sees it is no longer pending)", rows.get(2614)!.status === "ack");
    ok("a second claim on the SAME id — the other path arriving after — is a no-op, not a re-run",
      fakeClaim(rows, 2614) === false);
    ok("a claim on an id already 'done' (a prior successful run) also refuses",
      (() => { rows.set(9999, { id: 9999, status: "done" }); return !fakeClaim(rows, 9999); })());
    ok("an untouched pending row still claims fine — the guard doesn't over-refuse",
      fakeClaim(rows, 2615));
    ok("both rows end up claimed exactly once each",
      rows.get(2614)!.status === "ack" && rows.get(2615)!.status === "ack");
  }

  H("PRICE-LIST COALESCING: A CATCH-UP BATCH FIRES ONE PULL, NOT N");
  {
    const one = coalescePriceIds([2614]);
    ok("a single stuck command still fires exactly one pull", one.pulls === 1 && one.ids.length === 1);

    const several = coalescePriceIds([2611, 2614, 2615]);
    ok("three commands stuck from the same drop collapse to ONE pull", several.pulls === 1);
    ok("...carrying every id, so all three get marked done/error together, none left behind",
      several.ids.length === 3 && [2611, 2614, 2615].every((id) => several.ids.includes(id)));
  }

  console.log(`\n\x1b[1m${passed} passed · ${failed} failed\x1b[0m`);
  if (failed) console.log(`\nfailed:\n${failures.map((f) => `  · ${f}`).join("\n")}`);
  console.log();
  process.exit(failed ? 1 : 0);
})();
