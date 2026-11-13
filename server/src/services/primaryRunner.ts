/**
 * JOB: the single-primary mode's two loops (go-live dry run D-M.248, runbook D4, M1, M2): the QUEUE loop that works `erp_jobs` and the MIRROR loop that
 * keeps the ERP mirror. OFF unless MKCP_PRIMARY_MODE=on (primaryMode.ts). Nothing here is a second code path: the queue loop drives the same
 * `ErpJobAgent` the sandbox rigs drive, and the mirror loop runs the same `runMirrorSync`, `runDayCheck`, `runRepull`, `applyAcceptedDrops` and
 * `runMasters` the dummy rigs run. What is new is only who calls them and when, and that the role is the database's: the machine key says
 * `primary`, and `claim_erp_jobs` and the mirror functions give a primary machine real work only while `erp_control live_claims` and
 * `erp_sync_control live_mirror` are on (both off until go-live).
 *
 * Fail closed: the mode starts only when every line of `readPrimaryConfig` is satisfied (pinned GUID, machine id and key, database key, a company).
 * Posting still goes only through safePush, pushGuard and tallyPost; tallyPost holds every write to the pinned company again (tally.ts).
 */
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ErpJobAgent, Journal, supabaseErpQueue, tallySeams, type RunReport } from "./erpJobAgent.js";
import {
  planMirrorWork, runMirrorSync, runDayCheck, runRepull, applyAcceptedDrops, supabaseMirrorStore, tallyMirrorReads,
  type MirrorStore, type MirrorTally, type MirrorWork,
} from "./erpMirrorSync.js";
import { runMasters, supabaseMastersStore, fetchGstWithinLimit } from "./erpMasters.js";
import { loadCompanyYears, type CompanyYear } from "./companyYears.js";
import { primaryModeOn, primaryModeRefusal, primaryGuid, primaryCompanyName, primaryCompanyKey } from "./primaryMode.js";
import { agentMachineId, supabaseClient } from "./supabaseClient.js";
import { tallyCompany } from "../config/company.js";
import { tallyPost } from "../tally.js";

type Env = Record<string, string | undefined>;
type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => any; from?: (table: string) => any };

// ── Configuration ─────────────────────────────────────────────────────────────
export interface PrimaryConfig {
  tallyUrl: string;
  company: string;
  companyKey: string;
  machine: string;
  key: string;
  journalPath: string;
  companies: CompanyYear[];
  queuePollMs: number;
  queueBusyMs: number;
  mirrorTickMs: number;
}

/**
 * Pure: the mode's configuration read from the environment, or every reason it cannot start. Never prints a key. The machine key is returned
 * only to the caller that builds the queue client.
 */
export function readPrimaryConfig(tallyUrl: string, env: Env = process.env): { ok: true; cfg: PrimaryConfig } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!primaryModeOn(env)) problems.push("MKCP_PRIMARY_MODE is not on");
  const refused = primaryModeRefusal(env);
  if (refused) problems.push(refused);
  const machine = agentMachineId(env);
  if (machine === "unnamed-machine") problems.push("MKCP_AGENT_MACHINE_ID is not set (a neutral name such as office-pc-1; no row registers an unnamed machine)");
  const key = (env.MKCP_ERP_AGENT_KEY ?? "").trim();
  if (!key) problems.push("MKCP_ERP_AGENT_KEY is not set (the machine's own key; only its sha-256 is registered in the database)");
  if (!(env.SUPABASE_SERVICE_KEY ?? "").trim()) problems.push("SUPABASE_SERVICE_KEY is not set, so the agent cannot reach the database");
  if ((env.MKCP_OFFLINE ?? "").trim().toLowerCase() === "true") problems.push("MKCP_OFFLINE=true: the database is switched off for this process");
  const company = primaryCompanyName(env) || tallyCompany();
  if (!company) problems.push("no company name is set (MKCP_PRIMARY_COMPANY)");
  const years = loadCompanyYears(env as NodeJS.ProcessEnv);
  for (const p of years.problems) problems.push(`company list: ${p}`);
  if (problems.length) return { ok: false, problems };
  const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 1000 ? n : d; };
  return { ok: true, cfg: {
    tallyUrl, company, companyKey: primaryCompanyKey({ ...env, MKCP_PRIMARY_COMPANY: company }), machine, key,
    journalPath: (env.MKCP_ERP_JOURNAL_PATH ?? "").trim() || join(process.cwd(), "server", "data", "erp-job-journal.jsonl"),
    companies: years.list,
    queuePollMs: num(env.MKCP_PRIMARY_POLL_MS, 10_000), queueBusyMs: 2_000, mirrorTickMs: num(env.MKCP_PRIMARY_MIRROR_TICK_MS, 300_000),
  } };
}

