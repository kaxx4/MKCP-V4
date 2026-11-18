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
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { ErpJobAgent, Journal, type JournalEntry, supabaseErpQueue, tallySeams, tallyPinSeam, type RunReport } from "./erpJobAgent.js";
import {
  planMirrorWork, runMirrorSync, runDayCheck, runRepull, applyAcceptedDrops, supabaseMirrorStore, tallyMirrorReads,
  type MirrorStore, type MirrorTally, type MirrorWork,
} from "./erpMirrorSync.js";
import { pendingVanishAcks, normType, type MirrorAlarm } from "./mirrorGuards.js";
import { firePreflightNudge } from "./preflightNudge.js";
import { runMasters, supabaseMastersStore, fetchGstWithinLimit, type MastersStore } from "./erpMasters.js";
import { loadCompanyYears, type CompanyYear } from "./companyYears.js";
import { primaryModeOn, primaryModeRefusal, primaryGuid, primaryCompanyName, primaryCompanyKey } from "./primaryMode.js";
import { agentMachineId, supabaseClient } from "./supabaseClient.js";
import { tallyCompany } from "../config/company.js";
import { JOB_BACKOFF_MAX_MS, jobPollMs, withJitter, backoffMs, leaseSecondsFor } from "./jobPoll.js";
import { tallyPost } from "../tally.js";
import { ReadbackRunner, supabaseReadbackQueue, readbackVoucher, readbackTargetOf, READBACK_TIMEOUT_MS } from "./erpReadback.js";

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
  const journalPath = (env.MKCP_ERP_JOURNAL_PATH ?? "").trim();
  if (!journalPath) problems.push("MKCP_ERP_JOURNAL_PATH is not set (an absolute path to the agent's own journal file; the journal is what settles a job after a crash, so it must not depend on the folder the program was started from)");
  else if (!isAbsolute(journalPath)) problems.push(`MKCP_ERP_JOURNAL_PATH must be an absolute path (got "${journalPath}")`);
  if ((env.PUSH_AGENT_ENABLED ?? "").trim().toLowerCase() === "true") problems.push("PUSH_AGENT_ENABLED=true: the old push agent would also write to the live books. Set it to false; in the single-primary mode everything to the books goes through the ERP queue");
  const company = primaryCompanyName(env) || tallyCompany();
  if (!company) problems.push("no company name is set (MKCP_PRIMARY_COMPANY)");
  const years = loadCompanyYears(env as NodeJS.ProcessEnv);
  for (const p of years.problems) problems.push(`company list: ${p}`);
  if (problems.length) return { ok: false, problems };
  const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 1000 ? n : d; };
  return { ok: true, cfg: {
    tallyUrl, company, companyKey: primaryCompanyKey({ ...env, MKCP_PRIMARY_COMPANY: company }), machine, key,
    journalPath,
    companies: years.list,
    queuePollMs: jobPollMs(env.MKCP_PRIMARY_POLL_MS), queueBusyMs: 2_000, mirrorTickMs: num(env.MKCP_PRIMARY_MIRROR_TICK_MS, 300_000),
  } };
}

// ── The queue loop ────────────────────────────────────────────────────────────
/** `lastAt` is the last time the loop looked; `lastWorkAt` (agent-ui lane) is the last time it actually did something (worked a job, or ran a piece of mirror work), so a person can tell "looked and found nothing" from "did something". */
export interface LoopStatus { running: boolean; rounds: number; lastAt: string | null; lastNote: string | null; errors: number; busy: boolean; lastWorkAt?: string | null }

export class PrimaryQueueLoop {
  readonly status: LoopStatus = { running: false, rounds: 0, lastAt: null, lastNote: null, errors: 0, busy: false, lastWorkAt: null };
  private timer: unknown = null;
  private fails = 0;
  /**
   * `pollMs` is the wait after an idle round (jobPoll.ts: 30 s). `rand`, `setTimer` and `clearTimer` are for tests with a fake clock; the real
   * agent leaves them out. The wait is jittered by plus or minus 10 percent in `start`, not in `tick`, so `tick` returns the plain number.
   */
  constructor(private o: {
    agent: Pick<ErpJobAgent, "runOnce">; pollMs: number; busyMs: number; log?: (l: string) => void; now?: () => number;
    rand?: () => number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void;
    /**
     * Audit M1: the "Check again" readback (erpReadback.ts). Run inside this round's busy flag, after a round that held the lease, passed the
     * company pin and worked nothing, so it never overlaps a push or the mirror sync. Read only. Its own back-off; it never throws.
     */
    readback?: Pick<ReadbackRunner, "tick">;
  }) {}

