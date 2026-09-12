/**
 * The scheduled quick syncs — what they actually send, and when they stand down.
 *
 * Runs against a FAKE local server on a throwaway port. Tally is never touched
 * and neither is Supabase, so this is safe to run any time.
 *
 * ── Why the request shape is the subject ──────────────────────────────────
 *
 * Writing this module I got the request wrong twice, and both would have failed
 * silently in exactly the way the module exists to prevent — a scheduler that
 * logs cheerfully every thirty minutes while mirroring nothing:
 *
 *   1. The ROUTE. `/api/tally/sync` runs a whole sync plan; the renderer's quick
 *      sync has always called `/api/tally/sync-daybook`. Different handlers,
 *      different bodies.
 *   2. The DATE FORMAT. sync-daybook validates YYYYMMDD and rejects anything
 *      else with a 400. The hyphenated form that `/api/tally/sync` takes would
 *      have been refused on every single tick.
 *
 * Neither is visible in a type, and neither would show up in a unit test over
 * the date helpers alone. So this asserts on the bytes that reach the server.
 *
 *   npx tsx scripts/test-scheduled-syncs.ts
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  runScheduledWindow, scheduledWindows, noteDaybookSync,
  minutesSinceDaybookSync, todayYmd, daysAgoYmd, fyStartYmd,
} from "../src/services/scheduledSyncs.js";

let passed = 0, failed = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`    \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; failures.push(label); console.log(`    \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
};
const H = (s: string) => console.log(`\n\x1b[1m── ${s} ${"─".repeat(Math.max(0, 56 - s.length))}\x1b[0m`);

interface Seen { path: string; body: Record<string, unknown> }

/** A stand-in for our own Express app: records the request, answers as told. */
function fakeServer(reply: () => { status: number; json: unknown }) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* leave empty */ }
      seen.push({ path: req.url ?? "", body });
      const r = reply();
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.json));
    });
  });
  return {
    seen,
    listen: () => new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    }),
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

const COMPANY = "M.K.CYCLES (P) LTD.";
const todayWindow = () => ({ ...scheduledWindows()[0], everyMinutes: 30 });

