/**
 * The ERP mirror sync's agent half, offline (rebuild task 1-5, first half;
 * review fixes 6-Nov-2026).
 *
 * Contacts neither Supabase nor Tally. A recording fake store and a fake Tally
 * prove: the mark is read before any voucher read; one read per day, one at a
 * time; an incremental reads above the run's mark; when Tally's highest is
 * below the mark the incremental reads nothing and is refused (needs a full
 * run); a read that cannot be trusted (no GUID, a date that did not parse,
 * another day's voucher, an empty ledger placeholder, an accounting voucher
 * with no lines) fails the run; a Tally error fails the run and never reaches
 * the swap; an error-shaped reply is never "no vouchers"; a test run always
 * scrubs names with a keyed hash; the fenced client reaches the new functions
 * and reads only is_test rows; and today's sync does not import any of it.
 * The database half (staging, swap, mark, floors, switches) is the live test
 * web-dashboard/supabase/live-tests/1-5_mirror.sql.
 *
 *   npx tsx scripts/test-erp-mirror-sync.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import {
  mirrorRowFrom, scrubName, scrubSaltFrom, voucherProblem, isAccountingType, eachDay, runMirrorSync, assertParsedCollection, tallyMirrorReads,
  parseBalance, ledgerProblem, ledgerRowFrom, ledgersFromParsed, runRepull, runDayCheck, planMirrorWork, applyAcceptedDrops, deriveStepState, stageChunks, ERP_MIRROR_LEDGER_DEF, ERP_MIRROR_VOUCHERTYPE_DEF, ERP_MIRROR_UNIT_DEF, ERP_MIRROR_ITEM_DEF, voucherExtrasFromParsed, voucherExtraFields, ledgerContactFields, ERP_MIRROR_MARK_DEF,
  indiaToday, ledgerPeriod, judgeLoadedPeriod, incrementalRanges, INCREMENTAL_CHUNK, ERP_MIRROR_VOUCHER_DEF, loadedPeriodFromParsed, tallyDateToIso, ERP_MIRROR_COMPANY_DEF,
  type MirrorStore, type MirrorTally, type MirrorRow, type SwapResult, type MirrorLedgerRow, type TallyLedger, type DayCheckVoucher, type AcceptedRun,
} from "../src/services/erpMirrorSync.js";
import { erpTestFence, ERP_TEST_RPCS } from "../src/services/supabaseClient.js";
import { parseTallyAmount } from "../src/services/xml.js";
import { TRANSACTION_COLLECTIONS } from "../src/config/collections.js";
import { buildCollectionXml, buildChangedVoucherXml } from "../src/services/xmlBuilder.js";
import { installMock, uninstallMock } from "../src/services/tallyMock.js";

let passed = 0, failed = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`  ✓ ${label}${detail ? ` (${detail})` : ""}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` (${detail})` : ""}`); }
};
const H = (s: string) => console.log(`\n── ${s}`);
const SALT = scrubSaltFrom("zz-test-machine-key");

const voucher = (guid: string, date: string, alterid: number, extra: Record<string, unknown> = {}) => ({
  guid, date, alterid, masterid: alterid + 1000, vouchertypename: "SALES", vouchernumber: `26-27/${alterid}`,
  partyledgername: "REAL LOOKING TRADERS", narration: "goods sent", reference: "REF 1", iscancelled: false, isoptional: false,
  effectivedate: date,
  allledgerentries: [
    { ledgername: "REAL LOOKING TRADERS", amount: "-1180.00", isdeemedpositive: true },
    { ledgername: "SALES GST", amount: "1000.00", isdeemedpositive: false },
    { ledgername: "OUTPUT IGST", amount: "180.00", isdeemedpositive: false },
  ],
  ...extra,
});

function fakeStore(opts: { mark?: number | null; swap?: SwapResult; isTest?: boolean; salt?: string | null; repull?: string | null; check?: Record<string, any>; accepted?: AcceptedRun[] | unknown; acceptedSwap?: (run: string) => SwapResult | Error; derive?: () => Record<string, any> | Error } = {}) {
  const calls: string[] = [];
  const staged: MirrorRow[] = [];
  const ledgers: MirrorLedgerRow[] = [];
  let checked: { highest: number; vouchers: DayCheckVoucher[] } | null = null;
  const steps: { step: string; state: string; rows?: number | null; detail?: unknown }[] = [];
  let swapArgs: { mark: number } | null = null; let failed: string | null = null;
  const store: MirrorStore = {
    isTest: opts.isTest ?? true,
    scrubSalt: opts.salt === undefined ? SALT : opts.salt,
    async start(kind, scope) {
      calls.push(`start ${kind}`);
      return kind === "full" ? { run_id: "R1", scope_from: scope!.from, scope_to: scope!.to, mark: opts.mark ?? null }
        : { run_id: "R2", scope_from: "2026-10-30", scope_to: "2026-11-05", mark: opts.mark ?? 50 };
    },
    async step(_r, step, state, rows, _ms, detail) { calls.push(`step ${step}`); steps.push({ step, state, rows, detail }); },
    async stage(_r, rows) { calls.push(`stage ${rows.length}`); staged.push(...rows); return new Set(staged.map((x) => x.key)).size; },
    async swap(_r, mark) { calls.push("swap"); swapArgs = { mark }; return opts.swap ?? { state: "swapped", inserted: staged.length }; },
    async fail(_r, e) { calls.push("fail"); failed = e; },
    async stageLedgers(_r, rows) { calls.push(`ledgers ${rows.length}`); ledgers.push(...rows); return ledgers.length; },
    async repullStart() { calls.push("repull start"); return opts.repull ? { run_id: "R3", scope_from: opts.repull, scope_to: opts.repull, mark: 90, repull_id: "Q1" } : null; },
    async checkDays(highest, vouchers) { calls.push("check"); checked = { highest, vouchers }; return opts.check ?? { state: "ok", days_differing: 0, repulls_queued: 0 }; },
    async lastFullRun() { calls.push("last full"); return { run_id: "R0", finished_at: "2026-11-01T00:00:00Z" }; },
    async acceptedRuns() {
      calls.push("accepted list");
      if (opts.accepted !== undefined && !Array.isArray(opts.accepted)) throw new Error("erp_sync_accepted_runs: the answer is not a list, so nobody can say what was accepted");
      return (opts.accepted as AcceptedRun[] | undefined) ?? [];
    },
    async swapAccepted(run) {
      calls.push(`swap accepted ${run}`);
      const r = opts.acceptedSwap ? opts.acceptedSwap(run) : ({ state: "swapped" } as SwapResult);
      if (r instanceof Error) throw r;
      return r;
    },
    ...(opts.derive ? { async deriveTally() { calls.push("derive"); const d = opts.derive!(); if (d instanceof Error) throw d; return d; } } : {}),
  };
  return { store, calls, staged, steps, ledgers, get swapArgs() { return swapArgs; }, get failed() { return failed; }, get checked() { return checked; } };
}

const ledger = (guid: string, name: string, closing = "-1234.50", extra: Partial<TallyLedger> = {}): TallyLedger =>
  ({ guid, name, parent: "Sundry Debtors", closingbalance: closing, openingbalance: "100.00", alterid: "7", masterid: "70", ...extra });
const LEDGERS = [ledger("L-1", "REAL LOOKING TRADERS"), ledger("L-2", "Cash", "5000.00"), ledger("L-3", "ZERO LEDGER", "")];

/** Tally's loaded period in the fakes: this financial year, 1 April to 31 March (YYYYMMDD, as the Company object gives it). */
const FY_START = ledgerPeriod(indiaToday()).from;
const FY_NOW = { from: FY_START.replace(/-/g, ""), to: `${Number(FY_START.slice(0, 4)) + 1}0331` };
const FY_END = `${Number(FY_START.slice(0, 4)) + 1}-03-31`;
function fakeTally(byDay: Record<string, any[]>, opts: { highest?: number; failOn?: string; changed?: any[]; ledgers?: TallyLedger[]; vouchers?: DayCheckVoucher[]; period?: { from: string | null; to: string | null; lastVoucher?: string | null } | { from: string | null; to: string | null; lastVoucher?: string | null }[]; counted?: Record<string, number>; latestDate?: string | null; dropFirstTime?: string; undated?: number } = {}) {
  let dropped = false;
  let periodRead = 0;
  const calls: string[] = [];
  const asOf: string[] = [];
  let inFlight = 0, maxInFlight = 0;
  const wrap = async <T>(label: string, fn: () => T): Promise<T> => {
    calls.push(label); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    if (opts.failOn === label) throw new Error("Tally reported an error: ZZ TEST error window");
    return fn();
  };
  const tally: MirrorTally = {
    highest: () => wrap("highest", () => ({ alterId: opts.highest ?? 100, latestDate: opts.latestDate === undefined ? "2026-11-05" : opts.latestDate, count: 9, byDay: opts.counted ?? {}, undated: opts.undated, vouchers: opts.vouchers ?? [{ k: "A", d: "2026-11-01", a: 90 }] })),
    vouchersOn: (day) => wrap(`day ${day}`, () => byDay[day] ?? []),
    changedSince: (mark, upTo?: number) => wrap(`changed ${mark}${upTo === undefined ? "" : `..${upTo}`}`, () => (opts.changed ?? []).filter((v: any) => upTo === undefined ? (opts.changed!.length < 50 || Number(v.alterid) > mark) : (Number(v.alterid) > mark && Number(v.alterid) <= upTo))
      .filter((v: any) => { if (opts.dropFirstTime && v.guid === opts.dropFirstTime && !dropped) { dropped = true; return false; } return true; })),
    ledgers: (...a: unknown[]) => { asOf.push(String(a.length)); return wrap("ledgers", () => opts.ledgers ?? LEDGERS); },
    loadedPeriod: () => wrap("period", () => { const p = opts.period ?? FY_NOW; return Array.isArray(p) ? p[Math.min(periodRead++, p.length - 1)] : p; }),
  };
  return { tally, calls, asOf, get maxInFlight() { return maxInFlight; } };
}

