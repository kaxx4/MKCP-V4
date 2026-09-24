/**
 * The daily report refresh — when a report is due, and when it is not.
 *
 * Pure decision function only (`reportsDueForDailyRefresh`). No Tally, no
 * Supabase, no timers — every "now" is a literal local `Date`.
 *
 *   npx tsx scripts/test-report-schedule.ts
 */
import { reportsDueForDailyRefresh, DAILY_REQUESTER } from "../src/services/reportRunner.js";
import { REPORTS } from "../src/services/tallyReports.js";

let passed = 0, failed = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`    \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; console.log(`    \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
};

const HOUR = 18;
const d = (y: number, m: number, day: number, h: number, min = 0): Date => new Date(y, m - 1, day, h, min, 0);
const iso = (x: Date) => x.toISOString();
const KEYS = ["stock-summary", "cash-flow", "ratio-analysis"];

console.log("\n\x1b[1mDaily report refresh — the schedule\x1b[0m");

ok("before the hour nothing is due, even with no snapshot at all",
  reportsDueForDailyRefresh(d(2026, 9, 24, 17, 59), HOUR, KEYS, [], []).length === 0);

ok("at the hour, a report never fetched is due",
  reportsDueForDailyRefresh(d(2026, 9, 24, 18, 0), HOUR, KEYS, [], []).length === KEYS.length);

{
  const snaps = [
    { report: "stock-summary", captured_at: iso(d(2026, 9, 24, 18, 5)) }, // fresh today
    { report: "cash-flow", captured_at: iso(d(2026, 9, 24, 11, 0)) },     // this morning: stale
    { report: "ratio-analysis", captured_at: iso(d(2026, 9, 22, 11, 0)) },
  ];
  const due = reportsDueForDailyRefresh(d(2026, 9, 24, 19, 0), HOUR, KEYS, snaps, []);
  ok("a snapshot captured after today's hour is not due", !due.includes("stock-summary"));
  ok("a snapshot from this morning is due (the evening pull is the day's figure)", due.includes("cash-flow"));
  ok("a two-day-old snapshot is due", due.includes("ratio-analysis"));
}

{
  const jobs = [{ report: "cash-flow", status: "error", created_at: iso(d(2026, 9, 24, 18, 1)), requested_by: DAILY_REQUESTER }];
  const due = reportsDueForDailyRefresh(d(2026, 9, 24, 21, 0), HOUR, KEYS, [], jobs);
  ok("a daily job that FAILED today is not retried every minute", !due.includes("cash-flow"));
  ok("the others still go", due.includes("stock-summary") && due.includes("ratio-analysis"));
}

{
  const jobs = [{ report: "cash-flow", status: "error", created_at: iso(d(2026, 9, 23, 18, 1)), requested_by: DAILY_REQUESTER }];
  const due = reportsDueForDailyRefresh(d(2026, 9, 24, 18, 0), HOUR, KEYS, [], jobs);
  ok("yesterday's failure does not block today", due.includes("cash-flow"));
}

{
  const jobs = [{ report: "stock-summary", status: "running", created_at: iso(d(2026, 9, 24, 17, 0)), requested_by: "web" }];
  const due = reportsDueForDailyRefresh(d(2026, 9, 24, 18, 30), HOUR, KEYS, [], jobs);
  ok("a job already in flight (anyone's) is not doubled", !due.includes("stock-summary"));
}

{
  const jobs = [{ report: "cash-flow", status: "done", created_at: iso(d(2026, 9, 24, 18, 10)), requested_by: "web" }];
  const snaps = [{ report: "cash-flow", captured_at: iso(d(2026, 9, 24, 18, 11)) }];
  const due = reportsDueForDailyRefresh(d(2026, 9, 24, 20, 0), HOUR, KEYS, snaps, jobs);
  ok("a click after the hour already made it fresh", !due.includes("cash-flow"));
}

{
  const due = reportsDueForDailyRefresh(d(2026, 9, 24, 18, 0), HOUR, REPORTS.map((r) => r.key), [], []);
  ok("every catalogued report is covered, including the one never fetched", due.length === REPORTS.length && due.includes("reorder-status"), `${due.length} reports`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
