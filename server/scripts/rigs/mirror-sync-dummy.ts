/**
 * Task 1-5, first half, on the dummy Tally: the ERP mirror sync end to end, at
 * volume (review M8, 6-Nov-2026).
 *
 * The rig asks Tally for every voucher's date first and picks the busiest
 * window of days it can read in reasonable time (a few hundred vouchers), then
 * syncs that window from the practice company into the ERP's own test mirror on
 * live (erp_mirror_rows under a ZZTEST company key, as test rows, names
 * scrubbed with a keyed hash), step by step in erp_sync_runs. Then:
 *   - the mirror holds exactly what Tally counts for those days;
 *   - the same full sync again changes nothing;
 *   - a forced empty day (the rig's own stand-in for Tally answering an
 *     empty collection) is refused by the agent, because the AlterID read
 *     just before counted that day's vouchers (review 1-5 item 1); with the
 *     AlterID read made to lose the day too, it is refused by the database's
 *     per-day floor, the mirror unchanged and the read kept; a plain re-read
 *     then swaps with nothing changed;
 *   - an incremental with nothing changed reads nothing and keeps the mark;
 *   - one ZZTEST Contra is put in the dummy on the busiest day, and the
 *     incremental picks up exactly that voucher;
 *   - the Contra is swept, Tally's highest AlterID falls below the mark, and
 *     the incremental is refused before reading anything ("needs a full run");
 *     the next incremental cannot even start; a full run prunes the swept
 *     voucher, lowers the mark and clears the due flag; the incremental runs
 *     again.
 * Everything is swept and this run's rows deleted. The tally_* tables are
 * never read or written; the office agent is not involved. Every request to
 * Tally goes through tallyPost, which checks the practice company's GUID
 * (MKCP_PRACTICE_COMPANY_GUID) before sending anything.
 *
 * Needs: sandbox role, local Tally with the practice company open, the Tally
 * slot, MKCP_ERP_TEST_QUEUE=on for this one process, this machine's key.
 *
 *   $env:MKCP_ERP_TEST_QUEUE='on'; npx tsx scripts/rigs/mirror-sync-dummy.ts --out <file.json>
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";
guardScriptWrites("rigs/mirror-sync-dummy"); // writes only on a sandbox role against a local Tally
import { tallyPost } from "../../src/tally.js";
import { erpTestQueueClient, agentMachineId, agentMachineKey } from "../../src/services/supabaseClient.js";
import { practiceCompany, practiceGuid } from "../../src/services/tallyRole.js";
import { safePush, vouchersOnDateXml } from "../../src/services/safePush.js";
import { readTag } from "../../src/services/xml.js";
import { runMirrorSync, supabaseMirrorStore, tallyMirrorReads, eachDay, type MirrorSyncReport, type MirrorTally } from "../../src/services/erpMirrorSync.js";
import { rigPayload } from "./lib/simTally.js";
import { isSweepVoucher } from "../lib/testVoucherMatch.js";
import type { VoucherPayload } from "../../src/types.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const OUT = arg("--out");
const MAX_WINDOW_VOUCHERS = 800;     // a few hundred: enough volume, a full read stays in minutes
const company = practiceCompany();
if (!company) { console.error("MKCP_PRACTICE_COMPANY is not set"); process.exit(2); }
if (!practiceGuid()) { console.error("MKCP_PRACTICE_COMPANY_GUID is not set: the rig will not read a company it cannot identify"); process.exit(2); }
const c = erpTestQueueClient();
const machine = agentMachineId(), key = agentMachineKey();
const stamp = Date.now().toString().slice(-6);           // digits only: the sweep matches ZZTEST<digits>/<n>
const companyKey = `ZZTEST-MIRROR-${stamp}`;
const store = supabaseMirrorStore(c, machine, key, companyKey, true);
const tally = tallyMirrorReads(TALLY_URL, company);
const post = (xml: string) => tallyPost(TALLY_URL, xml, 180_000, true) as Promise<string>;

function provenance() {
  const git = (...a: string[]) => (spawnSync("git", a, { encoding: "utf8", cwd: dirname(process.argv[1]) }).stdout ?? "").trim();
  return { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirtyFiles: git("status", "--porcelain", "--", "..", "../../src").split("\n").filter(Boolean) };
}

/** The busiest run of consecutive days, as long as it fits under the cap (longest first, then most vouchers). */
function pickWindow(byDay: Record<string, number>): { from: string; to: string; count: number; days: number } | null {
  const dates = Object.keys(byDay).sort();
  if (!dates.length) return null;
  const all = eachDay(dates[0], dates[dates.length - 1]);
  for (const w of [7, 5, 3, 2, 1]) {
    let best: { from: string; to: string; count: number; days: number } | null = null;
    for (let i = 0; i + w <= all.length; i++) {
      const n = all.slice(i, i + w).reduce((s, d) => s + (byDay[d] ?? 0), 0);
      if (n <= MAX_WINDOW_VOUCHERS && (!best || n > best.count)) best = { from: all[i], to: all[i + w - 1], count: n, days: w };
    }
    if (best && best.count >= 150) return best;
  }
  return null;
}