(async () => {
  H("THE ROW (pure)");
  const v = voucher("G-1", "20261103", 77);
  const plain = mirrorRowFrom(v, { scrub: false })!;
  ok("key is Tally's GUID, date in ISO, identity kept", plain.key === "G-1" && plain.voucher_date === "2026-11-03" && plain.alter_id === 77 && plain.master_id === 1077);
  ok("ledger total is half the sum of the lines (1,180)", plain.ledger_total === 1180, String(plain.ledger_total));
  ok("the type keeps Tally's spelling (SALES)", plain.voucher_type === "SALES");
  const scrubbed = mirrorRowFrom(v, { scrub: true, salt: SALT })!;
  const text = JSON.stringify(scrubbed);
  ok("scrubbed: no party or ledger name from the dummy survives", !/REAL LOOKING|SALES GST|OUTPUT IGST|goods sent|REF 1/.test(text), text.slice(0, 120));
  ok("scrubbed: the same name gives the same stand-in", scrubName("PARTY", "Real Looking Traders", SALT) === scrubName("PARTY", "REAL LOOKING TRADERS", SALT) && /^ZZ TEST PARTY [0-9a-f]{10}$/.test(scrubbed.party ?? ""));
  const unkeyed = createHash("sha256").update("REAL LOOKING TRADERS").digest("hex");
  ok("review M3: the stand-in is keyed, so hashing a list of names does not reverse it", !unkeyed.startsWith((scrubbed.party ?? "").slice(-10))
    && scrubName("PARTY", "REAL LOOKING TRADERS", scrubSaltFrom("another-machine-key")) !== scrubbed.party);
  ok("review M3: scrubbing without a salt is refused", (() => { try { scrubName("PARTY", "X", ""); return false; } catch { return true; } })());
  ok("scrubbed: amounts, numbers and the ledger total stay", scrubbed.ledger_total === 1180 && scrubbed.voucher_number === "26-27/77" && (scrubbed.row.ledgers as any[])[0].amount === -1180);
  const zz = mirrorRowFrom(voucher("G-2", "20261103", 78, { partyledgername: "ZZ TEST PARTY 1", narration: "ZZTEST 1-5 rig" }), { scrub: true, salt: SALT })!;
  ok("scrubbed: ZZ TEST names and a ZZTEST narration stay readable", zz.party === "ZZ TEST PARTY 1" && zz.row.narration === "ZZTEST 1-5 rig");
  const zzLoose = mirrorRowFrom(voucher("G-3", "20261103", 79, { partyledgername: "zztest party" }), { scrub: true, salt: SALT })!;
  ok("scrubbed: a name only like ZZ TEST (zztest) is scrubbed too, as the database expects", /^ZZ TEST PARTY [0-9a-f]{10}$/.test(zzLoose.party ?? ""), zzLoose.party ?? "");
  const noLines = mirrorRowFrom(voucher("G-4", "20261103", 80, { vouchertypename: "Stock Journal", allledgerentries: [] }), { scrub: false })!;
  ok("review M4: a voucher with no ledger lines has no ledger total (null, never 0) and says so", noLines.ledger_total === null && noLines.row.no_ledger_lines === true);
  ok("a voucher with no GUID gets no made-up key (G5)", mirrorRowFrom(voucher("", "20261103", 1), { scrub: false }) === null);
  ok("eachDay is inclusive, seven days", eachDay("2026-10-30", "2026-11-05").length === 7 && eachDay("2026-10-30", "2026-11-05")[6] === "2026-11-05");
  ok("eachDay of a backwards range is empty", eachDay("2026-11-05", "2026-11-01").length === 0);

  H("A VOUCHER THAT CANNOT BE TRUSTED (pure)");
  ok("a good voucher has no problem", voucherProblem(v) === null);
  ok("no GUID", voucherProblem(voucher("", "20261103", 1)) === "no GUID");
  ok("a date that did not parse", voucherProblem(voucher("G", "3-Nov", 1)) === "a date that did not parse");
  ok("review M4: an empty ledger placeholder line", voucherProblem(voucher("G", "20261103", 1, { allledgerentries: [{ ledgername: "", amount: "" }] })) === "an empty ledger line (a placeholder)");
  ok("review M4: a Sales voucher with no ledger lines", voucherProblem(voucher("G", "20261103", 1, { allledgerentries: [] })) === "no ledger lines on a SALES");
  ok("review M4: a cancelled Sales voucher with no lines is fine", voucherProblem(voucher("G", "20261103", 1, { allledgerentries: [], iscancelled: true })) === null);
  ok("review M4: inventory-only types may have no ledger lines", ["Stock Journal", "Sales Order", "Delivery Note", "Receipt Note", "Physical Stock", "Purchase Order"].every((t) => !isAccountingType(t))
    && ["Sales", "SALES GST", "Purchase", "Receipt", "Payment", "Contra", "Journal", "Credit Note", "Debit Note"].every((t) => isAccountingType(t)));

  H("A FULL RUN");
  const days = { "2026-11-01": [voucher("A", "20261101", 101)], "2026-11-03": [voucher("B", "20261103", 120), voucher("C", "20261103", 121)] };
  let s = fakeStore(), t = fakeTally(days, { highest: 100 });
  let rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-03" } });
  ok("Tally's highest AlterID is read before any voucher", t.calls[0] === "highest" && t.calls.slice(1, -3).every((c) => c.startsWith("day ")), t.calls.join(", "));
  ok("one read per day of the scope, in order, then the loaded period, the ledgers once, and the period again (0119, D-C.2, D-1-5.43)", t.calls.slice(1).join(",") === "day 2026-11-01,day 2026-11-02,day 2026-11-03,period,ledgers,period");
  ok("never two Tally requests at once", t.maxInFlight === 1, `max ${t.maxInFlight}`);
  ok("the swap gets the mark read BEFORE the reads (100), not the highest staged (121)", s.swapArgs?.mark === 100 && rep.markCandidate === 100);
  ok("every step is written: the mark, each day, staged, the ledgers, swapped", s.steps.length === 7 && s.steps.every((x) => x.state === "ok"), s.steps.map((x) => x.step).join(" | "));
  ok("the report says swapped", rep.state === "swapped" && rep.read === 3 && rep.tallyReads === 7 && s.staged.length === 3 && rep.ledgers === 3);
  ok("0119: the ledgers are staged before the swap", s.calls.indexOf("ledgers 3") >= 0 && s.calls.indexOf("ledgers 3") < s.calls.indexOf("swap"), s.calls.join(","));
  ok("stage comes before swap, swap once", s.calls.indexOf("swap") > s.calls.findIndex((c) => c.startsWith("stage")) && s.calls.filter((c) => c === "swap").length === 1);
  ok("review M3: a test store's rows reach staging scrubbed (the caller has no switch for it)", s.staged.every((r) => /^ZZ TEST\b/.test(r.party ?? "") && (r.row.ledgers as any[]).every((l) => /^ZZ TEST\b/.test(l.ledger))));
  let threwNoSalt = false;
  try { await runMirrorSync({ store: fakeStore({ salt: null }).store, tally: fakeTally(days).tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-01" } }); } catch { threwNoSalt = true; }
  ok("review M3: a test store without a salt cannot run at all", threwNoSalt);
  s = fakeStore({ isTest: false, salt: null }); t = fakeTally(days);
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-01" } });
  ok("a live store (go-live) keeps Tally's names", rep.state === "swapped" && s.staged[0]?.party === "REAL LOOKING TRADERS");

  H("A DAY READ SHORTER THAN TALLY'S OWN COUNT IS REFUSED (review 1-5 item 1)");
  const counted = { "2026-11-01": 1, "2026-11-02": 0, "2026-11-03": 2 };
  s = fakeStore(); t = fakeTally({ ...days, "2026-11-03": [voucher("B", "20261103", 120)] }, { counted });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-03" } });
  ok("a day read with fewer vouchers than the AlterID read counted for that day fails the run, naming the day and both counts; nothing swapped",
    rep.state === "failed" && /read of 2026-11-03 returned 1 vouchers.*counted 2 on that day/.test(rep.error ?? "") && !s.calls.includes("swap") && s.calls.includes("fail"), rep.error ?? "");
  ok("the short day writes no read step, so its count can never be trusted later", !s.steps.some((x) => x.step === "read 2026-11-03"));
  s = fakeStore(); t = fakeTally({ "2026-11-01": [voucher("A", "20261101", 101)] }, { counted: { "2026-11-01": 1, "2026-11-02": 3 } });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-02" } });
  ok("an empty day that Tally's AlterID read counted 3 vouchers on is refused, never 'nothing there'",
    rep.state === "failed" && /read of 2026-11-02 returned 0 vouchers.*counted 3/.test(rep.error ?? "") && !s.calls.includes("swap") && !t.calls.includes("ledgers"), rep.error ?? "");
  s = fakeStore(); t = fakeTally(days, { counted: { "2026-11-01": 1, "2026-11-03": 1 } });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-03" } });
  ok("a day read with more vouchers than counted (made since the AlterID read) is fine", rep.state === "swapped" && s.staged.length === 3, rep.error ?? "");
  s = fakeStore({ repull: "2026-11-03" }); t = fakeTally({ "2026-11-03": [] }, { highest: 130, counted: { "2026-11-03": 2 } });
  const rpShort = await runRepull({ store: s.store, tally: t.tally });
  ok("a re-pull of a day that comes back empty while Tally counts 2 is refused, so the day is not pruned", rpShort?.state === "failed" && /counted 2/.test(rpShort.error ?? "") && !s.calls.includes("swap"), rpShort?.error ?? "");
  const noAlter = tallyMirrorReads("http://x", "ZZ CO", async () => ({ ENVELOPE: { BODY: { DATA: { COLLECTION: { VOUCHER: [{ GUID: "g1", DATE: "20261101" }, { GUID: "g2", DATE: "20261102", ALTERID: "" }] } } } } }));
  let noAlterErr = ""; try { await noAlter.highest(); } catch (e) { noAlterErr = (e as Error).message; }
  ok("review 1-5 item 5: an AlterID read with vouchers but no AlterID on any is refused, not a mark of 0", /2 vouchers and no AlterID/.test(noAlterErr), noAlterErr);
  const emptyAlter = await tallyMirrorReads("http://x", "ZZ CO", async () => ({ ENVELOPE: { BODY: { DATA: { COLLECTION: "" } } } })).highest();
  ok("an AlterID read of a company with no vouchers at all is still 0 (nothing to read)", emptyAlter.alterId === 0 && emptyAlter.count === 0);

  H("STAGING IN BATCHES");
  const many = Array.from({ length: 1200 }, (_, i) => voucher(`K${i}`, "20261102", 200 + i));
  s = fakeStore(); t = fakeTally({ "2026-11-02": many });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-02", to: "2026-11-02" } });
  ok("1,200 rows are staged in calls of at most 500", s.calls.filter((c) => c.startsWith("stage")).join(",") === "stage 500,stage 500,stage 200" && rep.staged === 1200);

  H("A READ THAT CANNOT BE TRUSTED FAILS THE RUN (review H2, M4)");
  const untrusted: [string, Record<string, any[]>, RegExp][] = [
    ["a voucher with no GUID", { "2026-11-01": [voucher("A", "20261101", 1), voucher("", "20261101", 2)] }, /1 with no GUID/],
    ["a date that did not parse", { "2026-11-01": [voucher("A", "1-Nov", 1)] }, /date that did not parse/],
    ["a day's read holding another day's voucher", { "2026-11-01": [voucher("A", "20261102", 1)] }, /dated 2026-11-02, not 2026-11-01/],
    ["an empty ledger placeholder", { "2026-11-01": [voucher("A", "20261101", 1, { allledgerentries: [{}] })] }, /placeholder/],
    ["a Sales voucher with no ledger lines", { "2026-11-01": [voucher("A", "20261101", 1, { allledgerentries: [] })] }, /no ledger lines on a SALES/],
  ];
  for (const [what, d, re] of untrusted) {
    s = fakeStore(); t = fakeTally(d);
    rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-01" } });
    ok(`${what}: the run fails, nothing is staged or swapped`, rep.state === "failed" && re.test(rep.error ?? "") && !s.calls.includes("swap") && s.staged.length === 0 && s.calls.includes("fail"), rep.error ?? "");
  }
  s = fakeStore({ mark: 50 }); t = fakeTally({}, { highest: 130, changed: [voucher("", "20261104", 125)] });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "incremental" });
  ok("an incremental voucher with no GUID fails the run too", rep.state === "failed" && rep.noGuid === 1 && !s.calls.includes("swap"));

  H("AN INCREMENTAL RUN");
  s = fakeStore({ mark: 50 }); t = fakeTally({}, { highest: 130, changed: [voucher("C", "20261104", 125)], vouchers: [{ k: "C", d: "2026-11-04", a: 125 }] });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "incremental" });
  ok("it reads above the run's mark, after reading Tally's highest, then the ledgers", t.calls.join(",") === "highest,changed 50,period,ledgers,period");
  ok("the swap gets Tally's highest (130)", s.swapArgs?.mark === 130 && rep.state === "swapped" && s.staged.length === 1);
  s = fakeStore({ mark: 130 }); t = fakeTally({}, { highest: 130 });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "incremental" });
  ok("Tally's highest equal to the mark: it reads above the mark, nothing new", t.calls.join(",") === "highest,changed 130,period,ledgers,period" && rep.state === "swapped");

  H("A VOUCHER WITH A DATE THAT DOES NOT PARSE IN THE ALTERID READ (thread 7 review 6)");
  s = fakeStore({ mark: 50 }); t = fakeTally({}, { highest: 130, changed: [voucher("C", "20261104", 125)], vouchers: [{ k: "C", d: "2026-11-04", a: 125 }], undated: 1 });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "incremental" });
  ok("the period is flagged balance_period_unexpected, never judged on a latest date that skipped a voucher", rep.state === "swapped" && rep.ledgerPeriod?.unexpected === true && /date that could not be read/.test(rep.ledgerPeriod?.why ?? ""), JSON.stringify(rep.ledgerPeriod));
  s = fakeStore({ mark: 50 }); t = fakeTally({}, { highest: 130, changed: [voucher("C", "20261104", 125)], vouchers: [{ k: "C", d: "2026-11-04", a: 125 }], undated: 0 });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "incremental" });
  ok("with every date read, the period is judged as before", rep.ledgerPeriod?.unexpected === false, JSON.stringify(rep.ledgerPeriod));

  H("A BIG INCREMENTAL IN ALTERID RANGES (L3)");
  const ids = Array.from({ length: 450 }, (_, i) => 1001 + i * 2);   // 450 vouchers above the mark 1000, AlterIDs 1001 to 1899
  const rg = incrementalRanges(1000, 1900, [...ids, 900, null], 200);
  ok("450 changed vouchers make 3 ranges of 200, 200 and 50, back to back, the last ending at Tally's highest",
    JSON.stringify(rg.map((r) => r.counted)) === "[200,200,50]" && rg[0].above === 1000 && rg[0].upTo === ids[199] && rg[1].above === ids[199] && rg[1].upTo === ids[399] && rg[2].above === ids[399] && rg[2].upTo === 1900, JSON.stringify(rg));
  ok("nothing above the mark is one range counting 0; no per-voucher list is one range counting nothing (as before)",
    JSON.stringify(incrementalRanges(1000, 1000, [900])) === JSON.stringify([{ above: 1000, upTo: 1000, counted: 0 }]) && JSON.stringify(incrementalRanges(1000, 1900, undefined)) === JSON.stringify([{ above: 1000, upTo: 1900, counted: null }]));
  ok("exactly 200 is one range", incrementalRanges(1000, 1900, ids.slice(0, 200), 200).length === 1 && INCREMENTAL_CHUNK === 200);
  const big = ids.map((a, i) => voucher(`BIG-${i}`, "20261104", a));
  s = fakeStore({ mark: 1000 }); t = fakeTally({}, { highest: 1900, changed: big, vouchers: ids.map((a, i) => ({ k: `BIG-${i}`, d: "2026-11-04", a })) });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "incremental" });
  ok("the run reads the three ranges in order, the last open-ended, and stages all 450", rep.state === "swapped" && rep.read === 450
    && t.calls.filter((x) => x.startsWith("changed")).join(",") === `changed 1000..${ids[199]},changed ${ids[199]}..${ids[399]},changed ${ids[399]}`, t.calls.filter((x) => x.startsWith("changed")).join(","));
  ok("each range is its own step", s.steps.filter((x) => /^read (AlterIDs|every voucher above)/.test(x.step)).length === 3);
  s = fakeStore({ mark: 1000 }); t = fakeTally({}, { highest: 1900, changed: big.filter((_, i) => i !== 250), vouchers: ids.map((a, i) => ({ k: `BIG-${i}`, d: "2026-11-04", a })) });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "incremental" });
  ok("a range read that lacks a voucher the AlterID read listed refuses the run, after one second read; nothing is swapped", rep.state === "failed" && /1 of the 450 vouchers.*did not come back, even on a second read/.test(rep.error ?? "") && !s.calls.includes("swap")
    && t.calls.filter((x) => x.startsWith("changed")).length === 4, rep.error ?? "");
  /* Thread 7 review 4: a count that matches proves nothing. One voucher swapped for another with a different key has the same count. */
  s = fakeStore({ mark: 1000 }); t = fakeTally({}, { highest: 1900, changed: big.map((v, i) => (i === 250 ? voucher("OTHER-KEY", "20261104", ids[250]) : v)), vouchers: ids.map((a, i) => ({ k: `BIG-${i}`, d: "2026-11-04", a })) });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "incremental" });
  ok("200 vouchers come back for a range that listed 200, but one is a different voucher: refused (the old count check passed this)", rep.state === "failed" && /1 of the 450 vouchers/.test(rep.error ?? "") && !s.calls.includes("swap"), rep.error ?? "");
  s = fakeStore({ mark: 1000 }); t = fakeTally({}, { highest: 1900, changed: big, dropFirstTime: "BIG-250", vouchers: ids.map((a, i) => ({ k: `BIG-${i}`, d: "2026-11-04", a })) });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "incremental" });
  ok("a range that comes back one short is read once more, and then passes", rep.state === "swapped" && s.staged.length === 450 && t.calls.filter((x) => x.startsWith("changed")).length === 4 && s.steps.some((x) => /again \(a voucher the AlterID read listed was missing\)/.test(x.step)), rep.error ?? "");
  s = fakeStore({ mark: 1000 }); t = fakeTally({}, { highest: 1900, changed: [...big, voucher("NEW-1", "20261104", 1950)], vouchers: ids.map((a, i) => ({ k: `BIG-${i}`, d: "2026-11-04", a })) });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "incremental" });
  ok("extras above the AlterID read (a voucher made since) are fine", rep.state === "swapped" && s.staged.length === 451, rep.error ?? "");
  s = fakeStore({ mark: 1000 }); t = fakeTally({}, { highest: 1900, changed: big.map((v, i) => (i === 100 ? voucher("BIG-100", "20261104", 1960) : v)), vouchers: ids.map((a, i) => ({ k: `BIG-${i}`, d: "2026-11-04", a })) });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "incremental" });
  ok("a voucher edited meanwhile (a higher AlterID, now in a later range) is found there, not refused", rep.state === "swapped", rep.error ?? "");
  const xUp = buildChangedVoucherXml(ERP_MIRROR_VOUCHER_DEF, "ZZ PRACTICE CO", 1000, 1399), xOpen = buildChangedVoucherXml(ERP_MIRROR_VOUCHER_DEF, "ZZ PRACTICE CO", 1000);
  ok("the range request escapes both bounds; without an upper bound the request is exactly as before chunking",
    xUp.includes("$AlterID &gt; 1000 AND $AlterID &lt;= 1399</SYSTEM>") && !/<=|>=/.test(xUp.match(/<SYSTEM[^>]*>([^<]*)<\/SYSTEM>/)?.[1] ?? "<=") && xOpen.includes("$AlterID &gt; 1000</SYSTEM>") && !xOpen.includes(" AND "));

  H("TALLY'S HIGHEST BELOW THE MARK (review H1)");
  s = fakeStore({ mark: 150, swap: { state: "refused", reason: "needs_full_run", mark: 150, candidate: 130 } }); t = fakeTally({}, { highest: 130, changed: [voucher("D", "20261104", 131)] });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "incremental" });
  ok("no voucher is read: nothing can be above Tally's own highest", t.calls.join(",") === "highest", t.calls.join(","));
  ok("the refusal goes to the database with Tally's highest, so it records that a full run is due", s.swapArgs?.mark === 130 && s.staged.length === 0 && rep.state === "refused" && rep.swap?.reason === "needs_full_run");
  ok("the run's steps say why", s.steps.some((x) => /below the mark 150: needs a full run/.test(x.step)) && s.steps.some((x) => x.step === "refused: needs_full_run" && x.state === "failed"));
  s = fakeStore({ mark: 150 }); t = fakeTally({}, { highest: 130 });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "incremental" });
  ok("if the database swapped anyway, the agent fails the run", rep.state === "failed" && /did not refuse/.test(rep.error ?? ""), rep.error ?? "");
  s = fakeStore({ mark: 150 }); t = fakeTally({ "2026-11-01": [voucher("A", "20261101", 101)] }, { highest: 130 });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-01" } });
  ok("a full run reads as usual and hands the lower AlterID to the swap (only a full run may lower the mark)", rep.state === "swapped" && s.swapArgs?.mark === 130 && t.calls.join(",") === "highest,day 2026-11-01,period,ledgers,period");

  H("FAILURES");
  s = fakeStore(); t = fakeTally(days, { failOn: "day 2026-11-02" });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-03" } });
  ok("a Tally error mid-run fails the run, and nothing is swapped", rep.state === "failed" && s.calls.includes("fail") && !s.calls.includes("swap"), rep.error ?? "");
  ok("it stops at the failed day (no read after it)", !t.calls.includes("day 2026-11-03"));
  ok("the failure is a step too", s.steps.some((x) => x.step === "failed" && x.state === "failed"));
  s = fakeStore(); t = fakeTally({}, { failOn: "highest" });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "incremental" });
  ok("if Tally's AlterID cannot be read, nothing is read or swapped", rep.state === "failed" && t.calls.length === 1 && !s.calls.includes("swap"));
  s = fakeStore({ swap: { state: "refused", reason: "day_below_floor", staged: 1, floor: 3 } }); t = fakeTally(days);
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-03" } });
  ok("a refused swap (A4, per day) is reported refused, with the reason as a failed step", rep.state === "refused" && s.steps.some((x) => x.step === "refused: day_below_floor" && x.state === "failed"));
  const src0 = readFileSync(join(dirname(process.argv[1]), "..", "src", "services", "erpMirrorSync.ts"), "utf8");
  ok("review H2: the agent never sends a floor (the database holds it at 0.8 or more)", !/p_floor_pct|floorPct/.test(src0));
  ok("review H1: the agent no longer reads above the lower of the mark and Tally's highest", !/Math\.min\(/.test(src0));

  H("TALLY REPLIES");
  const bad = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
  ok("a reply with no DATA is not 'no vouchers'", bad(() => assertParsedCollection({ ENVELOPE: { BODY: {} } }, "x")));
  ok("a DATA with no COLLECTION is not 'no vouchers'", bad(() => assertParsedCollection({ ENVELOPE: { BODY: { DATA: { LINEERROR: "x" } } } }, "x")));
  ok("an empty collection is an empty list", !bad(() => assertParsedCollection({ ENVELOPE: { BODY: { DATA: { COLLECTION: "" } } } }, "x")));
  const sent: string[] = [];
  const reads = tallyMirrorReads("http://localhost:9000", "ZZ PRACTICE CO", async (_u, xml) => { sent.push(xml); return { ENVELOPE: { BODY: { DATA: { COLLECTION: "" } } } }; });
  await reads.highest(); await reads.vouchersOn("2026-11-03"); await reads.changedSince(42);
  ok("every request has an <ID>, names the company, fetches no '*'", sent.length === 3 && sent.every((x) => /<ID>[^<]+<\/ID>/.test(x) && x.includes("<SVCURRENTCOMPANY>ZZ PRACTICE CO<") && !/<NATIVEMETHOD>[^<]*\*/.test(x)));
  ok("the AlterID read asks for AlterID, Date and Guid only (0119: Guid for the key compare), above 0, escaped", /\$AlterID &gt; 0</.test(sent[0]) && (sent[0].match(/<NATIVEMETHOD>/g) ?? []).length === 3 && sent[0].includes(">Guid<"));
  await reads.ledgers(); await reads.loadedPeriod().catch(() => null);
  ok("0119: the ledger read is one Ledger collection with an <ID>, the company, the named fields and no filter", sent.length === 5 && /<TYPE>Ledger<\/TYPE>/.test(sent[3]) && /<ID>[^<]+<\/ID>/.test(sent[3])
    && sent[3].includes("<SVCURRENTCOMPANY>ZZ PRACTICE CO<") && sent[3].includes(">ClosingBalance<") && !/<NATIVEMETHOD>[^<]*\*/.test(sent[3]) && !/<FILTER>/.test(sent[3]));
  ok("D-C.2: the ledger request carries no period (no SVFROMDATE, no SVTODATE): a dated ledger read hung the dummy Tally", !/SVFROMDATE|SVTODATE/.test(sent[3]) && sent[3] === buildCollectionXml(ERP_MIRROR_LEDGER_DEF, "ZZ PRACTICE CO"));
  ok("D-C.2: no request of the mirror carries a period", sent.length === 5 && sent.every((x) => !/SVFROMDATE|SVTODATE/.test(x)));
  ok("D-C.2: the period read is one Company collection with an <ID>, the company, StartingFrom and EndingAt, no '*'", /<TYPE>Company<\/TYPE>/.test(sent[4]) && /<ID>[^<]+<\/ID>/.test(sent[4])
    && sent[4].includes(">StartingFrom<") && sent[4].includes(">EndingAt<") && sent[4].includes(">LastVoucherDate<") && !/<NATIVEMETHOD>[^<]*\*/.test(sent[4]) && ERP_MIRROR_COMPANY_DEF.tallyCollection === "Company");
  const coll = (cs: any[]) => ({ ENVELOPE: { BODY: { DATA: { COLLECTION: { COMPANY: cs } } } } });
  ok("D-C.2: the loaded period is read for this company only", JSON.stringify(loadedPeriodFromParsed(coll([{ "@_NAME": "OTHER CO", STARTINGFROM: "20250401", ENDINGAT: "20260331" }, { "@_NAME": "ZZ CO", STARTINGFROM: "20260401", ENDINGAT: "20270331" }]), "ZZ CO")) === JSON.stringify({ from: "20260401", to: "20270331", lastVoucher: null }));
  ok("D-C.2: no company of that name, or two, refuses", bad(() => loadedPeriodFromParsed(coll([{ "@_NAME": "OTHER CO", ENDINGAT: "20270331" }]), "ZZ CO")) && bad(() => loadedPeriodFromParsed(coll([{ "@_NAME": "ZZ CO" }, { "@_NAME": "ZZ CO" }]), "ZZ CO")));
  ok("D-C.2: Tally's dates read as ISO; anything else is no date", tallyDateToIso("20270331") === "2027-03-31" && tallyDateToIso("2027-03-31") === "2027-03-31" && tallyDateToIso("20270231") === null && tallyDateToIso("") === null);
  ok("review 1-5 item 2: D-Mon-YYYY and DD-Mon-YYYY read, as Tally prints a date", tallyDateToIso("31-Mar-2027") === "2027-03-31" && tallyDateToIso("1-Apr-2026") === "2026-04-01"
    && tallyDateToIso("01-Apr-2026") === "2026-04-01" && tallyDateToIso(" 1-APR-2026 ") === "2026-04-01");
  ok("review 1-5 item 2: a two-digit year, a date off the calendar, a mixed or loose form is no date (fails closed)",
    ["1-Apr-26", "31-Apr-2026", "29-Feb-2027", "1-Sept-2026", "1 Apr 2026", "1/4/2026", "2026-0401", "202604011", "Apr-1-2026", "1-Apr-2026x"].every((x) => tallyDateToIso(x) === null));
  const jp = (from: string | null, to: string | null) => judgeLoadedPeriod({ from, to }, "2026-11-06", null);
  ok("D-C.2: the year to date is expected, and its end is the as-of date", JSON.stringify(jp("20260401", "20270331")) === JSON.stringify({ asOf: "2027-03-31", from: "2026-04-01", unexpected: false, why: null }) && !jp("20260401", "20261106").unexpected);
  ok("D-C.2: a period that starts on another day, ends before today or after the year is unexpected", jp("20260501", "20270331").unexpected && jp("20250401", "20260331").unexpected && jp("20260401", "20261031").unexpected && jp("20260401", "20270430").unexpected && /before today/.test(jp("20260401", "20261031").why ?? ""));
  ok("D-C.2: a loaded period with no readable end refuses the run (a balance with no date is never kept)", bad(() => jp("20260401", null)) && bad(() => jp("20260401", "31-Mar-27")) && bad(() => jp("20260401", "")));
  ok("review 1-5 item 2: a period Tally prints as 1-Apr-2026 to 31-Mar-2027 is the year to date", !jp("1-Apr-2026", "31-Mar-2027").unexpected && jp("1-Apr-2026", "31-Mar-2027").asOf === "2027-03-31");
  H("WHAT COUNTS AS AN EXPECTED LOADED PERIOD (D-1-5.43)");
  /* On the dummy, 6-Nov-2026: EndingAt was 5-Nov, the latest voucher's date,
     and moved to 6-Nov when a voucher dated 6-Nov went in. */
  const jl = (to: string, last: string | null | undefined, latest: string | null, today = "2026-11-06") => judgeLoadedPeriod({ from: "20260401", to, lastVoucher: last }, today, latest);
  ok("a period ending yesterday is expected when Tally's last voucher date and this run's latest voucher are both on or before it", !jl("20261105", "20261105", "2026-11-05").unexpected && jl("20261105", "20261105", "2026-11-05").asOf === "2026-11-05"
    && !jl("20261105", "5-Nov-2026", "2026-10-25").unexpected);
  ok("ending before today with no last voucher date, an empty one or one that does not read is unexpected (nothing shows the days after are empty)",
    [undefined, null, "", "5-Nov-26", "soon"].every((x) => jl("20261105", x as any, "2026-11-05").unexpected) && /gave no last voucher date/.test(jl("20261105", null, "2026-11-05").why ?? ""));
  ok("a last voucher date after the period's end is unexpected, ending before or after today", /last voucher date is 2026-11-06, after the loaded period ends 2026-11-05/.test(jl("20261105", "20261106", "2026-11-05").why ?? "")
    && jl("20261110", "20261120", "2026-11-05").unexpected);
  ok("a voucher of this run's AlterID read dated after the period's end is unexpected, even with a last voucher date that agrees with the period",
    /holds a voucher dated 2026-11-06, after the loaded period ends 2026-11-05/.test(jl("20261105", "20261105", "2026-11-06").why ?? "") && jl("20270331", null, "2027-03-31").unexpected === false && jl("20261106", null, "2026-11-07").unexpected);
  ok("ending today or later with no last voucher date stays expected as before (to and the run's latest voucher agree)", !jl("20261106", null, "2026-11-06").unexpected && !jl("20270331", undefined, null).unexpected);
  ok("the year's edges still win: a period from another 1 April, or past 31 March, is unexpected whatever the voucher dates", judgeLoadedPeriod({ from: "20250401", to: "20261105", lastVoucher: "20261105" }, "2026-11-06", "2026-11-05").unexpected
    && judgeLoadedPeriod({ from: "20260401", to: "20270401", lastVoucher: "20261105" }, "2026-11-06", "2026-11-05").unexpected);
  const yday = (() => { const d = new Date(`${indiaToday()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
  const ydayT = yday.replace(/-/g, "");
  s = fakeStore(); t = fakeTally({ "2026-11-01": [voucher("A", "20261101", 101)] }, { period: { from: FY_NOW.from, to: ydayT, lastVoucher: ydayT }, latestDate: yday });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-01" } });
  ok("the run: a period ending yesterday, with the last voucher yesterday, is not flagged, and the as-of date is yesterday",
    rep.state === "swapped" && rep.ledgerPeriod?.unexpected === false && rep.ledgersAsOf === yday && s.ledgers.every((l) => (l.row as any).balance_period_unexpected === false), JSON.stringify(rep.ledgerPeriod));
  s = fakeStore(); t = fakeTally({ "2026-11-01": [voucher("A", "20261101", 101)] }, { period: { from: FY_NOW.from, to: ydayT, lastVoucher: ydayT }, latestDate: indiaToday() });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-01" } });
  ok("the run: the same period with a voucher dated today in the AlterID read is flagged on every row", rep.ledgerPeriod?.unexpected === true && /after the loaded period ends/.test(rep.ledgerPeriod?.why ?? "") && s.ledgers.every((l) => (l.row as any).balance_period_unexpected === true));
  s = fakeStore(); t = fakeTally({ "2026-11-01": [voucher("A", "20261101", 101)] }, { period: [{ from: FY_NOW.from, to: ydayT, lastVoucher: ydayT }, { from: FY_NOW.from, to: indiaToday().replace(/-/g, ""), lastVoucher: indiaToday().replace(/-/g, "") }], latestDate: yday });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-01" } });
  ok("the run: the period is read again after the ledgers, and a period that moved meanwhile is flagged", t.calls.filter((c) => c === "period").length === 2 && t.calls.indexOf("ledgers") < t.calls.lastIndexOf("period")
    && rep.ledgerPeriod?.unexpected === true && /moved during the ledger read/.test(rep.ledgerPeriod?.why ?? ""), `${t.calls.join(",")} ${JSON.stringify(rep.ledgerPeriod)}`);

  H("THE LOADED PERIOD AT THE YEAR'S EDGES (review 1-5 item 6)");
  const at = (from: string, to: string, today: string) => judgeLoadedPeriod({ from, to }, today, null);
  ok("31-Mar-2026: last year's period (2025-26) is the year to date", !at("20250401", "20260331", "2026-03-31").unexpected);
  ok("31-Mar-2026: this coming year's period (2026-27) is unexpected (it starts after today's year)", at("20260401", "20270331", "2026-03-31").unexpected && /starts 2026-04-01, not 2025-04-01/.test(at("20260401", "20270331", "2026-03-31").why ?? ""));
  ok("1-Apr-2026: last year's period is now unexpected; the new year's is expected", at("20250401", "20260331", "2026-04-01").unexpected && !at("20260401", "20270331", "2026-04-01").unexpected);
  ok("31-Mar-2027: the 2026-27 period is expected, and one ending the day before is not", !at("20260401", "20270331", "2027-03-31").unexpected && /before today/.test(at("20260401", "20270330", "2027-03-31").why ?? ""));
  ok("1-Apr-2027: the 2026-27 period is unexpected; 2027-28 is expected", at("20260401", "20270331", "2027-04-01").unexpected && !at("20270401", "20280331", "2027-04-01").unexpected);
  ok("a period running past the year's 31 March is unexpected", /after the financial year ends 2027-03-31/.test(at("20260401", "20270401", "2026-11-06").why ?? ""));
  const justBefore = indiaToday(new Date("2026-03-31T18:29:59Z")), justAfter = indiaToday(new Date("2026-03-31T18:30:00Z"));
  ok("India midnight: 23:59:59 IST on 31-Mar-2026 is still 31 March, one second later is 1 April", justBefore === "2026-03-31" && justAfter === "2026-04-01", `${justBefore} ${justAfter}`);
  ok("India midnight: the same period flips from expected to unexpected across it (UTC is still 31 March)", !at("20250401", "20260331", justBefore).unexpected && at("20250401", "20260331", justAfter).unexpected);
  s = fakeStore(); t = fakeTally({ "2026-11-01": [voucher("A", "20261101", 101)] }, { period: { from: "20250401", to: "20260331" } });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-01" }, today: justAfter });
  ok("the run uses the today it is given: at 00:00 IST on 1 April last year's period is flagged on every row", rep.ledgerPeriod?.unexpected === true && s.ledgers.every((l) => (l.row as any).balance_period_unexpected === true));

  H("THE COMPANY READ THROUGH THE REAL PATH (review 1-5 item 6)");
  /* tallyMirrorReads with its default post, the real tallyPost: the request
     is built, the GUID guard runs, and the reply is parsed by the real XML
     parser. Only the socket is replaced (tallyMock); nothing reaches Tally. */
  const CO = (process.env.MKCP_PRACTICE_COMPANY ?? "").trim() || "ZZ PRACTICE CO";
  const GUID = (process.env.MKCP_PRACTICE_COMPANY_GUID ?? "").trim() || "zz-test-guid-0001";
  const companyReply = (from: string, to: string) => `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DESC></DESC><DATA><COLLECTION>`
    + `<COMPANY NAME="ZZ OTHER CO" RESERVEDNAME=""><STARTINGFROM TYPE="Date">20250401</STARTINGFROM><ENDINGAT TYPE="Date">20260331</ENDINGAT><GUID TYPE="String">zz-other</GUID></COMPANY>`
    + `<COMPANY NAME="${CO.replace(/&/g, "&amp;")}" RESERVEDNAME=""><STARTINGFROM TYPE="Date">${from}</STARTINGFROM><ENDINGAT TYPE="Date">${to}</ENDINGAT><LASTVOUCHERDATE TYPE="Date">20261105</LASTVOUCHERDATE><GUID TYPE="String">${GUID}</GUID></COMPANY>`
    + `</COLLECTION></DATA></BODY></ENVELOPE>`;
  const listing = `<ENVELOPE><BODY><DATA><COLLECTION><COMPANY NAME="${CO.replace(/&/g, "&amp;")}"><NAME>${CO.replace(/&/g, "&amp;")}</NAME><GUID>${GUID}</GUID></COMPANY></COLLECTION></DATA></BODY></ENVELOPE>`;
  let periodReply = companyReply("20260401", "20270331");
  const mockSent: { xml: string; ms: number }[] = [];
  const guidBefore = process.env.MKCP_PRACTICE_COMPANY_GUID;
  if (!guidBefore?.trim()) process.env.MKCP_PRACTICE_COMPANY_GUID = GUID;   // the sandbox's GUID guard needs one to compare with
  installMock(async (_u, xml, ms) => { mockSent.push({ xml, ms }); return /List of Companies/i.test(xml) ? listing : periodReply; });
  try {
    const real = tallyMirrorReads("http://127.0.0.1:9", CO);
    const lp1 = await real.loadedPeriod();
    const j1 = judgeLoadedPeriod(lp1, "2026-11-06", null);
    const companyReq = mockSent.find((x) => /<TYPE>Company<\/TYPE>/.test(x.xml));
    ok("the Company read, parsed by the real parser: this company's period only, typed values read as text", lp1.from === "20260401" && lp1.to === "20270331" && lp1.lastVoucher === "20261105" && !j1.unexpected && j1.asOf === "2027-03-31", JSON.stringify(lp1));
    ok("the request that went out is the Company collection, with its own short timeout", !!companyReq && companyReq.ms === ERP_MIRROR_COMPANY_DEF.timeout && !/SVFROMDATE|SVTODATE/.test(companyReq.xml));
    periodReply = companyReply("1-Apr-2026", "31-Mar-2027");
    const j2 = judgeLoadedPeriod(await real.loadedPeriod(), "2026-11-06", null);
    ok("the same read with dates printed as D-Mon-YYYY", !j2.unexpected && j2.asOf === "2027-03-31");
    periodReply = companyReply("20260401", "");
    let emptyEnd = ""; try { judgeLoadedPeriod(await real.loadedPeriod(), "2026-11-06", null); } catch (e) { emptyEnd = (e as Error).message; }
    ok("an empty EndingAt in the parsed reply refuses (G7: not asked and not held look alike)", /no end date/.test(emptyEnd), emptyEnd);
    periodReply = `<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>`;
    ok("a reply with no company of this name refuses", await real.loadedPeriod().then(() => false, (e) => /found 0 companies/.test((e as Error).message)));
    ok("nothing in this section reached a socket: every request went to the mock", mockSent.length >= 4);
  } finally {
    uninstallMock();
    if (guidBefore === undefined) delete process.env.MKCP_PRACTICE_COMPANY_GUID; else process.env.MKCP_PRACTICE_COMPANY_GUID = guidBefore;
  }

  H("TALLY REPLIES (continued)");
  ok("0120 M2: the period runs from the financial year's 1 April", ledgerPeriod("2026-11-06").from === "2026-04-01" && ledgerPeriod("2027-02-10").from === "2026-04-01" && ledgerPeriod("2026-04-01").from === "2026-04-01");
  ok("0120 M2: today is India's date, never the UTC date", indiaToday(new Date("2026-11-06T20:00:00Z")) === "2026-11-07" && indiaToday(new Date("2026-11-06T10:00:00Z")) === "2026-11-06");
  ok("a day read is filtered to that one day inside Tally", sent[1].includes("&gt;= 20261103") && sent[1].includes("&lt;= 20261103"));
  ok("the incremental read is filtered above the mark inside Tally", /\$AlterID &gt; 42</.test(sent[2]));
  ok("the voucher reads ask for the whole tally_vouchers field list (go-live swap, D-1-5.58): ledger lines, inventory lines, the e-way bill block, IRN, buyer and GST fields, each by name", ["AllLedgerEntries", "AllInventoryEntries", "EWayBillDetails", "IRN", "IRNQRCode", "PartyMailingName", "PartyGSTIN", "PlaceOfSupply", "ConsigneePinCode", "EnteredBy"].every((f) => sent[1].includes(`>${f}<`)));
  ok("...and none of them is a wildcard, which would crash Tally", !/\*/.test((ERP_MIRROR_VOUCHER_DEF.fetch ?? []).join("")));
  ok("...the mirror's list holds every field today's own voucher read asks for, so the two cannot drift", (() => { const mine = new Set(ERP_MIRROR_VOUCHER_DEF.fetch); const todays = TRANSACTION_COLLECTIONS.find((c) => c.name === "vouchers")?.fetch; /* review item 16: an empty find proves nothing */ return Array.isArray(todays) && todays.length > 20 && mine.size > 20 && todays.every((f) => mine.has(f)); })());
  ok("...and that comparison is not vacuous: today's voucher list is found and long, and a field missing from the mirror's list would be seen", (() => { const todays = TRANSACTION_COLLECTIONS.find((c) => c.name === "vouchers")?.fetch ?? []; const mine = new Set(ERP_MIRROR_VOUCHER_DEF.fetch); mine.delete(todays[0]); return todays.length > 20 && !todays.every((f) => mine.has(f)); })());
  const errReads = tallyMirrorReads("http://localhost:9000", "ZZ PRACTICE CO", async () => ({ ENVELOPE: { HEADER: { STATUS: 0 }, BODY: {} } }));
  let threw = false; try { await errReads.vouchersOn("2026-11-03"); } catch { threw = true; }
  ok("an error envelope from Tally throws, it is never an empty day", threw);

  H("LEDGERS AND CLOSING BALANCES (0119, M-6)");
  ok("a balance keeps Tally's sign and paise", parseBalance("-1234.50") === -1234.5 && parseBalance("5000.00") === 5000 && parseBalance("1,20,000.25") === 120000.25);
  ok("an empty balance is null from the parser (Tally sent none)", parseBalance("") === null && parseBalance(undefined) === null);
  ok("0120 M6: the parser is parseTallyAmount in strict mode: Dr and Cr keep their meaning", parseBalance("12,000 Dr") === -12000 && parseBalance("1,200.00 Cr") === 1200 && parseBalance("(-)5,000.00") === -5000);
  ok("0120 M6: strict mode throws on text after the number or no number at all, never a number it is not", ["abc", "1.2.3", "995.24/PC", "31320.00 UT = 87 PKG", "12 PCS"].every((x) => { try { parseBalance(x); return false; } catch { return true; } }));
  ok("0120 M6: the same reader without strict is unchanged for every other caller", parseTallyAmount("995.24/PC") === 995.24 && parseTallyAmount("31320.00 UT = 87 PKG") === 31320 && parseTallyAmount("abc") === null);
  ok("a ledger with no GUID, no name or a bad balance is a problem", ledgerProblem(ledger("", "X")) === "no GUID" && ledgerProblem(ledger("G", "")) === "no name"
    && ledgerProblem(ledger("G", "X", "12 PCS")) === "a balance that does not parse" && ledgerProblem(ledger("G", "X")) === null);
  const FY_OK = { from: "2026-04-01", unexpected: false, why: null };
  const lr = ledgerRowFrom(ledger("L-1", "REAL LOOKING TRADERS"), { scrub: true, salt: SALT }, "2026-11-06", FY_OK);
  ok("review 1-5 item 4: a ledger row without the judged period is refused, never 'expected' by default",
    bad(() => (ledgerRowFrom as any)(ledger("L-1", "X"), { scrub: false }, "2026-11-06")) && bad(() => (ledgerRowFrom as any)(ledger("L-1", "X"), { scrub: false }, "2026-11-06", {})));
  ok("review 1-5 item 4: an unexpected period is carried onto the row", (ledgerRowFrom(ledger("L-1", "X"), { scrub: false }, "2026-03-31", { from: "2025-04-01", unexpected: true, why: "w" }).row as any).balance_period_unexpected === true);
  ok("a test row's ledger and group names are keyed stand-ins; the balance stays", /^ZZ TEST LEDGER [0-9a-f]{10}$/.test(lr.name) && /^ZZ TEST GROUP [0-9a-f]{10}$/.test(lr.parent ?? "")
    && lr.closing_balance === -1234.5 && lr.opening_balance === 100 && !/REAL LOOKING|Sundry/.test(JSON.stringify(lr)));
  const lz = ledgerRowFrom(ledger("L-3", "Z", "", { openingbalance: "" }), { scrub: false }, "2026-11-06", FY_OK);
  ok("0120 M1: a balance Tally left empty is stored as 0, and the row says it was empty", lz.closing_balance === 0 && lz.opening_balance === 0 && lz.row.closing_balance_sent === false && lz.row.opening_balance_sent === false);
  ok("0120 M2: every ledger row carries the date its balance was asked for", lr.balance_as_of === "2026-11-06" && lz.balance_as_of === "2026-11-06");
  const lp = ledgersFromParsed({ ENVELOPE: { BODY: { DATA: { COLLECTION: { LEDGER: [
    { "@_NAME": "ZZ TEST A", GUID: "g-a", PARENT: "Cash-in-Hand", CLOSINGBALANCE: { "#text": "-10.00", "@_TYPE": "Amount" }, ALTERID: "5", MASTERID: "9" },
  ] } } } } });
  ok("the reply's ledgers are read by name attribute, with the balance's text", lp.length === 1 && lp[0].name === "ZZ TEST A" && lp[0].guid === "g-a" && lp[0].closingbalance === "-10.00" && lp[0].alterid === "5");
  const lq = ledgersFromParsed({ ENVELOPE: { BODY: { DATA: { COLLECTION: { LEDGER: { "@_NAME": "ZZ TEST B", GUID: "g-b", PARENT: { "#text": "\u0004 Primary", "@_TYPE": "String" }, CLOSINGBALANCE: "" } } } } } });
  ok("0120 M6: read with the converter's own field reader: one ledger alone, a typed parent, Tally's control prefix stripped", lq.length === 1 && lq[0].parent === "Primary" && lq[0].closingbalance === "", JSON.stringify(lq));
  ok("the ledger read names its fields (G7), with no *", ERP_MIRROR_LEDGER_DEF.fetch!.includes("ClosingBalance") && ERP_MIRROR_LEDGER_DEF.fetch!.includes("Guid") && !ERP_MIRROR_LEDGER_DEF.fetch!.some((f) => f.includes("*")));
  ok("the AlterID read also fetches the GUID, for the nightly key compare", ERP_MIRROR_MARK_DEF.fetch!.includes("Guid"));
  for (const [what, list, re] of [
    ["an empty ledger list", [], /came back empty/],
    ["a ledger with no GUID", [...LEDGERS, ledger("", "NO KEY")], /1 with no GUID/],
    ["a ledger balance that does not parse", [ledger("L-9", "X", "1,000 UT")], /does not parse/],
  ] as [string, TallyLedger[], RegExp][]) {
    s = fakeStore(); t = fakeTally({ "2026-11-01": [voucher("A", "20261101", 101)] }, { ledgers: list });
    rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-01" } });
    ok(`${what}: the run fails and nothing is swapped`, rep.state === "failed" && re.test(rep.error ?? "") && !s.calls.includes("swap") && s.ledgers.length === 0, rep.error ?? "");
  }
  s = fakeStore(); t = fakeTally({ "2026-11-01": [voucher("A", "20261101", 101)] }, { ledgers: Array.from({ length: 1100 }, (_, i) => ledger(`L${i}`, `ZZ TEST L ${i}`)) });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-01" } });
  ok("1,100 ledgers are staged in calls of at most 500", s.calls.filter((c) => c.startsWith("ledgers")).join(",") === "ledgers 500,ledgers 500,ledgers 100" && rep.ledgers === 1100);
  s = fakeStore(); t = fakeTally({ "2026-11-01": [voucher("A", "20261101", 101)] });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-01" }, ledgers: false });
  ok("a run told not to read ledgers reads none", !t.calls.includes("ledgers") && rep.ledgers === null && rep.state === "swapped");
  s = fakeStore(); t = fakeTally({ "2026-11-01": [voucher("A", "20261101", 101)] });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-01" } });
  ok("D-C.2: the ledgers are read with no period, the loaded period first, and every staged row carries its end as balance_as_of, not flagged",
    t.asOf.join(",") === "0" && t.calls.indexOf("period") >= 0 && t.calls.indexOf("period") < t.calls.indexOf("ledgers") && rep.ledgersAsOf === FY_END
    && s.ledgers.every((l) => l.balance_as_of === FY_END && (l.row as any).balance_period_unexpected === false) && rep.ledgerPeriod?.unexpected === false);
  s = fakeStore(); t = fakeTally({ "2026-11-01": [voucher("A", "20261101", 101)] }, { period: { from: "20250401", to: "20260331" } });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-01" }, today: "2026-11-06" });
  const flagStep = s.steps.find((x: any) => /ledgers/.test(x.step)) as any;
  ok("D-C.2: last year's period still swaps, but every row and the run step say balance_period_unexpected, with the loaded period",
    rep.state === "swapped" && rep.ledgersAsOf === "2026-03-31" && rep.ledgerPeriod?.unexpected === true
    && s.ledgers.every((l) => l.balance_as_of === "2026-03-31" && (l.row as any).balance_period_unexpected === true && (l.row as any).loaded_from === "2025-04-01")
    && /balance_period_unexpected/.test(flagStep?.step ?? "") && flagStep?.detail?.balance_period_unexpected === true, JSON.stringify(flagStep ?? null));
  s = fakeStore(); t = fakeTally({ "2026-11-01": [voucher("A", "20261101", 101)] }, { period: { from: "20260401", to: null } });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-01" } });
  ok("D-C.2: a loaded period with no end fails the run before the ledgers are asked for", rep.state === "failed" && !t.calls.includes("ledgers") && !s.calls.includes("swap") && /no end date/.test(rep.error ?? ""));
  s = fakeStore(); t = fakeTally({ "2026-11-01": [voucher("A", "20261101", 101)] });
  await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-01" } });
  const readStep = s.steps.find((x) => x.step === "read 2026-11-01");
  ok("0120 H1: the day's read step carries the count, and is written only after the read's checks (the database trusts a small day's count by it)",
    readStep?.state === "ok" && readStep.rows === 1 && s.calls.indexOf("step read 2026-11-01") < s.calls.indexOf("swap"));
  s = fakeStore(); t = fakeTally({ "2026-11-01": [voucher("A", "20261101", 101), voucher("", "20261101", 102)] });
  await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-01" } });
  ok("0120 H1: a day's read that fails its checks writes no read step, so the database would never take its count", !s.steps.some((x) => x.step === "read 2026-11-01") && !s.calls.includes("swap"));
  ok("0120 M4: the planner's weekly clock comes from the database's last full run that was not a re-pull", (await s.store.lastFullRun())?.run_id === "R0");

  H("THE ONE-DAY RE-PULL (0119, A11)");
  s = fakeStore({ repull: "2026-11-03" }); t = fakeTally({ "2026-11-03": [voucher("B", "20261103", 120)] }, { highest: 130 });
  const rp = await runRepull({ store: s.store, tally: t.tally });
  ok("a re-pull reads its one day and never the ledgers", t.calls.join(",") === "highest,day 2026-11-03" && rp?.state === "swapped" && rp.ledgers === null && s.ledgers.length === 0, t.calls.join(","));
  ok("a re-pull is started by the database's queue, not by the caller's scope", s.calls[0] === "repull start" && rp?.scope?.from === "2026-11-03");
  s = fakeStore({ repull: "2026-11-03" }); t = fakeTally({ "2026-11-03": [voucher("B", "20261102", 120)] });
  const rp2 = await runRepull({ store: s.store, tally: t.tally });
  ok("a re-pull holding another day's voucher fails, as any full read", rp2?.state === "failed" && /not 2026-11-03/.test(rp2.error ?? ""), rp2?.error ?? "");
  s = fakeStore({ repull: null }); t = fakeTally({});
  ok("nothing queued: nothing is read", (await runRepull({ store: s.store, tally: t.tally })) === null && t.calls.length === 0);

  H("THE NIGHTLY CHECK (0119, A11)");
  const vs: DayCheckVoucher[] = [{ k: "A", d: "2026-11-01", a: 90 }, { k: "B", d: "2026-11-03", a: 120 }];
  s = fakeStore({ check: { state: "gaps", days_differing: 1, repulls_queued: 1 } }); t = fakeTally({}, { highest: 130, vouchers: vs });
  let dc = await runDayCheck({ store: s.store, tally: t.tally });
  ok("one cheap read, then the database compares every key with Tally's highest", t.calls.join(",") === "highest" && s.checked?.highest === 130 && s.checked?.vouchers.length === 2 && dc.state === "gaps");
  s = fakeStore(); t = fakeTally({}, { failOn: "highest" });
  dc = await runDayCheck({ store: s.store, tally: t.tally });
  ok("a Tally error is a failed check, never ok, and nothing is compared", dc.state === "failed" && !s.calls.includes("check") && /error window/.test(dc.error ?? ""));
  s = fakeStore({ check: { nonsense: true } }); t = fakeTally({}, { vouchers: vs });
  dc = await runDayCheck({ store: s.store, tally: t.tally });
  ok("an answer from the database that is not ok, gaps or refused is a failed check", dc.state === "failed");
  const conv = await tallyMirrorReads("http://x", "ZZ CO", async () => ({ ENVELOPE: { BODY: { DATA: { COLLECTION: { VOUCHER: [
    { GUID: "g1", DATE: "20261101", ALTERID: "11" }, { GUID: "", DATE: "1-Nov", ALTERID: "" },
  ] } } } } })).highest();
  ok("the AlterID read keeps every voucher, even an unreadable one, for the database to refuse", conv.vouchers?.length === 2 && conv.vouchers[0].k === "g1" && conv.vouchers[0].d === "2026-11-01" && conv.vouchers[0].a === 11
    && conv.vouchers[1].k === "" && conv.vouchers[1].d === null && conv.vouchers[1].a === null, JSON.stringify(conv.vouchers));

  ok("the real AlterID read counts the vouchers whose date it could not read (and leaves them out of the latest date)", conv.undated === 1 && conv.latestDate === "2026-11-01", JSON.stringify({ u: conv.undated, l: conv.latestDate }));

  H("WHAT RUNS NEXT (0119, A7 weekly full, A11 nightly)");
  const now = new Date("2026-11-06T20:00:00Z"), ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
  ok("no mark: a full run, then the check", planMirrorWork({ now, hasMark: false, fullDue: false, lastFullAt: null, lastCheckAt: null, queuedRepulls: 0 }).join(",") === "full,check");
  ok("a full run due: full", planMirrorWork({ now, hasMark: true, fullDue: true, lastFullAt: ago(2), lastCheckAt: ago(1), queuedRepulls: 0 }).join(",") === "full");
  ok("the last full run 7 days ago: the weekly full (A7)", planMirrorWork({ now, hasMark: true, fullDue: false, lastFullAt: ago(7 * 24), lastCheckAt: ago(1), queuedRepulls: 0 }).join(",") === "full");
  ok("otherwise an incremental; the check after 20 hours; queued re-pulls last", planMirrorWork({ now, hasMark: true, fullDue: false, lastFullAt: ago(30), lastCheckAt: ago(21), queuedRepulls: 2 }).join(",") === "incremental,check,repull"
    && planMirrorWork({ now, hasMark: true, fullDue: false, lastFullAt: ago(30), lastCheckAt: ago(3), queuedRepulls: 0 }).join(",") === "incremental");

  ok("an Owner's accepted drop goes first, before any run that would swap", planMirrorWork({ now, hasMark: true, fullDue: false, lastFullAt: ago(30), lastCheckAt: ago(21), queuedRepulls: 1, acceptedDrops: 1 }).join(",") === "apply_accepted,incremental,check,repull"
    && planMirrorWork({ now, hasMark: false, fullDue: false, lastFullAt: null, lastCheckAt: ago(1), queuedRepulls: 0, acceptedDrops: 2 }).join(",") === "apply_accepted,full"
    && planMirrorWork({ now, hasMark: true, fullDue: false, lastFullAt: ago(30), lastCheckAt: ago(3), queuedRepulls: 0, acceptedDrops: 0 }).join(",") === "incremental");

  H("AN OWNER'S ACCEPTED DROP (task 1-5, 0121)");
  {
    const acc = (n: number): AcceptedRun => ({ acceptance: `A${n}`, run_id: `RUN${n}` });
    const f1 = fakeStore({ accepted: [acc(1), acc(2)] });
    const r1 = await applyAcceptedDrops({ store: f1.store, log: () => {} });
    ok("each accepted run is swapped by its own id, in the database's order, and nothing else is called", f1.calls.join("|") === "accepted list|swap accepted RUN1|swap accepted RUN2" && r1.length === 2 && r1.every((x) => x.state === "swapped"), f1.calls.join("|"));
    ok("the agent passes no floor and reads no Tally: its swap call is only the run id", f1.swapArgs === null && !f1.calls.some((c) => c === "swap" || c.startsWith("start") || c.startsWith("stage")));
    const f2 = fakeStore({ accepted: [] });
    ok("nothing accepted: nothing is swapped", (await applyAcceptedDrops({ store: f2.store, log: () => {} })).length === 0 && f2.calls.join("|") === "accepted list");
    const f3 = fakeStore({ accepted: [acc(1), acc(2), acc(3)], acceptedSwap: (run) => run === "RUN1" ? { state: "refused", reason: "acceptance_void", why: "it expired" } : run === "RUN2" ? new Error("erp_sync_swap: network down") : { state: "swapped" } });
    const logs: string[] = [];
    const r3 = await applyAcceptedDrops({ store: f3.store, log: (l) => logs.push(l) });
    ok("a refused or failed one is reported with its reason and the next is still tried", r3.map((x) => x.state).join(",") === "refused,failed,swapped" && r3[0].reason === "acceptance_void" && /network down/.test(r3[1].error ?? "") && f3.calls.length === 4, JSON.stringify(r3.map((x) => x.state)));
    ok("the log says what happened to each run", logs.length === 3 && /RUN1.*refused.*it expired/.test(logs[0]) && /RUN2.*failed/.test(logs[1]) && /RUN3.*swapped/.test(logs[2]), logs.join(" / "));
    const f4 = fakeStore({ accepted: { error: "x" } });
    let threw = "";
    try { await applyAcceptedDrops({ store: f4.store, log: () => {} }); } catch (e) { threw = (e as Error).message; }
    ok("an answer that is not a list is a fault, never 'nothing accepted'", /not a list/.test(threw) && !f4.calls.some((c) => c.startsWith("swap")), threw);
  }

  H("THE COPY INTO THE SWAP STORE IS WRITTEN AS WHAT IT WAS (review of thread 8, item 14)");
  {
    const whole = { mirror_vouchers: 4, with_block: 4, without_block: 0, deletes_skipped: false, day_floor_days: 0, day_floor_list: [] };
    ok("a whole copy is ok", deriveStepState(whole).state === "ok");
    ok("a mirror voucher without its block is info", deriveStepState({ ...whole, with_block: 3, without_block: 1, deletes_skipped: true }).state === "info");
    ok("skipped deletes alone are info", deriveStepState({ ...whole, deletes_skipped: true }).state === "info");
    ok("a day held back by the per-day floor is failed", deriveStepState({ ...whole, deletes_skipped: true, day_floor_days: 2 }).state === "failed");
    ok("no answer at all is failed", deriveStepState(null).state === "failed");
    const run = async (derive: () => Record<string, any> | Error) => {
      const f = fakeStore({ derive });
      const rep = await runMirrorSync({ store: f.store, tally: fakeTally({ "2026-11-01": [voucher("G-D1", "20261101", 40)] }, { highest: 40, counted: { "2026-11-01": 1 }, vouchers: [{ k: "G-D1", d: "2026-11-01", a: 40 }] }).tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-01" }, ledgers: false, log: () => {} });
      return { f, rep };
    };
    const a = await run(() => whole);
    ok("a whole copy writes an ok step and no tallyError", a.f.steps.some((x) => /^copied the tally-shaped rows/.test(x.step) && x.state === "ok") && !a.rep.tallyError);
    const b = await run(() => ({ ...whole, with_block: 3, without_block: 1, deletes_skipped: true }));
    ok("a copy with an unblocked voucher writes an info step that names it", b.f.steps.some((x) => x.state === "info" && /no tally-shaped block/.test(x.step)) && b.rep.state === "swapped");
    const c = await run(() => ({ ...whole, deletes_skipped: true, day_floor_days: 1 }));
    ok("a held-back day writes a failed step and sets tallyError, and the run still finishes swapped", c.f.steps.some((x) => x.state === "failed" && /per-day floor/.test(x.step)) && !!c.rep.tallyError && c.rep.state === "swapped");
    const d = await run(() => new Error("derive boom"));
    ok("a thrown copy writes a failed step", d.f.steps.some((x) => x.state === "failed" && /could not copy/.test(x.step)) && /boom/.test(d.rep.tallyError ?? ""));
    // an accepted drop: the copy leaves a step on the run and a failure is reported on the entry
    const e1 = fakeStore({ accepted: [{ acceptance: "A1", run_id: "RUN1" }], derive: () => whole });
    const r1 = await applyAcceptedDrops({ store: e1.store, log: () => {} });
    ok("an accepted drop that swapped writes the copy step on its own run", e1.steps.some((x) => /^copied the tally-shaped rows/.test(x.step) && x.state === "ok") && e1.calls.join("|") === "accepted list|swap accepted RUN1|derive|step copied the tally-shaped rows for the go-live swap" && r1[0].tally?.with_block === 4, e1.calls.join("|"));
    const e2 = fakeStore({ accepted: [{ acceptance: "A1", run_id: "RUN1" }], derive: () => new Error("derive down") });
    const r2 = await applyAcceptedDrops({ store: e2.store, log: () => {} });
    ok("an accepted drop whose copy fails records a failed step and the error, and is still reported as swapped", e2.steps.some((x) => x.state === "failed") && /derive down/.test(r2[0].tallyError ?? "") && r2[0].state === "swapped");
    const e3 = fakeStore({ accepted: [{ acceptance: "A1", run_id: "RUN1" }], acceptedSwap: () => ({ state: "refused", reason: "x" }), derive: () => whole });
    await applyAcceptedDrops({ store: e3.store, log: () => {} });
    ok("a refused accepted drop is not copied", !e3.calls.includes("derive"));
  }

  H("STAGING IS CAPPED BY BYTES AS WELL AS ROWS (review of thread 8, item 15)");
  {
    const big = (n: number, kb: number) => Array.from({ length: n }, (_, i) => ({ key: "K" + i, pad: "x".repeat(kb * 1024) }));
    const rows = big(10, 400);   // 10 rows of ~400 KB: the old 500-row batch would have sent 4 MB in one request
    const parts = stageChunks(rows, 500, 1_500_000);
    ok("ten 400 KB rows are split into requests of at most 1.5 MB", parts.length > 1 && parts.every((p) => Buffer.byteLength(JSON.stringify(p)) <= 1_500_000 + 20), parts.map((p) => p.length).join(","));
    ok("no row is dropped and the order is kept", parts.flat().map((r) => r.key).join(",") === rows.map((r) => r.key).join(","));
    ok("a row bigger than the cap goes alone and is not dropped", stageChunks(big(3, 2000), 500, 1_500_000).map((p) => p.length).join(",") === "1,1,1");
    ok("small rows still go 500 at a time", stageChunks(Array.from({ length: 1200 }, (_, i) => ({ i })), 500, 1_500_000).map((p) => p.length).join(",") === "500,500,200");
    ok("nothing in, nothing out", stageChunks([]).length === 0);
    const f = fakeStore();
    const days: Record<string, any[]> = { "2026-11-01": Array.from({ length: 6 }, (_, i) => voucher("G-B" + i, "20261101", 10 + i)) };
    const rep = await runMirrorSync({ store: f.store, tally: fakeTally(days, { highest: 20, counted: { "2026-11-01": 6 }, vouchers: Array.from({ length: 6 }, (_, i) => ({ k: "G-B" + i, d: "2026-11-01", a: 10 + i })) }).tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-01" }, ledgers: false, log: () => {} });
    ok("a run reports the rows and bytes of its largest staging request (the figure the dummy first-run measurement records)", rep.state === "swapped" && rep.largestBatchRows === 6 && (rep.largestBatchBytes ?? 0) > 1000, "rows " + rep.largestBatchRows + " bytes " + rep.largestBatchBytes);
  }

  H("PART 7: THE FULL FETCH LIST (phone, mobile, PAN, registration type, bill-wise, who entered it, instruments)");
  {
    const SIX = { scrub: false as const };
    const SCR = { scrub: true as const, salt: SALT };
    const named = (d: { fetch?: string[] }, ...want: string[]) => want.every((w) => (d.fetch ?? []).includes(w)) && !(d.fetch ?? []).some((f) => /[*.]/.test(f) || f.trim() === "");
    ok("the ledger read names phone, mobile, PAN, registration type and bill-wise, one by one", named(ERP_MIRROR_LEDGER_DEF, "LedgerPhone", "LedgerMobile", "IncomeTaxNumber", "GSTRegistrationType", "IsBillWiseOn", "Guid"));
    ok("the voucher read names who entered it", named(ERP_MIRROR_VOUCHER_DEF, "EnteredBy", "AllLedgerEntries", "Guid"));
    ok("voucher types (with parent), units (with decimals) and item keys are read with named fields too", named(ERP_MIRROR_VOUCHERTYPE_DEF, "Guid", "Name", "Parent")
      && named(ERP_MIRROR_UNIT_DEF, "Guid", "Name", "DecimalPlaces") && named(ERP_MIRROR_ITEM_DEF, "Guid", "Name"));
    for (const d of [ERP_MIRROR_LEDGER_DEF, ERP_MIRROR_VOUCHERTYPE_DEF, ERP_MIRROR_UNIT_DEF, ERP_MIRROR_ITEM_DEF]) {
      const x = buildCollectionXml(d, "ZZ TEST CO");
      ok(`${d.name}: the request has an <ID>, names the company, fetches no wildcard and sets no period`,
        /<ID>[^<]+<\/ID>/.test(x) && x.includes("ZZ TEST CO") && !/\.\*|<FETCH>\s*\*|SVFROMDATE|SVTODATE/.test(x), d.name);
    }
    const parsedLedgers = (l: Record<string, unknown>) => ({ ENVELOPE: { BODY: { DATA: { COLLECTION: { LEDGER: [l] } } } } });
    const L = { GUID: "L-1", NAME: "PARTY 042 CYCLE STORES", PARENT: "Sundry Debtors", CLOSINGBALANCE: "-10.00", OPENINGBALANCE: "0", ALTERID: "5", MASTERID: "50",
      LEDGERPHONE: "033-5550101", LEDGERMOBILE: "9000000001", INCOMETAXNUMBER: "AAAAA0000A", GSTREGISTRATIONTYPE: "Regular", ISBILLWISEON: "Yes" };
    const [a] = ledgersFromParsed(parsedLedgers(L));
    ok("the ledger reader takes all five fields and says the fields were served (the bill-wise tag is there)", a.phone === "033-5550101" && a.mobile === "9000000001" && a.pan === "AAAAA0000A"
      && a.gstregistrationtype === "Regular" && a.isbillwiseon === "Yes" && a.sent === true, JSON.stringify({ ...a, phone: "..", mobile: "..", pan: ".." }));
    const [b] = ledgersFromParsed(parsedLedgers({ ...L, LEDGERPHONE: "", LEDGERMOBILE: "", INCOMETAXNUMBER: "" }));
    ok("an empty tag is 'none': the count of phones does not move and the row still says the fields were served", b.sent === true && ledgerContactFields(b, SIX).has_phone === false && ledgerContactFields(b, SIX).contact_fields_sent === true);
    const { LEDGERMOBILE: _m, ...noMobile } = L;
    const [c] = ledgersFromParsed(parsedLedgers(noMobile));
    ok("a missing mobile tag is 'none' too (Tally sends a contact tag only when it holds a value), the bill-wise tag proves the fields were served", c.sent === true && ledgerContactFields(c, SIX).has_mobile === false);
    const { ISBILLWISEON: _b, ...noBillwise } = L;
    const [d] = ledgersFromParsed(parsedLedgers(noBillwise));
    ok("a ledger without the bill-wise tag is marked 'not served', never 'none'", d.sent === false && ledgerContactFields(d, SIX).contact_fields_sent === false);
    {
      const unserved = tallyMirrorReads("http://x", "ZZ CO", async () => ({ ENVELOPE: { BODY: { DATA: { COLLECTION: { LEDGER: [noBillwise, { ...noBillwise, GUID: "L-2", NAME: "PARTY 043" }] } } } } }));
      const got = await unserved.ledgers();
      ok("the real ledger read hands the 'not served' mark through", got.length === 2 && got.every((x) => x.sent === false));
      const f = fakeStore();
      const ft = fakeTally({}, { ledgers: got });
      const rr = await runMirrorSync({ store: f.store, tally: ft.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-01" }, today: "2026-11-06", log: () => {} }).catch((e) => ({ state: "threw", error: (e as Error).message }));
      ok("a run whose ledgers none came back with the bill-wise tag fails and swaps nothing", /bill-wise tag/.test(String((rr as any).error ?? "")) && !f.calls.includes("swap"), String((rr as any).error ?? "").slice(0, 120));
    }
    const real = ledgerContactFields(a, SIX), scr = ledgerContactFields(a, SCR);
    ok("a live row keeps the phone, mobile and PAN and counts them", real.phone === "033-5550101" && real.mobile === "9000000001" && real.pan === "AAAAA0000A" && real.has_phone === true && real.has_mobile === true && real.has_pan === true);
    ok("a test row never stores the phone, mobile or PAN, only that each is there; the registration type and bill-wise are kept",
      scr.phone === null && scr.mobile === null && scr.pan === null && scr.has_phone === true && scr.has_mobile === true && scr.has_pan === true
      && scr.gst_registration_type === "Regular" && scr.is_billwise_on === true && !JSON.stringify(scr).match(/5550101|9000000001|AAAAA0000A/));
    const rowS = ledgerRowFrom(a, SCR, "2026-11-05", { from: "2026-04-01", unexpected: false, why: null });
    ok("the staged test ledger row carries the counts and none of the numbers", rowS.row.has_pan === true && !JSON.stringify(rowS).match(/5550101|9000000001|AAAAA0000A/));
    ok("billwise 'No' is false and an unreadable value is null, not false", ledgerContactFields({ ...a, isbillwiseon: "No" }, SIX).is_billwise_on === false && ledgerContactFields({ ...a, isbillwiseon: "" }, SIX).is_billwise_on === null);

    const VCH = (guid: string, extra: Record<string, unknown>) => ({ GUID: guid, DATE: "20261101", ...extra });
    const parsedV = { ENVELOPE: { BODY: { DATA: { COLLECTION: { VOUCHER: [
      VCH("V-1", { ENTEREDBY: "USER ONE", "ALLLEDGERENTRIES.LIST": [{ LEDGERNAME: "Bank", "BANKALLOCATIONS.LIST": { INSTRUMENTNUMBER: "UTR0000001", INSTRUMENTDATE: "20261101" } }, { LEDGERNAME: "Party", "BANKALLOCATIONS.LIST": { INSTRUMENTNUMBER: "", INSTRUMENTDATE: "" } }] }),
      VCH("V-2", { ENTEREDBY: "", "LEDGERENTRIES.LIST": [{ LEDGERNAME: "Sales" }] }),
    ] } } } } };
    const ex = voucherExtrasFromParsed(parsedV);
    ok("who entered it and the bank instrument number and date are read by GUID", ex.get("V-1")?.enteredby === "USER ONE" && ex.get("V-1")?.instruments.length === 1
      && ex.get("V-1")?.instruments[0].number === "UTR0000001" && ex.get("V-1")?.instruments[0].date === "2026-11-01");
    ok("an empty bank block is a placeholder, not an instrument, and a voucher with none has an empty list", ex.get("V-2")?.instruments.length === 0 && ex.get("V-2")?.enteredby === "");
    const mk = (guid: string, scrub: boolean) => mirrorRowFrom({ guid, date: "20261101", alterid: 5, masterid: 6, vouchertypename: "RECEIPT", vouchernumber: "1", allledgerentries: [], erpExtras: ex.get(guid) }, scrub ? SCR : SIX)!;
    const live1 = mk("V-1", false), test1 = mk("V-1", true);
    ok("a live row keeps the user and the instrument", live1.row.entered_by === "USER ONE" && live1.row.instrument_count === 1 && (live1.row.instruments as any[])[0].number === "UTR0000001");
    ok("a test row holds a stand-in for the user and no instrument number, only that one is there", /^ZZ TEST /.test(String(test1.row.entered_by)) && test1.row.instrument_count === 1
      && (test1.row.instruments as any[])[0].number === null && (test1.row.instruments as any[])[0].number_present === true && !JSON.stringify(test1.row).match(/USER ONE|UTR0000001/));
    ok("a voucher built without the extras says so, so 'none' is never confused with 'not read'", voucherExtraFields({}, SIX).extras_sent === false && mk("V-2", false).row.extras_sent === true && mk("V-2", false).row.entered_by === null);
    const store = tallyMirrorReads("http://x", "ZZ CO", async () => ({ ENVELOPE: { BODY: { DATA: { COLLECTION: { VOUCHER: [
      VCH("V-9", { ALTERID: "9", VOUCHERTYPENAME: "Receipt", ENTEREDBY: "USER ONE", "ALLLEDGERENTRIES.LIST": [{ LEDGERNAME: "Bank", AMOUNT: "10", "BANKALLOCATIONS.LIST": { INSTRUMENTNUMBER: "UTR9", INSTRUMENTDATE: "20261101" } }] }),
    ] } } } } }));
    const got = await store.vouchersOn("2026-11-01");
    ok("the real day read attaches the extras to the converted voucher", got.length === 1 && got[0].erpExtras?.enteredby === "USER ONE" && got[0].erpExtras?.instruments[0].number === "UTR9");
    const got2 = await store.changedSince(5);
    ok("and so does the incremental read", got2.length === 1 && got2[0].erpExtras?.instruments.length === 1);
  }

  H("THE FENCE");
  const P = "https://abcdefghijklmnopqrst.supabase.co";
  const f = (path: string, m = "POST") => erpTestFence(`${P}${path}`, m, P);
  for (const fn of ["erp_sync_run_start", "erp_sync_run_step", "erp_sync_stage", "erp_sync_swap", "erp_sync_run_fail", "erp_sync_test_cleanup",
                    "erp_sync_stage_ledgers", "erp_sync_check_days", "erp_sync_repull_start", "erp_job_mirror_check", "erp_sync_last_full_run", "erp_sync_accepted_runs"]) {
    ok(`the sandbox may call ${fn}`, ERP_TEST_RPCS.includes(fn) && f(`/rest/v1/rpc/${fn}`) === null);
  }
  ok("the helper functions are not on the list", ["erp_sync_actor", "erp_sync_my_run", "erp_sync_jobs_of", "erp_sync_jobs_for", "erp_sync_reconcile_jobs"].every((fn) => f(`/rest/v1/rpc/${fn}`) !== null));
  ok("0119: it reads is_test ledgers, flags, checks and re-pulls, and writes none of them", ["erp_mirror_ledgers", "erp_record_flags", "erp_record_links", "erp_sync_day_checks", "erp_sync_repulls"]
    .every((tb) => f(`/rest/v1/${tb}?select=*&is_test=eq.true`, "GET") === null && f(`/rest/v1/${tb}?select=*`, "GET") !== null && f(`/rest/v1/${tb}?is_test=eq.true`, "POST") !== null));
  ok("it reads is_test mirror rows", f("/rest/v1/erp_mirror_rows?select=*&company_key=eq.ZZTEST-X&is_test=eq.true", "GET") === null);
  ok("it cannot read mirror rows without is_test", f("/rest/v1/erp_mirror_rows?select=*", "GET") !== null);
  ok("it cannot write or delete mirror rows directly", f("/rest/v1/erp_mirror_rows?is_test=eq.true", "POST") !== null && f("/rest/v1/erp_sync_marks?is_test=eq.true", "DELETE") !== null && f("/rest/v1/erp_sync_runs?is_test=eq.true", "PATCH") !== null);
  ok("the live mirror stays out of reach", f("/rest/v1/tally_vouchers?select=*", "GET") !== null && f("/rest/v1/tally_vouchers", "POST") !== null);

  /* Review of thread 8, item 16: the fence for the swap store, the derive and the signals, each named. */
  for (const fn of ["erp_tally_derive", "erp_tally_test_cleanup", "erp_signal_test_emit", "erp_signal_test_cleanup", "erp_signal_catch_up"]) {
    ok(`the sandbox may call ${fn}, by POST only`, ERP_TEST_RPCS.includes(fn) && f(`/rest/v1/rpc/${fn}`) === null && f(`/rest/v1/rpc/${fn}`, "GET") !== null && f(`/rest/v1/rpc/${fn}`, "DELETE") !== null);
  }
  ok("no other erp_tally_ or erp_signal_ function is open (put, finish, parity, ready, the read path, the classes, the real emit)",
    ["erp_tally_put", "erp_tally_finish", "erp_tally_parity", "erp_tally_swap_ready", "erp_tally_swap_read_path", "erp_tally_class", "erp_tally_view_classes_sync", "erp_tally_visible_tables", "erp_signal_emit", "erp_signal_prune", "erp_signal_prune_now"]
      .every((fn) => !ERP_TEST_RPCS.includes(fn) && f(`/rest/v1/rpc/${fn}`) !== null));
  for (const tb of ["erp_tally_rows", "erp_change_signals"]) {
    ok(`${tb}: read only, only is_test rows`, f(`/rest/v1/${tb}?select=*&is_test=eq.true`, "GET") === null && f(`/rest/v1/${tb}?select=*`, "GET") !== null && f(`/rest/v1/${tb}?select=*&is_test=eq.false`, "GET") !== null);
    ok(`${tb}: no insert, update or delete, even with is_test`, ["POST", "PATCH", "PUT", "DELETE"].every((m) => f(`/rest/v1/${tb}?is_test=eq.true`, m) !== null));
  }
  ok("the swap store views and the parity and run tables are out of reach", ["erp_tally_vouchers", "erp_tally_ledgers", "erp_tally_companies", "erp_swap_parity", "erp_tally_runs", "erp_golive_switches", "erp_backup_log"]
    .every((tb) => f(`/rest/v1/${tb}?select=*&is_test=eq.true`, "GET") !== null && f(`/rest/v1/${tb}?is_test=eq.true`, "POST") !== null));
  ok("the fence refuses another host for a permitted call", erpTestFence("https://evil.example/rest/v1/rpc/erp_tally_derive", "POST", P) !== null);

  H("TODAY'S SYNC IS UNTOUCHED");
  const src = join(dirname(process.argv[1]), "..", "src");
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p); } };
  walk(src);
  const importers = files.filter((p) => !p.endsWith("erpMirrorSync.ts") && /erpMirrorSync/.test(readFileSync(p, "utf8")));
  ok("nothing in the agent's src imports the ERP mirror sync (the office agent never starts it)", importers.length === 0, importers.join(", "));
  const mine = readFileSync(join(src, "services", "erpMirrorSync.ts"), "utf8");
  ok("it never names a tally_* table or today's SupabaseSync", !/["'`]tally_[a-z_]+["'`]|SupabaseSync|supabaseClient\(/.test(mine));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
