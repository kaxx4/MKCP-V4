/**
 * Rig R1 for the ERP mirror (task 1-5, second half): replays A1, A4, A6, A7,
 * A11, A12 and E1 with a simulated Tally against the real database rules.
 *
 * Tally is a simulation (its "books" are a map in this process; nothing
 * reaches port 9000). The database half is real: the ERP's own test mirror on
 * live, through the same functions the dummy rigs use, as test rows under a
 * ZZTEST company key, every name scrubbed, all deleted at the end. So each
 * scenario proves what the agent and the database do together, without the
 * cost or the risk of a Tally session. P7: the simulated Tally behaves as the
 * dummy rigs measured (AlterIDs only rise, a delete drops a voucher, a filtered
 * read returns one day); a Tally quirk it does not model is not proved here.
 *
 *   A1  Tally closes during a sync: the run fails, the mirror and the mark stay as they were.
 *   A4  a day read comes back empty: the agent refuses; when the AlterID read loses
 *       the day too, the database's per-day floor refuses. Mirror unchanged.
 *   E1  ten refreshes at once: one run starts, the other nine are told one is running.
 *   A6  a pushed voucher edited in Tally: the incremental reads the new AlterID and
 *       the job is flagged altered_in_tally.
 *   A12 the agent's clock is wrong: the incremental still reads by Tally's AlterID,
 *       a backdated edit is read, and the mark is Tally's number, not a time.
 *   A11 the mirror is two vouchers short on a day: the nightly check names that day
 *       and queues one re-pull, which brings both in.
 *   A7  the pushed voucher deleted in Tally: the nightly check queues its day, the
 *       re-pull prunes it, and the job is flagged vanished_from_tally.
 *
 * Needs: sandbox role, MKCP_ERP_TEST_QUEUE=on for this one process, this
 * machine's key. No Tally slot (nothing is sent to Tally).
 *
 *   $env:MKCP_ERP_TEST_QUEUE='on'; npx tsx scripts/rigs/r1-mirror-replay.ts --out <file.json>
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";
guardScriptWrites("rigs/r1-mirror-replay"); // writes only ERP test rows, on a sandbox
import { erpTestQueueClient, agentMachineId, agentMachineKey } from "../../src/services/supabaseClient.js";
import { practiceCompany } from "../../src/services/tallyRole.js";
import { ErpJobAgent, Journal, supabaseErpQueue } from "../../src/services/erpJobAgent.js";
import { runMirrorSync, runRepull, runDayCheck, supabaseMirrorStore, ledgerPeriod, indiaToday, type MirrorTally, type TallyLedger } from "../../src/services/erpMirrorSync.js";
import { rigPayload } from "./lib/simTally.js";
import type { VoucherPayload } from "../../src/types.js";
import type { SafePushResult } from "../../src/services/safePush.js";
import { rigExitCodeAtLeast, swapStoreCleanup } from "./rigExit.js";
/** Checks that passed in the last full live run (14 of 14, commit 7085222). A run with fewer passes is not a pass. */
const MIN_CHECKS = 14;

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const OUT = arg("--out");
const company = practiceCompany() || "ZZ PRACTICE CO";
const c = erpTestQueueClient();
const machine = agentMachineId(), key = agentMachineKey();
const stamp = Date.now().toString().slice(-6);
const companyKey = `ZZTEST-R1M-${stamp}`;
const store = supabaseMirrorStore(c, machine, key, companyKey, true);
const ymd = (iso: string) => iso.replace(/-/g, "");

