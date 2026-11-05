/**
 * Task 1-5, second half, first batch, on the dummy Tally (migration 0119):
 * the ledgers with their closing balances (M-6), the job-to-mirror check
 * (D-1-5.2), A6 (a job's voucher changed in Tally), the A11 nightly key
 * compare with its one-day re-pull, and A7 (a job's voucher gone from Tally).
 *
 * The rig reads every voucher's date first and picks a short window of days
 * (a few dozen vouchers, with a day holding 5 or more), then on the ERP's own
 * test mirror on live (ZZTEST company key, test rows, names scrubbed):
 *   1. a full run reads the window and the ledgers: the mirror holds Tally's
 *      count, and the ledgers carry closing balances, under ZZ TEST names;
 *   2. the nightly check right after finds nothing that differs;
 *   3. one ZZTEST Contra goes through the ERP test queue (erp_enqueue_test_job,
 *      ErpJobAgent) on the window's busiest day; the incremental reads it and
 *      the database links the job to its mirror row by MASTERID;
 *   4. the Contra is changed directly in the dummy (a stand-in for a hand
 *      edit); the incremental reads the new AlterID and the job is flagged
 *      altered_in_tally (A6);
 *   5. the Contra is swept from the dummy and a second ZZTEST Contra is put
 *      on a day outside the window (so Tally's highest is above the mark
 *      again); the nightly check finds exactly that one day differing and
 *      queues one re-pull of it (A11);
 *   6. the re-pull prunes the swept voucher, keeps the mark, and the job is
 *      flagged vanished_from_tally (A7); the check is clean again.
 * Everything is swept and every test row deleted. The tally_* tables are
 * never read or written. Every request to Tally goes through tallyPost, which
 * checks the practice company's GUID before sending anything.
 *
 * Needs: sandbox role, local Tally with the practice company open, the Tally
 * slot, MKCP_ERP_TEST_QUEUE=on for this one process, this machine's key.
 *
 *   $env:MKCP_ERP_TEST_QUEUE='on'; npx tsx scripts/rigs/mirror-checks-dummy.ts --out <file.json>
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";
guardScriptWrites("rigs/mirror-checks-dummy"); // writes only on a sandbox role against a local Tally
import { tallyPost } from "../../src/tally.js";
import { erpTestQueueClient, agentMachineId, agentMachineKey } from "../../src/services/supabaseClient.js";
import { practiceCompany, practiceGuid } from "../../src/services/tallyRole.js";
import { safePush } from "../../src/services/safePush.js";
import { ErpJobAgent, Journal, supabaseErpQueue, tallySeams } from "../../src/services/erpJobAgent.js";
import { runMirrorSync, runRepull, runDayCheck, supabaseMirrorStore, tallyMirrorReads, eachDay, type MirrorSyncReport, type DayCheckReport } from "../../src/services/erpMirrorSync.js";
import { rigPayload } from "./lib/simTally.js";
import { isSweepVoucher } from "../lib/testVoucherMatch.js";
import type { VoucherPayload } from "../../src/types.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const OUT = arg("--out");
const company = practiceCompany();
if (!company) { console.error("MKCP_PRACTICE_COMPANY is not set"); process.exit(2); }
if (!practiceGuid()) { console.error("MKCP_PRACTICE_COMPANY_GUID is not set: the rig will not read a company it cannot identify"); process.exit(2); }
const c = erpTestQueueClient();
const machine = agentMachineId(), key = agentMachineKey();
const stamp = Date.now().toString().slice(-6);           // digits only: the sweep matches ZZTEST<digits>/<n>
const companyKey = `ZZTEST-CHECKS-${stamp}`;
const store = supabaseMirrorStore(c, machine, key, companyKey, true);
const tally = tallyMirrorReads(TALLY_URL, company);
const post = (url: string, xml: string) => tallyPost(url, xml, 180_000, true) as Promise<string>;
const journal = join(tmpdir(), `mirror-checks-dummy-${stamp}.jsonl`);
const sweepScript = join(dirname(process.argv[1]), "..", "sweep-test-vouchers.ts");
const tsxCli = join(dirname(process.argv[1]), "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const sweep = (day: string) => spawnSync(process.execPath, [tsxCli, sweepScript, "ZZTEST", day, "--yes"], { encoding: "utf8", env: process.env });

function provenance() {
  const git = (...a: string[]) => (spawnSync("git", a, { encoding: "utf8", cwd: dirname(process.argv[1]) }).stdout ?? "").trim();
  return { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirtyFiles: git("status", "--porcelain", "--", "..", "../../src").split("\n").filter(Boolean) };
}

/** A short run of days: 3 then 2, 20 to 200 vouchers, one day with 6 or more; the smallest such window (fast reads). */
function pickWindow(byDay: Record<string, number>) {
  const dates = Object.keys(byDay).sort();
  if (!dates.length) return null;
  const all = eachDay(dates[0], dates[dates.length - 1]);
  for (const w of [3, 2]) {
    let best: { from: string; to: string; count: number; days: number } | null = null;
    for (let i = 0; i + w <= all.length; i++) {
      const ds = all.slice(i, i + w);
      const n = ds.reduce((s, d) => s + (byDay[d] ?? 0), 0);
      if (n >= 20 && n <= 200 && ds.some((d) => (byDay[d] ?? 0) >= 6) && (!best || n < best.count)) best = { from: ds[0], to: ds[w - 1], count: n, days: w };
    }
    if (best) return best;
  }
  return null;
}