  /**
   * One round. Never throws. At most one round at a time: a call while one is running does nothing and returns the poll time (single flight).
   * A failed round (a timeout, a 5xx, a network error) is noted in one plain line and the wait before the next one doubles (30 s, 60 s, 120 s, 240 s,
   * then 300 s); one good round puts it back to the poll time. Returns the wait before the next round (before jitter).
   */
  async tick(): Promise<number> {
    if (this.status.busy) return this.o.pollMs;
    const log = this.o.log ?? ((l: string) => console.log(`[primary queue] ${l}`));
    this.status.busy = true;
    try {
      const r: RunReport = await this.o.agent.runOnce(1);
      if (this.fails > 0) log(`the database answers again; asking every ${Math.round(this.o.pollMs / 1000)} s`);
      this.fails = 0;
      this.status.rounds++;
      this.status.lastAt = new Date((this.o.now ?? Date.now)()).toISOString();
      if (!r.held) { this.status.lastNote = r.stopped ?? "not holding the queue lease"; return this.o.pollMs; }
      /* D-M.258 item 2: a round that stopped for a reason (the claim pause and why) says so, never "idle". */
      if (r.stopped && r.results.length === 0 && r.settled.length === 0) { this.status.lastNote = r.stopped; return this.o.pollMs; }
      const n = r.results.length + r.settled.length;
      this.status.lastNote = n ? `${r.results.length} job(s) worked, ${r.settled.length} settled` : "idle";
      if (n) { log(this.status.lastNote); this.status.lastWorkAt = this.status.lastAt; }
      /* Audit M1: only on an idle round that held the lease and passed the pin (runOnce reports held=false when the pin fails). Still inside
         the busy flag, so the mirror waits. A failure here is the readback's own and never fails the queue round. */
      if (!n && this.o.readback) {
        try { const rb = await this.o.readback.tick(); if (rb && rb.results.length) this.status.lastWorkAt = this.status.lastAt; }
        catch { /* tick never throws; this is a second fence */ }
      }
      return n ? this.o.busyMs : this.o.pollMs;
    } catch (e) {
      this.status.errors++;
      this.fails++;
      const wait = backoffMs(this.o.pollMs, this.fails);
      const why = (e as Error).message.slice(0, 160);
      this.status.lastNote = `round failed: ${why}`;
      log(`round failed (${this.fails} in a row): ${why}. Next try in ${Math.round(wait / 1000)} s.`);
      return wait;
    } finally { this.status.busy = false; }
  }