(async () => {
  const prov = provenance();
  const steps: { step: string; ok: boolean; detail: string; at: string }[] = [];
  const step = (s: string, ok: boolean, detail = "") => { steps.push({ step: s, ok, detail, at: new Date().toISOString() }); console.log(`  ${ok ? "✓" : "✗"} ${s}${detail ? ` (${detail})` : ""}`); };
  const runs: Record<string, MirrorSyncReport> = {};
  const counts: Record<string, unknown> = {};
  const mirrorCount = async (day?: string) => {
    let q = c.from("erp_mirror_rows").select("key", { count: "exact", head: true }).eq("company_key", companyKey).eq("is_test", true);
    if (day) q = q.eq("voucher_date", day);
    const { count, error } = await q;
    if (error) throw new Error(`count: ${error.message}`);
    return count ?? 0;
  };
  const mark = async () => (await c.from("erp_sync_marks").select("alter_id,scope_from,scope_to,full_due").eq("company_key", companyKey).eq("is_test", true).maybeSingle()).data as { alter_id: number; scope_from: string; scope_to: string; full_due: boolean } | null;
  const sw = (r?: MirrorSyncReport) => (r?.swap ?? {}) as Record<string, any>;
  const t0 = Date.now();
  let busy = "", pushed: VoucherPayload | null = null, swept = false;

  console.log(`\n  ERP mirror sync on the dummy Tally, at volume (stamp ${stamp}, commit ${prov.commit.slice(0, 8)}, tree ${prov.tree.slice(0, 8)})\n`);
  step("the run uses committed code (no uncommitted change in the agent's src or scripts)", prov.dirtyFiles.length === 0, prov.dirtyFiles.join(", "));
  try {
    const top = await tally.highest();
    const win = pickWindow(top.byDay);
    if (!win) throw new Error("no window of days with 150 or more vouchers under the cap");
    const scope = { from: win.from, to: win.to };
    busy = eachDay(win.from, win.to).sort((a, b) => (top.byDay[b] ?? 0) - (top.byDay[a] ?? 0))[0];
    const perDay = Object.fromEntries(eachDay(win.from, win.to).map((d) => [d, top.byDay[d] ?? 0]));
    counts.tally = { vouchers: top.count, highestAlterId: top.alterId, window: win, perDay, busiestDay: busy };
    step("picked the busiest window the rig can read (Tally's own count per day, read first)", win.count >= 150 && (top.byDay[busy] ?? 0) >= 5,
      `${win.days} days ${win.from} to ${win.to}: ${win.count} vouchers; busiest ${busy} with ${top.byDay[busy]}; Tally holds ${top.count}, highest AlterID ${top.alterId}`);

    // 1. a full sync of the window
    runs.full1 = await runMirrorSync({ store, tally, kind: "full", scope });
    const n1 = await mirrorCount();
    counts.full1 = { read: runs.full1.read, mirror: n1, tallyReads: runs.full1.tallyReads };
    step("full sync of the window: swapped, and the mirror holds exactly what Tally counts for those days", runs.full1.state === "swapped" && n1 === runs.full1.read && n1 === win.count,
      `${runs.full1.read} read, ${n1} in the mirror, Tally counts ${win.count}, ${runs.full1.tallyReads} Tally reads${runs.full1.error ? `, ${runs.full1.error}` : ""}`);
    const { data: st1 } = await c.from("erp_sync_run_steps").select("seq,step,state,rows,ms").eq("run_id", runs.full1.run_id!).eq("is_test", true).order("seq");
    step("the run shows step by step (mark, each day, staged, the ledgers, swapped), each day's rows matching Tally's count", (st1 ?? []).length === win.days + 4 && (st1 ?? []).every((s: any) => s.state === "ok")
      && eachDay(win.from, win.to).every((d) => (st1 ?? []).some((s: any) => s.step === `read ${d}` && s.rows === perDay[d])),
      (st1 ?? []).map((s: any) => `${s.step}: ${s.rows ?? "-"} rows, ${s.ms ?? "-"} ms`).join(" | "));
    const m1 = await mark();
    step("the high-water mark is Tally's AlterID read before the reads, with the scope", m1?.alter_id === runs.full1.markCandidate && m1?.scope_from === scope.from && m1?.scope_to === scope.to && m1?.full_due === false, JSON.stringify(m1));
    const { data: sample } = await c.from("erp_mirror_rows").select("party,row,ledger_total,is_cancelled").eq("company_key", companyKey).eq("is_test", true).limit(1000);
    const names = (sample ?? []).flatMap((r: any) => [r.party, ...((r.row?.ledgers ?? []) as any[]).map((l) => l.ledger)]).filter(Boolean);
    const noLines = (sample ?? []).filter((r: any) => r.row?.no_ledger_lines);
    counts.names = { checked: names.length, vouchersWithoutLedgerLines: noLines.length };
    step("names from the dummy are stored only as ZZ TEST stand-ins", names.length > 0 && names.every((x: string) => /^ZZ TEST\b/.test(x)), `${names.length} names checked`);
    step("a voucher with no ledger lines has no ledger total (null, never 0)", noLines.every((r: any) => r.ledger_total === null), `${noLines.length} such vouchers (inventory-only types or cancelled)`);

    // 2. the same full sync again
    runs.full2 = await runMirrorSync({ store, tally, kind: "full", scope });
    step("the same full sync again changes nothing", runs.full2.state === "swapped" && sw(runs.full2).inserted === 0 && sw(runs.full2).changed === 0 && sw(runs.full2).pruned === 0 && sw(runs.full2).unchanged === n1,
      JSON.stringify({ ...sw(runs.full2), changed_keys: undefined }));

    // 3. a forced empty day: the per-day floor refuses the run. The day is one
    //    the whole-scope floor would let through (under 20 percent of the
    //    window, 5 or more vouchers), so only the per-day floor can catch it.
    const forced = eachDay(win.from, win.to).filter((d) => perDay[d] >= 5 && perDay[d] < 0.2 * win.count).sort((a, b) => perDay[b] - perDay[a])[0];
    if (!forced) throw new Error("no day in the window that only the per-day floor would catch");
    /* Review 1-5 item 1: the agent itself refuses a day read shorter than the
       AlterID read's count for that day, before the database is asked. */
    const emptyDay: MirrorTally = { ...tally, vouchersOn: async (d) => (d === forced ? [] : tally.vouchersOn(d)) };
    runs.full3a = await runMirrorSync({ store, tally: emptyDay, kind: "full", scope });
    const { count: kept3a } = await c.from("erp_mirror_stage").select("key", { count: "exact", head: true }).eq("run_id", runs.full3a.run_id!).eq("is_test", true);
    step("review 1-5 item 1: a day forced empty while Tally's AlterID read counts its vouchers is refused by the agent, naming the day and both counts; nothing swapped",
      runs.full3a.state === "failed" && runs.full3a.swap === null && new RegExp(`read of ${forced} returned 0 vouchers.*counted ${perDay[forced]}`).test(runs.full3a.error ?? "") && (await mirrorCount()) === n1,
      `${runs.full3a.error ?? ""}; staged ${kept3a ?? 0}`);
    /* The database's own per-day floor, behind it: the AlterID read is made to
       lose the day too (a stand-in for both reads coming back short). */
    const emptyBoth: MirrorTally = { ...emptyDay, highest: async () => { const h = await tally.highest(); return { ...h, byDay: { ...h.byDay, [forced]: 0 } }; } };
    runs.full3 = await runMirrorSync({ store, tally: emptyBoth, kind: "full", scope });
    const { count: kept3 } = await c.from("erp_mirror_stage").select("key", { count: "exact", head: true }).eq("run_id", runs.full3.run_id!).eq("is_test", true);
    const day3 = (sw(runs.full3).days ?? []).find((d: any) => d.day === forced);
    counts.forcedEmptyDay = { day: forced, mirror: perDay[forced], reason: sw(runs.full3).reason, scopeStaged: sw(runs.full3).staged, scopeFloor: sw(runs.full3).floor, kept: kept3 };
    step("review H2: a day forced empty is refused by the per-day floor alone (the whole scope passes); the mirror is unchanged and the read kept",
      runs.full3.state === "refused" && sw(runs.full3).reason === "day_below_floor" && sw(runs.full3).staged >= sw(runs.full3).floor
        && day3?.read === 0 && day3?.mirror === perDay[forced] && (await mirrorCount()) === n1 && kept3 === n1 - perDay[forced],
      `${forced}: mirror ${day3?.mirror}, read ${day3?.read}; reason ${sw(runs.full3).reason}; scope ${sw(runs.full3).staged} of ${sw(runs.full3).mirror} passes its floor of ${sw(runs.full3).floor}; kept ${kept3}`);
    runs.full4 = await runMirrorSync({ store, tally, kind: "full", scope });
    step("a refused run is simply read again: the re-read swaps with nothing changed", runs.full4.state === "swapped" && sw(runs.full4).inserted === 0 && sw(runs.full4).changed === 0 && sw(runs.full4).pruned === 0,
      JSON.stringify({ ...sw(runs.full4), changed_keys: undefined }));

    // 4. an incremental with nothing changed
    const before = (await mark())?.alter_id ?? -1;
    runs.inc0 = await runMirrorSync({ store, tally, kind: "incremental" });
    step("an incremental with nothing changed in Tally reads nothing and keeps the mark", runs.inc0.state === "swapped" && runs.inc0.read === 0 && (await mark())?.alter_id === before,
      `read ${runs.inc0.read}, mark ${before}`);

    // 5. one ZZTEST Contra on the busiest day; the incremental finds exactly it
    pushed = { ...rigPayload(stamp, 1, busy), label: "ZZ TEST 1-5 mirror" } as VoucherPayload;
    if (!isSweepVoucher({ number: pushed.voucherNumber ?? "", narration: pushed.narration ?? "" }, "ZZTEST")) throw new Error("refused: not a shape the sweep can remove");
    const pr = await safePush(TALLY_URL, company!, pushed);
    step("one ZZTEST Contra is put in the dummy on the busiest day", pr.ok, pr.errors[0] ?? pushed.voucherNumber ?? "");
    runs.inc1 = await runMirrorSync({ store, tally, kind: "incremental" });
    const { data: got } = await c.from("erp_mirror_rows").select("voucher_number,voucher_type,alter_id,ledger_total").eq("company_key", companyKey).eq("is_test", true).eq("voucher_number", pushed.voucherNumber!);
    const m2 = await mark();
    step("the incremental picks up exactly that voucher, and the mark moves to it",
      runs.inc1.state === "swapped" && runs.inc1.read === 1 && sw(runs.inc1).inserted === 1 && (got ?? []).length === 1 && (m2?.alter_id ?? 0) > before && m2?.alter_id === (got ?? [])[0]?.alter_id,
      `read ${runs.inc1.read}, ${JSON.stringify((got ?? [])[0] ?? null)}, mark ${before} to ${m2?.alter_id}`);
    step("the mirror holds one more voucher, on the busiest day", (await mirrorCount()) === n1 + 1 && (await mirrorCount(busy)) === perDay[busy] + 1);

    // 6. sweep: Tally's highest falls below the mark
    swept = true;
    const sweep = spawnSync(process.execPath, [join(dirname(process.argv[1]), "..", "..", "node_modules", "tsx", "dist", "cli.mjs"), join(dirname(process.argv[1]), "..", "sweep-test-vouchers.ts"), "ZZTEST", busy, "--yes"], { encoding: "utf8", env: process.env });
    const raw = await post(vouchersOnDateXml(company!, busy, { voucherType: "Contra" }));
    const left = [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => readTag(m[0], "VOUCHERNUMBER")).filter((n) => n.startsWith(`ZZTEST${stamp}/`));
    step("swept from the dummy: none of this run's numbers is left", sweep.status === 0 && left.length === 0, `sweep exit ${sweep.status}, left ${left.length}`);
    const after = await tally.highest();
    const markNow = (await mark())?.alter_id ?? 0;
    counts.counterFall = { markAfterPush: markNow, tallyHighestAfterSweep: after.alterId };
    step("after the sweep Tally's highest AlterID is below the mark (the counter fall, staged on the dummy)", after.alterId < markNow, `Tally ${after.alterId}, mark ${markNow}`);

    // 7. the incremental is refused before reading; the next cannot start
    runs.inc2 = await runMirrorSync({ store, tally, kind: "incremental" });
    const m3 = await mark();
    step("review H1: the incremental is refused before any voucher read (needs a full run), the mark kept, a full run recorded as due",
      runs.inc2.state === "refused" && sw(runs.inc2).reason === "needs_full_run" && runs.inc2.read === 0 && runs.inc2.tallyReads === 1 && m3?.alter_id === markNow && m3?.full_due === true,
      `reads ${runs.inc2.tallyReads}, ${JSON.stringify(sw(runs.inc2))}, mark ${m3?.alter_id}, full due ${m3?.full_due}`);
    let startErr = "";
    try { await runMirrorSync({ store, tally, kind: "incremental" }); } catch (e) { startErr = (e as Error).message; }
    step("review H1: while a full run is due, no incremental can start", /full run is due/.test(startErr), startErr.slice(0, 160));

    // 8. the full run prunes the swept voucher and lowers the mark
    runs.full5 = await runMirrorSync({ store, tally, kind: "full", scope });
    const m4 = await mark();
    step("review H1: the full run prunes the swept voucher, lowers the mark to Tally's highest and clears the due flag",
      runs.full5.state === "swapped" && sw(runs.full5).pruned === 1 && sw(runs.full5).inserted === 0 && sw(runs.full5).alter_id_fell === true && m4?.alter_id === runs.full5.markCandidate && m4?.full_due === false && (await mirrorCount()) === n1,
      `pruned ${sw(runs.full5).pruned}, mark ${markNow} to ${m4?.alter_id}, mirror ${await mirrorCount()}`);
    runs.inc3 = await runMirrorSync({ store, tally, kind: "incremental" });
    step("after the full run the incremental runs again", runs.inc3.state === "swapped" && runs.inc3.read === 0, `read ${runs.inc3.read}`);
  } catch (e) {
    step("the run finished without an error", false, (e as Error).message);
  } finally {
    if (pushed && !swept && busy) {
      const sweep = spawnSync(process.execPath, [join(dirname(process.argv[1]), "..", "..", "node_modules", "tsx", "dist", "cli.mjs"), join(dirname(process.argv[1]), "..", "sweep-test-vouchers.ts"), "ZZTEST", busy, "--yes"], { encoding: "utf8", env: process.env });
      step("swept from the dummy after an early stop", sweep.status === 0, `sweep exit ${sweep.status}`);
    }
    const { data: cleaned, error: ce } = await c.rpc("erp_sync_test_cleanup", { p_machine: machine, p_key: key, p_company_key: companyKey });
    await c.rpc("erp_tally_test_cleanup", { p_machine: machine, p_key: key, p_company_key: companyKey });   // the swap store's test rows (migration 0130)
    const remaining = ce ? -1 : await mirrorCount().catch(() => -1);
    const { count: runsLeft } = await c.from("erp_sync_runs").select("id", { count: "exact", head: true }).eq("company_key", companyKey).eq("is_test", true);
    step("this run's test rows are deleted (mirror rows, mark, runs, steps, staging)", !ce && remaining === 0 && runsLeft === 0, ce?.message ?? JSON.stringify(cleaned));
    const brief = (r?: MirrorSyncReport) => r && { run_id: r.run_id, state: r.state, read: r.read, staged: r.staged, noGuid: r.noGuid, markCandidate: r.markCandidate, tallyReads: r.tallyReads, swap: r.swap ? { ...r.swap, changed_keys: undefined } : null, error: r.error };
    const report = { rig: "mirror-sync-dummy", stamp, companyKey, provenance: prov, minutes: Math.round((Date.now() - t0) / 6000) / 10, counts, steps,
      runs: Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, brief(r)])),
      passed: steps.filter((s) => s.ok).length, failed: steps.filter((s) => !s.ok).length };
    if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2)); }
    console.log(`\n  ${report.passed} passed, ${report.failed} failed (${report.minutes} min)`);
    process.exit(report.failed ? 1 : 0);
  }
})();
