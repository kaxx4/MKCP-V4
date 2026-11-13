/**
 * D-M.248 item 2, offline: the single-primary mode's loops (services/primaryRunner.ts). OFF unless MKCP_PRIMARY_MODE=on.
 *   - the configuration: every missing setting is named, and the mode never half-starts;
 *   - the queue loop drives the real job agent: works a real job when the pin holds, backs off on errors, stops when told;
 *   - the mirror loop asks the planner and runs the work in its order, waits for the queue, pauses when the database says the mirror is off;
 *   - the planner's inputs are read from the mirror's tables (a fake client);
 *   - startPrimaryMode: off means nothing, a missing setting means nothing starts and the reasons are logged, a complete setting starts both loops.
 * No Tally, no database: fakes only.
 *
 *   npx tsx scripts/test-primary-runner.ts
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErpJobAgent, Journal } from "../src/services/erpJobAgent.js";
import { readPrimaryConfig, PrimaryQueueLoop, PrimaryMirrorLoop, supabaseMirrorPlanSource, startPrimaryMode, type MirrorRunners, type MirrorPlanSource } from "../src/services/primaryRunner.js";
import type { SafePushResult } from "../src/services/safePush.js";
import type { VoucherPayload } from "../src/types.js";
import type { MirrorStore, MirrorTally } from "../src/services/erpMirrorSync.js";
import { memErpQueue } from "./rigs/lib/memErpQueue.js";
import { rigPayload, indiaToday } from "./rigs/lib/simTally.js";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
};
const GUID = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-8888-4777-8666-444444444444";
const NAME = "ZZ OFFICE CO - (from 1-Apr-26)";
const dir = mkdtempSync(join(tmpdir(), "primary-runner-"));
const good = (extra: Record<string, string> = {}): Record<string, string> => ({
  MKCP_PRIMARY_MODE: "on", MKCP_PRIMARY_COMPANY_GUID: GUID, MKCP_PRIMARY_COMPANY: NAME, MKCP_AGENT_MACHINE_ID: "office-pc-1",
  MKCP_ERP_AGENT_KEY: "k".repeat(64), SUPABASE_SERVICE_KEY: "s", MKCP_ERP_JOURNAL_PATH: join(dir, "main.jsonl"), ...extra,
});
const without = (e: Record<string, string>, ...ks: string[]) => { const o = { ...e }; for (const k of ks) delete o[k]; return o; };
const listing = (cos: Array<[string, string]>) => `<ENVELOPE><BODY><DATA><COLLECTION>${cos.map(([n, g]) => `<COMPANY NAME="${n}"><NAME>${n}</NAME><GUID>${g}</GUID></COMPANY>`).join("")}</COLLECTION></DATA></BODY></ENVELOPE>`;
const noop = () => {};

(async () => {
  console.log("\n  the configuration");
  {
    const c = readPrimaryConfig("http://t", good());
    ok("a complete setting reads", c.ok && c.cfg.machine === "office-pc-1" && c.cfg.company === NAME && c.cfg.companyKey === NAME);
    ok("the defaults are 10 s polling and a 5 minute mirror pass", c.ok && c.cfg.queuePollMs === 10_000 && c.cfg.mirrorTickMs === 300_000);
    const cases: Array<[string, string[], RegExp]> = [
      ["the mode off", ["MKCP_PRIMARY_MODE"], /MKCP_PRIMARY_MODE is not on/],
      ["no pinned GUID", ["MKCP_PRIMARY_COMPANY_GUID"], /MKCP_PRIMARY_COMPANY_GUID is not set/],
      ["no machine id", ["MKCP_AGENT_MACHINE_ID"], /MKCP_AGENT_MACHINE_ID is not set/],
      ["no machine key", ["MKCP_ERP_AGENT_KEY"], /MKCP_ERP_AGENT_KEY is not set/],
      ["no database key", ["SUPABASE_SERVICE_KEY"], /SUPABASE_SERVICE_KEY is not set/],
    ];
    for (const [what, drop, re] of cases) {
      const r = readPrimaryConfig("http://t", without(good(), ...drop));
      ok(`${what}: it cannot start and says why`, !r.ok && r.problems.some((p) => re.test(p)), r.ok ? "started" : r.problems.join(" | "));
    }
    const sb = readPrimaryConfig("http://t", good({ MKCP_TALLY_ROLE: "sandbox" }));
    ok("a sandbox machine cannot run the mode", !sb.ok && sb.problems.some((p) => /sandbox/.test(p)));
    const off = readPrimaryConfig("http://t", good({ MKCP_OFFLINE: "true" }));
    ok("offline mode is named as a problem", !off.ok && off.problems.some((p) => /MKCP_OFFLINE/.test(p)));
    const bad = readPrimaryConfig("http://t", good({ MKCP_COMPANY_YEARS: "not json" }));
    ok("a bad company list is a problem, never half-used", !bad.ok && bad.problems.some((p) => /company list/.test(p)));
    ok("the key is never part of a problem line", !(readPrimaryConfig("http://t", without(good(), "MKCP_PRIMARY_COMPANY_GUID")) as any).problems.join(" ").includes("kkkk"));
  }

  console.log("\n  the queue loop");
  {
    const saved = { ...process.env };
    Object.assign(process.env, good());
    const day = indiaToday();
    const pl = (n: number): VoucherPayload & { label: string } => ({ ...rigPayload("PRIM", n, day), label: "real job" });
    const m = memErpQueue();
    const id = m.add(pl(1), false);
    const pushed: string[] = [];
    const agent = new ErpJobAgent({
      queue: m.queue, journal: new Journal(join(dir, "q1.jsonl")), company: NAME,
      push: async (_c, p): Promise<SafePushResult> => { pushed.push(String(p.remoteId)); return { ok: true, stage: "done", voucherId: "7001", errors: [], warnings: [], differences: [] }; },
      find: async () => [], pin: async () => null, leaseSeconds: 90, jobLeaseSeconds: 120, wait: async () => {},
    });
    const loop = new PrimaryQueueLoop({ agent, pollMs: 10_000, busyMs: 2_000, log: noop });
    const d1 = await loop.tick();
    ok("a round works a real job and asks for the next round soon", m.rows.get(id)!.state === "succeeded" && pushed.length === 1 && d1 === 2_000, `${m.rows.get(id)!.state} ${d1}`);
    const d2 = await loop.tick();
    ok("an idle round waits the poll time", d2 === 10_000 && loop.status.lastNote === "idle");
    ok("the loop counts rounds and notes the time", loop.status.rounds === 2 && loop.status.lastAt !== null && !loop.status.busy);

    let n = 0;
    const flaky = new PrimaryQueueLoop({ agent: { runOnce: async () => { if (++n <= 4) throw new Error("socket hang up"); return { held: true, settled: [], results: [] }; } } as any, pollMs: 10_000, busyMs: 2_000, log: noop });
    const ds = [await flaky.tick(), await flaky.tick(), await flaky.tick(), await flaky.tick()];
    ok("a failing round backs off: 5 s, 10 s, 20 s, 40 s", ds.join() === "5000,10000,20000,40000", ds.join());
    ok("a round that throws never throws out of the loop, and is counted", flaky.status.errors === 4 && /round failed: socket hang up/.test(flaky.status.lastNote ?? ""));
    ok("the back-off resets after a good round", (await flaky.tick()) === 10_000 && (await new PrimaryQueueLoop({ agent: { runOnce: async () => { throw new Error("x"); } } as any, pollMs: 1, busyMs: 1, log: noop }).tick()) === 5_000);
    let many = 0;
    const always = new PrimaryQueueLoop({ agent: { runOnce: async () => { many++; throw new Error("x"); } } as any, pollMs: 1, busyMs: 1, log: noop });
    let last = 0; for (let i = 0; i < 8; i++) last = await always.tick();
    ok("the back-off stops at 60 s", last === 60_000 && many === 8);

    const held = new PrimaryQueueLoop({ agent: { runOnce: async () => ({ held: false, stopped: "the queue lease is held by another boot; waiting", settled: [], results: [] }) } as any, pollMs: 10_000, busyMs: 2_000, log: noop });
    ok("not holding the lease: it waits the poll time and says why", (await held.tick()) === 10_000 && /lease is held/.test(held.status.lastNote ?? ""));

    let runs = 0;
    const live = new PrimaryQueueLoop({ agent: { runOnce: async () => { runs++; return { held: true, settled: [], results: [] }; } } as any, pollMs: 5, busyMs: 5, log: noop });
    live.start(); live.start();
    await new Promise((r) => setTimeout(r, 60));
    live.stop();
    const at = runs;
    await new Promise((r) => setTimeout(r, 40));
    ok("start runs rounds on a timer; a second start changes nothing; stop ends them", at >= 3 && runs === at && !live.status.running, `${at} ${runs}`);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    for (const k of Object.keys(good())) if (!(k in saved)) delete process.env[k];
  }

  console.log("\n  the mirror loop");
  const calls: string[] = [];
  const fakeStore = (extra: Partial<MirrorStore> = {}): MirrorStore => ({
    isTest: false, scrubSalt: null, acceptedRuns: async () => [], lastFullRun: async () => ({ run_id: "r0", finished_at: new Date().toISOString() }), ...extra,
  }) as unknown as MirrorStore;
  const tally = {} as MirrorTally;
  const plan = (o: Partial<{ hasMark: boolean; fullDue: boolean; lastCheck: Date | null; repulls: number }> = {}): MirrorPlanSource => ({
    hasMark: async () => o.hasMark ?? true, fullDue: async () => o.fullDue ?? false,
    lastCheckAt: async () => (o.lastCheck === undefined ? new Date() : o.lastCheck), queuedRepulls: async () => o.repulls ?? 0,
  });
  const runners = (over: Partial<MirrorRunners> = {}): MirrorRunners => ({
    mirror: async (_s, _t, kind) => { calls.push(kind); return { state: "swapped", error: null }; },
    check: async () => { calls.push("check"); return { state: "ok", error: null }; },
    repull: (() => { let left = 2; return async () => { if (left-- <= 0) return null; calls.push("repull"); return { state: "swapped", error: null }; }; })(),
    accepted: async () => { calls.push("accepted"); return [{ state: "swapped" }]; },
    ...over,
  });
  const mk = (p: MirrorPlanSource, r: MirrorRunners, extra: Partial<ConstructorParameters<typeof PrimaryMirrorLoop>[0]> = {}) =>
    new PrimaryMirrorLoop({ store: fakeStore(), tally, plan: p, tickMs: 1000, log: noop, runners: r, ...extra });
  {
    calls.length = 0;
    const t = await mk(plan({ hasMark: false, lastCheck: null, repulls: 2 }), runners()).tick();
    ok("no mark yet: a full run, then the nightly check, then the re-pulls, in that order", calls.join() === "full,check,repull,repull" && t.planned.join() === "full,check,repull", calls.join());
  }
  {
    calls.length = 0;
    await mk(plan(), runners()).tick();
    ok("a mark, a recent check, nothing queued: only an incremental", calls.join() === "incremental");
  }
  {
    calls.length = 0;
    const t = await mk(plan({ fullDue: true }), runners(), { store: fakeStore({ acceptedRuns: async () => [{ acceptance: "a", run_id: "r" }] }) }).tick();
    ok("an Owner-accepted drop is applied first, before any run that swaps", t.planned[0] === "apply_accepted" && calls[0] === "accepted" && calls[1] === "full");
  }
  {
    calls.length = 0;
    let masters = 0;
    await mk(plan({ hasMark: false }), runners(), { masters: async () => { masters++; return { ok: true, error: null }; } }).tick();
    ok("after a full run that swapped, the masters of the swap store are run", masters === 1);
    calls.length = 0; masters = 0;
    await mk(plan(), runners(), { masters: async () => { masters++; return { ok: true, error: null }; } }).tick();
    ok("not after an incremental", masters === 0);
    masters = 0;
    await mk(plan({ hasMark: false }), runners({ mirror: async () => ({ state: "refused", error: "a big drop" }) }), { masters: async () => { masters++; return { ok: true, error: null }; } }).tick();
    ok("not after a run the database refused, and the pass stops there", masters === 0);
  }
  {
    calls.length = 0;
    const t = await mk(plan({ lastCheck: null, repulls: 1 }), runners({ mirror: async () => ({ state: "failed", error: "Tally did not answer" }) })).tick();
    ok("a failed run ends the pass; the next pass plans again", t.did.length === 1 && t.did[0].state === "failed" && !calls.includes("check"));
  }
  {
    let busy = true;
    calls.length = 0;
    const loop = mk(plan(), runners(), { queueBusy: () => busy });
    const t1 = await loop.tick();
    busy = false;
    const t2 = await loop.tick();
    ok("while the queue is mid-round the mirror starts nothing", /waits/.test(t1.skipped ?? "") && t1.did.length === 0 && t2.did.length === 1);
  }
  {
    let now = Date.parse("2026-12-01T10:00:00Z");
    let n = 0;
    const loop = mk(plan(), runners({ mirror: async () => { n++; return { state: "failed", error: "refused: the ERP mirror sync is off until go-live (erp_sync_control live_mirror)" }; } }), { now: () => now });
    await loop.tick();
    const t2 = await loop.tick();
    ok("the database saying the mirror is off pauses the loop (no hammering)", n === 1 && /paused/.test(t2.skipped ?? ""));
    now += 16 * 60_000;
    await loop.tick();
    ok("the pause ends after 15 minutes", n === 2);
  }
  {
    const loop = mk({ ...plan(), hasMark: async () => { throw new Error("erp_sync_marks: permission denied"); } }, runners());
    const t = await loop.tick();
    ok("a pass that cannot read the planner's inputs does nothing, notes why, and never throws", t.did.length === 0 && loop.status.errors === 1 && /permission denied/.test(loop.status.lastNote ?? ""));
  }

  console.log("\n  the planner's inputs from the tables");
  {
    const seen: string[] = [];
    const rows: Record<string, any[]> = {
      erp_sync_marks: [{ alter_id: 5, full_due: true }], erp_sync_day_checks: [{ checked_at: "2026-12-01T01:00:00Z" }], erp_sync_repulls: [],
    };
    const from = (table: string) => {
      const q: any = {
        select: (_c: string, o?: any) => { q.head = !!o?.head; return q; },
        eq: (col: string, v: unknown) => { seen.push(`${table}.${col}=${v}`); return q; },
        order: () => q, limit: async () => ({ data: rows[table], error: null }),
        then: (res: (v: unknown) => void) => res({ count: 3, error: null }),
      };
      return q;
    };
    const src = supabaseMirrorPlanSource({ from }, "ZZ OFFICE CO");
    ok("the mark is read for the company, real rows only", (await src.hasMark()) === true && seen.includes("erp_sync_marks.company_key=ZZ OFFICE CO") && seen.includes("erp_sync_marks.is_test=false"));
    ok("full_due and the last check are read", (await src.fullDue()) === true && (await src.lastCheckAt())?.toISOString() === "2026-12-01T01:00:00.000Z");
    ok("queued re-pulls are counted", (await src.queuedRepulls()) === 3);
    rows.erp_sync_marks = [];
    ok("no mark row means no mark, and no full_due", (await src.hasMark()) === false && (await src.fullDue()) === false);
  }

  console.log("\n  starting the mode");
  {
    const logs: string[] = [];
    const log = (l: string) => logs.push(l);
    const client = { rpc: async (fn: string) => ({ data: fn === "erp_agent_take_lease" ? { held: false, holder: "other", db_now: new Date().toISOString(), conflict: false } : null, error: null }), from: () => ({}) };
    ok("mode off: nothing starts and nothing is said", startPrimaryMode("http://t", {}, { log, client }) === null && logs.length === 0);
    ok("mode on, GUID unset: nothing starts, the reason is logged, the key is not", startPrimaryMode("http://t", without(good(), "MKCP_PRIMARY_COMPANY_GUID"), { log, client }) === null && logs.some((l) => /MKCP_PRIMARY_COMPANY_GUID is not set/.test(l)) && !logs.join(" ").includes("kkkk"));
    logs.length = 0;
    ok("mode on on a sandbox machine: nothing starts", startPrimaryMode("http://t", good({ MKCP_TALLY_ROLE: "sandbox" }), { log, client }) === null && logs.some((l) => /sandbox/.test(l)));
    logs.length = 0;
    const saved = process.env.MKCP_TALLY_ROLE; delete process.env.MKCP_TALLY_ROLE;
    const h = startPrimaryMode("http://t", good(), { log, client, post: async () => listing([[NAME, GUID]]) });
    ok("a complete setting starts both loops and says which machine and company", !!h && logs.some((l) => /office-pc-1/.test(l)) && !logs.join(" ").includes("kkkk"));
    await new Promise((r) => setTimeout(r, 80));
    const st = h!.status();
    ok("the status shows the mode, the machine, the company and both loops", st.mode === "primary" && st.machine === "office-pc-1" && st.company === NAME && st.queue.running && st.mirror.running);
    ok("the first queue round ran against the (fake) database and found the lease held elsewhere", st.queue.rounds >= 1 && /lease is held/.test(String(st.queue.lastNote)), String(st.queue.lastNote));
    h!.stop();
    ok("stop ends both loops", !h!.status().queue.running && !h!.status().mirror.running);
    if (saved !== undefined) process.env.MKCP_TALLY_ROLE = saved;
  }

  console.log("\n  the two doors that are shut on the office PC");
  {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    ok("/api/local/push and /api/tally/debug carry the closed-door guard", src.includes('app.post("/api/local/push", primaryClosed,') && src.includes('app.post("/api/tally/debug", primaryClosed,'));
    ok("the guard lets everything through when the mode is off", /const primaryClosed[^;]{0,120}=> [{][^}]{0,80}if [(]!primaryModeOn[(][)][)] return next[(][)];/.test(src));
    ok("the mode is started from index.ts through startPrimaryMode, once", (src.match(/startPrimaryMode[(]/g) ?? []).length === 1);
    /* D-M.256 item 7: every other hand door to the live books is shut too, and the old push agent does not start beside the primary. */
    ok("/api/bank/push, /api/push-agent/drain and /api/push-agent/requeue carry the closed-door guard",
      src.includes('app.post("/api/bank/push", primaryClosed,') && src.includes('app.post("/api/push-agent/drain", primaryClosed,') && src.includes('app.post("/api/push-agent/requeue", primaryClosed,'));
    ok("the old push agent is not started when the single-primary mode is on", /PUSH_AGENT_ENABLED === "true" && !primaryModeOn\(\)/.test(src));
  }

  console.log("\n  D-M.256 items 7 and 8: start-up refusals");
  {
    const c1 = readPrimaryConfig("http://t", good({ PUSH_AGENT_ENABLED: "true" }));
    ok("PUSH_AGENT_ENABLED=true: the mode refuses to start, in plain words", !c1.ok && c1.problems.some((p) => /PUSH_AGENT_ENABLED=true/.test(p) && /ERP queue/.test(p)));
    ok("PUSH_AGENT_ENABLED=false (or unset) is fine", readPrimaryConfig("http://t", good({ PUSH_AGENT_ENABLED: "false" })).ok && readPrimaryConfig("http://t", good()).ok);
    const c2 = readPrimaryConfig("http://t", without(good(), "MKCP_ERP_JOURNAL_PATH"));
    ok("no MKCP_ERP_JOURNAL_PATH: the mode refuses to start (no default folder)", !c2.ok && c2.problems.some((p) => /MKCP_ERP_JOURNAL_PATH is not set/.test(p)));
    const c3 = readPrimaryConfig("http://t", good({ MKCP_ERP_JOURNAL_PATH: "data/journal.jsonl" }));
    ok("a relative journal path is refused", !c3.ok && c3.problems.some((p) => /absolute path/.test(p)));

    // A failure while starting is logged as "cannot start" and never thrown.
    const logs: string[] = [];
    const client = { rpc: async () => ({ data: null, error: null }), from: () => ({}) };
    const file = join(dir, "a-file.txt");
    (await import("node:fs")).writeFileSync(file, "x");
    const saved = process.env.MKCP_TALLY_ROLE; delete process.env.MKCP_TALLY_ROLE;
    let threw = false, h: ReturnType<typeof startPrimaryMode> = null;
    try { h = startPrimaryMode("http://t", good({ MKCP_ERP_JOURNAL_PATH: join(file, "sub", "j.jsonl") }), { log: (l) => logs.push(l), client, post: async () => listing([[NAME, GUID]]) }); }
    catch { threw = true; }
    ok("a start-up failure (the journal folder cannot be made) does not throw", !threw && h === null);
    ok("it is logged as 'cannot start: <reason>'", logs.some((l) => /cannot start: /.test(l)), logs.join("|").slice(0, 200));
    if (saved !== undefined) process.env.MKCP_TALLY_ROLE = saved;
  }

  console.log("\n  D-M.256 item 6: the mirror loop checks the pin before each piece of work");
  {
    calls.length = 0;
    let why: string | null = "refused: not the pinned company. Nothing was sent to Tally.";
    const loop = mk(plan({ hasMark: false, lastCheck: null, repulls: 1 }), runners(), { pin: async () => why });
    const t = await loop.tick();
    ok("pin fails: no work runs at all (a full run in particular), and the pass says why", calls.length === 0 && /not confirmed/.test(t.skipped ?? "") && t.did.length === 0, calls.join());
    why = null; calls.length = 0;
    await mk(plan({ hasMark: false, lastCheck: null, repulls: 1 }), runners(), { pin: async () => why }).tick();
    ok("pin holds: the work runs in order", calls.join() === "full,check,repull,repull", calls.join());
    calls.length = 0;
    let n = 0;
    await mk(plan({ hasMark: false, lastCheck: null, repulls: 1 }), runners(), { pin: async () => (++n === 1 ? null : "refused: gone") }).tick();
    ok("the pin is asked again before the NEXT piece of work: it changed after the full run, so the check does not run", calls.join() === "full", calls.join());
    calls.length = 0;
    await mk(plan(), runners(), { pin: async () => { throw new Error("socket hang up"); } }).tick();
    ok("a pin check that cannot run is a refusal: nothing runs", calls.length === 0);
    calls.length = 0;
    let masters = 0, pinAsked = 0;
    await mk(plan({ fullDue: true }), runners(), { masters: async () => { masters++; return { ok: true, error: null }; }, pin: async () => (++pinAsked === 1 ? null : "refused: gone") }).tick();
    ok("the pin is asked again before the masters load that follows a full run", masters === 0 && calls.join() === "full", `${masters} ${calls.join()}`);
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
