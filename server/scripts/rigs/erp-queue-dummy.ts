/**
 * Task 1-3 done-when on the dummy Tally: the ERP queue agent (`erpJobAgent.ts`)
 * against the live `erp_jobs` (ZZ TEST rows only, deleted at the end) and the
 * practice company (ZZTEST vouchers only, swept at the end).
 *
 *   C19  a 60-job run, two boots racing, never double-claims or double-books
 *   M-3  a job cancelled while claimed is never booked
 *   D2   a kill mid-push (after Tally accepted) recovers within 2 minutes, nothing lost or doubled
 *   D4   a kill before Tally got it ends uncertain, and an uncertain job never retries itself
 *        a dropped connection after Tally accepted ends succeeded
 *   H-14 a second job with a used REMOTEID is refused before Tally
 *   M3   the database refuses a wrong machine key and an unregistered machine
 *
 * Needs: sandbox role, local Tally with the practice company open, the Tally slot,
 * MKCP_ERP_TEST_QUEUE=on for this one process, and this machine's registered key.
 *
 *   $env:MKCP_ERP_TEST_QUEUE='on'; npx tsx scripts/rigs/erp-queue-dummy.ts --out <file.json> [--jobs 60]
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";
guardScriptWrites("rigs/erp-queue-dummy"); // writes only on a sandbox role against a local Tally
import { tallyPost } from "../../src/tally.js";
import { erpTestQueueClient, agentMachineId, agentMachineKey } from "../../src/services/supabaseClient.js";
import { practiceCompany } from "../../src/services/tallyRole.js";
import { safePush } from "../../src/services/safePush.js";
import { ErpJobAgent, Journal, supabaseErpQueue, tallySeams, type ErpJob } from "../../src/services/erpJobAgent.js";
import { rigPayload, indiaToday } from "./lib/simTally.js";
import type { VoucherPayload } from "../../src/types.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const OUT = arg("--out");
const JOBS = Number(arg("--jobs") ?? 60);
const CHILD = arg("--child");             // "after-accept" | "before-send": a boot that dies mid-push
const JOURNAL = arg("--journal") ?? join(tmpdir(), `erp-queue-dummy-${Date.now()}.jsonl`);
const company = practiceCompany();
if (!company) { console.error("MKCP_PRACTICE_COMPANY is not set"); process.exit(2); }
const c = erpTestQueueClient();
const machine = agentMachineId(), key = agentMachineKey();
const q = supabaseErpQueue(c, machine, key);
const post = (url: string, xml: string) => tallyPost(url, xml, 180_000, true) as Promise<string>;
const seams = tallySeams(TALLY_URL, post);
const agent = (extra: Partial<ConstructorParameters<typeof ErpJobAgent>[0]> = {}) =>
  new ErpJobAgent({ queue: q, journal: new Journal(JOURNAL), company: company!, ...seams, leaseSeconds: 30, jobLeaseSeconds: 120, ...extra });
const sleep = (t: number) => new Promise((r) => setTimeout(r, t));
async function untilHeld(a: ErpJobAgent, maxMs = 60_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) { if (await a.heartbeat()) return true; await sleep(3000); }
  return false;
}

if (CHILD) {
  // A boot that dies mid-push. It claims the one queued job, and exits with code 9
  // either right after Tally accepted (nothing journalled after `sent`) or right before calling Tally.
  (async () => {
    const a = agent({ push: async (co, p) => {
      if (CHILD === "before-send") process.exit(9);
      await safePush(TALLY_URL, co, p);
      process.exit(9);
    } });
    if (!(await untilHeld(a))) { console.error("child: no lease"); process.exit(3); }
    await a.runOnce(1);
    process.exit(4);   // should never get here
  })();
} else {
  main();
}

async function main() {
  const day = indiaToday();
  const stamp = Date.now().toString().slice(-6);
  const steps: { step: string; ok: boolean; detail: string; at: string }[] = [];
  const step = (s: string, ok: boolean, detail = "") => {
    steps.push({ step: s, ok, detail, at: new Date().toISOString() });
    console.log(`  ${ok ? "✓" : "✗"} ${s}${detail ? ` (${detail})` : ""}`);
  };
  const made: { job: string; proposal: string; request: string }[] = [];
  const payload = (n: number, over: Partial<VoucherPayload> = {}) => ({ ...rigPayload(`Q${stamp}`, n, day), label: "ZZ TEST 1-3 queue", ...over });
  async function enqueue(n: number, over: Partial<VoucherPayload> = {}): Promise<{ id: string; p: VoucherPayload }> {
    const p = payload(n, over);
    const request = `ZZTEST-Q${stamp}-${n}${over.remoteId ? "-dup" : ""}`;
    const { data, error } = await c.rpc("erp_enqueue_test_job", { p_machine: machine, p_key: key, p_payload: p, p_request_id: request });
    if (error) throw new Error(`enqueue: ${error.message}`);
    made.push({ job: data.job_id, proposal: data.proposal_id, request });
    return { id: data.job_id, p };
  }
  const job = async (id: string) => (await c.from("erp_jobs").select("id,state,error,master_id,attempts").eq("is_test", true).eq("id", id).single()).data as ErpJob & { error: string | null };
  const inTally = async (p: VoucherPayload) => (await seams.find(company!, p)).length;
  const tsx = join(dirname(process.argv[1]), "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
  const child = (mode: string) => spawnSync(process.execPath, [tsx, process.argv[1], "--child", mode, "--journal", JOURNAL], { encoding: "utf8", env: process.env, timeout: 180_000 });

  console.log(`\n  ERP queue on the dummy Tally (${day}, stamp Q${stamp}, ${JOBS} jobs)\n`);
  try {
    // M3, live
    const bad = await c.rpc("erp_agent_take_lease", { p_machine: machine, p_key: "not-the-key", p_nonce: "x" });
    step("M3 the database refuses this machine with a wrong key", !!bad.error && /key is wrong/.test(bad.error.message), bad.error?.message.slice(0, 70));
    const office = await c.rpc("claim_erp_jobs", { p_machine: "OFFICE-PC", p_key: key, p_nonce: "x" });
    step("M3 an unregistered machine cannot claim", !!office.error && /not registered/.test(office.error.message));
    const old = await c.rpc("claim_erp_test_jobs", { p_agent: `${machine}#x`, p_limit: 1, p_lease_seconds: 10 });
    step("M3 the old test-queue claim with only the service key is refused", !!old.error && /machine key/.test(old.error.message));

    // C19: 60 jobs, two boots racing
    const ids: string[] = [];
    for (let n = 1; n <= JOBS; n++) ids.push((await enqueue(n)).id);
    const A = agent(), B = agent();
    const t0 = Date.now();
    let byA = 0, byB = 0;
    for (let round = 0; round < JOBS * 3; round++) {
      const [ra, rb] = await Promise.all([A.runOnce(1), B.runOnce(1)]);
      byA += ra.results.length; byB += rb.results.length;
      if (ra.results.length + rb.results.length === 0 && (ra.held || rb.held)) break;
    }
    const states = await Promise.all(ids.map(job));
    const good = states.filter((s) => s?.state === "succeeded").length;
    const counts = await Promise.all(ids.map((_, i) => inTally(payload(i + 1))));
    step(`C19 ${JOBS} jobs, two boots racing: all succeeded`, good === JOBS, `${good}/${JOBS} in ${Math.round((Date.now() - t0) / 1000)} s, boots ${byA}/${byB}`);
    step("C19 each voucher is in Tally exactly once (never double-claimed or double-booked)", counts.every((n) => n === 1), `counts ${[...new Set(counts)].join(",")}`);
    step("C19 one Tally write at a time: only the lease holder worked", byA === 0 || byB === 0);

    // H-14: a used REMOTEID is refused before Tally
    const dupP = payload(9001, { remoteId: String(payload(1).remoteId) });
    const dup = await enqueue(9001, { remoteId: String(payload(1).remoteId) });
    const holder = byA ? A : B;
    await holder.runOnce(1);
    const dj = await job(dup.id);
    step("H-14 a second job with a used REMOTEID is refused before Tally", dj.state === "failed" && /REMOTEID/.test(dj.error ?? "") && (await inTally(dupP)) === 0, dj.error?.slice(0, 80) ?? "");

    // M-3: cancel while claimed
    const cx = await enqueue(9002);
    await holder.heartbeat();
    const [claimed] = await q.claim(holder.nonce, 1, 120);
    const cancel = await c.rpc("erp_cancel_test_job", { p_machine: machine, p_key: key, p_id: claimed.id });
    const r = await holder.processJob(claimed);
    step("M-3 a job cancelled while claimed is never booked", !!cancel.data && r.outcome === "not-sent" && (await job(cx.id)).state === "cancelled" && (await inTally(cx.p)) === 0, r.detail);

    // dropped connection after Tally accepted
    const dr = await enqueue(9003);
    const D = agent({ push: async (co, p) => { await safePush(TALLY_URL, co, p); throw new Error("simulated: the network dropped after Tally accepted"); } });
    await sleep(31_000);                              // the holder's lease runs out; D takes it
    await untilHeld(D);
    await D.runOnce(1);
    step("a dropped connection after Tally accepted ends succeeded, booked once", (await job(dr.id)).state === "succeeded" && (await inTally(dr.p)) === 1);

    // D2: kill mid-push after Tally accepted
    const k1 = await enqueue(9004);
    await sleep(31_000);
    const c1 = child("after-accept");
    const killedAt = Date.now();
    step("D2 a boot dies after Tally accepted (exit 9), the job is left sent", c1.status === 9 && (await job(k1.id)).state === "sent", `exit ${c1.status}`);
    const R = agent();
    const held = await untilHeld(R, 90_000);
    const rep = await R.runOnce(1);
    const k1s = await job(k1.id);
    step("D2 the restarted boot settles it by reading Tally, within 2 minutes, booked once",
      held && k1s.state === "succeeded" && (await inTally(k1.p)) === 1 && Date.now() - killedAt < 120_000,
      `${k1s.state}, ${Math.round((Date.now() - killedAt) / 1000)} s, ${rep.settled[0]?.how ?? "no settle"}`);

    // D4: kill before Tally got it
    const k2 = await enqueue(9005);
    await sleep(31_000);
    const c2 = child("before-send");
    const R2 = agent();
    await untilHeld(R2, 90_000);
    await R2.runOnce(1);
    const k2s = await job(k2.id);
    step("D4 sent but not in Tally after a crash: uncertain, not pushed", c2.status === 9 && k2s.state === "uncertain" && (await inTally(k2.p)) === 0, k2s.error?.slice(0, 70) ?? "");
    await R2.runOnce(5);
    step("D4 an uncertain job never retries itself", (await job(k2.id)).state === "uncertain" && (await inTally(k2.p)) === 0);
  } catch (e) {
    step("the run finished without an error", false, (e as Error).message);
  } finally {
    // Clean up: sweep the dummy by what is in the books, then delete this run's rows.
    const sweep = spawnSync(process.execPath, [tsx, join(dirname(process.argv[1]), "..", "sweep-test-vouchers.ts"), "ZZTEST", day, "--yes"], { encoding: "utf8", env: process.env });
    const left = await inTally(payload(1)).catch(() => -1);
    step("swept from the dummy", sweep.status === 0 && left === 0, `sweep exit ${sweep.status}, voucher 1 count ${left}`);
    const ids = made.map((m) => m.job).filter(Boolean);
    const d1 = ids.length ? await c.from("erp_jobs").delete().in("id", ids).eq("is_test", true) : { error: null };
    const d2 = made.length ? await c.from("erp_proposal_requests").delete().in("request_id", made.map((m) => m.request)).eq("is_test", true) : { error: null };
    const d3 = made.length ? await c.from("erp_proposals").delete().in("id", made.map((m) => m.proposal)).eq("is_test", true) : { error: null };
    const { data: rest } = await c.from("erp_jobs").select("id").eq("is_test", true).in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
    step("this run's test rows are deleted", !d1.error && !d2.error && !d3.error && (rest ?? []).length === 0,
      [d1.error?.message, d2.error?.message, d3.error?.message].filter(Boolean).join("; "));
    const report = { rig: "erp-queue-dummy", day, stamp: `Q${stamp}`, jobs: JOBS, steps, passed: steps.filter((s) => s.ok).length, failed: steps.filter((s) => !s.ok).length,
      sweepTail: (sweep.stdout ?? "").split("\n").slice(-6) };
    if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2)); }
    console.log(`\n  ${report.passed} passed, ${report.failed} failed`);
    process.exit(report.failed ? 1 : 0);
  }
}
