/**
 * Lane agent-poll (18-Nov-2026), offline: how often the office agent asks the database for work and how it slows down when the database is slow
 * (services/jobPoll.ts and PrimaryQueueLoop in services/primaryRunner.ts). A fake clock drives the real loop; no timers wait, no database, no Tally.
 *   - the poll is 30 s plus or minus 10 percent, from one named constant, with a safe environment override;
 *   - one round at a time (a second call, or a long round, never overlaps);
 *   - after a failure the wait goes 30, 60, 120, 240, 300 s and a good round resets it; the failure is one plain log line;
 *   - a database failing for 10 minutes costs a small, bounded number of calls (the old 10 s loop made 13);
 *   - the three calls of a round keep their order and meaning (take lease, list open jobs, claim);
 *   - the lease the agent asks for is at least 3 times the longest healthy gap, and fits the database's 30..300 s clamp.
 *
 *   npx tsx scripts/test-job-poll.ts
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErpJobAgent, Journal } from "../src/services/erpJobAgent.js";
import { PrimaryQueueLoop, readPrimaryConfig } from "../src/services/primaryRunner.js";
import {
  JOB_POLL_MS, JOB_POLL_JITTER, JOB_BACKOFF_MAX_MS, JOB_POLL_MAX_MS, DB_LEASE_MIN_SEC, DB_LEASE_MAX_SEC, LEASE_SAFETY_FACTOR,
  jobPollMs, withJitter, backoffMs, leaseSecondsFor, longestHealthyGapMs,
} from "../src/services/jobPoll.js";
import { ReportRunner, REPORT_POLL_MS } from "../src/services/reportRunner.js";
import { memErpQueue } from "./rigs/lib/memErpQueue.js";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
};

/** A fake clock: timers fire in time order, and every promise the fired code is waiting on settles before the next one fires. */
class FakeClock {
  t = 0;
  private q: Array<{ at: number; fn: () => void; id: number }> = [];
  private n = 0;
  set = (fn: () => void, ms: number): unknown => { const id = ++this.n; this.q.push({ at: this.t + ms, fn, id }); return id; };
  clear = (h: unknown): void => { this.q = this.q.filter((e) => e.id !== h); };
  private flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  async advanceTo(end: number): Promise<void> {
    await this.flush();
    for (;;) {
      this.q.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.q[0];
      if (!next || next.at > end) break;
      this.q.shift(); this.t = next.at; next.fn(); await this.flush();
    }
    this.t = end;
  }
}

