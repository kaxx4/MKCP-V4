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
  parseBalance, ledgerProblem, ledgerRowFrom, ledgersFromParsed, runRepull, runDayCheck, planMirrorWork, ERP_MIRROR_LEDGER_DEF, ERP_MIRROR_MARK_DEF,
  indiaToday, ledgerPeriod, judgeLoadedPeriod, loadedPeriodFromParsed, tallyDateToIso, ERP_MIRROR_COMPANY_DEF,
  type MirrorStore, type MirrorTally, type MirrorRow, type SwapResult, type MirrorLedgerRow, type TallyLedger, type DayCheckVoucher,
} from "../src/services/erpMirrorSync.js";
import { erpTestFence, ERP_TEST_RPCS } from "../src/services/supabaseClient.js";
import { parseTallyAmount } from "../src/services/xml.js";
import { buildCollectionXml } from "../src/services/xmlBuilder.js";
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

function fakeStore(opts: { mark?: number | null; swap?: SwapResult; isTest?: boolean; salt?: string | null; repull?: string | null; check?: Record<string, any> } = {}) {
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
function fakeTally(byDay: Record<string, any[]>, opts: { highest?: number; failOn?: string; changed?: any[]; ledgers?: TallyLedger[]; vouchers?: DayCheckVoucher[]; period?: { from: string | null; to: string | null; lastVoucher?: string | null } | { from: string | null; to: string | null; lastVoucher?: string | null }[]; counted?: Record<string, number>; latestDate?: string | null } = {}) {
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
    highest: () => wrap("highest", () => ({ alterId: opts.highest ?? 100, latestDate: opts.latestDate === undefined ? "2026-11-05" : opts.latestDate, count: 9, byDay: opts.counted ?? {}, vouchers: opts.vouchers ?? [{ k: "A", d: "2026-11-01", a: 90 }] })),
    vouchersOn: (day) => wrap(`day ${day}`, () => byDay[day] ?? []),
    changedSince: (mark) => wrap(`changed ${mark}`, () => opts.changed ?? []),
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
  s = fakeStore({ mark: 50 }); t = fakeTally({}, { highest: 130, changed: [voucher("C", "20261104", 125)] });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "incremental" });
  ok("it reads above the run's mark, after reading Tally's highest, then the ledgers", t.calls.join(",") === "highest,changed 50,period,ledgers,period");
  ok("the swap gets Tally's highest (130)", s.swapArgs?.mark === 130 && rep.state === "swapped" && s.staged.length === 1);
  s = fakeStore({ mark: 130 }); t = fakeTally({}, { highest: 130 });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "incremental" });
  ok("Tally's highest equal to the mark: it reads above the mark, nothing new", t.calls.join(",") === "highest,changed 130,period,ledgers,period" && rep.state === "swapped");

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
  ok("the voucher reads ask for the ledger lines but not the inventory or e-way blocks", sent[1].includes(">AllLedgerEntries<") && !sent[1].includes("Inventory") && !sent[1].includes("EWayBill"));
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

  H("WHAT RUNS NEXT (0119, A7 weekly full, A11 nightly)");
  const now = new Date("2026-11-06T20:00:00Z"), ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
  ok("no mark: a full run, then the check", planMirrorWork({ now, hasMark: false, fullDue: false, lastFullAt: null, lastCheckAt: null, queuedRepulls: 0 }).join(",") === "full,check");
  ok("a full run due: full", planMirrorWork({ now, hasMark: true, fullDue: true, lastFullAt: ago(2), lastCheckAt: ago(1), queuedRepulls: 0 }).join(",") === "full");
  ok("the last full run 7 days ago: the weekly full (A7)", planMirrorWork({ now, hasMark: true, fullDue: false, lastFullAt: ago(7 * 24), lastCheckAt: ago(1), queuedRepulls: 0 }).join(",") === "full");
  ok("otherwise an incremental; the check after 20 hours; queued re-pulls last", planMirrorWork({ now, hasMark: true, fullDue: false, lastFullAt: ago(30), lastCheckAt: ago(21), queuedRepulls: 2 }).join(",") === "incremental,check,repull"
    && planMirrorWork({ now, hasMark: true, fullDue: false, lastFullAt: ago(30), lastCheckAt: ago(3), queuedRepulls: 0 }).join(",") === "incremental");

  H("THE FENCE");
  const P = "https://abcdefghijklmnopqrst.supabase.co";
  const f = (path: string, m = "POST") => erpTestFence(`${P}${path}`, m, P);
  for (const fn of ["erp_sync_run_start", "erp_sync_run_step", "erp_sync_stage", "erp_sync_swap", "erp_sync_run_fail", "erp_sync_test_cleanup",
                    "erp_sync_stage_ledgers", "erp_sync_check_days", "erp_sync_repull_start", "erp_job_mirror_check", "erp_sync_last_full_run"]) {
    ok(`the sandbox may call ${fn}`, ERP_TEST_RPCS.includes(fn) && f(`/rest/v1/rpc/${fn}`) === null);
  }
  ok("the helper functions are not on the list", ["erp_sync_actor", "erp_sync_my_run", "erp_sync_jobs_of", "erp_sync_jobs_for", "erp_sync_reconcile_jobs"].every((fn) => f(`/rest/v1/rpc/${fn}`) !== null));
  ok("0119: it reads is_test ledgers, flags, checks and re-pulls, and writes none of them", ["erp_mirror_ledgers", "erp_record_flags", "erp_record_links", "erp_sync_day_checks", "erp_sync_repulls"]
    .every((tb) => f(`/rest/v1/${tb}?select=*&is_test=eq.true`, "GET") === null && f(`/rest/v1/${tb}?select=*`, "GET") !== null && f(`/rest/v1/${tb}?is_test=eq.true`, "POST") !== null));
  ok("it reads is_test mirror rows", f("/rest/v1/erp_mirror_rows?select=*&company_key=eq.ZZTEST-X&is_test=eq.true", "GET") === null);
  ok("it cannot read mirror rows without is_test", f("/rest/v1/erp_mirror_rows?select=*", "GET") !== null);
  ok("it cannot write or delete mirror rows directly", f("/rest/v1/erp_mirror_rows?is_test=eq.true", "POST") !== null && f("/rest/v1/erp_sync_marks?is_test=eq.true", "DELETE") !== null && f("/rest/v1/erp_sync_runs?is_test=eq.true", "PATCH") !== null);
  ok("the live mirror stays out of reach", f("/rest/v1/tally_vouchers?select=*", "GET") !== null && f("/rest/v1/tally_vouchers", "POST") !== null);

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
