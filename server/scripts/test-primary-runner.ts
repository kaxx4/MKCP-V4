/**
 * D-M.248 item 2, offline: the single-primary mode's loops (services/primaryRunner.ts). OFF unless MKCP_PRIMARY_MODE=on.
 *   - the configuration: every missing setting is named, and the mode never half-starts;
 *   - the queue loop drives the real job agent: works a real job when the pin holds, backs off on errors, stops when told;
 *   - the mirror loop asks the planner and runs the work in its order, waits for the queue, pauses when the database says the mirror is off;
 *   - the planner's inputs are read from the mirror's tables (a fake client);
 *   - housekeeping: the once-a-day change-signal prune (D-M.262), counted in the status and the journal, off with the mode;
 *   - startPrimaryMode: off means nothing, a missing setting means nothing starts and the reasons are logged, a complete setting starts both loops.
 * No Tally, no database: fakes only.
 *
 *   npx tsx scripts/test-primary-runner.ts
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErpJobAgent, Journal } from "../src/services/erpJobAgent.js";
import { readPrimaryConfig, PrimaryQueueLoop, PrimaryMirrorLoop, PrimaryHousekeeping, guardedMirrorStore, guardedMirrorTally, supabaseMirrorPlanSource, startPrimaryMode, type MirrorRunners, type MirrorPlanSource } from "../src/services/primaryRunner.js";
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

  console.log("\n  D-M.263 item 2: the pin is asked FRESH right before the swap");
  {
    const calls: string[] = [];
    const base = {
      isTest: false, scrubSalt: null, companyKey: "ZZ",
      swap: async (run: string, mark: number) => { calls.push(`swap ${run} ${mark}`); return { state: "swapped" }; },
      swapAccepted: async (run: string) => { calls.push(`swapAccepted ${run}`); return { state: "swapped" }; },
      checkDays: async () => { calls.push("checkDays"); return {}; },
      step: async () => { calls.push("step"); },
    } as unknown as import("../src/services/erpMirrorSync.js").MirrorStore;
    let pinAnswer: string | null = null; let asked = 0; let throws = false;
    const g = guardedMirrorStore(base, async () => { asked++; if (throws) throw new Error("socket hang up"); return pinAnswer; });
    await g.swap("r1", 7);
    ok("a swap with the pin holding goes through, after one fresh pin check", calls.join() === "swap r1 7" && asked === 1, `${calls.join()} ${asked}`);
    ok("other store calls and fields are the real store's", g.isTest === false && g.companyKey === "ZZ" && typeof g.step === "function");
    calls.length = 0; pinAnswer = "refused: another company is open";
    let err = ""; try { await g.swap("r2", 8); } catch (e) { err = (e as Error).message; }
    ok("a mismatch refuses the swap BEFORE the store is called", /refused: the pinned company is not confirmed right before the swap/.test(err) && calls.length === 0, `${err} | ${calls.join()}`);
    err = ""; try { await g.swapAccepted("r3"); } catch (e) { err = (e as Error).message; }
    ok("an accepted drop's swap is held to the same check", /an accepted swap/.test(err) && calls.length === 0);
    err = ""; try { await g.checkDays(1, []); } catch (e) { err = (e as Error).message; }
    ok("the nightly day check (which queues re-pulls from what Tally said) is too", /day check/.test(err) && calls.length === 0);
    pinAnswer = null; throws = true; err = "";
    try { await g.swap("r4", 9); } catch (e) { err = (e as Error).message; }
    ok("a pin that cannot be checked refuses the swap as well", /could not be checked/.test(err) && calls.length === 0, err);
    throws = false; asked = 0; calls.length = 0;
    await g.swap("r5", 1); await g.swap("r6", 2);
    ok("every swap asks again: the answer is never reused from before", asked === 2 && calls.length === 2, `${asked} ${calls.length}`);
    /* The tally wrapper remembers a good answer for 60 s; the store wrapper must not. */
    let t = 0; let tallyAsks = 0;
    const gt = guardedMirrorTally({ highest: async () => ({ alterId: 1, vouchers: [] }), vouchersOn: async () => [], changedSince: async () => [], ledgers: async () => [], loadedPeriod: async () => ({}) } as any, async () => { tallyAsks++; return null; }, 60_000, () => t);
    await gt.highest(); await gt.highest();
    ok("(the reads remember a good answer for 60 s: that is why the swap needs its own fresh one)", tallyAsks === 1);
    const src = readFileSync(new URL("../src/services/primaryRunner.ts", import.meta.url), "utf8");
    ok("the mode builds its store through guardedMirrorStore", /const store = guardedMirrorStore[(]supabaseMirrorStore/.test(src));
  }

  console.log("\n  D-M.263 item 3: a restart does not prune again the same day");
  {
    const calls: string[] = [];
    const client = { rpc: async (fn: string) => { calls.push(fn); return { data: 4, error: null }; } };
    const jf = join(dir, "hk-restart.jsonl");
    const j = new Journal(jf);
    j.append({ kind: "housekeeping", task: "signals-prune", pruned: 9, error: null, at: new Date(Date.now() - 700).toISOString() });
    const early = new PrimaryHousekeeping({ client, journal: j, firstMs: 20, everyMs: 1000, log: noop });
    early.start();
    ok("the last good prune is read from the journal on start", early.status.lastGoodPruneAt !== null);
    await new Promise((r) => setTimeout(r, 120));
    ok("a prune 0.7 s ago (of a 1 s interval): nothing yet after 0.12 s, not at the first-run wait", calls.length === 0, String(calls.length));
    await new Promise((r) => setTimeout(r, 300));
    early.stop();
    ok("it runs when the full interval since the last good prune has passed", calls.length >= 1, String(calls.length));
    calls.length = 0;
    const j2 = new Journal(join(dir, "hk-restart2.jsonl"));
    j2.append({ kind: "housekeeping", task: "signals-prune", pruned: null, error: "permission denied", at: new Date(Date.now() - 100).toISOString() });
    const failedBefore = new PrimaryHousekeeping({ client, journal: j2, firstMs: 20, everyMs: 5000, log: noop });
    failedBefore.start();
    const knewBefore = failedBefore.status.lastGoodPruneAt;
    await new Promise((r) => setTimeout(r, 120));
    failedBefore.stop();
    ok("a failed prune in the journal is no memory: the first run waits only the normal first wait", calls.length === 1 && knewBefore === null, `${calls.length}`);
    calls.length = 0;
    const blind = new PrimaryHousekeeping({ client, journal: { append() {}, entries() { throw new Error("unreadable"); } }, firstMs: 20, everyMs: 5000, log: noop });
    blind.start();
    await new Promise((r) => setTimeout(r, 120));
    blind.stop();
    ok("a journal that cannot be read means no memory, never a crash", calls.length === 1, `${calls.length}`);
  }

  console.log("\n  housekeeping: the once-a-day change-signal prune (D-M.262)");
  {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    let answer: { data: unknown; error: { message: string } | null } = { data: 12, error: null };
    const client = { rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return answer; } };
    const jf = join(dir, "hk.jsonl");
    const journal = new Journal(jf);
    const logs: string[] = [];
    const hk = new PrimaryHousekeeping({ client, journal, log: (l) => logs.push(l), now: () => Date.parse("2026-12-01T03:00:00Z") });
    await hk.tick();
    ok("it calls erp_signals_prune with seven days", calls.length === 1 && calls[0].fn === "erp_signals_prune" && calls[0].args.p_older === "7 days", JSON.stringify(calls));
    ok("the number pruned is in the status", hk.status.signalsPrunedLast === 12 && hk.status.signalsPrunedTotal === 12 && /pruned 12 change signal/.test(String(hk.status.lastNote)));
    const e = journal.entries().filter((x) => x.kind === "housekeeping");
    ok("the number pruned is in the journal, with the time", e.length === 1 && (e[0] as any).pruned === 12 && (e[0] as any).error === null && (e[0] as any).at === "2026-12-01T03:00:00.000Z");
    answer = { data: "0", error: null };
    await hk.tick();
    ok("a count the database sends as text is read; zero is a good answer", hk.status.signalsPrunedLast === 0 && hk.status.signalsPrunedTotal === 12 && hk.status.errors === 0);
    answer = { data: null, error: { message: "permission denied for function erp_signals_prune" } };
    await hk.tick();
    ok("a refused call is an error, not a prune: the last good number stays, the reason is shown and journalled", hk.status.errors === 1 && hk.status.signalsPrunedLast === 0 && /permission denied/.test(String(hk.status.lastNote)) && journal.entries().some((x) => x.kind === "housekeeping" && (x as any).error?.includes("permission denied")));
    answer = { data: null, error: null };
    await hk.tick();
    ok("an answer that is not a count is an error (an empty answer never reads as zero)", hk.status.errors === 2 && /not a count/.test(String(hk.status.lastNote)));
    const bad = new PrimaryHousekeeping({ client: { rpc: async () => { throw new Error("socket hang up"); } }, journal, log: noop });
    await bad.tick();
    ok("a thrown call never escapes the loop", bad.status.errors === 1 && /socket hang up/.test(String(bad.status.lastNote)));
    const deaf = new PrimaryHousekeeping({ client: { rpc: async () => ({ data: 3, error: null }) }, journal: { append() { throw new Error("disk full"); } }, log: (l) => logs.push(l) });
    await deaf.tick();
    ok("a journal that cannot be written is said and does not stop the prune", deaf.status.signalsPrunedLast === 3 && logs.some((l) => /disk full/.test(l)));
    ok("the journal reader still reads job replies beside the new kind", journal.lastReply("none") === null && journal.readFailures("none") === 0);

    answer = { data: 5, error: null };
    calls.length = 0;
    const timed = new PrimaryHousekeeping({ client, journal, firstMs: 30, everyMs: 40, log: noop });
    timed.start();
    await new Promise((r) => setTimeout(r, 15));
    ok("the first prune waits (not at the instant of start)", calls.length === 0);
    await new Promise((r) => setTimeout(r, 160));
    timed.stop();
    const after = calls.length;
    ok("then it repeats on its interval", after >= 2, String(after));
    await new Promise((r) => setTimeout(r, 120));
    ok("stop ends it", calls.length === after && !timed.status.running);

    const src = readFileSync(new URL("../src/services/primaryRunner.ts", import.meta.url), "utf8");
    ok("the default is one prune a day, first after ten minutes, seven days old", /everyMs \?\? 24 \* 3_600_000/.test(src) && /firstMs \?\? 600_000/.test(src) && /older \?\? "7 days"/.test(src));
    ok("the prune is built only inside the single-primary start (off when the mode is off)", (src.match(/new PrimaryHousekeeping[(]/g) ?? []).length === 1 && src.indexOf("new PrimaryHousekeeping(") > src.indexOf("function startPrimaryModeInner"));

    const seen: string[] = [];
    const spy = { rpc: async (fn: string) => { seen.push(fn); return { data: fn === "erp_agent_take_lease" ? { held: false, holder: "other", db_now: new Date().toISOString(), conflict: false } : 0, error: null }; }, from: () => ({}) };
    startPrimaryMode("http://t", {}, { log: noop, client: spy });
    await new Promise((r) => setTimeout(r, 40));
    ok("mode off: no prune call of any kind", seen.length === 0, seen.join());
    const saved2 = process.env.MKCP_TALLY_ROLE; delete process.env.MKCP_TALLY_ROLE;
    const h2 = startPrimaryMode("http://t", good(), { log: noop, client: spy, post: async () => listing([[NAME, GUID]]) });
    await new Promise((r) => setTimeout(r, 60));
    const st2 = h2!.status();
    const hkRunning = st2.housekeeping.running, hkLast = st2.housekeeping.signalsPrunedLast;
    h2!.stop();
    if (saved2 !== undefined) process.env.MKCP_TALLY_ROLE = saved2;
    ok("mode on: /api/primary/status carries the housekeeping block, running, and no prune yet at start", hkRunning && hkLast === null && !seen.includes("erp_signals_prune"));
    ok("stop ends housekeeping too", !h2!.status().housekeeping.running);
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
