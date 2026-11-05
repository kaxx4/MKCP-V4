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
  type MirrorStore, type MirrorTally, type MirrorRow, type SwapResult,
} from "../src/services/erpMirrorSync.js";
import { erpTestFence, ERP_TEST_RPCS } from "../src/services/supabaseClient.js";

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

function fakeStore(opts: { mark?: number | null; swap?: SwapResult; isTest?: boolean; salt?: string | null } = {}) {
  const calls: string[] = [];
  const staged: MirrorRow[] = [];
  const steps: { step: string; state: string; rows?: number | null }[] = [];
  let swapArgs: { mark: number } | null = null; let failed: string | null = null;
  const store: MirrorStore = {
    isTest: opts.isTest ?? true,
    scrubSalt: opts.salt === undefined ? SALT : opts.salt,
    async start(kind, scope) {
      calls.push(`start ${kind}`);
      return kind === "full" ? { run_id: "R1", scope_from: scope!.from, scope_to: scope!.to, mark: opts.mark ?? null }
        : { run_id: "R2", scope_from: "2026-10-30", scope_to: "2026-11-05", mark: opts.mark ?? 50 };
    },
    async step(_r, step, state, rows) { calls.push(`step ${step}`); steps.push({ step, state, rows }); },
    async stage(_r, rows) { calls.push(`stage ${rows.length}`); staged.push(...rows); return new Set(staged.map((x) => x.key)).size; },
    async swap(_r, mark) { calls.push("swap"); swapArgs = { mark }; return opts.swap ?? { state: "swapped", inserted: staged.length }; },
    async fail(_r, e) { calls.push("fail"); failed = e; },
  };
  return { store, calls, staged, steps, get swapArgs() { return swapArgs; }, get failed() { return failed; } };
}

function fakeTally(byDay: Record<string, any[]>, opts: { highest?: number; failOn?: string; changed?: any[] } = {}) {
  const calls: string[] = [];
  let inFlight = 0, maxInFlight = 0;
  const wrap = async <T>(label: string, fn: () => T): Promise<T> => {
    calls.push(label); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    if (opts.failOn === label) throw new Error("Tally reported an error: ZZ TEST error window");
    return fn();
  };
  const tally: MirrorTally = {
    highest: () => wrap("highest", () => ({ alterId: opts.highest ?? 100, latestDate: "2026-11-05", count: 9, byDay: {} })),
    vouchersOn: (day) => wrap(`day ${day}`, () => byDay[day] ?? []),
    changedSince: (mark) => wrap(`changed ${mark}`, () => opts.changed ?? []),
  };
  return { tally, calls, get maxInFlight() { return maxInFlight; } };
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
  ok("Tally's highest AlterID is read before any voucher", t.calls[0] === "highest" && t.calls.slice(1).every((c) => c.startsWith("day ")), t.calls.join(", "));
  ok("one read per day of the scope, in order", t.calls.slice(1).join(",") === "day 2026-11-01,day 2026-11-02,day 2026-11-03");
  ok("never two Tally requests at once", t.maxInFlight === 1, `max ${t.maxInFlight}`);
  ok("the swap gets the mark read BEFORE the reads (100), not the highest staged (121)", s.swapArgs?.mark === 100 && rep.markCandidate === 100);
  ok("every step is written: the mark, each day, staged, swapped", s.steps.length === 6 && s.steps.every((x) => x.state === "ok"), s.steps.map((x) => x.step).join(" | "));
  ok("the report says swapped", rep.state === "swapped" && rep.read === 3 && rep.tallyReads === 4 && s.staged.length === 3);
  ok("stage comes before swap, swap once", s.calls.indexOf("swap") > s.calls.findIndex((c) => c.startsWith("stage")) && s.calls.filter((c) => c === "swap").length === 1);
  ok("review M3: a test store's rows reach staging scrubbed (the caller has no switch for it)", s.staged.every((r) => /^ZZ TEST\b/.test(r.party ?? "") && (r.row.ledgers as any[]).every((l) => /^ZZ TEST\b/.test(l.ledger))));
  let threwNoSalt = false;
  try { await runMirrorSync({ store: fakeStore({ salt: null }).store, tally: fakeTally(days).tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-01" } }); } catch { threwNoSalt = true; }
  ok("review M3: a test store without a salt cannot run at all", threwNoSalt);
  s = fakeStore({ isTest: false, salt: null }); t = fakeTally(days);
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "full", scope: { from: "2026-11-01", to: "2026-11-01" } });
  ok("a live store (go-live) keeps Tally's names", rep.state === "swapped" && s.staged[0]?.party === "REAL LOOKING TRADERS");

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
  ok("it reads above the run's mark, after reading Tally's highest", t.calls.join(",") === "highest,changed 50");
  ok("the swap gets Tally's highest (130)", s.swapArgs?.mark === 130 && rep.state === "swapped" && s.staged.length === 1);
  s = fakeStore({ mark: 130 }); t = fakeTally({}, { highest: 130 });
  rep = await runMirrorSync({ store: s.store, tally: t.tally, kind: "incremental" });
  ok("Tally's highest equal to the mark: it reads above the mark, nothing new", t.calls.join(",") === "highest,changed 130" && rep.state === "swapped");

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
  ok("a full run reads as usual and hands the lower AlterID to the swap (only a full run may lower the mark)", rep.state === "swapped" && s.swapArgs?.mark === 130 && t.calls.join(",") === "highest,day 2026-11-01");

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
  ok("the AlterID read asks for AlterID and Date only, above 0, escaped", /\$AlterID &gt; 0</.test(sent[0]) && (sent[0].match(/<NATIVEMETHOD>/g) ?? []).length === 2);
  ok("a day read is filtered to that one day inside Tally", sent[1].includes("&gt;= 20261103") && sent[1].includes("&lt;= 20261103"));
  ok("the incremental read is filtered above the mark inside Tally", /\$AlterID &gt; 42</.test(sent[2]));
  ok("the voucher reads ask for the ledger lines but not the inventory or e-way blocks", sent[1].includes(">AllLedgerEntries<") && !sent[1].includes("Inventory") && !sent[1].includes("EWayBill"));
  const errReads = tallyMirrorReads("http://localhost:9000", "ZZ PRACTICE CO", async () => ({ ENVELOPE: { HEADER: { STATUS: 0 }, BODY: {} } }));
  let threw = false; try { await errReads.vouchersOn("2026-11-03"); } catch { threw = true; }
  ok("an error envelope from Tally throws, it is never an empty day", threw);

  H("THE FENCE");
  const P = "https://abcdefghijklmnopqrst.supabase.co";
  const f = (path: string, m = "POST") => erpTestFence(`${P}${path}`, m, P);
  for (const fn of ["erp_sync_run_start", "erp_sync_run_step", "erp_sync_stage", "erp_sync_swap", "erp_sync_run_fail", "erp_sync_test_cleanup"]) {
    ok(`the sandbox may call ${fn}`, ERP_TEST_RPCS.includes(fn) && f(`/rest/v1/rpc/${fn}`) === null);
  }
  ok("the two helper functions are not on the list", f("/rest/v1/rpc/erp_sync_actor") !== null && f("/rest/v1/rpc/erp_sync_my_run") !== null);
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