// ── The queue loop ────────────────────────────────────────────────────────────
export interface LoopStatus { running: boolean; rounds: number; lastAt: string | null; lastNote: string | null; errors: number; busy: boolean }

export class PrimaryQueueLoop {
  readonly status: LoopStatus = { running: false, rounds: 0, lastAt: null, lastNote: null, errors: 0, busy: false };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fails = 0;
  constructor(private o: { agent: Pick<ErpJobAgent, "runOnce">; pollMs: number; busyMs: number; log?: (l: string) => void; now?: () => number }) {}

  /** One round. Never throws: a failed round is noted and the delay before the next one grows (5 s, 10 s ... up to 60 s). Returns that delay. */
  async tick(): Promise<number> {
    const log = this.o.log ?? ((l: string) => console.log(`[primary queue] ${l}`));
    this.status.busy = true;
    try {
      const r: RunReport = await this.o.agent.runOnce(1);
      this.fails = 0;
      this.status.rounds++;
      this.status.lastAt = new Date((this.o.now ?? Date.now)()).toISOString();
      if (!r.held) { this.status.lastNote = r.stopped ?? "not holding the queue lease"; return this.o.pollMs; }
      const n = r.results.length + r.settled.length;
      this.status.lastNote = n ? `${r.results.length} job(s) worked, ${r.settled.length} settled` : "idle";
      if (n) log(this.status.lastNote);
      return n ? this.o.busyMs : this.o.pollMs;
    } catch (e) {
      this.status.errors++;
      this.fails++;
      this.status.lastNote = `round failed: ${(e as Error).message.slice(0, 160)}`;
      log(this.status.lastNote);
      return Math.min(60_000, 5_000 * 2 ** (this.fails - 1));
    } finally { this.status.busy = false; }
  }

  start(): void {
    if (this.status.running) return;
    this.status.running = true;
    const loop = async () => {
      if (!this.status.running) return;
      const wait = await this.tick();
      if (this.status.running) { this.timer = setTimeout(loop, wait); this.timer.unref?.(); }
    };
    void loop();
  }
  stop(): void { this.status.running = false; if (this.timer) clearTimeout(this.timer); this.timer = null; }
}

// ── The mirror loop ───────────────────────────────────────────────────────────
/** What the planner needs from the database that the store does not already give. */
export interface MirrorPlanSource {
  hasMark(): Promise<boolean>;
  fullDue(): Promise<boolean>;
  lastCheckAt(): Promise<Date | null>;
  queuedRepulls(): Promise<number>;
}

/** The planner's inputs read straight from the mirror's own tables (service role, selects only). */
export function supabaseMirrorPlanSource(c: Required<Pick<Rpc, "from">>, companyKey: string): MirrorPlanSource {
  const one = async (table: string, cols: string, filter: (q: any) => any, order?: string): Promise<any[]> => {
    let q = c.from(table).select(cols).eq("company_key", companyKey).eq("is_test", false);
    q = filter(q);
    if (order) q = q.order(order, { ascending: false });
    const { data, error } = await q.limit(1);
    if (error) throw new Error(`${table}: ${error.message}`);
    return data ?? [];
  };
  return {
    hasMark: async () => (await one("erp_sync_marks", "alter_id", (q) => q.eq("object", "voucher"))).length > 0,
    fullDue: async () => !!(await one("erp_sync_marks", "full_due", (q) => q.eq("object", "voucher")))[0]?.full_due,
    lastCheckAt: async () => { const r = await one("erp_sync_day_checks", "checked_at", (q) => q, "checked_at"); return r[0]?.checked_at ? new Date(r[0].checked_at) : null; },
    queuedRepulls: async () => {
      const { count, error } = await c.from("erp_sync_repulls").select("id", { count: "exact", head: true }).eq("company_key", companyKey).eq("is_test", false).eq("state", "queued");
      if (error) throw new Error(`erp_sync_repulls: ${error.message}`);
      return count ?? 0;
    },
  };
}

/** The pieces of work the mirror loop can run. The defaults are the real ones; a test passes its own. */
export interface MirrorRunners {
  mirror(store: MirrorStore, tally: MirrorTally, kind: "full" | "incremental", log: (l: string) => void): Promise<{ state: string; error: string | null }>;
  check(store: MirrorStore, tally: MirrorTally, log: (l: string) => void): Promise<{ state: string; error: string | null }>;
  repull(store: MirrorStore, tally: MirrorTally, log: (l: string) => void): Promise<{ state: string; error: string | null } | null>;
  accepted(store: MirrorStore, log: (l: string) => void): Promise<{ state: string }[]>;
}
export const REAL_MIRROR_RUNNERS: MirrorRunners = {
  mirror: (store, tally, kind, log) => runMirrorSync({ store, tally, kind, log }),
  check: (store, tally, log) => runDayCheck({ store, tally, log }),
  repull: (store, tally, log) => runRepull({ store, tally, log }),
  accepted: (store, log) => applyAcceptedDrops({ store, log }),
};

