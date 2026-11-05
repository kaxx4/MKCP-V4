/**
 * Rig R2: fault proxy (task 1-0). Offline. Puts a fault between the agent and
 * Tally (the simulated Tally's switch) and between the agent and the queue (a
 * wrapper that fails the database call), one scenario at a time, and records
 * what the claim path did. A scenario's "expect" is the plan's rule (file 06
 * section 7, file 16 H-7); a miss is a finding for task 1-3, not hidden.
 *
 *   npx tsx scripts/rigs/r2-fault-proxy.ts --out <file.json>
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SimTally, rigPayload, indiaToday, sandboxForRig, type Fault } from "./lib/simTally.js";
import { memoryTestQueue, runErpTestQueueOnce, type TestJob, type TestQueue } from "../../src/services/erpTestQueueAgent.js";

const OUT = (() => { const i = process.argv.indexOf("--out"); return i >= 0 ? process.argv[i + 1] : null; })();

interface Scenario { name: string; tally?: Fault; queueFault?: "finish-fails-once" | "markSent-fails"; expectState: string; expectBooked: number; rule: string }
const SCENARIOS: Scenario[] = [
  { name: "clean push", expectState: "succeeded", expectBooked: 1, rule: "baseline" },
  { name: "Tally refuses", tally: "refuse", expectState: "failed", expectBooked: 0, rule: "a verdict is never retried by itself" },
  { name: "connection fails before send", tally: "drop-before", expectState: "uncertain", expectBooked: 0, rule: "no reply after sent: uncertain, never retried by itself (conservative)" },
  { name: "Tally accepted, reply lost", tally: "drop-after-accept", expectState: "uncertain", expectBooked: 1, rule: "uncertain, booked once, never pushed again" },
  { name: "created, but not found on read-back", tally: "created-not-found", expectState: "uncertain", expectBooked: 1, rule: "M2: may be in the books, so uncertain, never failed, never resent" },
  { name: "read-back differs", tally: "differ", expectState: "readback_differs", expectBooked: 1, rule: "never retried by itself" },
  { name: "Tally slower than the lease", tally: "slow:1500", expectState: "succeeded", expectBooked: 1, rule: "a sent job is never reclaimed while slow" },
  { name: "queue update for the outcome fails once", queueFault: "finish-fails-once", expectState: "succeeded", expectBooked: 1, rule: "H-7: retry every database update until it lands" },
  { name: "queue refuses the sent mark", queueFault: "markSent-fails", expectState: "claimed", expectBooked: 0, rule: "nothing goes to Tally without the sent mark" },
];

(async () => {
  sandboxForRig();
  const results = [];
  for (const [n, s] of SCENARIOS.entries()) {
    const sim = new SimTally();
    sim.fault = s.tally ?? "none";
    const job: TestJob = { id: `r2-${n}`, idempotency_key: `ZZTEST-R2-${n}`, label: "ZZ TEST R2", company: process.env.MKCP_PRACTICE_COMPANY!,
      payload: rigPayload("R2" + n, n, indiaToday()), state: "queued", attempts: 0 };
    const mem = memoryTestQueue([job]);
    let failedOnce = false;
    const q: TestQueue = {
      claim: (a, l, ls) => mem.claim(a, l, s.tally?.startsWith("slow:") ? 1 : ls),
      markSent: async (id, a) => (s.queueFault === "markSent-fails" ? false : mem.markSent(id, a)),
      finish: async (id, a, st, f) => {
        if (s.queueFault === "finish-fails-once" && !failedOnce) { failedOnce = true; throw new Error("simulated: database update failed"); }
        return mem.finish(id, a, st, f);
      },
    };
    let error: string | null = null;
    try { await runErpTestQueueOnce(q, { tallyUrl: "http://127.0.0.1:1", push: sim.push, leaseSeconds: 1 }); }
    catch (e) { error = (e as Error).message; }
    // A second agent looks once more after the lease would have run out.
    await new Promise((r) => setTimeout(r, s.tally?.startsWith("slow:") ? 50 : 0));
    const second = await runErpTestQueueOnce(q, { tallyUrl: "http://127.0.0.1:1", push: sim.push, agent: "second-agent" }).catch(() => null);
    const row = mem.rows.get(job.id)!;
    const booked = sim.books.get(String(job.payload.remoteId)) ?? 0;
    const pass = row.state === s.expectState && booked === s.expectBooked;
    results.push({ scenario: s.name, rule: s.rule, state: row.state, booked, secondAgentClaimed: second?.claimed ?? null, error, expect: { state: s.expectState, booked: s.expectBooked }, pass });
    console.log(`  ${pass ? "✓" : "✗"} ${s.name}: ${row.state}, booked ${booked}${error ? `, threw: ${error}` : ""}`);
  }
  const report = { rig: "R2 fault proxy", ranAt: new Date().toISOString(), results,
    passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length,
    note: "In-process fault switch at the two seams (agent to Tally, agent to queue). A failed row is a finding for task 1-3." };
  if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2)); }
  console.log(`\n  ${report.passed} passed, ${report.failed} failed`);
})();
