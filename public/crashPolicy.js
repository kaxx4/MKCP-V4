/**
 * What the app does after an uncaught exception (rebuild task 1-5, S-10).
 *
 * Before, public/electron.js logged the error and kept running. Node's own
 * rule is that after an uncaught exception the process is in an unknown
 * state; a sync or a push half way through may hold a lock or a lease that
 * nothing will release, and the window keeps showing "running". So now the
 * error is written to the failure log on disk first (P8: keep the evidence of
 * a failure), and then the app exits. It restarts itself, once per crash,
 * unless it is quitting anyway, the crash came in the first 30 s after start
 * (a crash at boot would loop for ever), or it has already crashed 3 times in
 * the last 10 minutes (then it stays closed and the log says why).
 *
 * Pure apart from the two file helpers, so scripts/test.js can check it
 * without Electron.
 */
const fs = require('fs');
const path = require('path');

const BOOT_WINDOW_MS = 30_000;
const CRASH_WINDOW_MS = 10 * 60_000;
const MAX_CRASHES_IN_WINDOW = 3;

/**
 * @param {{ quitting: boolean, uptimeMs: number, recentCrashes: number }} s
 *   recentCrashes counts earlier crashes in the last CRASH_WINDOW_MS, not this one.
 * @returns {'exit' | 'exit-no-restart' | 'restart'}
 */
function decideOnCrash(s) {
  if (s.quitting) return 'exit';
  if (s.uptimeMs < BOOT_WINDOW_MS) return 'exit-no-restart';
  if (s.recentCrashes + 1 >= MAX_CRASHES_IN_WINDOW) return 'exit-no-restart';
  return 'restart';
}

/** Earlier crashes in the log within the window. An unreadable log counts as many: staying closed is safe, a loop is not. */
function recentCrashCount(logPath, now) {
  let text;
  try { text = fs.readFileSync(logPath, 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? 0 : MAX_CRASHES_IN_WINDOW; }
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const at = Date.parse(JSON.parse(line).at); if (Number.isFinite(at) && now - at <= CRASH_WINDOW_MS) n++; } catch { /* a bad line is skipped */ }
  }
  return n;
}

/** One line per crash: when, what, and what the app decided. Never throws. */
function writeCrash(logPath, err, decision, now) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const e = err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : { message: String(err) };
    fs.appendFileSync(logPath, JSON.stringify({ at: new Date(now).toISOString(), decision, error: e }) + '\n');
  } catch { /* the console line in electron.js still carries it */ }
}

module.exports = { decideOnCrash, recentCrashCount, writeCrash, BOOT_WINDOW_MS, CRASH_WINDOW_MS, MAX_CRASHES_IN_WINDOW };