export interface MirrorTickReport { skipped: string | null; planned: MirrorWork[]; did: { work: string; state: string; note?: string }[] }

export class PrimaryMirrorLoop {
  readonly status: LoopStatus = { running: false, rounds: 0, lastAt: null, lastNote: null, errors: 0, busy: false };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pausedUntil = 0;
  constructor(private o: {
    store: MirrorStore; tally: MirrorTally; plan: MirrorPlanSource;
    /** The masters of the swap store, run after a full mirror run (M2). Absent: skipped. */
    masters?: () => Promise<{ ok: boolean; error: string | null }>;
    /** True while the queue loop is mid-round: the mirror waits its turn rather than starting a read beside a push. */
    queueBusy?: () => boolean;
    tickMs: number; log?: (l: string) => void; now?: () => number; runners?: MirrorRunners;
  }) {}

  /** One pass: ask the planner, do each piece of work in order. Never throws. */
  async tick(): Promise<MirrorTickReport> {
    const log = this.o.log ?? ((l: string) => console.log(`[primary mirror] ${l}`));
    const now = new Date((this.o.now ?? Date.now)());
    const rep: MirrorTickReport = { skipped: null, planned: [], did: [] };
    const run = this.o.runners ?? REAL_MIRROR_RUNNERS;
    if (now.getTime() < this.pausedUntil) { rep.skipped = "paused: the database said the mirror is off"; return rep; }
    if (this.o.queueBusy?.()) { rep.skipped = "the queue is mid-round; the mirror waits"; return rep; }
    this.status.busy = true;
    try {
      const [hasMark, fullDue, lastCheckAt, queuedRepulls, accepted, last] = await Promise.all([
        this.o.plan.hasMark(), this.o.plan.fullDue(), this.o.plan.lastCheckAt(), this.o.plan.queuedRepulls(),
        this.o.store.acceptedRuns(), this.o.store.lastFullRun(),
      ]);
      rep.planned = planMirrorWork({ now, hasMark, fullDue, lastFullAt: last ? new Date(last.finished_at) : null, lastCheckAt, queuedRepulls, acceptedDrops: accepted.length });
      for (const w of rep.planned) {
        if (this.o.queueBusy?.()) { rep.skipped = "the queue became busy; the rest waits for the next pass"; break; }
        if (w === "apply_accepted") {
          const r = await run.accepted(this.o.store, log);
          rep.did.push({ work: w, state: r.every((x) => x.state === "swapped") ? "ok" : "failed", note: `${r.length} accepted drop(s)` });
        } else if (w === "full" || w === "incremental") {
          const r = await run.mirror(this.o.store, this.o.tally, w, log);
          rep.did.push({ work: w, state: r.state, note: r.error ?? undefined });
          if (r.state === "failed" && /off until go-live/i.test(r.error ?? "")) { this.pausedUntil = now.getTime() + 15 * 60_000; break; }
          if (w === "full" && r.state === "swapped" && this.o.masters) {
            const m = await this.o.masters();
            rep.did.push({ work: "masters", state: m.ok ? "ok" : "failed", note: m.error ?? undefined });
          }
          if (r.state !== "swapped") break;     // a refused or failed run stops the pass; the next pass plans again
        } else if (w === "check") {
          const r = await run.check(this.o.store, this.o.tally, log);
          rep.did.push({ work: w, state: r.state, note: r.error ?? undefined });
        } else if (w === "repull") {
          for (let i = 0; i < 7; i++) {
            const r = await run.repull(this.o.store, this.o.tally, log);
            if (!r) break;
            rep.did.push({ work: "repull", state: r.state, note: r.error ?? undefined });
            if (r.state !== "swapped") break;
          }
        }
      }
      this.status.rounds++;
      this.status.lastAt = now.toISOString();
      this.status.lastNote = rep.skipped ?? (rep.did.map((d) => `${d.work}:${d.state}`).join(", ") || "nothing due");
    } catch (e) {
      this.status.errors++;
      const msg = (e as Error).message;
      this.status.lastNote = `pass failed: ${msg.slice(0, 160)}`;
      if (/off until go-live|live_mirror/i.test(msg)) this.pausedUntil = now.getTime() + 15 * 60_000;
      log(this.status.lastNote);
      rep.skipped = this.status.lastNote;
    } finally { this.status.busy = false; }
    return rep;
  }

