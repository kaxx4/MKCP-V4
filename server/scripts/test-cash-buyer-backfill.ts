/**
 * CASH-P2 — the agent's own Cash-bill buyer backfill. OFFLINE: Tally answers
 * through the MOCK transport (so tallyPost's LINEERROR / no-DATA rejection and
 * the real XMLParser + convertVouchers run), Supabase is a fake.
 *
 * What is pinned: the request is a single-day header-only Export (never an
 * import, never a range); which days are read; the stop at the first Tally
 * error with no request after it; only the buyer_* columns are written, only
 * for mirror-listed GUIDs; the pause between days; yielding to a running sync;
 * the once-a-day rule; and that a sandbox never starts it.
 *
 *   npx tsx server/scripts/test-cash-buyer-backfill.ts
 */
import { join } from "node:path";
import { tmpdir } from "node:os";

delete process.env.SUPABASE_SERVICE_KEY;   // never a live client, whatever the shell carries

import { tallyPost } from "../src/tally.js";
import { installMock, uninstallMock } from "../src/services/tallyMock.js";
import { configureTallyLog } from "../src/services/tallyLog.js";
import {
  cashBuyerDayRequest, groupPendingByDay, selectDays, backfillDays, backfillDue,
  startCashBuyerBackfill, BUYER_KEYS, INITIAL_BACKFILL_STATE, type BuyerPatch,
} from "../src/services/cashBuyerBackfill.js";

configureTallyLog(join(tmpdir(), "mkcp-test-cash-buyer-backfill-tally-log.jsonl"));