(async () => {
  const prov = provenance();
  const steps: { step: string; ok: boolean; detail: string; at: string }[] = [];
  const step = (s: string, ok: boolean, detail = "") => { steps.push({ step: s, ok, detail, at: new Date().toISOString() }); console.log(`  ${ok ? "✓" : "✗"} ${s}${detail ? ` (${detail})` : ""}`); };
  const runs: Record<string, MirrorSyncReport | DayCheckReport | null> = {};
  const counts: Record<string, unknown> = {};
  const made: { job: string; proposal: string; request: string }[] = [];
  const sw = (r: any) => (r?.swap ?? {}) as Record<string, any>;
  const mark = async () => (await c.from("erp_sync_marks").select("alter_id,scope_from,scope_to,full_due").eq("company_key", companyKey).eq("is_test", true).maybeSingle()).data as any;
  const jobCheck = async () => { const { data, error } = await c.rpc("erp_job_mirror_check", { p_machine: machine, p_key: key, p_company_key: companyKey, p_is_test: true }); if (error) throw new Error(error.message); return data as any; };
  const flags = async (job: string) => ((await c.from("erp_record_flags").select("kind,detail,resolved_at").eq("is_test", true).eq("company_key", companyKey).eq("job_id", job)).data ?? []) as any[];
  const t0 = Date.now();
  const pushedDays = new Set<string>();

  console.log(`\n  ERP mirror checks on the dummy Tally (stamp ${stamp}, commit ${prov.commit.slice(0, 8)}, tree ${prov.tree.slice(0, 8)})\n`);
  step("the run uses committed code (no uncommitted change in the agent's src or scripts)", prov.dirtyFiles.length === 0, prov.dirtyFiles.join(", "));
  try {
    const top = await tally.highest();
    const win = pickWindow(top.byDay);
    if (!win) throw new Error("no short window of days with 20 to 200 vouchers and a day of 6 or more");
    const scope = { from: win.from, to: win.to };
    const busy = eachDay(win.from, win.to).sort((a, b) => (top.byDay[b] ?? 0) - (top.byDay[a] ?? 0))[0];
    const outside = eachDay(win.to, "2027-03-31")[1];   // the day after the window, inside the year
    counts.tally = { vouchers: top.count, highestAlterId: top.alterId, keysRead: top.vouchers?.length, window: win, busiestDay: busy, busiestCount: top.byDay[busy], outsideDay: outside };
    step("picked a short window (Tally's own count per day, read first, with every voucher's key)", !!outside && (top.vouchers?.length ?? 0) === top.count && top.vouchers!.every((v) => v.k && v.d && v.a),
      `${win.days} days ${win.from} to ${win.to}: ${win.count} vouchers; busiest ${busy} with ${top.byDay[busy]}; Tally holds ${top.count}, highest AlterID ${top.alterId}; every one of ${top.vouchers?.length} keys read`);

    // 1. a full run with the ledgers
    const full = runs.full = await runMirrorSync({ store, tally, kind: "full", scope });
    const { count: nRows } = await c.from("erp_mirror_rows").select("key", { count: "exact", head: true }).eq("company_key", companyKey).eq("is_test", true);
    const { data: leds } = await c.from("erp_mirror_ledgers").select("name,parent,closing_balance,row").eq("company_key", companyKey).eq("is_test", true).limit(5000);
    const withBal = (leds ?? []).filter((l: any) => l.closing_balance !== null);
    const sumBal = Math.round(withBal.reduce((s: number, l: any) => s + Number(l.closing_balance), 0) * 100) / 100;
    counts.ledgers = { read: full.ledgers, inMirror: (leds ?? []).length, withClosingBalance: withBal.length, sentNone: (leds ?? []).filter((l: any) => l.row?.closing_balance_sent === false).length, sumOfClosingBalances: sumBal };
    step("full run: swapped, the mirror holds exactly Tally's count for the window", full.state === "swapped" && nRows === win.count && full.read === win.count, `${full.read} read, ${nRows} in the mirror, Tally ${win.count}${full.error ? `, ${full.error}` : ""}`);
    step("M-6: the ledgers are in the ERP mirror with Tally's closing balances (counted before and after: 0, then every ledger Tally sent)",
      (full.ledgers ?? 0) > 0 && (leds ?? []).length === full.ledgers && withBal.length > 0,
      `${full.ledgers} ledgers read, ${(leds ?? []).length} in the mirror, ${withBal.length} with a closing balance, sum ${sumBal}`);
    step("ledger and group names from the dummy are stored only as ZZ TEST stand-ins", (leds ?? []).every((l: any) => /^ZZ TEST\b/.test(l.name) && (!l.parent || /^ZZ TEST\b/.test(l.parent))));

    // 2. the nightly check right after
    const dc0 = runs.check0 = await runDayCheck({ store, tally });
    step("A11: the nightly check right after the full run finds nothing that differs", dc0.state === "ok" && dc0.result?.days_differing === 0 && dc0.result?.tally === win.count && dc0.result?.mirror === win.count,
      JSON.stringify({ ...dc0.result, days: undefined }));

    // 3. one ZZTEST Contra through the ERP test queue
    const p1 = { ...rigPayload(stamp, 1, busy), label: "ZZ TEST 1-5 checks" } as VoucherPayload;
    if (!isSweepVoucher({ number: p1.voucherNumber ?? "", narration: p1.narration ?? "" }, "ZZTEST")) throw new Error("refused: not a shape the sweep can remove");
    const request = `ZZTEST-M${stamp}-1`;
    const { data: enq, error: ee } = await c.rpc("erp_enqueue_test_job", { p_machine: machine, p_key: key, p_payload: p1, p_request_id: request });
    if (ee) throw new Error(`enqueue: ${ee.message}`);
    made.push({ job: enq.job_id, proposal: enq.proposal_id, request });
    pushedDays.add(busy);
    const agent = new ErpJobAgent({ queue: supabaseErpQueue(c, machine, key), journal: new Journal(journal), company: company!, ...tallySeams(TALLY_URL, post), leaseSeconds: 30, jobLeaseSeconds: 120 });
    let held = false;
    for (let i = 0; i < 20 && !held; i++) { held = await agent.heartbeat(); if (!held) await new Promise((r) => setTimeout(r, 3000)); }
    await agent.runOnce(1);
    const { data: job } = await c.from("erp_jobs").select("id,state,master_id,error").eq("is_test", true).eq("id", enq.job_id).single();
    step("one ZZTEST Contra goes through the ERP test queue and succeeds with Tally's MASTERID", (job as any)?.state === "succeeded" && /^\d+$/.test((job as any)?.master_id ?? ""), JSON.stringify(job));
    const inc1 = runs.inc1 = await runMirrorSync({ store, tally, kind: "incremental" });
    const jc1 = await jobCheck();
    step("the incremental reads it and the database links the job to its one mirror row (D-1-5.2)",
      inc1.state === "swapped" && inc1.read === 1 && sw(inc1).jobs?.linked === 1 && jc1.mapped_one === 1 && jc1.mapped_none.length === 0 && jc1.shared_create_master_ids.length === 0,
      `read ${inc1.read}, jobs ${JSON.stringify(sw(inc1).jobs)}, check ${JSON.stringify({ ...jc1 })}`);

    // 4. the Contra changed directly in the dummy (a hand edit)
    const edited = await safePush(TALLY_URL, company!, { ...p1, action: "Alter", narration: `ZZTEST${stamp} rig, changed in Tally` } as VoucherPayload);
    const inc2 = runs.inc2 = await runMirrorSync({ store, tally, kind: "incremental" });
    const f2 = await flags(enq.job_id);
    step("A6: changed in Tally, the incremental reads the new AlterID and the job is flagged altered_in_tally",
      edited.ok && inc2.state === "swapped" && inc2.read === 1 && sw(inc2).jobs?.altered_in_tally === 1 && f2.some((f) => f.kind === "altered_in_tally" && !f.resolved_at),
      `alter ${edited.ok ? "ok" : edited.errors[0]}; read ${inc2.read}; ${JSON.stringify(f2.map((f) => ({ kind: f.kind, detail: f.detail })))}`);

    // 5. swept from the dummy; a second Contra outside the window lifts Tally's highest above the mark again
    const s1 = sweep(busy);
    const p2 = { ...rigPayload(stamp, 2, outside), label: "ZZ TEST 1-5 checks" } as VoucherPayload;
    pushedDays.add(outside);
    const pr2 = await safePush(TALLY_URL, company!, p2);
    const m5 = await mark();
    const dc1 = runs.check1 = await runDayCheck({ store, tally });
    const { data: q } = await c.from("erp_sync_repulls").select("day,state").eq("company_key", companyKey).eq("is_test", true);
    const dayRow = (dc1.result?.days ?? [])[0] ?? {};
    counts.check1 = { tallyHighest: dc1.tallyHighest, mark: m5?.alter_id, result: { ...dc1.result } };
    step("A11: after the sweep the nightly check finds exactly the busiest day differing (one gone from Tally) and queues one re-pull of it",
      s1.status === 0 && pr2.ok && (dc1.tallyHighest ?? 0) > (m5?.alter_id ?? Infinity) && dc1.state === "gaps" && dc1.result?.days_differing === 1 && dc1.result?.repulls_queued === 1
        && dayRow.day === busy && dayRow.gone_from_tally === 1 && (q ?? []).length === 1 && (q ?? [])[0].day === busy && (q ?? [])[0].state === "queued",
      `sweep exit ${s1.status}; second Contra ${pr2.ok ? "in" : pr2.errors[0]}; Tally ${dc1.tallyHighest} above the mark ${m5?.alter_id}; ${JSON.stringify(dayRow)}`);

    // 6. the re-pull
    const rp = runs.repull = await runRepull({ store, tally });
    const m6 = await mark();
    const f6 = await flags(enq.job_id);
    step("A7: the one-day re-pull prunes the swept voucher, keeps the mark and its days, and the job is flagged vanished_from_tally",
      rp?.state === "swapped" && sw(rp).repull === true && sw(rp).pruned === 1 && sw(rp).jobs?.vanished_from_tally === 1 && rp?.ledgers === null
        && m6?.alter_id === m5?.alter_id && m6?.scope_from === scope.from && m6?.scope_to === scope.to && f6.some((f) => f.kind === "vanished_from_tally" && !f.resolved_at),
      `pruned ${sw(rp).pruned}, mark ${m5?.alter_id} to ${m6?.alter_id}, jobs ${JSON.stringify(sw(rp).jobs)}`);
    const dc2 = runs.check2 = await runDayCheck({ store, tally });
    const jc2 = await jobCheck();
    step("the nightly check is clean again (the second Contra is outside the window and above the mark), and the job maps to no row",
      dc2.state === "ok" && dc2.result?.days_differing === 0 && jc2.mapped_one === 0 && jc2.mapped_none.length === 1 && jc2.open_flags?.altered_in_tally === 1 && jc2.open_flags?.vanished_from_tally === 1,
      `${JSON.stringify({ ...dc2.result, days: undefined })}; ${JSON.stringify(jc2)}`);
    step("a re-pull with nothing queued reads nothing", (await runRepull({ store, tally })) === null);
  } catch (e) {
    step("the run finished without an error", false, (e as Error).message);
  } finally {
    for (const d of pushedDays) { const r = sweep(d); step(`swept ZZTEST vouchers from ${d}`, r.status === 0, `sweep exit ${r.status}`); }
    const { data: cleaned, error: ce } = await c.rpc("erp_sync_test_cleanup", { p_machine: machine, p_key: key, p_company_key: companyKey });
    const ids = made.map((m) => m.job);
    const d1 = ids.length ? await c.from("erp_jobs").delete().in("id", ids).eq("is_test", true) : { error: null };
    const d2 = made.length ? await c.from("erp_proposal_requests").delete().in("request_id", made.map((m) => m.request)).eq("is_test", true) : { error: null };
    const d3 = made.length ? await c.from("erp_proposals").delete().in("id", made.map((m) => m.proposal)).eq("is_test", true) : { error: null };
    const left: Record<string, number> = {};
    for (const tb of ["erp_sync_runs", "erp_mirror_rows", "erp_mirror_ledgers", "erp_sync_day_checks", "erp_sync_repulls", "erp_record_flags", "erp_record_links"]) {
      const { count } = await c.from(tb).select("*", { count: "exact", head: true }).eq("company_key", companyKey).eq("is_test", true);
      left[tb] = count ?? -1;
    }
    const { count: jobsLeft } = await c.from("erp_jobs").select("id", { count: "exact", head: true }).eq("is_test", true).in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
    step("every test row of this run is deleted", !ce && !d1.error && !d2.error && !d3.error && Object.values(left).every((n) => n === 0) && jobsLeft === 0,
      `${ce?.message ?? JSON.stringify(cleaned)}; left ${JSON.stringify(left)}, jobs ${jobsLeft}`);
    const brief = (r: any) => r && ("swap" in r ? { run_id: r.run_id, kind: r.kind, state: r.state, read: r.read, ledgers: r.ledgers, tallyReads: r.tallyReads, swap: r.swap ? { ...r.swap, changed_keys: undefined, pruned_keys: undefined } : null, error: r.error }
      : { state: r.state, vouchers: r.vouchers, tallyHighest: r.tallyHighest, result: r.result ? { ...r.result, days: r.result.days } : null, error: r.error });
    const report = { rig: "mirror-checks-dummy", stamp, companyKey, provenance: prov, minutes: Math.round((Date.now() - t0) / 6000) / 10, counts, steps,
      runs: Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, brief(r)])), passed: steps.filter((s) => s.ok).length, failed: steps.filter((s) => !s.ok).length };
    if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2)); }
    console.log(`\n  ${report.passed} passed, ${report.failed} failed (${report.minutes} min)`);
    process.exit(report.failed ? 1 : 0);
  }
})();
