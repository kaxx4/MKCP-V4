/**
 * Rig R7: chaos schedule (task 1-0). Offline. Three agents drain 30 ZZ TEST jobs
 * from one in-memory queue while a timed schedule switches Tally faults on and
 * off and kills and restarts agents. Counts, at the end: jobs booked twice
 * (must be 0), jobs lost (never booked and not in a final state), and jobs left
 * stuck in a state only task 1-3's settling can clear.
 *
 *   npx tsx scripts/rigs/r7-chaos.ts --out <file.json>
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SimTally, rigPayload, indiaToday, sandboxForRig, type Fault } from "./lib/simTally.js";
import { memoryTestQueue, runErpTestQueueOnce, type TestJob } from "../../src/services/erpTestQueueAgent.js";

const OUT = (() => { const i = process.argv.indexOf("--out"); return i >= 0 ? process.argv[i + 1] : null; })();
/** The schedule: at t ms, set the Tally fault; or kill / revive an agent. */
const SCHEDULE: { t: number; tally?: Fault; kill?: number; revive?: number }[] = [
  { t: 0, tally: "slow:300" },
  { t: 400, tally: "slow:600" },
  { t: 900, kill: 1 },
  { t: 1200, tally: "drop-after-accept" },
  { t: 1300, tally: "slow:300" },
  { t: 1700, revive: 1 },
  { t: 2000, tally: "refuse" },
  { t: 2150, tally: "slow:300" },
  { t: 2600, kill: 2 },
  { t: 3200, revive: 2 },
];
const RUN_MS = 9000;  // every push takes 300 ms (600 ms in the slow window), so the faults land mid-drain

(async () => {
  sandboxForRig();
  const sim = new SimTally();
  const jobs: TestJob[] = Array.from({ length: 30 }, (_, n) => ({
    id: `r7-${n}`, idempotency_key: `ZZTEST-R7-${n}`, label: "ZZ TEST R7", company: process.env.MKCP_PRACTICE_COMPANY!,
    payload: rigPayload("R7", n, indiaToday()), state: "queued", attempts: 0,
  }));
  const q = memoryTestQueue(jobs);
  const alive = [true, true, true];
  const log: string[] = [];
  const t0 = Date.now();
  for (const s of SCHEDULE) setTimeout(() => {
    if (s.tally) sim.fault = s.tally;
    if (s.kill !== undefined) alive[s.kill] = false;
    if (s.revive !== undefined) alive[s.revive] = true;
    log.push(`${s.t}ms ${JSON.stringify(s)}`);
  }, s.t);
  /* A killed agent stops between jobs. Its claimed-but-unsent jobs come back
     after the lease (2 s); a job it marked sent stays sent (only 1-3 settles it). */
  const loops = [0, 1, 2].map(async (a) => {
    while (Date.now() - t0 < RUN_MS) {
      if (alive[a]) await runErpTestQueueOnce(q, { tallyUrl: "http://127.0.0.1:1", agent: `agent-${a}`, push: sim.push, leaseSeconds: 2 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 40));
    }
  });
  await Promise.all(loops);
  const rows = [...q.rows.values()];
  const states = rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.state]: (m[r.state] ?? 0) + 1 }), {});
  const booked = (r: TestJob) => sim.books.get(String(r.payload.remoteId)) ?? 0;
  const lost = rows.filter((r) => booked(r) === 0 && ["queued", "claimed"].includes(r.state)).length;
  const report = {
    rig: "R7 chaos schedule", ranAt: new Date().toISOString(), jobs: 30, runMs: RUN_MS, schedule: log, states,
    doubled: sim.doubled().length, lost,
    uncertainBookedOnce: rows.filter((r) => r.state === "uncertain" && booked(r) === 1).length,
    pass: sim.doubled().length === 0 && lost === 0,
    note: "uncertain jobs are booked once and wait for 1-3's settling (read Tally by MASTERID or type, date, number, party, amount).",
  };
  console.log(JSON.stringify(report, null, 2));
  if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2)); }
  process.exit(report.pass ? 0 : 1);
})();
