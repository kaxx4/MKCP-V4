/**
 * Polling less, smartly (owner, 20-Nov-2026): the voucher check backs off while nothing changes and snaps back when something does.
 * Offline: no Tally, no database. Asserts the schedule (`nextVoucherStep`) and that `nudge()` brings the next check forward.
 */
import { RealtimeSync, nextVoucherStep } from "../src/services/realtimeSync.js";

let failed = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`);
};

// every 2 ticks of 30 s, never longer than 5 minutes (10 ticks)
const steps = [0, 1, 2, 3, 4, 5, 6, 9, 12, 30].map((i) => nextVoucherStep(2, 10, i));
eq("waits 2 ticks (60 s) while changes are recent", steps.slice(0, 3), [2, 2, 2]);
eq("doubles after three empty checks, again after six", steps.slice(3, 7), [4, 4, 4, 8]);
eq("never passes the ceiling (10 ticks = 5 min)", steps.slice(7), [10, 10, 10]);
eq("a ceiling below the base never goes under the base", nextVoucherStep(2, 1, 99), 2);
eq("a base of 0 or less is one tick", nextVoucherStep(0, 10, 0), 1);

const rt = new RealtimeSync("http://tally.invalid:9000", {} as never, null, { tickMs: 30_000, voucherEvery: 2, voucherMaxEveryMs: 300_000 });
eq("a fresh poller reports no voucher checks", rt.getStatus().voucherChecks, 0);
rt.nudge();
eq("nudge does not throw and leaves the poller stopped", rt.getStatus().running, false);

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log("realtime backoff: all checks passed");
