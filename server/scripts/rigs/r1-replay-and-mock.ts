/**
 * Rig R1: Tally replay and mock (task 1-0). Offline: nothing reaches Tally or Supabase.
 *
 * Replay half: the captured-fixture suites (`guardrails/run.ts --offline`, which
 * replays real Tally answers through the mock transport in `tallyMock.ts`).
 * Mock half: 20 ZZ TEST jobs through the ERP test-queue claim path, in memory,
 * against the simulated Tally; every job must book exactly once. Since the 1-3
 * review (M4, 5-Nov-2026) the same 20 jobs also run through the ERP queue agent
 * (`services/erpJobAgent.ts`) on the in-memory queue with 0109's rules, two boots.
 *
 *   npx tsx scripts/rigs/r1-replay-and-mock.ts --out <file.json>
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { SimTally, rigPayload, indiaToday, sandboxForRig } from "./lib/simTally.js";
import { memoryTestQueue, runErpTestQueueOnce, type TestJob } from "../../src/services/erpTestQueueAgent.js";
import { ErpJobAgent, Journal } from "../../src/services/erpJobAgent.js";
import { memErpQueue } from "./lib/memErpQueue.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const OUT = (() => { const i = process.argv.indexOf("--out"); return i >= 0 ? process.argv[i + 1] : null; })();
const here = dirname(process.argv[1]);

(async () => {
  const tsx = join(here, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
  const replay = spawnSync(process.execPath, [tsx, join(here, "..", "guardrails", "run.ts"), "--offline"],
    { encoding: "utf8", env: { ...process.env, MKCP_OFFLINE: "true" }, cwd: join(here, "..", "..") });
  const tail = (replay.stdout ?? "").split("\n").filter((l) => /passed|failed|suites?/i.test(l)).slice(-4);

  sandboxForRig();
  const sim = new SimTally();
  const stamp = "R1" + Date.now().toString().slice(-4);
  const jobs: TestJob[] = Array.from({ length: 20 }, (_, n) => ({
    id: `r1-${n}`, idempotency_key: `ZZTEST-R1-${n}`, label: "ZZ TEST R1", company: process.env.MKCP_PRACTICE_COMPANY!,
    payload: rigPayload(stamp, n, indiaToday()), state: "queued", attempts: 0,
  }));
  const q = memoryTestQueue(jobs);
  let rounds = 0;
  while ([...q.rows.values()].some((r) => r.state === "queued") && rounds++ < 50) {
    await runErpTestQueueOnce(q, { tallyUrl: "http://127.0.0.1:1", limit: 3, push: sim.push });
  }
  const states = [...q.rows.values()].reduce<Record<string, number>>((m, r) => ({ ...m, [r.state]: (m[r.state] ?? 0) + 1 }), {});
  const mockOk = states.succeeded === 20 && sim.doubled().length === 0 && sim.books.size === 20;

  // The same 20 jobs through erpJobAgent: two boots of one machine, one lease.
  const sim2 = new SimTally();
  const m = memErpQueue();
  for (let n = 0; n < 20; n++) m.add({ ...rigPayload(`${800 + n}`, n, indiaToday()), label: "ZZ TEST R1" });
  const jdir = mkdtempSync(join(tmpdir(), "r1-erp-"));
  const boot = (k: string) => new ErpJobAgent({
    queue: m.queue, journal: new Journal(join(jdir, `${k}.jsonl`)), company: process.env.MKCP_PRACTICE_COMPANY!,
    push: (c, p) => sim2.push("sim", c, p),
    find: async (_c, p) => Array.from({ length: sim2.books.get(String(p.remoteId)) ?? 0 }, (_, i) => ({ masterId: `M${i}` })),
    wait: async () => {},
  });
  const a = boot("a"), b = boot("b");
  for (let r = 0; r < 30 && [...m.rows.values()].some((x) => x.state === "queued"); r++) await Promise.all([a.runOnce(3), b.runOnce(3)]);
  rmSync(jdir, { recursive: true, force: true });
  const erpStates = [...m.rows.values()].reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.state]: (acc[r.state] ?? 0) + 1 }), {});
  const erpOk = erpStates.succeeded === 20 && sim2.doubled().length === 0 && sim2.books.size === 20;

  const report = {
    rig: "R1 Tally replay and mock", ranAt: new Date().toISOString(),
    replay: { command: "guardrails/run.ts --offline", exit: replay.status, summary: tail },
    mock: { jobs: 20, states, booked: sim.books.size, doubled: sim.doubled().length, pass: mockOk },
    mockErpAgent: { jobs: 20, states: erpStates, booked: sim2.books.size, doubled: sim2.doubled().length, pass: erpOk },
    pass: replay.status === 0 && mockOk && erpOk,
  };
  console.log(JSON.stringify(report, null, 2));
  if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2)); }
  process.exit(report.pass ? 0 : 1);
})();