/** The simulated Tally: AlterIDs only rise; a delete removes a voucher; a day read returns that day. */
class SimMirrorTally {
  books = new Map<string, any>();
  top = 500_000;
  n = 0;
  closeAfterDayReads: number | null = null;   // A1: Tally closes after this many day reads
  dayReads = 0;
  emptyDay: string | null = null;              // A4: the day read of this day comes back empty
  hiddenDay: string | null = null;             // A4: the AlterID read loses this day too
  requests = 0;
  add(day: string, extra: Record<string, unknown> = {}) {
    const alterid = ++this.top, guid = `zz-sim-${stamp}-${++this.n}`;
    const v = { guid, date: ymd(day), alterid, masterid: 900_000 + this.n, vouchertypename: "SALES", vouchernumber: `ZZ/${this.n}`, partyledgername: "ZZ TEST PARTY",
      narration: "ZZ TEST", reference: "", iscancelled: false, isoptional: false, effectivedate: ymd(day),
      allledgerentries: [{ ledgername: "ZZ TEST PARTY", amount: "-118.00", isdeemedpositive: true }, { ledgername: "ZZ TEST SALES", amount: "118.00", isdeemedpositive: false }], ...extra };
    this.books.set(guid, v);
    return v;
  }
  alter(guid: string) { const v = this.books.get(guid); v.alterid = ++this.top; v.narration = "ZZ TEST changed in Tally"; return v; }
  private visible() { return [...this.books.values()].filter((v) => !this.hiddenDay || v.date !== ymd(this.hiddenDay)); }
  private gate(what: string) {
    this.requests++;
    if (this.closeAfterDayReads !== null && this.dayReads >= this.closeAfterDayReads) throw new Error(`simulated: Tally is not reachable (${what})`);
  }
  reads(): MirrorTally {
    const iso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    return {
      highest: async () => {
        this.gate("the AlterID read");
        const vs = this.visible();
        const byDay: Record<string, number> = {};
        for (const v of vs) byDay[iso(v.date)] = (byDay[iso(v.date)] ?? 0) + 1;
        const latest = vs.map((v) => iso(v.date)).sort().pop() ?? null;
        return { alterId: vs.reduce((m, v) => Math.max(m, v.alterid), 0), latestDate: latest, count: vs.length, byDay, vouchers: vs.map((v) => ({ k: v.guid, d: iso(v.date), a: v.alterid })) };
      },
      vouchersOn: async (day) => {
        this.gate(`the read of ${day}`);
        this.dayReads++;
        if (day === this.emptyDay) return [];
        return this.visible().filter((v) => v.date === ymd(day)).map((v) => ({ ...v }));
      },
      changedSince: async (mark) => { this.gate(`the read above ${mark}`); return this.visible().filter((v) => v.alterid > mark).map((v) => ({ ...v })); },
      ledgers: async (): Promise<TallyLedger[]> => { this.gate("the ledger read"); return ["PARTY", "SALES", "CASH"].map((n, i) => ({ guid: `zz-sim-led-${i}`, name: `ZZ TEST ${n}`, parent: "Sundry Debtors", closingbalance: "100.00", openingbalance: "0.00", alterid: "1", masterid: String(i + 1) })); },
      loadedPeriod: async () => {
        this.gate("the period read");
        const last = [...this.books.values()].map((v) => v.date).sort().pop() ?? ymd(indiaToday());
        return { from: ymd(ledgerPeriod(indiaToday()).from), to: last, lastVoucher: last };
      },
    };
  }
  /** safePush in the simulation: books the voucher, returns its MASTERID. */
  push = async (_company: string, p: VoucherPayload): Promise<SafePushResult> => {
    const v = this.add(p.date, { vouchertypename: p.voucherType, vouchernumber: p.voucherNumber, partyledgername: p.partyLedgerName, narration: p.narration, remoteid: p.remoteId,
      allledgerentries: (p.ledgerEntries ?? []).map((e) => ({ ledgername: e.ledgerName, amount: String(e.isDeemedPositive ? -e.amount : e.amount), isdeemedpositive: e.isDeemedPositive })) });
    return { ok: true, stage: "done", voucherId: String(v.masterid), errors: [], warnings: [], differences: [] } as SafePushResult;
  };
  find = async (_company: string, p: VoucherPayload) => [...this.books.values()].filter((v) => v.remoteid === p.remoteId).map((v) => ({ masterId: String(v.masterid) }));
  stamp = async (_company: string, _p: VoucherPayload, masterId: string) => [...this.books.values()].find((v) => String(v.masterid) === masterId)?.alterid ?? null;
}

function provenance() {
  const git = (...a: string[]) => (spawnSync("git", a, { encoding: "utf8", cwd: dirname(process.argv[1]) }).stdout ?? "").trim();
  return { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirtyFiles: git("status", "--porcelain", "--", "..", "../../src").split("\n").filter(Boolean) };
}