  start(): void {
    if (this.status.running) return;
    this.status.running = true;
    const set = this.o.setTimer ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    const loop = async () => {
      if (!this.status.running) return;
      const base = await this.tick();
      if (!this.status.running) return;
      const wait = withJitter(base, this.o.rand);
      /* The jitter never pushes a failure wait past the 300 s ceiling. */
      this.timer = set(loop, this.fails > 0 ? Math.min(wait, JOB_BACKOFF_MAX_MS) : wait);
    };
    void loop();
  }
  stop(): void {
    this.status.running = false;
    if (this.timer !== null) (this.o.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }
}

// ── The mirror loop ───────────────────────────────────────────────────────────
/**
 * D-M.258 item 3: a full run reads for many minutes (one day per request), so the pin cannot be checked only between pieces of work. This wraps the
 * run's Tally reads: before any read, if the last good pin answer is older than `everyMs`, the pin is asked again (a fresh company list); on a
 * mismatch, or a pin that cannot be checked, the read throws "stopped: ..." and the run FAILS where it stands. Nothing is swapped from a failed run
 * (the mark stays, the staged rows are kept for a person), and the loop's report says why.
 */
export function guardedMirrorTally(tally: MirrorTally, pin: () => Promise<string | null>, everyMs: number, now: () => number = Date.now): MirrorTally {
  let okAt = -Infinity;
  const guard = async (): Promise<void> => {
    if (now() - okAt < everyMs) return;
    let why: string | null;
    try { why = await pin(); } catch (e) { why = `the company pin could not be checked (${(e as Error).message.slice(0, 100)})`; }
    if (why) { okAt = -Infinity; throw new Error(`stopped: the pinned company is no longer confirmed, so the run reads no further and nothing is swapped from it. ${why}`); }
    okAt = now();
  };
  return {
    highest: async () => { await guard(); return tally.highest(); },
    vouchersOn: async (day) => { await guard(); return tally.vouchersOn(day); },
    changedSince: async (mark, upTo) => { await guard(); return tally.changedSince(mark, upTo); },
    ledgers: async () => { await guard(); return tally.ledgers(); },
    loadedPeriod: async () => { await guard(); return tally.loadedPeriod(); },
  };
}

/**
 * D-M.263 item 2: the pin is also asked FRESH (never from the 60-second memory of guardedMirrorTally) immediately before anything the run read from
 * Tally is written into the mirror: the swap, an accepted drop's swap, and the nightly day check (which queues re-pulls from what Tally said). It
 * comes after the run's last read, so it covers the last reads too. A mismatch, or a pin that cannot be checked, THROWS before the call: the swap
 * is refused, runMirrorSync marks the run failed (the mark stays, the staged rows are kept), and nothing from that read reaches the mirror.
 */
export function guardedMirrorStore(store: MirrorStore, pinNow: () => Promise<string | null>): MirrorStore {
  return guardStoreCalls(store, pinNow, { swap: "the swap", swapAccepted: "an accepted swap", checkDays: "the day check is stored" });
}

/**
 * D-M.270: the SAME helper for the masters of the go-live swap store (runMasters). The pin is asked fresh before the first rows of each table are
 * staged (a marker not seen yet) and before every `finish`, which is the swap. All reads come first, so both asks come after the read; a mismatch or
 * an unreadable pin throws before the database is called, the run fails with the reason, and the swap store keeps what it held.
 */
export function guardedMastersStore(store: MastersStore, pinNow: () => Promise<string | null>): MastersStore {
  let lastMarker = "";
  return guardStoreCalls(store, pinNow, {
    put: { what: "the masters are staged", when: (_t: unknown, marker: unknown) => { const first = marker !== lastMarker; lastMarker = String(marker); return first; } },
    finish: "the masters swap",
  });
}

/**
 * The one wrapper behind guardedMirrorStore and guardedMastersStore (D-M.270: no second copy). Each named method of the store first asks the pin
 * FRESH (never from a remembered answer); a mismatch, or a pin that cannot be checked, throws "refused: ..." before the store is called.
 * `when` limits a check to the calls that need it (the first stage of a table, not every chunk).
 */
export const PIN_REFUSAL = /^refused: the pinned company is not confirmed right before /;
function guardStoreCalls<S extends object>(store: S, pinNow: () => Promise<string | null>,
  calls: Record<string, string | { what: string; when?: (...args: any[]) => boolean }>): S {
  const w = Object.create(store) as Record<string, unknown>;
  for (const [name, spec] of Object.entries(calls)) {
    const what = typeof spec === "string" ? spec : spec.what;
    const when = typeof spec === "string" ? undefined : spec.when;
    const real = (store as Record<string, unknown>)[name] as (...args: unknown[]) => Promise<unknown>;
    w[name] = async (...args: unknown[]) => {
      if (!when || when(...args)) {
        let why: string | null;
        try { why = await pinNow(); } catch (e) { why = `the company pin could not be checked (${(e as Error).message.slice(0, 100)})`; }
        if (why) throw new Error(`refused: the pinned company is not confirmed right before ${what}, so nothing the run read is written. ${why}`);
      }
      return real.apply(store, args);
    };
  }
  return w as S;
}

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
export type RunnerResult = {
  state: string; error: string | null;
  /** D-M.279: a voucher type vanished from the read; the run was held */
  alarms?: MirrorAlarm[];
  /** D-M.281: voucher types an Owner's acknowledgement let this run prune (the acknowledgement is used up once the run swapped) */
  released?: string[];
};
export interface MirrorRunners {
  /** `released`: the voucher types an Owner has acknowledged as vanished (D-M.281); a run may prune them. */
  mirror(store: MirrorStore, tally: MirrorTally, kind: "full" | "incremental", log: (l: string) => void, released?: string[]): Promise<RunnerResult>;
  check(store: MirrorStore, tally: MirrorTally, log: (l: string) => void, released?: string[]): Promise<RunnerResult>;
  repull(store: MirrorStore, tally: MirrorTally, log: (l: string) => void, released?: string[]): Promise<RunnerResult | null>;
  accepted(store: MirrorStore, log: (l: string) => void): Promise<{ state: string }[]>;
}
export const REAL_MIRROR_RUNNERS: MirrorRunners = {
  mirror: (store, tally, kind, log, released) => runMirrorSync({ store, tally, kind, log, released }),
  check: (store, tally, log, released) => runDayCheck({ store, tally, log, released }),
  repull: (store, tally, log, released) => runRepull({ store, tally, log, released }),
  accepted: (store, log) => applyAcceptedDrops({ store, log }),
};

export interface MirrorTickReport { skipped: string | null; planned: MirrorWork[]; did: { work: string; state: string; note?: string }[] }

/** D-M.279: what /api/primary/status shows of a mirror alarm (the last 20, newest last). */
export interface MirrorAlarmNote extends MirrorAlarm { at: string }
/**
 * D-M.281: a voucher type the mirror is holding back from pruning, for the Owner to read on /api/primary/status. `line` is the sentence to show:
 * the type, how many vouchers, how long, and the one command that releases it once.
 */
export interface MirrorHold {
  type: string; storeRows: number; where: MirrorAlarm["where"]; since: string; lastAt: string;
  /** Held runs in a row (a run that did not trip clears the hold). */
  consecutive: number;
  line: string;
  /** When the alarm last reached the ERP's sync-health row (tally_sync_history), if it has. */
  healthAt?: string;
}
export interface MirrorLoopStatus extends LoopStatus { alarms: MirrorAlarmNote[]; holds: MirrorHold[] }

/** D-M.281: a hold that lasts this many runs in a row also reaches the ERP's sync-health signal (the web's sync log), so it is never silent. */
export const MIRROR_HOLD_HEALTH_AFTER = 2;
/** While a hold lasts, the sync-health row is written again at most this often. */
export const MIRROR_HOLD_HEALTH_EVERY_MS = 60 * 60_000;

/** What the sync-health signal is told: one row for the web's sync log (tally_sync_history). */
export interface MirrorHealthNote { syncType: string; startedAt: string; errors: string[]; counts: Record<string, unknown> }

const holdLine = (h: Pick<MirrorHold, "type" | "storeRows" | "consecutive" | "since">): string =>
  `${h.type}: ${h.storeRows} voucher(s) of this type vanished from Tally's read, so the mirror is NOT pruning them (held ${h.consecutive} run(s) in a row since ${h.since}). If they really are gone from Tally, release it once with: npx tsx scripts/primary-switches.ts ack-vanish "${h.type}"`;

export class PrimaryMirrorLoop {
  readonly status: MirrorLoopStatus = { running: false, rounds: 0, lastAt: null, lastNote: null, errors: 0, busy: false, lastWorkAt: null, alarms: [], holds: [] };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pausedUntil = 0;
  constructor(private o: {
    store: MirrorStore; tally: MirrorTally; plan: MirrorPlanSource;
    /** The masters of the swap store, run after a full mirror run (M2). Absent: skipped. */
    masters?: () => Promise<{ ok: boolean; error: string | null }>;
    /** True while the queue loop is mid-round: the mirror waits its turn rather than starting a read beside a push. */
    queueBusy?: () => boolean;
    /**
     * D-M.256 item 6: null when the pinned company is the one open in Tally (a fresh company list), else the reason. Checked before every piece of
     * work a pass does (so always before a full run); on a failure that work does not run and nothing is read or swapped from it.
     */
    pin?: () => Promise<string | null>;
    /** D-M.270: where a refused masters swap is written down (the agent's own journal). Absent: not journalled. */
    journal?: { append(e: JournalEntry): void; entries?(): JournalEntry[] };
    /** D-M.281: where a hold that lasts MIRROR_HOLD_HEALTH_AFTER runs is told to the ERP's sync-health signal. Absent: only the status and journal show it. */
    health?: (n: MirrorHealthNote) => Promise<void>;
    /** D-M.258 item 3: while a run is reading, the pin is asked again when this long has passed since the last good answer (default 60 s). */
    pinEveryMs?: number;
    tickMs: number; log?: (l: string) => void; now?: () => number; runners?: MirrorRunners;
  }) {}

