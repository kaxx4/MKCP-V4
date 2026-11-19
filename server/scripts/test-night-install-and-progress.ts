/**
 * Offline proof for three agent changes of 19-Nov-2026 (owner list H-1, A-2, "last 7 days"):
 *   1. refreshProgressWriter: writes days done / days in all onto the web's sync request rows, throttled, last value always written.
 *   2. lastNDaysRange: "last N days" is N days including today.
 *   3. autoInstallReason: a downloaded update installs with nobody at the machine only at night (01:00-05:00 India time) or when asked
 *      from the website after this copy started, and only after a quiet spell with no push and no sync.
 * No Tally, no database. Run: npx tsx server/scripts/test-night-install-and-progress.ts
 */
import { createRequire } from "node:module";
import { refreshProgressWriter, cleanIds, THROTTLE_MS, type ProgressRow } from "../src/services/refreshProgress.js";
import { lastNDaysRange } from "../src/services/refreshListener.js";
import { buildPrints, daysToRead, dayKey } from "../src/services/dayFingerprint.js";

const require = createRequire(import.meta.url);
const { autoInstallReason, istHour, QUIET_MS } = require("../../public/autoUpdate.js");

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) passed++; else { failed++; console.log(`  FAIL ${name}${detail ? ` (${detail})` : ""}`); }
};

async function progressTests() {
  check("cleanIds drops junk", JSON.stringify(cleanIds([3, "4", 3, -1, 0, 2.5, "x", null])) === "[3,4]");
  check("cleanIds on a non-array is empty", cleanIds("7").length === 0);

  let t = 1_000_000;
  const writes: Array<{ ids: number[]; row: ProgressRow }> = [];
  const w = refreshProgressWriter([11, 12], async (ids, row) => { writes.push({ ids, row }); }, () => t);
  const ev = (step: number, total = 30, phase = "days-done") => w.onProgress({ phase, step, totalSteps: total, detail: `day ${step}`, timestamp: t });

  ev(3);                       // first: written at once
  t += 500; ev(6);             // inside the throttle: held
  t += 500; ev(5, 30, "vouchers"); // other phases never count
  await w.flush();
  check("first event written at once, held one flushed", writes.length === 2, `got ${writes.length}`);
  check("flushed value is the latest held", writes[1]?.row.progress_done === 6);
  check("ids carried", JSON.stringify(writes[0]?.ids) === "[11,12]");
  t += THROTTLE_MS; ev(9);
  await w.flush();
  check("after the throttle a new value is written", writes.length === 3 && writes[2].row.progress_done === 9);
  t += 10; ev(30);
  await w.flush();
  check("the last day is always written at once", writes.length === 4 && writes[3].row.progress_done === 30 && writes[3].row.progress_total === 30);
  await w.flush();
  check("nothing pending after the end", writes.length === 4);

  const none: ProgressRow[] = [];
  const w2 = refreshProgressWriter(undefined, async (_i, r) => { none.push(r); });
  w2.onProgress({ phase: "days-done", step: 1, totalSteps: 2, detail: "", timestamp: 0 });
  await w2.flush();
  check("no ids (desktop or nightly sync) writes nothing", none.length === 0);

  const w3 = refreshProgressWriter([1], async () => { throw new Error("db down"); });
  w3.onProgress({ phase: "days-done", step: 1, totalSteps: 1, detail: "", timestamp: 0 });
  let threw = false;
  try { await w3.flush(); } catch { threw = true; }
  check("a failed write never fails the sync", !threw);
}

function rangeTests() {
  const now = new Date(2026, 10, 19, 15, 0, 0); // 19-Nov-2026 local
  const r7 = lastNDaysRange(7, now);
  check("last 7 days starts 6 days back", r7.from === "20261113" && r7.to === "20261119", `${r7.from}-${r7.to}`);
  const r1 = lastNDaysRange(1, now);
  check("last 1 day is today", r1.from === "20261119" && r1.to === "20261119");
  const r30 = lastNDaysRange(30, now);
  check("last 30 days crosses the month", r30.from === "20261021", r30.from);
}