(async () => {
  const prov = provenance();
  const steps: { step: string; ok: boolean; detail: string }[] = [];
  const step = (s: string, ok: boolean, detail = "") => { steps.push({ step: s, ok, detail }); console.log(`  ${ok ? "✓" : "✗"} ${s}${detail ? ` (${detail})` : ""}`); };
  const t0 = Date.now();
  const made: { job: string; proposal: string; request: string }[] = [];
  const sim = new SimMirrorTally();
  const tally = sim.reads();
  const mirror = async () => ((await c.from("erp_mirror_rows").select("key,alter_id").eq("company_key", companyKey).eq("is_test", true).limit(5000)).data ?? []) as { key: string; alter_id: number }[];
  const snap = async () => (await mirror()).map((r) => `${r.key}:${r.alter_id}`).sort().join(",");
  const mark = async () => (await c.from("erp_sync_marks").select("alter_id,full_due").eq("company_key", companyKey).eq("is_test", true).maybeSingle()).data as any;
  const flags = async (job: string) => ((await c.from("erp_record_flags").select("kind,resolved_at").eq("is_test", true).eq("company_key", companyKey).eq("job_id", job)).data ?? []) as any[];
  const fy = ledgerPeriod(indiaToday()).from;
  const day = (offset: number) => { const d = new Date(`${fy}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 90 + offset); return d.toISOString().slice(0, 10); };
  const D1 = day(0), D2 = day(1), D3 = day(2);
  const scope = { from: D1, to: D3 };

  console.log(`\n  R1 mirror replay (simulated Tally, real database rules; stamp ${stamp}, commit ${prov.commit.slice(0, 8)}, tree ${prov.tree.slice(0, 8)})\n`);
  step("the run uses committed code", prov.dirtyFiles.length === 0, prov.dirtyFiles.join(", "));
  try {
    for (let i = 0; i < 6; i++) sim.add(D1);
    for (let i = 0; i < 3; i++) sim.add(D2);
    for (let i = 0; i < 5; i++) sim.add(D3);
    const f0 = await runMirrorSync({ store, tally, kind: "full", scope });
    step("a full run of three days is swapped and the mirror holds Tally's 14", f0.state === "swapped" && (await mirror()).length === 14, `${f0.state}, read ${f0.read}`);

    // A1
    const before = await snap(), m0 = await mark();
    sim.dayReads = 0; sim.closeAfterDayReads = 1;
    const a1 = await runMirrorSync({ store, tally, kind: "full", scope });
    sim.closeAfterDayReads = null;
    const { count: stageLeft } = await c.from("erp_mirror_stage").select("key", { count: "exact", head: true }).eq("run_id", a1.run_id ?? "00000000-0000-0000-0000-000000000000");
    step("A1: Tally closes after the first day's read: the run fails, the mirror and the mark are as they were", a1.state === "failed" && /not reachable/.test(a1.error ?? "") && (await snap()) === before && (await mark())?.alter_id === m0?.alter_id,
      `${a1.state}: ${a1.error}; ${stageLeft ?? "?"} rows left in that run's staging, never swapped`);

    // A4, the agent's own check
    sim.emptyDay = D1;
    const a4a = await runMirrorSync({ store, tally, kind: "full", scope });
    step("A4: the read of a 6-voucher day comes back empty: the agent refuses before anything is swapped", a4a.state === "failed" && /returned 0 vouchers, but Tally's AlterID read just before counted 6/.test(a4a.error ?? "") && (await snap()) === before, a4a.error ?? "");
    // A4, the database's floor behind it
    sim.hiddenDay = D1;
    const a4b = await runMirrorSync({ store, tally, kind: "full", scope });
    sim.emptyDay = null; sim.hiddenDay = null;
    /* 8 of 14 is under the whole run's 80 percent too, so either floor of the database may answer first (the volume rig proves the per-day one alone). */
    step("A4: when the AlterID read loses that day too, a floor of the database refuses (the run's or the day's), and the mirror is unchanged", a4b.state === "refused" && ["below_floor", "day_below_floor"].includes(String(a4b.swap?.reason)) && (await snap()) === before,
      `${a4b.state}: ${a4b.swap?.reason}`);

    // E1
    const ten = await Promise.all(Array.from({ length: 10 }, () => runMirrorSync({ store, tally, kind: "incremental" }).catch((e) => ({ refusedWith: (e as Error).message }) as any)));
    const ran = ten.filter((r) => r && r.run_id), told = ten.filter((r) => !r || r.refusedWith);
    step("E1: ten refreshes at once: exactly one run starts, the other nine are told a run is already going", ran.length === 1 && told.length === 9,
      `${ran.length} ran (${ran[0]?.state}), ${told.length} not started${told.find((t) => t?.refusedWith) ? `: ${String(told.find((t) => t?.refusedWith).refusedWith).slice(0, 120)}` : ""}`);

    // A6: a job pushed through the ERP test queue, then edited in Tally
    const p1 = { ...rigPayload(stamp, 1, D2), label: "ZZ TEST R1 mirror" } as VoucherPayload;
    const request = `ZZTEST-R1M${stamp}-1`;
    const { data: enq, error: ee } = await c.rpc("erp_enqueue_test_job", { p_machine: machine, p_key: key, p_payload: p1, p_request_id: request });
    if (ee) throw new Error(`enqueue: ${ee.message}`);
    made.push({ job: enq.job_id, proposal: enq.proposal_id, request });
    const agent = new ErpJobAgent({ queue: supabaseErpQueue(c, machine, key), journal: new Journal(join(tmpdir(), `r1-mirror-${stamp}.jsonl`)), company,
      push: sim.push, find: sim.find, stamp: sim.stamp, wait: async () => {}, leaseSeconds: 30, jobLeaseSeconds: 120 } as any);
    let held = false;
    for (let i = 0; i < 20 && !held; i++) { held = await agent.heartbeat(); if (!held) await new Promise((r) => setTimeout(r, 3000)); }
    await agent.runOnce(1);
    const { data: job } = await c.from("erp_jobs").select("state,master_id,alter_id_at_push").eq("is_test", true).eq("id", enq.job_id).single();
    const inc1 = await runMirrorSync({ store, tally, kind: "incremental" });
    step("the job succeeds in the simulation with its MASTERID, and the incremental reads it and links it", (job as any)?.state === "succeeded" && inc1.state === "swapped" && inc1.read === 1 && (inc1.swap as any)?.jobs?.linked === 1,
      `job ${(job as any)?.state} ${(job as any)?.master_id}, AlterID at push ${(job as any)?.alter_id_at_push}; read ${inc1.read}, ${JSON.stringify((inc1.swap as any)?.jobs)}`);
    const pushed = [...sim.books.values()].find((v) => v.remoteid === p1.remoteId);
    sim.alter(pushed.guid);
    const a6 = await runMirrorSync({ store, tally, kind: "incremental" });
    step("A6: edited in Tally, the incremental reads the new AlterID and the job is flagged altered_in_tally", a6.state === "swapped" && a6.read === 1 && (a6.swap as any)?.jobs?.altered_in_tally === 1 && (await flags(enq.job_id)).some((f) => f.kind === "altered_in_tally" && !f.resolved_at),
      `read ${a6.read}, ${JSON.stringify((a6.swap as any)?.jobs)}`);

    // A12: the agent's clock is off by months; a backdated voucher is edited
    const old = [...sim.books.values()].find((v) => v.date === ymd(D1))!;
    const altered = sim.alter(old.guid);
    const a12 = await runMirrorSync({ store, tally, kind: "incremental", today: "2027-03-30" } as any);
    const rowA12 = (await mirror()).find((r) => r.key === old.guid);
    step("A12: with the agent's clock months ahead, the incremental still reads the backdated edit by Tally's AlterID, and the mark is that AlterID",
      a12.state === "swapped" && a12.read === 1 && Number(rowA12?.alter_id) === altered.alterid && (await mark())?.alter_id === sim.top, `read ${a12.read}, mark ${(await mark())?.alter_id}, Tally ${sim.top}`);

    // A11: the mirror is two short on D3 (two vouchers the mirror never got: entered with AlterIDs the mark already passed, as a restore can leave them)
    const markNow = (await mark())?.alter_id;
    for (let i = 0; i < 2; i++) { const v = sim.add(D3); v.alterid = markNow - 1 - i; }
    const dc = await runDayCheck({ store, tally });
    const d3row = (dc.result?.days ?? []).find((d: any) => d.day === D3) ?? {};
    step("A11: the nightly check finds exactly the day two vouchers short and queues one re-pull of it", dc.state === "gaps" && dc.result?.days_differing === 1 && d3row.day === D3 && dc.result?.repulls_queued === 1,
      JSON.stringify({ state: dc.state, differing: dc.result?.days_differing, queued: dc.result?.repulls_queued, day: d3row }));
    const rp11 = await runRepull({ store, tally });
    const inD3 = [...sim.books.values()].filter((v) => v.date === ymd(D3)).map((v) => v.guid);
    const mirrorKeys = new Set((await mirror()).map((r) => r.key));
    step("A11: the targeted re-pull brings both in, keeps the mark, and the check after is clean", rp11?.state === "swapped" && inD3.every((g) => mirrorKeys.has(g)) && (await mark())?.alter_id === markNow
      && (await runDayCheck({ store, tally })).state === "ok", `${rp11?.state}, mirror holds ${inD3.filter((g) => mirrorKeys.has(g)).length} of ${inD3.length} on ${D3}`);

    // A7: the pushed voucher deleted in Tally
    sim.books.delete(pushed.guid);
    const dc7 = await runDayCheck({ store, tally });
    const rp7 = await runRepull({ store, tally });
    step("A7: deleted in Tally, the nightly check queues its day, the re-pull prunes it, and the job is flagged vanished_from_tally",
      dc7.state === "gaps" && rp7?.state === "swapped" && rp7?.swap?.pruned === 1 && (rp7?.swap as any)?.jobs?.vanished_from_tally === 1 && (await flags(enq.job_id)).some((f) => f.kind === "vanished_from_tally" && !f.resolved_at) && !(await mirror()).some((r) => r.key === pushed.guid),
      `check ${dc7.state}; re-pull ${rp7?.state}, pruned ${rp7?.swap?.pruned}, ${JSON.stringify((rp7?.swap as any)?.jobs)}`);
    step("nothing was sent to a real Tally: every read went to the simulation", sim.requests > 0, `${sim.requests} simulated reads`);
  } catch (e) {
    step("the run finished without an error", false, (e as Error).message);
  } finally {
    const { data: cleaned, error: ce } = await c.rpc("erp_sync_test_cleanup", { p_machine: machine, p_key: key, p_company_key: companyKey });
    const swapClean = await swapStoreCleanup(c, machine, key, companyKey);   // the swap store's test rows (migration 0130): the call is checked and the leftover rows counted
    step("the swap store holds none of this run's test rows after the clean-up", swapClean.ok, swapClean.detail);
    const ids = made.map((m) => m.job);
    const d1 = ids.length ? await c.from("erp_jobs").delete().in("id", ids).eq("is_test", true) : { error: null };
    const d2 = made.length ? await c.from("erp_proposal_requests").delete().in("request_id", made.map((m) => m.request)).eq("is_test", true) : { error: null };
    const d3 = made.length ? await c.from("erp_proposals").delete().in("id", made.map((m) => m.proposal)).eq("is_test", true) : { error: null };
    const left: Record<string, number> = {};
    for (const tb of ["erp_sync_runs", "erp_mirror_rows", "erp_mirror_ledgers", "erp_sync_day_checks", "erp_sync_repulls", "erp_record_flags", "erp_record_links"]) {
      const { count } = await c.from(tb).select("*", { count: "exact", head: true }).eq("company_key", companyKey).eq("is_test", true);
      left[tb] = count ?? -1;
    }
    step("every test row of this run is deleted", !ce && !d1.error && !d2.error && !d3.error && Object.values(left).every((n) => n === 0), `${ce?.message ?? JSON.stringify(cleaned)}; left ${JSON.stringify(left)}`);
    const report = { rig: "r1-mirror-replay", stamp, companyKey, provenance: prov, minutes: Math.round((Date.now() - t0) / 6000) / 10, steps, passed: steps.filter((s) => s.ok).length, failed: steps.filter((s) => !s.ok).length };
    if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2)); }
    console.log(`\n  ${report.passed} passed, ${report.failed} failed (${report.minutes} min)`);
    const exitCode = rigExitCodeAtLeast(steps.map((s) => ({ name: s.step, ok: s.ok, detail: s.detail })), MIN_CHECKS);
    if (exitCode === 1 && report.failed === 0) console.log(`  only ${report.passed} checks passed; at least ${MIN_CHECKS} are expected, so this is not a pass`);
    process.exit(exitCode);
  }
})();