  start(): void {
    if (this.status.running) return;
    this.status.running = true;
    const loop = async () => {
      if (!this.status.running) return;
      await this.tick();
      if (this.status.running) { this.timer = setTimeout(loop, this.o.tickMs); this.timer.unref?.(); }
    };
    this.timer = setTimeout(loop, 30_000);        // the first pass waits half a minute, so the queue loop's first lease comes first
    this.timer.unref?.();
  }
  stop(): void { this.status.running = false; if (this.timer) clearTimeout(this.timer); this.timer = null; }
}

// ── Start it ──────────────────────────────────────────────────────────────────
export interface PrimaryHandle {
  stop(): void;
  status(): { mode: "primary"; company: string; machine: string; queue: LoopStatus; mirror: LoopStatus; agent: unknown };
}

export interface PrimaryDeps {
  /** The database client (service role). Default: the process's own. */
  client?: Rpc;
  /** One Tally request, raw reply. Default: tallyPost. */
  post?: (url: string, xml: string, timeoutMs?: number) => Promise<string>;
  log?: (l: string) => void;
}

/**
 * Start the single-primary mode, or say why not. Returns null (with the reasons logged) when the mode is off or any setting is missing: it
 * never half-starts. Called once from index.ts, after the HTTP server is up.
 */
export function startPrimaryMode(tallyUrl: string, env: Env = process.env, deps: PrimaryDeps = {}): PrimaryHandle | null {
  const log = deps.log ?? ((l: string) => console.log(l));
  if (!primaryModeOn(env)) return null;
  const cfg = readPrimaryConfig(tallyUrl, env);
  if (!cfg.ok) {
    log(`🛑 [primary] the single-primary mode is on but cannot start:\n   - ${cfg.problems.join("\n   - ")}\n   Nothing is claimed and nothing is posted.`);
    return null;
  }
  const c = deps.client ?? (supabaseClientOrNull() as Rpc | null);
  if (!c) { log("🛑 [primary] no database client (offline, or no service key). Nothing is claimed and nothing is posted."); return null; }
  const { cfg: k } = cfg;
  const post = deps.post ?? ((u: string, x: string, t?: number) => tallyPost(u, x, t ?? 300_000, true) as Promise<string>);
  const seams = tallySeams(k.tallyUrl, post);
  const agent = new ErpJobAgent({
    queue: supabaseErpQueue(c, k.machine, k.key), journal: new Journal(k.journalPath), company: k.company,
    ...seams, companies: k.companies,
  } as ConstructorParameters<typeof ErpJobAgent>[0]);
  const queue = new PrimaryQueueLoop({ agent, pollMs: k.queuePollMs, busyMs: k.queueBusyMs, log: (l) => log(`[primary queue] ${l}`) });
  const store = supabaseMirrorStore(c as any, k.machine, k.key, k.companyKey, false);
  const mastersStore = supabaseMastersStore(c as any, k.machine, k.key, k.companyKey, false);
  const mirror = new PrimaryMirrorLoop({
    store, tally: tallyMirrorReads(k.tallyUrl, k.company), plan: supabaseMirrorPlanSource(c as any, k.companyKey), tickMs: k.mirrorTickMs,
    queueBusy: () => queue.status.busy, log: (l) => log(`[primary mirror] ${l}`),
    masters: async () => {
      const rep = await runMasters({
        post: async (xml, ms) => tallyPost(k.tallyUrl, xml, ms, false), fetchGst: () => fetchGstWithinLimit(k.tallyUrl, k.company),
        store: mastersStore, mastersOpts: { company: k.companyKey, test: false }, company: k.company, newMarker: randomUUID,
      });
      return { ok: rep.ok, error: rep.error };
    },
  });
  log(`📒 [primary] single-primary mode: machine ${k.machine}, company pinned by GUID ${primaryGuid(env).slice(0, 8)}..., queue every ${k.queuePollMs / 1000} s, mirror every ${k.mirrorTickMs / 60000} min. The database switches live_claims and live_mirror decide whether any work is handed out.`);
  queue.start();
  mirror.start();
  return {
    stop: () => { queue.stop(); mirror.stop(); },
    status: () => ({ mode: "primary", company: k.company, machine: k.machine, queue: queue.status, mirror: mirror.status, agent: agent.status }),
  };
}

function supabaseClientOrNull() { try { return supabaseClient(); } catch { return null; } }