  /** D-M.281: the voucher types an Owner has acknowledged and no run has used up yet (read from the journal; none when there is no journal). */
  private releasedNow(nowMs: number): string[] {
    try { return pendingVanishAcks((this.o.journal?.entries?.() ?? []) as { kind: string; type?: string; at?: string }[], nowMs); } catch { return []; }
  }

  /**
   * D-M.279 and D-M.281: after one piece of work, write what it held to the status (alarms and holds) and the journal, tell the ERP's sync-health
   * signal when a hold has lasted MIRROR_HOLD_HEALTH_AFTER runs, clear holds that did not trip again, and use up an acknowledgement that a swapped
   * run pruned. Never throws.
   */
  private async settleRun(where: MirrorAlarm["where"], r: RunnerResult, at: string): Promise<void> {
    const alarms = r.alarms ?? [];
    for (const a of alarms) {
      this.status.alarms.push({ ...a, at });
      if (this.status.alarms.length > 20) this.status.alarms.shift();
      try { this.o.journal?.append({ kind: "mirror-alarm", alarm: `${a.kind}: ${a.type}`, where: a.where, reason: a.reason.slice(0, 400), at }); } catch { /* the status still shows it */ }
      const key = normType(a.type);
      const old = this.status.holds.find((h) => normType(h.type) === key && h.where === a.where);
      const hold: MirrorHold = old
        ? { ...old, storeRows: a.storeRows, lastAt: at, consecutive: old.consecutive + 1 }
        : { type: a.type, storeRows: a.storeRows, where: a.where, since: at, lastAt: at, consecutive: 1, line: "" };
      hold.line = holdLine(hold);
      this.status.holds = [...this.status.holds.filter((h) => h !== old), hold];
    }
    /* a run that finished without tripping clears this kind of hold; a run that failed for another reason says nothing about it */
    const finished = /^(swapped|ok|gaps)$/.test(r.state);
    const tripped = new Set(alarms.map((a) => normType(a.type)));
    if (finished) this.status.holds = this.status.holds.filter((h) => h.where !== where || tripped.has(normType(h.type)));
    /* an acknowledgement is used up only by a run that swapped (so pruned) the type it released */
    if (r.state === "swapped" && r.released?.length) {
      for (const t of r.released) {
        try { this.o.journal?.append({ kind: "vanish-ack-used", type: t, at }); } catch { /* a missing note only means the next run may release it again */ }
        this.status.holds = this.status.holds.filter((h) => normType(h.type) !== normType(t));
      }
    }
    if (!this.o.health) return;
    for (const h of this.status.holds) {
      if (h.consecutive < MIRROR_HOLD_HEALTH_AFTER) continue;
      if (h.healthAt && new Date(at).getTime() - new Date(h.healthAt).getTime() < MIRROR_HOLD_HEALTH_EVERY_MS) continue;
      try {
        await this.o.health({ syncType: "mirror-held", startedAt: at, errors: [h.line.slice(0, 500)], counts: { held_runs: h.consecutive, type: h.type, rows: h.storeRows, where: h.where } });
        h.healthAt = at;
      } catch (e) { (this.o.log ?? (() => {}))(`could not tell the sync-health signal about the held ${h.type}: ${(e as Error).message.slice(0, 120)}`); }
    }
  }

