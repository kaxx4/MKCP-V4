/**
 * Task 1-3 done-when, offline: the ERP queue agent (`services/erpJobAgent.ts`)
 * against an in-memory queue with migration 0109's rules and a simulated Tally.
 * Nothing here reaches Tally or Supabase. The same rules run on live in
 * web-dashboard/supabase/live-tests/1-3_queue.sql and on the dummy Tally in
 * scripts/rigs/erp-queue-dummy.ts.
 *
 *   npx tsx server/scripts/test-queue-lease.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErpJobAgent, Journal, bookedNumberOf, looksLikeTallyMessage, sameVoucherType, type JournalEntry } from "../src/services/erpJobAgent.js";
import type { SafePushResult } from "../src/services/safePush.js";
import type { VoucherPayload } from "../src/types.js";
import { memErpQueue } from "./rigs/lib/memErpQueue.js";
import { SimTally, rigPayload, sandboxForRig, indiaToday } from "./rigs/lib/simTally.js";

sandboxForRig();
const COMPANY = process.env.MKCP_PRACTICE_COMPANY!;
let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
};
const dir = mkdtempSync(join(tmpdir(), "erp-journal-"));
let jn = 0;
const journal = () => new Journal(join(dir, `j${++jn}.jsonl`));
const day = indiaToday();
const pl = (n: number): VoucherPayload & { label: string } => ({ ...rigPayload("LEASE", n, day), label: "ZZ TEST lease" });
const noWait = async () => {};

function agentFor(m: ReturnType<typeof memErpQueue>, sim: SimTally, j = journal(), extra: Partial<ConstructorParameters<typeof ErpJobAgent>[0]> = {}) {
  return new ErpJobAgent({
    queue: m.queue, journal: j, company: COMPANY,
    push: (c, p) => sim.push("sim", c, p),
    find: async (_c, p) => Array.from({ length: sim.books.get(String(p.remoteId)) ?? 0 }, (_, i) => ({ masterId: `M${i}` })),
    leaseSeconds: 90, jobLeaseSeconds: 120, wait: noWait, ...extra,
  });
}

(async () => {
  console.log("\n  ERP queue agent, offline (task 1-3)\n");

  // C19: a 60-job run never double-claims or double-books, two boots racing
  {
    const m = memErpQueue(); const sim = new SimTally();
    for (let i = 1; i <= 60; i++) m.add(pl(i));
    const a = agentFor(m, sim), b = agentFor(m, sim);
    const ra: number[] = [], rb: number[] = [];
    for (let round = 0; round < 70; round++) {
      const [x, y] = await Promise.all([a.runOnce(1), b.runOnce(1)]);
      ra.push(x.results.length); rb.push(y.results.length);
    }
    const done = [...m.rows.values()].filter((r) => r.state === "succeeded").length;
    ok("C19 60 jobs, two boots racing: all 60 succeed", done === 60, `${done}`);
    ok("C19 nothing is booked twice", sim.doubled().length === 0 && sim.books.size === 60);
    ok("only the boot that holds the lease claims; the other waits", ra.reduce((s, v) => s + v, 0) === 60 && rb.every((v) => v === 0));
    ok("the waiting boot says why", b.status.red.some((r) => r.includes("lease is held")));
  }

  // a job cancelled while claimed is never booked
  {
    const m = memErpQueue(); const sim = new SimTally();
    const id = m.add(pl(1));
    const a = agentFor(m, sim);
    await a.heartbeat();
    const [job] = await m.queue.claim(a.nonce, 1, 120);
    m.cancel(id);
    const r = await a.processJob(job);
    ok("a job cancelled while claimed is never booked", sim.books.size === 0 && m.rows.get(id)!.state === "cancelled" && r.outcome === "not-sent");
  }

  // a kill mid-push: Tally booked it, the process died before the reply was journalled
  {
    const m = memErpQueue({ secondMs: 10 }); const sim = new SimTally();
    const id = m.add(pl(2));
    const j = journal();
    const a = agentFor(m, sim, j, { push: async (c, p) => { await sim.push("sim", c, p); return new Promise<SafePushResult>(() => {}); } });
    await a.heartbeat();
    const [job] = await m.queue.claim(a.nonce, 1, 120);
    void a.processJob(job);                          // never resolves: the process "dies" here
    await new Promise((r) => setTimeout(r, 30));
    ok("kill mid-push: the job is left sent", m.rows.get(id)!.state === "sent");
    m.expireLease();
    const t0 = Date.now();
    const b = agentFor(m, sim, j);                   // the restarted agent, same machine, same journal, new boot
    const rep = await b.runOnce(1);
    ok("kill mid-push: the restart settles it as succeeded by reading Tally, not by pushing again",
      m.rows.get(id)!.state === "succeeded" && sim.books.get(String(pl(2).remoteId)) === 1 && rep.settled[0]?.how.includes("exactly once"));
    ok("kill mid-push: settled within 2 minutes of the restart", Date.now() - t0 < 120_000);
  }

  // a kill before Tally got it: sent, not in Tally: uncertain, never resent by itself
  {
    const m = memErpQueue({ secondMs: 10 }); const sim = new SimTally();
    const id = m.add(pl(3));
    const j = journal();
    const a = agentFor(m, sim, j, { push: () => new Promise<SafePushResult>(() => {}) });
    await a.heartbeat();
    const [job] = await m.queue.claim(a.nonce, 1, 120);
    void a.processJob(job);
    await new Promise((r) => setTimeout(r, 30));
    m.expireLease();
    const b = agentFor(m, sim, j);
    await b.runOnce(1);
    const again = await b.runOnce(5);
    ok("sent but not in Tally after a crash: uncertain", m.rows.get(id)!.state === "uncertain");
    ok("an uncertain job is never retried by itself", again.results.length === 0 && sim.calls === 0);
    ok("its message says it may already be in the books", /may already be in the books/.test(m.rows.get(id)!.error ?? ""));
  }

  // a dropped connection after Tally accepted: settled succeeded from the read-back
  {
    const m = memErpQueue(); const sim = new SimTally();
    const id = m.add(pl(4));
    sim.next = ["drop-after-accept"];
    const a = agentFor(m, sim);
    const r = await a.runOnce(1);
    ok("reply lost after Tally accepted: ends succeeded, booked once", m.rows.get(id)!.state === "succeeded" && sim.books.get(String(pl(4).remoteId)) === 1, r.results[0]?.detail);
  }

  // review R2 leftover: the outcome write fails for longer than the retries
  {
    const m = memErpQueue(); const sim = new SimTally();
    const id = m.add(pl(5));
    const j = journal();
    const a = agentFor(m, sim, j, { finishTries: 3 });
    m.state.finishFails = 3;
    await a.runOnce(1);
    ok("R2 leftover: when the outcome write keeps failing the job stays sent", m.rows.get(id)!.state === "sent");
    ok("R2 leftover: the outcome is in the journal", j.entries().some((e: JournalEntry) => e.kind === "finish-pending" && e.jobId === id));
    const rep = await a.runOnce(1);
    ok("R2 leftover: the next run writes it from the journal, booked once", m.rows.get(id)!.state === "succeeded" && rep.settled[0]?.how === "from the journal" && sim.calls === 1);
  }

  // a Tally refusal is failed; a read-back difference is readback_differs; created-not-found is uncertain
  {
    const m = memErpQueue(); const sim = new SimTally();
    const a1 = m.add(pl(6)), a2 = m.add(pl(7)), a3 = m.add(pl(8));
    sim.next = ["refuse", "differ", "created-not-found"];
    const a = agentFor(m, sim);
    await a.runOnce(1); await a.runOnce(1); await a.runOnce(1);
    ok("Tally refused at the push: failed (nothing booked)", m.rows.get(a1)!.state === "failed");
    ok("read-back differs: readback_differs, never retried", m.rows.get(a2)!.state === "readback_differs");
    ok("created but not found: uncertain, never failed (M2)", m.rows.get(a3)!.state === "uncertain");
  }

  // the REMOTEID registry: a second job with the same REMOTEID is refused before Tally
  {
    const m = memErpQueue(); const sim = new SimTally();
    m.add(pl(9));
    const dup = m.add({ ...pl(9), voucherNumber: "ZZTESTLEASE/9b" });
    const a = agentFor(m, sim);
    await a.runOnce(1); const r = await a.runOnce(1);
    ok("a Create with a REMOTEID already used is refused before Tally", m.rows.get(dup)!.state === "failed" && sim.calls === 1 && r.results[0]?.outcome === "failed");
  }

  // a slow Tally: the job's own lease is renewed every interval, so it is never reclaimed
  {
    const m = memErpQueue({ secondMs: 10 }); const sim = new SimTally();
    const id = m.add(pl(10));
    sim.next = ["slow:3000"];
    const a = agentFor(m, sim, journal(), { jobLeaseSeconds: 30, renewEveryMs: 100, leaseSeconds: 1000 });
    const r = await a.runOnce(1);
    ok("a Tally ten times slower than the job lease: renewed, not reclaimed, succeeded once",
      m.rows.get(id)!.state === "succeeded" && sim.books.get(String(pl(10).remoteId)) === 1, r.results[0]?.detail);
  }

  // stops: kill switch, conflict, clock skew, journal
  {
    const m = memErpQueue(); const sim = new SimTally(); m.add(pl(11));
    m.state.kill = true;
    const r = await agentFor(m, sim).runOnce(5);
    ok("kill switch on: nothing claimed", r.results.length === 0 && sim.calls === 0);
    m.state.kill = false; m.state.conflict = true;
    const c = agentFor(m, sim);
    const r2 = await c.runOnce(5);
    ok("two machines of one role: this one stops and says so", !r2.held && c.status.red.some((x) => x.includes("both stop")));
    const skewed = memErpQueue({ clockOffsetMs: 90_000 }); skewed.add(pl(12));
    const s = agentFor(skewed, sim);
    const r3 = await s.runOnce(5);
    ok("a clock 90 s off the database: claiming stops", !r3.held && s.status.red.some((x) => x.includes("off the database")));
    const bad = { path: "x", append: () => { throw new Error("disk full"); }, entries: () => [], lastReply: () => null } as unknown as Journal;
    let threw = false;
    try { agentFor(memErpQueue(), sim, bad); } catch { threw = true; }
    ok("a journal that cannot be written stops the agent before any claim", threw);
  }

  // D5: an error window mid-batch pauses the queue; nothing is dropped; it resumes when Tally answers
  {
    const m = memErpQueue(); const sim = new SimTally();
    const j1 = m.add(pl(14)), j2 = m.add(pl(15));
    let tallyOk = false;
    const hang = async (c: string, p: VoucherPayload) => { if (tallyOk) return sim.push("sim", c, p); throw new Error("Tally request timed out after 180000 ms"); };
    const a = agentFor(m, sim, journal(), { push: hang, find: async () => [], probe: async () => tallyOk });
    await a.runOnce(1); await a.runOnce(1);
    const paused = await a.runOnce(1);
    ok("D5 two timeouts in a row: health red, queue paused", !paused.held && a.status.red.some((x) => x.includes("may be showing a message")));
    ok("D5 nothing is dropped: both jobs are uncertain, none lost", m.rows.get(j1)!.state === "uncertain" && m.rows.get(j2)!.state === "uncertain");
    m.add(pl(16)); tallyOk = true;
    const resumed = await a.runOnce(1);
    ok("D5 resumes once Tally answers normally", resumed.held && !a.status.tallyMayShowMessage);
  }

  // D21: a person's resend keeps the REMOTEID; the agent reads Tally first
  {
    const m = memErpQueue(); const sim = new SimTally();
    const old1 = m.add(pl(17)); m.rows.get(old1)!.state = "uncertain";
    sim.books.set(String(pl(17).remoteId), 1);          // the uncertain one had landed
    const r1 = m.add(pl(17), true, old1);
    const old2 = m.add(pl(18)); m.rows.get(old2)!.state = "failed";
    const r2 = m.add(pl(18), true, old2);                // the failed one had not
    const a = agentFor(m, sim);
    await a.runOnce(1); await a.runOnce(1);
    ok("D21 a resend of a job that landed is settled from Tally without pushing", m.rows.get(r1)!.state === "succeeded" && sim.books.get(String(pl(17).remoteId)) === 1);
    ok("D21 a resend of a job that did not land is pushed once, same REMOTEID", m.rows.get(r2)!.state === "succeeded" && sim.books.get(String(pl(18).remoteId)) === 1);
  }

  // a real job (not is_test) is refused on the sandbox
  {
    const m = memErpQueue(); const sim = new SimTally();
    const id = m.add(pl(13), false);
    await agentFor(m, sim).runOnce(1);
    ok("a real ERP job is never pushed from the sandbox", m.rows.get(id)!.state === "failed" && sim.calls === 0);
  }

  // review M3: a job with no voucher number is never settled succeeded from a read
  {
    const m = memErpQueue(); const sim = new SimTally();
    const id = m.add(pl(20));
    const a = agentFor(m, sim, journal(), {
      push: async (_c, p) => { delete (p as { voucherNumber?: string }).voucherNumber; throw new Error("socket hang up"); },
      find: async () => [{ masterId: "M1" }],
    });
    const r = await a.runOnce(1);
    ok("M3 no number and one match on date, type, party and amount: uncertain, not succeeded",
      m.rows.get(id)!.state === "uncertain" && r.results[0]?.outcome === "uncertain", r.results[0]?.detail);
  }

  // review L4: a read-back that keeps failing stops after readTries and ends uncertain
  {
    const m = memErpQueue(); const sim = new SimTally();
    const id = m.add(pl(21));
    let reads = 0;
    const j = journal();
    const mk = () => agentFor(m, sim, j, {
      push: async () => { throw new Error("socket hang up"); },
      find: async () => { reads++; throw new Error("Tally timeout"); },
      readTries: 3,
    });
    const a = mk();
    await a.runOnce(1);
    const after1 = m.rows.get(id)!.state;
    await a.runOnce(1);
    const after2 = m.rows.get(id)!.state;
    await a.runOnce(1);
    const after3 = m.rows.get(id)!.state;
    await a.runOnce(1);
    ok("L4 a failed read leaves the job sent for the next run, twice", after1 === "sent" && after2 === "sent", `${after1}, ${after2}`);
    ok("L4 the third failed read finishes it uncertain, and nothing reads it again", after3 === "uncertain" && reads === 3, `${after3}, reads ${reads}`);
  }

  // review L5: one round at a time on one boot
  {
    const m = memErpQueue(); const sim = new SimTally();
    m.add(pl(22)); m.add(pl(23));
    sim.next = ["slow:200"];
    const a = agentFor(m, sim);
    const [x, y] = await Promise.all([a.runOnce(1), a.runOnce(1)]);
    ok("L5 a second round on the same boot while one runs is refused, not run beside it",
      x.results.length === 1 && y.results.length === 0 && /already in progress/.test(y.stopped ?? ""), y.stopped);
  }

  // review L1 and L2: the queue lease and every claimed job are renewed from claim time
  {
    const m = memErpQueue({ secondMs: 10 }); const sim = new SimTally();
    const ids = [m.add(pl(24)), m.add(pl(25)), m.add(pl(26))];
    sim.next = ["slow:1500", "slow:1500", "slow:1500"];
    const a = agentFor(m, sim, journal(), { jobLeaseSeconds: 30, renewEveryMs: 100, leaseSeconds: 30 });
    const r = await a.runOnce(3);
    ok("L1 L2 three slow jobs in one round: the lease and jobs 2 and 3 never lapse; all succeed once",
      ids.every((i) => m.rows.get(i)!.state === "succeeded") && r.results.length === 3 && sim.doubled().length === 0,
      ids.map((i) => m.rows.get(i)!.state).join(","));
  }

  // pure helpers
  ok("H1 voucher types compare as Tally does: Sales is SALES", sameVoucherType("Sales", "SALES") && sameVoucherType(" sales ", "SALES") && !sameVoucherType("Sales", "Purchase"));
  ok("renumber: the booked number is read from safePush's warning", bookedNumberOf({ ok: true, stage: "done", voucherId: "1", errors: [], differences: [],
    warnings: ['"ZZTEST/1" was already taken in Tally, so this voucher was numbered "ZZTEST/2" instead. Re-sync to see it.'] }, pl(1)) === "ZZTEST/2");
  ok("a timeout looks like Tally showing a message", looksLikeTallyMessage("Tally request timed out after 180000 ms"));

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