let passed = 0, failed = 0;
const ok = (what: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`  ok    ${what}`); }
  else { failed++; console.log(`  FAIL  ${what}${detail ? "  — " + detail : ""}`); }
};
const eq = (what: string, got: unknown, want: unknown) =>
  ok(what, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const CO = "TEST CO";
const envelope = (vouchers: string) =>
  `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DESC></DESC><DATA><COLLECTION>` +
  vouchers + `</COLLECTION></DATA></BODY></ENVELOPE>`;
const ERROR_ENVELOPE = `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>0</STATUS></HEADER><BODY><DATA><LINEERROR>Could not set &apos;SVCurrentCompany&apos;</LINEERROR></DATA></BODY></ENVELOPE>`;

/** Fictitious vouchers, shaped on real 26-27/0654 (see test-cash-buyer-converter). */
const cashV = (guid: string, num: string, mailing: string | null, town: string | null, state: string | null = "West Bengal") => `<VOUCHER VCHTYPE="SALES">
 ${town ? `<ADDRESS.LIST TYPE="String"><ADDRESS>${town}</ADDRESS></ADDRESS.LIST>` : ""}
 <DATE TYPE="Date">20260905</DATE><GUID>${guid}</GUID>
 ${state ? `<STATENAME TYPE="String">${state}</STATENAME>` : ""}<VOUCHERTYPENAME>SALES</VOUCHERTYPENAME>
 <PARTYLEDGERNAME TYPE="String">Cash</PARTYLEDGERNAME><VOUCHERNUMBER>${num}</VOUCHERNUMBER>
 <BASICBUYERNAME TYPE="String">Cash</BASICBUYERNAME>
 ${mailing ? `<PARTYMAILINGNAME TYPE="String">${mailing}</PARTYMAILINGNAME>` : ""}
</VOUCHER>`;
const partyV = (guid: string, num: string) => `<VOUCHER VCHTYPE="SALES"><DATE TYPE="Date">20260905</DATE><GUID>${guid}</GUID>
 <VOUCHERTYPENAME>SALES</VOUCHERTYPENAME><PARTYLEDGERNAME TYPE="String">FAKE TRADERS (MOCKNAGAR)</PARTYLEDGERNAME><VOUCHERNUMBER>${num}</VOUCHERNUMBER>
 <PARTYMAILINGNAME TYPE="String">FAKE TRADERS</PARTYMAILINGNAME></VOUCHER>`;

/** Mock Tally keyed on the day in the request's filter; records every request. */
function mockTally(byDay: Record<string, string>, requests: string[]) {
  installMock(async (_url, xml) => {
    requests.push(xml);
    const day = /=\s*(\d{8})\s*<\/SYSTEM>/.exec(xml)?.[1] ?? "";
    return byDay[day] ?? envelope("");
  });
}

function fakeDeps(requests: string[], opts: { busyAfter?: number } = {}) {
  const writes: { guid: string; patch: BuyerPatch }[] = [];
  const sleeps: number[] = [];
  const lines: string[] = [];
  let fetches = 0;
  return {
    writes, sleeps, lines,
    deps: {
      fetchDay: (day: string) => { fetches++; return tallyPost("http://mock.invalid", cashBuyerDayRequest(CO, day), 60_000); },
      writeBuyer: async (guid: string, patch: BuyerPatch) => { writes.push({ guid, patch }); return 1; },
      sleep: async (ms: number) => { sleeps.push(ms); },
      busy: () => opts.busyAfter !== undefined && fetches >= opts.busyAfter,
      log: (l: string) => { lines.push(l); },
    },
  };
}

async function main(): Promise<void> {
  console.log("\n  CASH-P2 — the agent backfills Cash buyers itself\n  " + "─".repeat(62));

  console.log("\n  the request: one day, header only, READ-ONLY");
  const xml = cashBuyerDayRequest(CO, "20260905");
  ok("an Export", /<TALLYREQUEST>Export<\/TALLYREQUEST>/.test(xml));
  ok("never an Import / IMPORTDATA", !/Import/i.test(xml.replace(/<TALLYREQUEST>Export/, "")) && !/IMPORTDATA/i.test(xml));
  ok("filtered to exactly one day (= 20260905)", /<SYSTEM[^>]*>[^<]*=\s*20260905\s*<\/SYSTEM>/.test(xml));
  ok("no date RANGE (no &gt;= / &lt;=)", !/&gt;|&lt;/.test(xml.replace(/<SYSTEM[^>]*>/, "")));
  ok("no entry blocks (header scalars only)", !/LedgerEntries|InventoryEntries/i.test(xml));
  ok("no wildcard in the fetch list", !/<NATIVEMETHOD>[^<]*\*/.test(xml));
  ok("asks for the buyer fields and the GUID", ["Guid", "PartyMailingName", "Address", "PartyPincode", "BasicBuyerName"].every((f) => xml.includes(`<NATIVEMETHOD>${f}</NATIVEMETHOD>`)));
  let threw = false;
  try { cashBuyerDayRequest(CO, "2026-09-05"); } catch { threw = true; }
  ok("refuses a day that is not YYYYMMDD", threw);

  console.log("\n  which days");
  const pending = groupPendingByDay([
    { guid: "g1", date: "2026-09-05" }, { guid: "g2", date: "2026-09-05" },
    { guid: "g3", date: "2026-09-06" }, { guid: "g4", date: "2026-03-31" },
    { guid: "g5", date: "2026-10-01" }, { guid: "g6", date: "2026-10-02" },
    { guid: "", date: "2026-09-07" }, { guid: "g8", date: null },
    { guid: "g9", date: "2026-04-01" },
  ]);
  eq("grouped by YYYYMMDD, rows without guid/date dropped", [...pending.keys()].sort(), ["20260331", "20260401", "20260905", "20260906", "20261001", "20261002"]);
  eq("two GUIDs on 5-Sep", [...(pending.get("20260905") ?? [])], ["g1", "g2"]);
  const base = { done: [] as string[], fyStart: "20260401", today: "20261001", maxDays: 30 };
  eq("current FY only, strictly before today, oldest first", selectDays(pending, base), ["20260401", "20260905", "20260906"]);
  eq("done days are never re-read", selectDays(pending, { ...base, done: ["20260905"] }), ["20260401", "20260906"]);
  eq("capped at maxDays", selectDays(pending, { ...base, maxDays: 2 }), ["20260401", "20260905"]);
  eq("maxDays 0 reads nothing", selectDays(pending, { ...base, maxDays: 0 }), []);

  console.log("\n  a clean run");
  {
    const requests: string[] = [];
    mockTally({
      "20260905": envelope(cashV("g1", "26-27/0654", "EXAMPLE CYCLE HOUSE", "SAMPLEGRAM") + cashV("g2", "26-27/0655", null, null, null) + partyV("gp", "26-27/0656")),
      "20260906": envelope(cashV("g3", "26-27/0700", "SAMPLE & SONS", "DEMOPUR") + cashV("gx", "26-27/0701", "NOT IN MIRROR", "X")),
    }, requests);
    const f = fakeDeps(requests);
    const r = await backfillDays(["20260905", "20260906"], pending, f.deps, { pauseMs: 3000 });
    uninstallMock();
    eq("both days done", r.daysDone, ["20260905", "20260906"]);
    ok("no stop", r.stopped === null && !r.yielded);
    eq("one request per day", requests.length, 2);
    eq("written: only mirror-listed GUIDs with a buyer (g2 reads back with no buyer field at all → not written; gx unmatched, party ledger ignored)", f.writes.map((w) => w.guid), ["g1", "g3"]);
    ok("each write carries exactly the six buyer_* keys", f.writes.every((w) => JSON.stringify(Object.keys(w.patch).sort()) === JSON.stringify([...BUYER_KEYS].sort())));
    eq("g1's buyer is the mailing name, not \"Cash\"", [f.writes[0].patch.buyer_name, f.writes[0].patch.buyer_place], ["EXAMPLE CYCLE HOUSE", "SAMPLEGRAM"]);
    eq("counts", [r.named, r.written, r.unmatched], [3, 2, 1]);
    eq("one pause, between the days", f.sleeps, [3000]);
  }

  console.log("\n  stop at the first Tally error");
  {
    const requests: string[] = [];
    mockTally({
      "20260401": envelope(cashV("g9", "26-27/0001", "FIRST BUYER", "TOWNA")),
      "20260905": ERROR_ENVELOPE,
      "20260906": envelope(cashV("g3", "26-27/0700", "SAMPLE & SONS", "DEMOPUR")),
    }, requests);
    const f = fakeDeps(requests);
    const r = await backfillDays(["20260401", "20260905", "20260906"], pending, f.deps, { pauseMs: 3000 });
    uninstallMock();
    eq("stopped on the failing day", r.stopped?.day, "20260905");
    ok("the stop carries Tally's words", /Tally reported an error/.test(r.stopped?.error ?? ""), r.stopped?.error);
    eq("the day before it is done, the failing day is not", r.daysDone, ["20260401"]);
    eq("NO request after the error", requests.length, 2);
    eq("only the first day's buyer written", f.writes.map((w) => w.guid), ["g9"]);
    ok("every request was an Export", requests.every((x) => /<TALLYREQUEST>Export<\/TALLYREQUEST>/.test(x) && !/<TALLYREQUEST>\s*Import/i.test(x)));
  }

  console.log("\n  G7: Tally answers EMPTY for a day the mirror has Cash bills on");
  {
    const requests: string[] = [];
    mockTally({ "20260905": envelope(""), "20260906": envelope(cashV("g3", "26-27/0700", "SAMPLE & SONS", "DEMOPUR")) }, requests);
    const f = fakeDeps(requests);
    const r = await backfillDays(["20260905", "20260906"], pending, f.deps, { pauseMs: 3000 });
    uninstallMock();
    ok("stops — wrong/closed company answers exactly like this", r.stopped?.day === "20260905" && /no vouchers/.test(r.stopped.error));
    eq("day not marked done, nothing after it requested", [r.daysDone, requests.length], [[], 1]);
  }

  console.log("\n  yields to a running sync");
  {
    const requests: string[] = [];
    mockTally({ "20260905": envelope(cashV("g1", "26-27/0654", "EXAMPLE CYCLE HOUSE", "SAMPLEGRAM")) }, requests);
    const f = fakeDeps(requests, { busyAfter: 1 });
    const r = await backfillDays(["20260905", "20260906"], pending, f.deps, { pauseMs: 3000 });
    uninstallMock();
    ok("yielded after the first day, no stop", r.yielded && r.stopped === null);
    eq("first day done, second not requested", [r.daysDone, requests.length], [["20260905"], 1]);
  }

  console.log("\n  once a day");
  const at = (h: number) => new Date(2026, 9, 1, h, 5);
  ok("not before the hour", !backfillDue(at(18), INITIAL_BACKFILL_STATE, 19));
  ok("due at/after the hour when not yet run today", backfillDue(at(19), INITIAL_BACKFILL_STATE, 19));
  ok("not again the same day (a stopped run included)", !backfillDue(at(22), { ...INITIAL_BACKFILL_STATE, lastRunDate: "2026-10-01" }, 19));
  ok("due again the next day", backfillDue(new Date(2026, 9, 2, 19, 0), { ...INITIAL_BACKFILL_STATE, lastRunDate: "2026-10-01" }, 19));

  console.log("\n  never on a sandbox");
  {
    const prev = process.env.MKCP_TALLY_ROLE;
    process.env.MKCP_TALLY_ROLE = "sandbox";
    const warned: string[] = [];
    const w = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a.join(" ")); };
    const requests: string[] = [];
    mockTally({}, requests);
    try { startCashBuyerBackfill("http://mock.invalid", CO); } finally { console.warn = w; uninstallMock(); }
    if (prev === undefined) delete process.env.MKCP_TALLY_ROLE; else process.env.MKCP_TALLY_ROLE = prev;
    ok("refused out loud on MKCP_TALLY_ROLE=sandbox", warned.some((l) => /Cash-bill buyer backfill refused/.test(l)), warned.join(" | "));
    eq("and sent nothing to Tally", requests.length, 0);
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("ERR:", e); process.exit(1); });