  /** One pass: ask the planner, do each piece of work in order. Never throws. */
  async tick(): Promise<MirrorTickReport> {
    const log = this.o.log ?? ((l: string) => console.log(`[primary mirror] ${l}`));
    const now = new Date((this.o.now ?? Date.now)());
    const rep: MirrorTickReport = { skipped: null, planned: [], did: [] };
    const run = this.o.runners ?? REAL_MIRROR_RUNNERS;
    if (now.getTime() < this.pausedUntil) { rep.skipped = "paused: the database said the mirror is off"; return rep; }
    if (this.o.queueBusy?.()) { rep.skipped = "the queue is mid-round; the mirror waits"; return rep; }
    this.status.busy = true;
    const tally = this.o.pin ? guardedMirrorTally(this.o.tally, this.o.pin, this.o.pinEveryMs ?? 60_000, this.o.now ?? Date.now) : this.o.tally;
    try {
      const [hasMark, fullDue, lastCheckAt, queuedRepulls, accepted, last] = await Promise.all([
        this.o.plan.hasMark(), this.o.plan.fullDue(), this.o.plan.lastCheckAt(), this.o.plan.queuedRepulls(),
        this.o.store.acceptedRuns(), this.o.store.lastFullRun(),
      ]);
      rep.planned = planMirrorWork({ now, hasMark, fullDue, lastFullAt: last ? new Date(last.finished_at) : null, lastCheckAt, queuedRepulls, acceptedDrops: accepted.length });
      for (const w of rep.planned) {
        if (this.o.queueBusy?.()) { rep.skipped = "the queue became busy; the rest waits for the next pass"; break; }
        if (this.o.pin && w !== "apply_accepted") {
          let why: string | null;
          try { why = await this.o.pin(); } catch (e) { why = `the company pin could not be checked (${(e as Error).message.slice(0, 100)})`; }
          if (why) { rep.skipped = `not run, the pinned company is not confirmed: ${why}`; log(rep.skipped); break; }
        }
        if (w === "apply_accepted") {
          const r = await run.accepted(this.o.store, log);
          rep.did.push({ work: w, state: r.every((x) => x.state === "swapped") ? "ok" : "failed", note: `${r.length} accepted drop(s)` });
        } else if (w === "full" || w === "incremental") {
          const r = await run.mirror(this.o.store, tally, w, log, w === "full" ? this.releasedNow(now.getTime()) : []);
          await this.settleRun("full", r, now.toISOString());
          rep.did.push({ work: w, state: r.state, note: r.error ?? undefined });
          if (r.state === "failed" && /off until go-live/i.test(r.error ?? "")) { this.pausedUntil = now.getTime() + 15 * 60_000; break; }
          if (w === "full" && r.state === "swapped" && this.o.masters) {
            let why: string | null = null;
            if (this.o.pin) { try { why = await this.o.pin(); } catch (e) { why = `the company pin could not be checked (${(e as Error).message.slice(0, 100)})`; } }
            if (why) { rep.skipped = `masters not run, the pinned company is not confirmed: ${why}`; log(rep.skipped); break; }
            const m = await this.o.masters();
            rep.did.push({ work: "masters", state: m.ok ? "ok" : "failed", note: m.error ?? undefined });
            if (!m.ok && PIN_REFUSAL.test(m.error ?? "")) {
              /* D-M.270: the pin check refused the masters swap: the swap store keeps what it held, the reason is journalled, and the pass holds (like a
                 refused voucher swap, the next pass plans again). */
              rep.skipped = `masters not swapped: ${m.error}`;
              try { this.o.journal?.append({ kind: "swap-refused", what: "masters", reason: String(m.error).slice(0, 300), at: now.toISOString() }); } catch { /* the note below still shows it */ }
              log(rep.skipped);
              break;
            }
          }
          if (r.state !== "swapped") break;     // a refused or failed run stops the pass; the next pass plans again
        } else if (w === "check") {
          const r = await run.check(this.o.store, tally, log, this.releasedNow(now.getTime()));
          await this.settleRun("day_check", r, now.toISOString());
          rep.did.push({ work: w, state: r.state, note: r.error ?? undefined });
        } else if (w === "repull") {
          for (let i = 0; i < 7; i++) {
            const r = await run.repull(this.o.store, tally, log, this.releasedNow(now.getTime()));
            if (!r) break;
            await this.settleRun("repull", r, now.toISOString());
            rep.did.push({ work: "repull", state: r.state, note: r.error ?? undefined });
            if (r.state !== "swapped") break;
          }
        }
      }
      this.status.rounds++;
      this.status.lastAt = now.toISOString();
      this.status.lastNote = rep.skipped ?? (rep.did.map((d) => `${d.work}:${d.state}`).join(", ") || "nothing due");
      if (rep.did.length > 0) this.status.lastWorkAt = now.toISOString();
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

// ── Housekeeping (D-M.262) ────────────────────────────────────────────────────
export interface HousekeepingStatus {
  running: boolean; rounds: number; lastAt: string | null; lastNote: string | null; errors: number;
  /** Change signals removed by the last good prune, and in all since this process started. Null until the first prune. */
  signalsPrunedLast: number | null; signalsPrunedTotal: number;
  /** When the last good prune ran, read from the journal on start (so a restart does not prune again the same day), then kept up to date. */
  lastGoodPruneAt: string | null;
}

/**
 * D-M.262: once a day the primary asks the database to prune change signals older than 7 days (`erp_signals_prune`, migration 0124; the function
 * itself refuses anything under a day, and only service_role may run it). Without this `erp_change_signals` grows for ever once go-live makes a
 * signal for every change. The number removed goes to the journal and to /api/primary/status. A failed call is noted, journalled and tried again
 * the next day; it never throws and never touches Tally. It exists only inside the single-primary mode, so it is off whenever the mode is off.
 */
export class PrimaryHousekeeping {
  readonly status: HousekeepingStatus = { running: false, rounds: 0, lastAt: null, lastNote: null, errors: 0, signalsPrunedLast: null, signalsPrunedTotal: 0, lastGoodPruneAt: null };
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private o: {
    client: Pick<Rpc, "rpc">; journal: { append(e: JournalEntry): void; entries?(): JournalEntry[] };
    /** How long between prunes (default one day) and how long after start the first one waits (default 10 minutes). */
    everyMs?: number; firstMs?: number;
    /** What counts as old (default 7 days). The database refuses anything under one day. */
    older?: string; log?: (l: string) => void; now?: () => number;
  }) {}

  /** One prune. Never throws. */
  async tick(): Promise<void> {
    const log = this.o.log ?? ((l: string) => console.log(`[primary housekeeping] ${l}`));
    const at = new Date((this.o.now ?? Date.now)()).toISOString();
    const note = (pruned: number | null, error: string | null) => {
      try { this.o.journal.append({ kind: "housekeeping", task: "signals-prune", pruned, error, at }); }
      catch (e) { log(`could not write the journal: ${(e as Error).message.slice(0, 120)}`); }
    };
    this.status.rounds++;
    this.status.lastAt = at;
    try {
      const { data, error } = await this.o.client.rpc("erp_signals_prune", { p_older: this.o.older ?? "7 days" });
      if (error) throw new Error(error.message ?? String(error));
      const n = Number(data);
      if (data === null || data === undefined || !Number.isFinite(n) || n < 0) throw new Error(`the database answered "${String(data)}", not a count`);
      this.status.signalsPrunedLast = n;
      this.status.signalsPrunedTotal += n;
      this.status.lastGoodPruneAt = at;
      this.status.lastNote = `pruned ${n} change signal(s) older than ${this.o.older ?? "7 days"}`;
      note(n, null);
      log(this.status.lastNote);
    } catch (e) {
      this.status.errors++;
      const m = (e as Error).message.slice(0, 160);
      this.status.lastNote = `signal prune failed: ${m}`;
      note(null, m);
      log(this.status.lastNote);
    }
  }

  start(): void {
    if (this.status.running) return;
    this.status.running = true;
    const loop = async () => {
      if (!this.status.running) return;
      await this.tick();
      if (this.status.running) { this.timer = setTimeout(loop, this.o.everyMs ?? 24 * 3_600_000); this.timer.unref?.(); }
    };
    /* D-M.263 item 3: a restart must not prune again the same day. The last good prune is read from the journal; the first run waits until a full
       interval has passed since it (and never less than `firstMs`). A journal that cannot be read means no memory: the normal first wait. */
    const every = this.o.everyMs ?? 24 * 3_600_000, first = this.o.firstMs ?? 600_000;
    let wait = first;
    try {
      const last = (this.o.journal.entries?.() ?? []).filter((e): e is Extract<JournalEntry, { kind: "housekeeping" }> => e.kind === "housekeeping" && e.error === null && e.pruned !== null).pop();
      if (last) {
        this.status.lastGoodPruneAt = last.at;
        const age = (this.o.now ?? Date.now)() - new Date(last.at).getTime();
        if (Number.isFinite(age) && age >= 0) wait = Math.max(first, every - age);
      }
    } catch { /* no memory of an earlier prune */ }
    this.timer = setTimeout(loop, wait);
    this.timer.unref?.();
  }
  stop(): void { this.status.running = false; if (this.timer) clearTimeout(this.timer); this.timer = null; }
}

// ── Start it ──────────────────────────────────────────────────────────────────
export interface PrimaryHandle {
  stop(): void;
  status(): { mode: "primary"; company: string; machine: string; queue: LoopStatus; mirror: MirrorLoopStatus; housekeeping: HousekeepingStatus; agent: unknown };
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
function startPrimaryModeInner(tallyUrl: string, env: Env, deps: PrimaryDeps): PrimaryHandle | null {
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
  /* D-M.286: a failed company pin also asks the preflight reporter to report (the reporter throttles itself). */
  const basePin = tallyPinSeam(k.tallyUrl, post);
  const seams = { ...tallySeams(k.tallyUrl, post), pin: async (company: string) => { const r = await basePin(company); if (r) firePreflightNudge(); return r; } };
  const journal = new Journal(k.journalPath);
  const agent = new ErpJobAgent({
    queue: supabaseErpQueue(c, k.machine, k.key), journal, company: k.company,
    ...seams, companies: k.companies,
    /* lane agent-poll: the lease outlasts three healthy gaps between rounds, so a slower poll never lets it lapse (jobPoll.ts). */
    leaseSeconds: leaseSecondsFor(k.queuePollMs),
  } as ConstructorParameters<typeof ErpJobAgent>[0]);
  /* Audit M1: the "Check again" readback. Read only (one filtered day read per ask, never a push), the pinned company only, real asks only
     (a sandbox answers the test ones). It is not a claim, so it runs whether or not live_claims is on. */
  const readback = new ReadbackRunner({
    queue: supabaseReadbackQueue(c, k.machine, k.key), wantTest: false, company: k.company, pollMs: k.queuePollMs,
    find: (ask) => readbackVoucher((xml) => post(k.tallyUrl, xml, READBACK_TIMEOUT_MS), k.company, readbackTargetOf(ask)),
    pin: async () => (await seams.pin(k.company))?.reason ?? null,
    log: (l) => log(`[primary readback] ${l}`),
  });
  const queue = new PrimaryQueueLoop({ agent, pollMs: k.queuePollMs, busyMs: k.queueBusyMs, log: (l) => log(`[primary queue] ${l}`), readback });
  const store = guardedMirrorStore(supabaseMirrorStore(c as any, k.machine, k.key, k.companyKey, false), async () => (await seams.pin(k.company))?.reason ?? null);
  const pinNow = async () => (await seams.pin(k.company))?.reason ?? null;
  const mastersStore = guardedMastersStore(supabaseMastersStore(c as any, k.machine, k.key, k.companyKey, false), pinNow);
  const mirror = new PrimaryMirrorLoop({
    store, tally: tallyMirrorReads(k.tallyUrl, k.company), plan: supabaseMirrorPlanSource(c as any, k.companyKey), tickMs: k.mirrorTickMs,
    queueBusy: () => queue.status.busy, log: (l) => log(`[primary mirror] ${l}`), journal,
    /* D-M.281: the sync-health row the web's sync log already reads (tally_sync_history, success false), so a hold is seen in the app. */
    health: async (n) => {
      const { error } = await (c as any).from("tally_sync_history").insert({
        company: k.company, sync_type: n.syncType, started_at: n.startedAt, completed_at: n.startedAt, row_counts: n.counts, errors: n.errors, success: false, duration_ms: 0,
      });
      if (error) throw new Error(error.message);
    },
    pin: async () => (await seams.pin(k.company))?.reason ?? null,
    masters: async () => {
      const rep = await runMasters({
        post: async (xml, ms) => tallyPost(k.tallyUrl, xml, ms, false), fetchGst: () => fetchGstWithinLimit(k.tallyUrl, k.company),
        store: mastersStore, mastersOpts: { company: k.companyKey, test: false }, company: k.company, newMarker: randomUUID,
      });
      return { ok: rep.ok, error: rep.error };
    },
  });
  const housekeeping = new PrimaryHousekeeping({ client: c, journal, log: (l) => log(`[primary housekeeping] ${l}`) });
  log(`📒 [primary] single-primary mode: machine ${k.machine}, company pinned by GUID ${primaryGuid(env).slice(0, 8)}..., queue every ${k.queuePollMs / 1000} s, mirror every ${k.mirrorTickMs / 60000} min. The database switches live_claims and live_mirror decide whether any work is handed out.`);
  queue.start();
  try { mirror.start(); } catch (e) { queue.stop(); throw e; }
  housekeeping.start();
  return {
    stop: () => { queue.stop(); mirror.stop(); housekeeping.stop(); },
    status: () => ({ mode: "primary", company: k.company, machine: k.machine, queue: queue.status, mirror: mirror.status, housekeeping: housekeeping.status, agent: agent.status }),
  };
}

function supabaseClientOrNull() { try { return supabaseClient(); } catch { return null; } }

/**
 * Start the single-primary mode, or say why not (D-M.256 item 8). Whatever goes wrong while starting is logged as "cannot start: <reason>" and the
 * process carries on without the mode: a failure here never crashes the agent, and it never leaves one loop running without the other.
 */
export function startPrimaryMode(tallyUrl: string, env: Env = process.env, deps: PrimaryDeps = {}): PrimaryHandle | null {
  const log = deps.log ?? ((l: string) => console.log(l));
  try {
    return startPrimaryModeInner(tallyUrl, env, deps);
  } catch (e) {
    log(`🛑 [primary] cannot start: ${(e as Error).message}. Nothing is claimed and nothing is posted.`);
    return null;
  }
}