function installTests() {
  // 02:30 IST on 20-Nov-2026 = 21:00 UTC on 19-Nov.
  const night = Date.UTC(2026, 10, 19, 21, 0, 0);
  const day = Date.UTC(2026, 10, 20, 6, 30, 0); // 12:00 IST
  const started = Date.UTC(2026, 10, 19, 3, 0, 0);
  const base = { phase: "ready", busy: false, lastBusyAtMs: null, requestAtMs: null, startedAtMs: started };
  check("istHour 21:00 UTC is 02 IST", istHour(night) === 2);
  check("istHour 06:30 UTC is 12 IST", istHour(day) === 12);
  check("night, idle, ready: installs", autoInstallReason({ ...base, nowMs: night }) === "night window");
  check("daytime, no request: waits", autoInstallReason({ ...base, nowMs: day }) === null);
  check("night but busy: waits", autoInstallReason({ ...base, nowMs: night, busy: true }) === null);
  check("night but busy a minute ago: waits for quiet", autoInstallReason({ ...base, nowMs: night, lastBusyAtMs: night - 60_000 }) === null);
  check("night, quiet long enough: installs", autoInstallReason({ ...base, nowMs: night, lastBusyAtMs: night - QUIET_MS - 1 }) === "night window");
  check("nothing downloaded: never", autoInstallReason({ ...base, nowMs: night, phase: "downloading" }) === null);
  check("05:00 IST is outside the window", autoInstallReason({ ...base, nowMs: Date.UTC(2026, 10, 19, 23, 30, 0) }) === null);
  check("00:59 IST is outside the window", autoInstallReason({ ...base, nowMs: Date.UTC(2026, 10, 19, 19, 29, 0) }) === null);
  check("asked from the website after start: installs by day", autoInstallReason({ ...base, nowMs: day, requestAtMs: day - 5_000 }) === "asked from the website");
  check("a request older than this copy is not acted on again", autoInstallReason({ ...base, nowMs: day, requestAtMs: started - 1 }) === null);
  check("a request far in the future is ignored", autoInstallReason({ ...base, nowMs: day, requestAtMs: day + 3_600_000 }) === null);
  check("asked but busy: waits", autoInstallReason({ ...base, nowMs: day, requestAtMs: day - 5_000, busy: true }) === null);
}

function selectiveTests() {
  const days = ["20261113", "20261114", "20261115", "20261116"];
  const t = (rows: Array<[string, string, number | null]>) => buildPrints(rows.map(([guid, date, alterId]) => ({ guid, date, alterId })));
  const tally = t([["a", "20261113", 10], ["b", "20261114", 11], ["c", "20261116", 12]]);
  const mirrorSame = t([["a", "2026-11-13", 10], ["b", "2026-11-14", 11], ["c", "2026-11-16", 12]]);
  check("dayKey reads both machine forms", dayKey("2026-11-13") === "20261113" && dayKey("20261113") === "20261113" && dayKey("13-Nov-26") === null);
  check("identical days are all skipped (empty Sunday too)", daysToRead(days, tally, mirrorSame).length === 0);
  check("an edit (AlterID moved) reads that day only",
    JSON.stringify(daysToRead(days, tally, t([["a", "2026-11-13", 10], ["b", "2026-11-14", 9], ["c", "2026-11-16", 12]]))) === '["20261114"]');
  check("a new voucher in Tally reads its day",
    JSON.stringify(daysToRead(days, t([["a", "20261113", 10], ["b", "20261114", 11], ["c", "20261116", 12], ["d", "20261115", 13]]), mirrorSame)) === '["20261115"]');
  check("a voucher deleted in Tally reads its day (so it is pruned)",
    JSON.stringify(daysToRead(days, t([["a", "20261113", 10], ["c", "20261116", 12]]), mirrorSame)) === '["20261114"]');
  check("a voucher moved to another date reads both days",
    JSON.stringify(daysToRead(days, t([["a", "20261115", 14], ["b", "20261114", 11], ["c", "20261116", 12]]), mirrorSame)) === '["20261113","20261115"]');
  check("a blank AlterID in the mirror reads that day",
    JSON.stringify(daysToRead(days, tally, t([["a", "2026-11-13", null], ["b", "2026-11-14", 11], ["c", "2026-11-16", 12]]))) === '["20261113"]');
  check("could not read the mirror: every day", daysToRead(days, tally, null).length === 4);
  check("could not read Tally: every day", daysToRead(days, null, mirrorSame).length === 4);
  check("an EMPTY Tally fingerprint is not trusted: every day", daysToRead(days, t([]), t([])).length === 4);
  check("a row with no guid or date makes the print unusable", buildPrints([{ guid: "", date: "20261113", alterId: 1 }]) === null && buildPrints([{ guid: "x", date: "bad", alterId: 1 }]) === null);
}

(async () => {
  await progressTests();
  selectiveTests();
  rangeTests();
  installTests();
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