(async () => {
  console.log("\n  the numbers");
  ok("the poll is one named constant, 30 s, with 10 percent jitter and a 300 s ceiling", JOB_POLL_MS === 30_000 && JOB_POLL_JITTER === 0.1 && JOB_BACKOFF_MAX_MS === 300_000);
  ok("the agent's own settings use it when nothing is set", jobPollMs(undefined) === JOB_POLL_MS && jobPollMs("") === JOB_POLL_MS);
  ok("an environment override inside the safe range is used", jobPollMs("45000") === 45_000 && jobPollMs("5000") === 5_000);
  ok("nonsense, too fast or too slow falls back to 30 s", jobPollMs("abc") === 30_000 && jobPollMs("10") === 30_000 && jobPollMs(String(JOB_POLL_MAX_MS + 1000)) === 30_000);
  const base = { MKCP_PRIMARY_MODE: "on", MKCP_PRIMARY_COMPANY_GUID: "11111111-2222-4333-8444-555555555555", MKCP_PRIMARY_COMPANY: "ZZ OFFICE CO - (from 1-Apr-26)", MKCP_AGENT_MACHINE_ID: "office-pc-1", MKCP_ERP_AGENT_KEY: "k".repeat(64), SUPABASE_SERVICE_KEY: "s", MKCP_ERP_JOURNAL_PATH: join(tmpdir(), "job-poll-main.jsonl") };
  const poll = (extra: Record<string, string> = {}) => { const r = readPrimaryConfig("http://t", { ...base, ...extra }); return r.ok ? r.cfg.queuePollMs : -1; };
  ok("the agent's real config polls every 30 s by default, and honours a safe MKCP_PRIMARY_POLL_MS", poll() === 30_000 && poll({ MKCP_PRIMARY_POLL_MS: "40000" }) === 40_000 && poll({ MKCP_PRIMARY_POLL_MS: "500" }) === 30_000, `${poll()} ${poll({ MKCP_PRIMARY_POLL_MS: "40000" })}`);
  const lo = withJitter(30_000, () => 0), hi = withJitter(30_000, () => 1), mid = withJitter(30_000, () => 0.5);
  ok("jitter is within plus or minus 10 percent (27 s to 33 s), unchanged at the middle", lo === 27_000 && hi === 33_000 && mid === 30_000, `${lo} ${hi} ${mid}`);
  let inBounds = true; for (let i = 0; i < 2000; i++) { const w = withJitter(30_000); if (w < 27_000 || w > 33_000) inBounds = false; }
  ok("2000 real random waits all stay within 27 s to 33 s", inBounds);
  ok("backoff after 1, 2, 3, 4, 5, 6 failures: 30, 60, 120, 240, 300, 300 s", [1, 2, 3, 4, 5, 6].map((f) => backoffMs(30_000, f) / 1000).join() === "30,60,120,240,300,300");
  ok("no failure means the plain poll time", backoffMs(30_000, 0) === 30_000);

  console.log("\n  the lease");
  const leaseSec = leaseSecondsFor(JOB_POLL_MS);
  const gapSec = longestHealthyGapMs(JOB_POLL_MS) / 1000;
  ok(`the lease asked for (${leaseSec} s) is at least ${LEASE_SAFETY_FACTOR} times the longest healthy gap (${gapSec} s)`, leaseSec >= LEASE_SAFETY_FACTOR * gapSec, `${leaseSec} vs ${LEASE_SAFETY_FACTOR * gapSec}`);
  ok("the old 90 s lease would NOT have been enough for a 30 s poll (why the agent now asks for more)", 90 < LEASE_SAFETY_FACTOR * gapSec);
  ok("it fits the database's clamp (30 to 300 s)", leaseSec >= DB_LEASE_MIN_SEC && leaseSec <= DB_LEASE_MAX_SEC);
  ok("it holds for every allowed poll time, up to the slowest the clamp allows", (() => { for (let p = 1_000; p <= JOB_POLL_MAX_MS; p += 1_000) { const s = leaseSecondsFor(p); if (s > DB_LEASE_MAX_SEC || s < LEASE_SAFETY_FACTOR * longestHealthyGapMs(p) / 1000) return false; } return true; })(), `max poll ${JOB_POLL_MAX_MS}`);
  ok("the real agent is built with that lease", /leaseSeconds: leaseSecondsFor\(k\.queuePollMs\)/.test(readFileSync(join(__dirname, "../src/services/primaryRunner.ts"), "utf8")));

  console.log("\n  the loop, with a fake clock");
  const noop = () => {};
  {
    const clock = new FakeClock();
    const at: number[] = [];
    const loop = new PrimaryQueueLoop({
      agent: { runOnce: async () => { at.push(clock.t); return { held: true, settled: [], results: [] }; } } as any,
      pollMs: JOB_POLL_MS, busyMs: 2_000, log: noop, rand: Math.random, setTimer: clock.set, clearTimer: clock.clear,
    });
    loop.start();
    await clock.advanceTo(10 * 60_000);
    loop.stop();
    const gaps = at.slice(1).map((t, i) => t - at[i]);
    ok("a healthy 10 minutes asks about every 30 s: every gap is 27 s to 33 s", gaps.length > 0 && gaps.every((g) => g >= 27_000 && g <= 33_000), gaps.join());
    ok(`and makes about 20 rounds in 10 minutes (the old loop made 60): ${at.length}`, at.length >= 18 && at.length <= 23);
    ok("the gaps are not all equal (jitter is applied each cycle)", new Set(gaps).size > 3);
  }
  {
    const clock = new FakeClock();
    const at: number[] = [];
    const loop = new PrimaryQueueLoop({
      agent: { runOnce: async () => { at.push(clock.t); return { held: true, settled: [], results: [] }; } } as any,
      pollMs: JOB_POLL_MS, busyMs: 2_000, log: noop, rand: () => 0.5, setTimer: clock.set, clearTimer: clock.clear,
    });
    loop.start();
    await clock.advanceTo(95_000);
    loop.stop();
    ok("with the jitter at its middle the rounds start at 0, 30, 60, 90 s", at.join() === "0,30000,60000,90000", at.join());
  }

  console.log("\n  one round at a time");
  {
    let started = 0; let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const loop = new PrimaryQueueLoop({ agent: { runOnce: async () => { started++; await gate; return { held: true, settled: [], results: [] }; } } as any, pollMs: JOB_POLL_MS, busyMs: 2_000, log: noop });
    const first = loop.tick();
    const second = await loop.tick();
    const third = await loop.tick();
    ok("a call while a round is running does nothing and starts no second round", started === 1 && second === JOB_POLL_MS && third === JOB_POLL_MS && loop.status.busy);
    release(); await first;
    await loop.tick();
    ok("when it ends the next call may start a round", !loop.status.busy && started === 2);
  }
  {
    const clock = new FakeClock();
    let running = 0, maxRunning = 0, started = 0;
    const loop = new PrimaryQueueLoop({
      agent: { runOnce: async () => { started++; running++; maxRunning = Math.max(maxRunning, running); await new Promise<void>((r) => clock.set(r, 100_000)); running--; return { held: true, settled: [], results: [] }; } } as any,
      pollMs: JOB_POLL_MS, busyMs: 2_000, log: noop, rand: () => 0.5, setTimer: clock.set, clearTimer: clock.clear,
    });
    loop.start();
    await clock.advanceTo(10 * 60_000);
    loop.stop();
    ok("a round that takes 100 s never overlaps the next one; the wait counts from its end", maxRunning === 1 && started === 5, `max ${maxRunning}, started ${started}`);
  }

  console.log("\n  slowing down when the database is slow");
  {
    const clock = new FakeClock();
    const lines: string[] = [];
    const times: number[] = [];
    let broken = true;
    const loop = new PrimaryQueueLoop({
      agent: { runOnce: async () => { times.push(clock.t); if (broken) throw new Error("erp_agent_take_lease: canceling statement due to statement timeout"); return { held: true, settled: [], results: [] }; } } as any,
      pollMs: JOB_POLL_MS, busyMs: 2_000, log: (l) => lines.push(l), rand: () => 0.5, setTimer: clock.set, clearTimer: clock.clear,
    });
    loop.start();
    await clock.advanceTo(10 * 60_000);
    ok("a database failing for 10 minutes: calls at 0, 30, 90, 210, 450 s, five calls (the old loop made 13)", times.join() === "0,30000,90000,210000,450000", times.join());
    ok("each failure is one plain log line that says how many in a row and the next wait", lines.length === 5 && /round failed \(1 in a row\).*Next try in 30 s\./.test(lines[0]) && /\(4 in a row\).*Next try in 240 s\./.test(lines[3]) && /\(5 in a row\).*Next try in 300 s\./.test(lines[4]), lines.join(" | "));
    ok("the loop notes the failure and counts it", loop.status.errors === 5 && /^round failed: .*statement timeout/.test(loop.status.lastNote ?? ""));
    broken = false;
    await clock.advanceTo(10 * 60_000 + 300_000 + 1);
    ok("one good round after the outage: it says so and goes back to 30 s", /the database answers again; asking every 30 s/.test(lines[lines.length - 1] ?? "") && loop.status.errors === 5, lines[lines.length - 1]);
    const before = times.length;
    await clock.advanceTo(clock.t + 95_000);
    loop.stop();
    ok("then polls every 30 s again (3 rounds in the next 95 s)", times.length - before === 3, `${times.length - before}`);
  }
  {
    const clock = new FakeClock();
    const times: number[] = [];
    const loop = new PrimaryQueueLoop({
      agent: { runOnce: async () => { times.push(clock.t); throw new Error("fetch failed"); } } as any,
      pollMs: JOB_POLL_MS, busyMs: 2_000, log: noop, rand: () => 1, setTimer: clock.set, clearTimer: clock.clear,
    });
    loop.start();
    await clock.advanceTo(60 * 60_000);
    loop.stop();
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    ok("with the jitter at its top, a long outage never waits more than 300 s", Math.max(...gaps) <= 300_000, `${Math.max(...gaps)}`);
    ok("an hour of outage costs about a dozen calls, not hundreds", times.length <= 16, `${times.length}`);
  }
  {
    const clock = new FakeClock();
    let calls = 0;
    const loop = new PrimaryQueueLoop({
      agent: { runOnce: async () => { calls++; throw new Error("x"); } } as any,
      pollMs: JOB_POLL_MS, busyMs: 2_000, log: noop, rand: Math.random, setTimer: clock.set, clearTimer: clock.clear,
    });
    loop.start();
    await clock.advanceTo(10 * 60_000);
    loop.stop();
    ok(`with real jitter the 10 minute outage is still 5 or 6 calls: ${calls}`, calls >= 5 && calls <= 6);
  }

  console.log("\n  the report runner's 20 s timer backs off too");
  {
    let calls = 0; let broken = true;
    const chain: any = new Proxy(function () {}, {
      get: (_t, k) => (k === "then" ? (res: (v: unknown) => void) => res(broken ? { data: null, error: { message: "statement timeout" } } : { data: [], error: null }) : () => chain),
      apply: () => chain,
    });
    const client = { from: () => { calls++; return chain; } } as any;
    let now = 0;
    const silent = console.error; const lines: string[] = [];
    console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
    const runner = new ReportRunner(client, "http://t", { count: () => 0, add: noop }, () => now, { has: () => false, add: noop });
    for (now = 0; now <= 600_000; now += REPORT_POLL_MS) await runner.drain(true);
    const failing = calls;
    ok(`a database failing for 10 minutes: 12 reads (6 looks) from the timer, was 62 at 20 s: ${failing}`, failing === 12, String(failing));
    ok("each failure says how many in a row and when it tries next", lines.some((l) => /\(5 in a row\).*Next try in 300 s\./.test(l)), lines.join(" | "));
    calls = 0; now = 700_000; await runner.drain(false);
    ok("a new job announced by the database looks at once, whatever the back-off", calls === 2, String(calls));
    broken = false; calls = 0;
    now = 1_000_000; await runner.drain(true);
    const afterGood = calls; calls = 0; now = 1_000_000 + REPORT_POLL_MS; await runner.drain(true);
    console.error = silent;
    ok("one good read ends the back-off: the next timer tick looks again", afterGood === 2 && calls === 2, `${afterGood} ${calls}`);
    ok("the poll time is still 20 s", REPORT_POLL_MS === 20_000);
  }

  console.log("\n  the three calls keep their order and meaning");
  {
    const dir = mkdtempSync(join(tmpdir(), "job-poll-"));
    const m = memErpQueue();
    const seen: string[] = [];
    const q = m.queue;
    const spy = { ...q,
      takeLease: async (...a: Parameters<typeof q.takeLease>) => { seen.push("erp_agent_take_lease"); return q.takeLease(...a); },
      myOpenJobs: async () => { seen.push("erp_my_open_jobs"); return q.myOpenJobs!(); },
      claim: async (...a: Parameters<typeof q.claim>) => { seen.push("claim_erp_jobs"); return q.claim(...a); },
    } as typeof q;
    const agent = new ErpJobAgent({ queue: spy, journal: new Journal(join(dir, "j.jsonl")), company: "ZZ OFFICE CO", find: async () => [], pin: async () => null, jobLeaseSeconds: 120, wait: async () => {}, leaseSeconds: leaseSecondsFor(JOB_POLL_MS) } as any);
    const loop = new PrimaryQueueLoop({ agent, pollMs: JOB_POLL_MS, busyMs: 2_000, log: noop });
    const wait = await loop.tick();
    ok("an idle round: take the lease, list this machine's open jobs, claim, in that order, once each", seen.join() === "erp_agent_take_lease,erp_my_open_jobs,claim_erp_jobs", seen.join());
    ok("and it waits the 30 s poll time", wait === JOB_POLL_MS);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