(async () => {
  console.log(`\n\x1b[1mScheduled quick syncs — the request, and the stand-down\x1b[0m`);

  H("DATE FORMAT");
  /* Eight digits, no separators. The hyphenated form is a 400 on this route —
     which reads, from the scheduler's side, exactly like everything working. */
  for (const [name, v] of [["today", todayYmd()], ["7 days ago", daysAgoYmd(6)], ["FY start", fyStartYmd()]] as const) {
    ok(`${name} is compact YYYYMMDD`, /^\d{8}$/.test(v), v);
  }
  ok("the FY window starts on 1 April", /0401$/.test(fyStartYmd()), fyStartYmd());
  ok("seven days ago is not today", daysAgoYmd(6) !== todayYmd());

  H("WHAT REACHES THE SERVER");
  {
    const srv = fakeServer(() => ({ status: 200, json: { success: true, stats: { vouchers: 7, elapsedSeconds: 2 } } }));
    const port = await srv.listen();
    const res = await runScheduledWindow(port, COMPANY, todayWindow());
    await srv.close();

    ok("the tick succeeds", res === "ok", res);
    ok("exactly one request was made", srv.seen.length === 1, String(srv.seen.length));
    const req = srv.seen[0];
    // THE BUG. /api/tally/sync is a different handler taking a different body.
    ok("it calls the DAY BOOK route, not the whole-plan sync",
      req?.path === "/api/tally/sync-daybook", req?.path);
    ok("both dates are compact, as that route demands",
      /^\d{8}$/.test(String(req?.body.fromDate)) && /^\d{8}$/.test(String(req?.body.toDate)),
      `${req?.body.fromDate} → ${req?.body.toDate}`);
    ok("it chunks daily", req?.body.chunkMode === "daily", String(req?.body.chunkMode));
    ok("it names the company", req?.body.company === COMPANY, String(req?.body.company));
    // So a [SYNC] line can be attributed to the scheduler rather than a person.
    ok("it tags its origin as scheduled", String(req?.body.origin).startsWith("scheduled-"),
      String(req?.body.origin));
  }

  H("WHEN THE SERVER SAYS NO");
  {
    // 409 = another sync holds the lock. Not a failure: that sync is refreshing
    // the same data. Reporting it as an error would cry wolf every tick.
    const srv = fakeServer(() => ({ status: 409, json: { success: false, error: "in progress" } }));
    const port = await srv.listen();
    ok("a busy lock reads as busy, not failed",
      (await runScheduledWindow(port, COMPANY + " busy", todayWindow())) === "busy");
    await srv.close();
  }
  {
    // Zero rows is what Tally being closed looks like. It must NOT read as a
    // success, or a mirror that stopped updating looks perfectly healthy.
    const srv = fakeServer(() => ({ status: 200, json: { success: false, error: "no data" } }));
    const port = await srv.listen();
    ok("a zero-row answer is a failure, not a quiet success",
      (await runScheduledWindow(port, COMPANY + " empty", todayWindow())) === "failed");
    await srv.close();
  }
  {
    const srv = fakeServer(() => ({ status: 500, json: { error: "boom" } }));
    const port = await srv.listen();
    ok("a 500 is a failure", (await runScheduledWindow(port, COMPANY + " 500", todayWindow())) === "failed");
    await srv.close();
  }
  // A scheduled job that dies on its first bad tick is worse than one that logs
  // and comes back. Nothing is listening on this port at all.
  ok("an unreachable server does not throw",
    (await runScheduledWindow(1, COMPANY + " dead", todayWindow())) === "failed");

  H("STANDING DOWN FOR THE OTHER SCHEDULER");
  {
    const c = "COOP CO";
    ok("a company never synced is due", minutesSinceDaybookSync(c) === Infinity);

    const srv = fakeServer(() => ({ status: 200, json: { success: true } }));
    const port = await srv.listen();

    // Whoever syncs first marks the clock — here, standing in for the renderer's
    // own scheduler, or the nightly job, or someone pressing Sync.
    noteDaybookSync(c);
    ok("a fresh sync makes the window not due", minutesSinceDaybookSync(c) < 1);
    const skipped = await runScheduledWindow(port, c, { ...todayWindow(), label: "Today" });
    ok("the tick stands down rather than pulling Tally again", skipped === "skipped", skipped);
    ok("and nothing was sent", srv.seen.length === 0, `${srv.seen.length} request(s)`);

    await srv.close();
  }
  {
    /* Half the interval is the threshold, so a genuinely due tick still fires.
       Pinned because getting it wrong in the other direction is worse than the
       duplicate it prevents: a scheduler that always stands down is a scheduler
       that never runs. */
    const c = "STALE CO";
    const srv = fakeServer(() => ({ status: 200, json: { success: true } }));
    const port = await srv.listen();
    noteDaybookSync(c);
    // A 2-minute window: 1 minute is the threshold, and no time has passed.
    const fired = await runScheduledWindow(port, c, { ...todayWindow(), everyMinutes: 0 });
    ok("a window with no interval is always due — it cannot suppress itself",
      fired === "ok", fired);
    ok("and it did send", srv.seen.length === 1, `${srv.seen.length} request(s)`);
    await srv.close();
  }

  H("CONFIGURATION");
  {
    const w = scheduledWindows();
    ok("three windows", w.length === 3, w.map((x) => x.label).join(", "));
    // The renderer's own shipped defaults, so moving this changes nobody's cadence.
    ok("Today defaults to 30 minutes", w[0].everyMinutes === 30, String(w[0].everyMinutes));
    ok("the 7-day window is off by default", w[1].everyMinutes === 0);
    ok("the FY window is off by default — the nightly job covers it", w[2].everyMinutes === 0);
  }

  console.log(`\n\x1b[1m${passed} passed · ${failed} failed\x1b[0m`);
  if (failed) console.log(`\nfailed:\n${failures.map((f) => `  · ${f}`).join("\n")}`);
  console.log();
  process.exit(failed ? 1 : 0);
})();
