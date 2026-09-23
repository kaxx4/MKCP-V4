/**
 * The daily price-list + GST scheduler — when it fires, catch-up, and backoff.
 *
 * Pure decision functions only (`dueForAttempt`, `afterAttempt`) plus the local
 * state file round trip. No Tally, no Supabase, no real timers — every "now" is
 * a literal `Date`, in the style of test-scheduled-syncs.ts.
 *
 *   npx tsx scripts/test-price-gst-daily-sync.ts
 */
import { unlinkSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  dueForAttempt, afterAttempt, INITIAL_STATE, BACKOFF_MS, MAX_ATTEMPTS_PER_DAY,
  dateKey, loadState, saveState, configureStatePath,
  type DailySyncState,
} from "../src/services/priceGstDailySync.js";

let passed = 0, failed = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`    \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; failures.push(label); console.log(`    \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
};
const H = (s: string) => console.log(`\n\x1b[1m── ${s} ${"─".repeat(Math.max(0, 56 - s.length))}\x1b[0m`);

const HOUR = 18;
const d = (y: number, m: number, day: number, h: number, min = 0): Date => new Date(y, m - 1, day, h, min, 0);

(async () => {
  console.log(`\n\x1b[1mDaily price/GST sync — the schedule, the catch-up, the backoff\x1b[0m`);

  H("BEFORE THE HOUR");
  {
    const fresh: DailySyncState = { ...INITIAL_STATE };
    ok("17:59 is not due, nothing has run today", !dueForAttempt(d(2026, 9, 23, 17, 59), fresh, HOUR));
    ok("18:00 is due", dueForAttempt(d(2026, 9, 23, 18, 0), fresh, HOUR));
    ok("23:00 the same day is also due — no attempt has happened yet", dueForAttempt(d(2026, 9, 23, 23, 0), fresh, HOUR));
  }

  H("ONCE A DAY, NOT REPEATEDLY");
  {
    const now = d(2026, 9, 23, 18, 0);
    const afterSuccess = afterAttempt(now, INITIAL_STATE, true);
    ok("a success records today's date", afterSuccess.lastSuccessDate === dateKey(now));
    ok("not due again 5 minutes later, same day", !dueForAttempt(d(2026, 9, 23, 18, 5), afterSuccess, HOUR));
    ok("not due again at 23:59, same day", !dueForAttempt(d(2026, 9, 23, 23, 59), afterSuccess, HOUR));
    ok("due again at 18:00 the NEXT day", dueForAttempt(d(2026, 9, 24, 18, 0), afterSuccess, HOUR));
  }

  H("CATCH-UP — THE MACHINE WAS OFF AT 18:00");
  {
    // Nothing recorded for today at all (process just started, state carried
    // over from a day it never got to run, or never ran before).
    const staleState: DailySyncState = { ...INITIAL_STATE, lastSuccessDate: "2026-09-20" };
    ok("21:00, nothing ran today — due immediately (this IS the catch-up)",
      dueForAttempt(d(2026, 9, 23, 21, 0), staleState, HOUR));
    ok("but 09:00 — before the hour — still waits, even with a stale state",
      !dueForAttempt(d(2026, 9, 23, 9, 0), staleState, HOUR));
  }

  H("BACKOFF AFTER A FAILURE");
  {
    let state = INITIAL_STATE;
    const t0 = d(2026, 9, 23, 18, 0);
    state = afterAttempt(t0, state, false);
    ok("1st failure recorded", state.attempts === 1);
    ok("not due again immediately after a failure", !dueForAttempt(new Date(t0.getTime() + 60_000), state, HOUR));
    ok("not due before the 1st backoff (5 min) elapses",
      !dueForAttempt(new Date(t0.getTime() + BACKOFF_MS[0] - 1000), state, HOUR));
    ok("due once the 1st backoff (5 min) elapses",
      dueForAttempt(new Date(t0.getTime() + BACKOFF_MS[0]), state, HOUR));

    const t1 = new Date(t0.getTime() + BACKOFF_MS[0]);
    state = afterAttempt(t1, state, false);
    ok("2nd failure recorded", state.attempts === 2);
    ok("2nd backoff is longer (15 min) than the 1st",
      !dueForAttempt(new Date(t1.getTime() + BACKOFF_MS[1] - 1000), state, HOUR));
    ok("due once the 2nd backoff elapses", dueForAttempt(new Date(t1.getTime() + BACKOFF_MS[1]), state, HOUR));

    const t2 = new Date(t1.getTime() + BACKOFF_MS[1]);
    state = afterAttempt(t2, state, false);
    ok(`3rd failure recorded (attempts=${MAX_ATTEMPTS_PER_DAY})`, state.attempts === MAX_ATTEMPTS_PER_DAY);
    ok("NO retry storm — after the 3rd failure, never due again today, at any elapsed time",
      !dueForAttempt(new Date(t2.getTime() + 999 * 60_000), state, HOUR));
    ok("but due again at 18:00 the next day", dueForAttempt(d(2026, 9, 24, 18, 0), state, HOUR));

    // A success at any point resets the streak.
    const recovered = afterAttempt(t2, state, true);
    ok("a success resets the failure streak", recovered.attempts === 0 && recovered.lastSuccessDate === dateKey(t2));
  }

  H("A LATE SUCCESS THE SAME DAY DOES NOT LOSE THE STREAK'S SHAPE");
  {
    // Failing once, then succeeding on the retry, must not leave a stray
    // "1 attempt logged" that changes tomorrow's due-ness.
    let state = INITIAL_STATE;
    const t0 = d(2026, 9, 23, 18, 0);
    state = afterAttempt(t0, state, false);
    const t1 = new Date(t0.getTime() + BACKOFF_MS[0]);
    state = afterAttempt(t1, state, true);
    ok("succeeds on the 2nd attempt", state.lastSuccessDate === dateKey(t1));
    ok("not due again later the same day", !dueForAttempt(new Date(t1.getTime() + 60_000), state, HOUR));
  }

  H("STATE FILE ROUND TRIP");
  {
    const dir = mkdtempSync(join(tmpdir(), "mkcp-price-gst-test-"));
    const path = join(dir, "state.json");
    configureStatePath(path);
    try {
      ok("no file yet → initial state", JSON.stringify(loadState()) === JSON.stringify(INITIAL_STATE));

      const state: DailySyncState = { lastSuccessDate: "2026-09-23", attemptDate: "2026-09-23", attempts: 0, lastAttemptAt: 1234 };
      saveState(state);
      ok("the file now exists", existsSync(path));
      const reloaded = loadState();
      ok("reloads exactly what was saved", JSON.stringify(reloaded) === JSON.stringify(state));
    } finally {
      configureStatePath(null);
      try { unlinkSync(path); } catch { /* best-effort cleanup */ }
    }
  }

  console.log(`\n\x1b[1m${passed} passed · ${failed} failed\x1b[0m`);
  if (failed) console.log(`\nfailed:\n${failures.map((f) => `  · ${f}`).join("\n")}`);
  console.log();
  process.exit(failed ? 1 : 0);
})();
