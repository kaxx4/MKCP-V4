/**
 * JOB: the ERP queue's agent (rebuild task 1-3). It works `erp_jobs` beside
 * main's push agent, never inside it: main's `push_queue` and
 * `claim_push_jobs` are not touched (D-1-3.1).
 *
 * The rules, in the order a run follows them (file 03 task 1-3, files 18 and 19 rows 1-3):
 *  1. Heartbeat first. The machine takes its role's lease in the database
 *     (`erp_agent_take_lease`, machine id plus a boot nonce). It stops when the
 *     lease is someone else's, when a second machine of its role has asked for
 *     it (two primaries: both stop), or when its clock is more than 60 s off the
 *     database clock. All lease and retry maths is the database's.
 *  2. Settle before claiming. Every job this machine left `claimed` or `sent`
 *     (a crash, a sleep, a lost outcome write) is settled from the journal, or
 *     by reading Tally by type, date, number, party and amount, and settled only
 *     on exactly one match. Never by pushing again (M-4). This is also the path
 *     for a job left `sent` after its outcome write failed (review R2 leftover).
 *  3. One Tally write at a time. Each job's lease is renewed every 30 s on its own.
 *  4. Right before Tally, `erp_mark_job_sent` re-reads the job conditioned on this
 *     boot still holding it (a cancel wins), checks the REMOTEID registry, and
 *     writes `sent`.
 *  5. Every step is appended to an on-disk journal and flushed before the next
 *     one; MASTERID (Tally's LASTVCHID) is journalled from every reply, failed
 *     ones included. A journal that cannot be written stops claiming.
 *  6. Every outcome write is retried until it lands; if it still has not, the
 *     job stays `sent` with its outcome in the journal and step 2 writes it.
 *  7. `failed` only when nothing can be in the books (stage guard or push);
 *     a reply lost after sending is read back; a job left uncertain is never
 *     retried by itself.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { safePush, vouchersOnDateXml, diffStored, type SafePushResult } from "./safePush.js";
import { readTag } from "./xml.js";
import { testJobRefusal, outcomeOf, type TestOutcome } from "./erpTestQueueAgent.js";
import type { VoucherPayload } from "../types.js";

export interface ErpJob {
  id: string;
  kind: string;
  idempotency_key: string;
  payload: VoucherPayload & { label?: string };
  state: string;
  attempts: number;
  is_test: boolean;
  claimed_by?: string | null;
  master_id?: string | null;
  /** Set on a person's resend (D21): the job this one resends. */
  resend_of?: string | null;
}

export interface LeaseInfo {
  held: boolean; holder?: string; db_now: string; conflict?: boolean;
  kill_switch?: boolean; outage?: boolean; role?: string;
}

export type JobOutcome = TestOutcome;

/** The seam between this agent and wherever the queue lives (live database or memory). */
export interface ErpQueue {
  takeLease(nonce: string, seconds: number, details?: unknown): Promise<LeaseInfo>;
  claim(nonce: string, limit: number, leaseSeconds: number): Promise<ErpJob[]>;
  renew(nonce: string, id: string, seconds: number): Promise<boolean>;
  markSent(nonce: string, id: string, company: string): Promise<{ ok: boolean; refused?: boolean; reason?: string }>;
  finish(nonce: string, id: string, state: JobOutcome | "queued", f?: {
    masterId?: string | null; bookedNumber?: string | null; result?: unknown; error?: string | null;
  }): Promise<boolean>;
  myOpenJobs(): Promise<ErpJob[]>;
}

// ── The journal ───────────────────────────────────────────────────────────────
export type JournalEntry =
  | { kind: "boot"; nonce: string; at: string }
  | { kind: "claimed" | "sent"; jobId: string; key: string; at: string }
  | { kind: "not-sent"; jobId: string; reason: string; at: string }
  | { kind: "reply"; jobId: string; outcome: JobOutcome; stage: string; masterId: string | null;
      bookedNumber: string | null; errors: string[]; differences: string[]; at: string }
  | { kind: "reply-lost"; jobId: string; error: string; at: string }
  | { kind: "read-failed"; jobId: string; error: string; at: string }
  | { kind: "finished"; jobId: string; state: string; by: string; at: string }
  | { kind: "finish-pending"; jobId: string; state: string; error: string; at: string };

/** Append-only, one JSON line per step, flushed to disk before the call returns. */
export class Journal {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }
  append(e: JournalEntry): void {
    const fd = openSync(this.path, "a");
    try {
      appendFileSync(fd, JSON.stringify(e) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  entries(): JournalEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8").split("\n").filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l) as JournalEntry]; } catch { return []; }
    });
  }
  /** How many read-backs of a job have failed to reach Tally (review L4). */
  readFailures(jobId: string): number {
    return this.entries().filter((e) => e.kind === "read-failed" && e.jobId === jobId).length;
  }
  /** The last reply journalled for a job, if Tally answered. */
  lastReply(jobId: string): Extract<JournalEntry, { kind: "reply" }> | null {
    const r = this.entries().filter((e): e is Extract<JournalEntry, { kind: "reply" }> => e.kind === "reply" && e.jobId === jobId);
    return r.length ? r[r.length - 1] : null;
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────────
/** The number Tally booked, when safePush renumbered a taken one (item 6). */
export function bookedNumberOf(res: SafePushResult, payload: VoucherPayload): string | null {
  for (const w of res.warnings) {
    const m = /was numbered "([^"]+)" instead/.exec(w);
    if (m) return m[1];
  }
  return res.ok ? payload.voucherNumber ?? null : null;
}

/** A reply pattern that looks like Tally is stuck behind a message box (A2). */
export function looksLikeTallyMessage(err: string): boolean {
  return /timed? ?out|ETIMEDOUT|socket hang up|ECONNRESET|empty response/i.test(err);
}

const ms = (iso: string) => new Date(iso).getTime();

// ── Reading Tally to settle ───────────────────────────────────────────────────
/** Voucher types compared as Tally does: the queue says "Sales", the master is "SALES" (review H1, 5-Nov-2026). */
export const sameVoucherType = (a: string | undefined, b: string | undefined): boolean =>
  (a ?? "").trim().toUpperCase() === (b ?? "").trim().toUpperCase();

/**
 * The vouchers in Tally that match a payload on type, date, number, party and
 * amount. Tally never returns REMOTEID on a read (file 18 section 2.1), so this
 * is the identity. The day's read is filtered in the request by date, type and number.
 */
export async function findInTally(post: (xml: string) => Promise<string>, company: string, p: VoucherPayload): Promise<{ masterId: string }[]> {
  const xml = await post(vouchersOnDateXml(company, p.date, { voucherType: p.voucherType, voucherNumber: p.voucherNumber || undefined }));
  return [...xml.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => m[0])
    .filter((v) => sameVoucherType(readTag(v, "VOUCHERTYPENAME"), p.voucherType)
      && (!p.voucherNumber || readTag(v, "VOUCHERNUMBER") === p.voucherNumber)
      && (!p.partyLedgerName || readTag(v, "PARTYLEDGERNAME") === p.partyLedgerName)
      && diffStored(p, v).length === 0)
    .map((v) => ({ masterId: readTag(v, "MASTERID") }));
}

// ── The agent ─────────────────────────────────────────────────────────────────
export interface AgentStatus {
  red: string[];
  holder: string | null;
  lastHeartbeat: string | null;
  skewMs: number | null;
  tallyMayShowMessage: boolean;
}

export interface ErpJobAgentOpts {
  queue: ErpQueue;
  journal: Journal;
  company: string;
  /** Book one payload; defaults to safePush against tallyUrl. */
  push: (company: string, payload: VoucherPayload) => Promise<SafePushResult>;
  /** Read Tally for a payload; defaults to findInTally. */
  find: (company: string, payload: VoucherPayload) => Promise<{ masterId: string }[]>;
  nonce?: string;
  leaseSeconds?: number;
  jobLeaseSeconds?: number;
  renewEveryMs?: number;
  maxSkewMs?: number;
  finishTries?: number;
  /** Failed Tally reads of one job before it is finished uncertain (review L4). */
  readTries?: number;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Is Tally answering normally? Used to clear "Tally may be showing a message" (D5). */
  probe?: () => Promise<boolean>;
  /** Refuse a job before Tally (defaults: sandbox test rules for is_test jobs). */
  refuse?: (job: ErpJob, company: string) => string | null;
}

export interface RunReport {
  held: boolean;
  stopped?: string;
  settled: { id: string; state: string; how: string }[];
  results: { id: string; key: string; outcome: string; detail: string; masterId?: string | null }[];
}

export class ErpJobAgent {
  readonly nonce: string;
  readonly status: AgentStatus = { red: [], holder: null, lastHeartbeat: null, skewMs: null, tallyMayShowMessage: false };
  private o: Required<Omit<ErpJobAgentOpts, "nonce" | "refuse" | "probe">> & { refuse: NonNullable<ErpJobAgentOpts["refuse"]>; probe?: ErpJobAgentOpts["probe"] };
  private timeouts = 0;

  constructor(opts: ErpJobAgentOpts) {
    this.nonce = opts.nonce ?? randomUUID();
    this.o = {
      leaseSeconds: 90, jobLeaseSeconds: 120, renewEveryMs: 30_000, maxSkewMs: 60_000, finishTries: 6, readTries: 3,
      wait: (t: number) => new Promise<void>((r) => setTimeout(r, t)), now: () => Date.now(),
      refuse: (job: ErpJob, company: string) => (job.is_test
        ? testJobRefusal({ company, payload: job.payload, label: String(job.payload.label ?? "") })
        : "refused: real ERP jobs are claimed only by the office agent after go-live"),
      ...opts,
    } as any;
    this.journalOrStop({ kind: "boot", nonce: this.nonce, at: new Date().toISOString() });
  }

  private journalOrStop(e: JournalEntry): void {
    try {
      this.o.journal.append(e);
    } catch (err) {
      const why = `the journal could not be written (${(err as Error).message}); claiming stopped`;
      if (!this.status.red.includes(why)) this.status.red.push(why);
      throw new Error(why);
    }
  }

  /** Take or renew the lease; false means do not claim this round. */
  async heartbeat(): Promise<boolean> {
    const l = await this.o.queue.takeLease(this.nonce, this.o.leaseSeconds, {
      nonce: this.nonce, tallyMayShowMessage: this.status.tallyMayShowMessage, red: this.status.red,
    });
    this.status.lastHeartbeat = new Date(this.o.now()).toISOString();
    this.status.holder = l.holder ?? null;
    this.status.skewMs = Math.abs(ms(l.db_now) - this.o.now());
    const red: string[] = this.status.red.filter((r) => r.startsWith("the journal"));
    if (this.status.skewMs > this.o.maxSkewMs) red.push(`this clock is ${Math.round(this.status.skewMs / 1000)} s off the database's; claiming stopped`);
    if (l.conflict) red.push("another machine of this role asked for the queue; both stop claiming until one is switched off");
    if (!l.held && !l.conflict) red.push(`the queue lease is held by ${l.holder ?? "another boot"}; waiting`);
    if (this.status.tallyMayShowMessage && this.o.probe) {
      this.status.tallyMayShowMessage = !(await this.o.probe().catch(() => false));
      if (!this.status.tallyMayShowMessage) this.timeouts = 0;
    }
    if (this.status.tallyMayShowMessage) red.push("Tally may be showing a message on the office screen; the queue is paused until it answers normally");
    this.status.red = red;
    return l.held && red.length === 0;
  }

  /** Write an outcome, retrying until it lands; journal it either way. */
  private async finishWithRetry(job: ErpJob, state: JobOutcome | "queued", f: Parameters<ErpQueue["finish"]>[3] = {}): Promise<boolean> {
    let last = "";
    for (let i = 0; i < this.o.finishTries; i++) {
      try {
        if (await this.o.queue.finish(this.nonce, job.id, state, f)) {
          this.journalOrStop({ kind: "finished", jobId: job.id, state, by: this.nonce, at: new Date().toISOString() });
          return true;
        }
        last = "the job was no longer ours to finish";
        break;
      } catch (e) {
        last = (e as Error).message;
        await this.o.wait(Math.min(1000 * 2 ** i, 15_000));
      }
    }
    this.journalOrStop({ kind: "finish-pending", jobId: job.id, state, error: last, at: new Date().toISOString() });
    return false;
  }

  /** Step 2: settle what this machine left open. */
  async settleOwn(): Promise<RunReport["settled"]> {
    const done: RunReport["settled"] = [];
    for (const job of await this.o.queue.myOpenJobs()) {
      const reply = this.o.journal.lastReply(job.id);
      if (reply) {
        await this.finishWithRetry(job, reply.outcome, {
          masterId: reply.masterId, bookedNumber: reply.bookedNumber,
          result: { stage: reply.stage, differences: reply.differences, errors: reply.errors, settled: "journal" },
          error: reply.outcome === "succeeded" ? null : reply.errors.join("; ") || reply.outcome,
        });
        done.push({ id: job.id, state: reply.outcome, how: "from the journal" });
        continue;
      }
      if (job.state === "claimed") {
        await this.finishWithRetry(job, "queued");
        done.push({ id: job.id, state: "queued", how: "never sent; back to the queue" });
        continue;
      }
      const s = await this.readBack(job);
      done.push({ id: job.id, state: s.state, how: s.how });
    }
    return done;
  }

  /** A job that was sent with no reply in hand: read Tally, settle only on exactly one match. */
  private async readBack(job: ErpJob): Promise<{ state: JobOutcome; how: string; masterId?: string | null }> {
    let found: { masterId: string }[];
    try {
      found = await this.o.find(this.o.company, job.payload);
    } catch (e) {
      const msg = (e as Error).message;
      this.journalOrStop({ kind: "read-failed", jobId: job.id, error: msg, at: new Date().toISOString() });
      if (this.o.journal.readFailures(job.id) < this.o.readTries) {
        return { state: "uncertain", how: `Tally could not be read (${msg}); left for the next run` };
      }
      // L4: after readTries failed reads, stop re-reading: uncertain, finished, a person decides.
      const how = `Tally could not be read ${this.o.readTries} times (${msg}); a person must check it`;
      await this.finishWithRetry(job, "uncertain", { result: { settled: "read-back", readFailures: this.o.readTries }, error: `This may already be in the books: ${how}` });
      return { state: "uncertain", how };
    }
    /* M3 (review, 5-Nov-2026): with no voucher number, one match on date, type,
       party and amount may be a different voucher (a hand-typed twin), so a read
       never settles it as succeeded. It stays uncertain for a person. */
    if (!job.payload.voucherNumber && found.length > 0) {
      const how = `it carries no voucher number; ${found.length} voucher(s) in Tally match on date, type, party and amount, and a read cannot tell which is this one`;
      await this.finishWithRetry(job, "uncertain", { result: { settled: "read-back", matches: found.length, no_number: true }, error: `This may already be in the books: ${how}` });
      return { state: "uncertain", how };
    }
    if (found.length === 1) {
      await this.finishWithRetry(job, "succeeded", { masterId: found[0].masterId, bookedNumber: job.payload.voucherNumber ?? null,
        result: { settled: "read-back", matches: 1 } });
      return { state: "succeeded", how: "found exactly once in Tally by type, date, number, party and amount", masterId: found[0].masterId };
    }
    const how = found.length === 0
      ? "sent, but not found in Tally; it may not have arrived. Check it before sending again"
      : `found ${found.length} times in Tally; a person must decide`;
    await this.finishWithRetry(job, "uncertain", { result: { settled: "read-back", matches: found.length }, error: `This may already be in the books: ${how}` });
    return { state: "uncertain", how };
  }

  private running = false;
  /** Jobs this boot holds right now, renewed together from claim time (review L2). */
  private open = new Set<string>();

  /** One round: heartbeat, settle, claim, book one at a time. One round at a time (review L5). */
  async runOnce(limit = 1): Promise<RunReport> {
    if (this.running) return { held: false, stopped: "a run is already in progress on this boot", settled: [], results: [] };
    this.running = true;
    /* L1 and L2: while a round runs, renew the queue lease and every job this boot
       holds on the 30 s timer, from the claim on, so a slow Tally or a long list
       never lets the lease or a job lapse between steps. */
    const renew = setInterval(() => {
      void this.o.queue.takeLease(this.nonce, this.o.leaseSeconds, { nonce: this.nonce, renewal: true }).catch(() => {});
      for (const id of this.open) void this.o.queue.renew(this.nonce, id, this.o.jobLeaseSeconds).catch(() => {});
    }, this.o.renewEveryMs);
    try {
      const report: RunReport = { held: false, settled: [], results: [] };
      report.held = await this.heartbeat();
      if (!report.held) { report.stopped = this.status.red.join("; "); return report; }
      report.settled = await this.settleOwn();
      const jobs = await this.o.queue.claim(this.nonce, limit, this.o.jobLeaseSeconds);
      for (const job of jobs) this.open.add(job.id);
      for (const job of jobs) {
        try { report.results.push(await this.processJob(job)); } finally { this.open.delete(job.id); }
      }
      return report;
    } finally {
      clearInterval(renew);
      this.open.clear();
      this.running = false;
    }
  }

  async processJob(job: ErpJob): Promise<RunReport["results"][number]> {
    const key = job.idempotency_key;
    const refusal = this.o.refuse(job, this.o.company);
    if (refusal) {
      await this.finishWithRetry(job, "failed", { error: refusal, result: { stage: "guard" } });
      return { id: job.id, key, outcome: "failed", detail: refusal };
    }
    this.journalOrStop({ kind: "claimed", jobId: job.id, key, at: new Date().toISOString() });
    /* D21: a resend keeps its REMOTEID, so a Create would alter in place if the
       old one landed. Read Tally first: exactly that voucher found, it is
       already in the books; more than one, a person decides; none, push. */
    if (job.resend_of) {
      let found: { masterId: string }[] | null = null;
      try { found = await this.o.find(this.o.company, job.payload); } catch { found = null; }
      if (found === null || found.length > 0) {
        const one = found?.length === 1 && !!job.payload.voucherNumber; // M3: no number, never settled by a read
        const state: JobOutcome = one ? "succeeded" : "uncertain";
        const detail = found === null ? "Tally could not be read before the resend; not pushed"
          : one ? "the earlier attempt is already in the books; settled without pushing again"
          : `found ${found.length} times in Tally before the resend; not pushed, a person must decide`;
        await this.finishWithRetry(job, state, { masterId: one ? found![0].masterId : null, result: { resend_check: found?.length ?? null }, error: one ? null : detail });
        return { id: job.id, key, outcome: state, detail, masterId: one ? found![0].masterId : null };
      }
    }
    // Called on its own (not from runOnce), the job is renewed here; runOnce's timer covers it otherwise.
    const renew = this.open.has(job.id) ? null
      : setInterval(() => { void this.o.queue.renew(this.nonce, job.id, this.o.jobLeaseSeconds).catch(() => {}); }, this.o.renewEveryMs);
    try {
      const m = await this.o.queue.markSent(this.nonce, job.id, this.o.company);
      if (!m.ok) {
        this.journalOrStop({ kind: "not-sent", jobId: job.id, reason: m.reason ?? "refused", at: new Date().toISOString() });
        return { id: job.id, key, outcome: m.refused ? "failed" : "not-sent", detail: m.reason ?? "not sent" };
      }
      this.journalOrStop({ kind: "sent", jobId: job.id, key, at: new Date().toISOString() });
      let res: SafePushResult;
      try {
        res = await this.o.push(this.o.company, job.payload);
        this.timeouts = 0;
      } catch (e) {
        const msg = (e as Error).message;
        this.journalOrStop({ kind: "reply-lost", jobId: job.id, error: msg, at: new Date().toISOString() });
        if (looksLikeTallyMessage(msg) && ++this.timeouts >= 2) this.status.tallyMayShowMessage = true;
        const s = await this.readBack(job);
        return { id: job.id, key, outcome: s.state, detail: `no reply from Tally (${msg}); ${s.how}`, masterId: s.masterId };
      }
      const outcome = outcomeOf(res);
      const bookedNumber = bookedNumberOf(res, job.payload);
      this.journalOrStop({ kind: "reply", jobId: job.id, outcome, stage: res.stage, masterId: res.voucherId, bookedNumber,
        errors: res.errors, differences: res.differences, at: new Date().toISOString() });
      const detail = outcome === "succeeded" ? (bookedNumber && bookedNumber !== job.payload.voucherNumber
        ? `booked as ${bookedNumber} (renumbered); tell the Checker` : "read back and matched")
        : outcome === "readback_differs" ? `stored differently: ${res.differences.join("; ")}`
        : outcome === "uncertain" ? `This may already be in the books: ${res.errors.join("; ")}`
        : res.errors.join("; ") || "push failed";
      await this.finishWithRetry(job, outcome, {
        masterId: res.voucherId, bookedNumber,
        result: { stage: res.stage, warnings: res.warnings, differences: res.differences, errors: res.errors },
        error: outcome === "succeeded" ? null : detail,
      });
      return { id: job.id, key, outcome, detail, masterId: res.voucherId };
    } finally {
      if (renew) clearInterval(renew);
    }
  }
}

/** The default Tally seams for a real run. */
export function tallySeams(tallyUrl: string, post: (url: string, xml: string) => Promise<string>) {
  return {
    push: (company: string, p: VoucherPayload) => safePush(tallyUrl, company, p),
    find: (company: string, p: VoucherPayload) => findInTally((xml) => post(tallyUrl, xml), company, p),
  };
}

/** The live queue, through a client (the fenced test-queue client on the sandbox). */
export function supabaseErpQueue(c: { rpc: (fn: string, args: Record<string, unknown>) => any }, machine: string, key: string): ErpQueue {
  const call = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await c.rpc(fn, { p_machine: machine, p_key: key, ...args });
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  };
  return {
    takeLease: (nonce, seconds, details) => call<LeaseInfo>("erp_agent_take_lease", { p_nonce: nonce, p_seconds: seconds, p_details: details ?? null }),
    claim: (nonce, limit, lease) => call<ErpJob[]>("claim_erp_jobs", { p_nonce: nonce, p_limit: limit, p_lease_seconds: lease }),
    renew: (nonce, id, seconds) => call<boolean>("erp_renew_job", { p_nonce: nonce, p_id: id, p_seconds: seconds }),
    markSent: (nonce, id, company) => call("erp_mark_job_sent", { p_nonce: nonce, p_id: id, p_company: company }),
    finish: (nonce, id, state, f = {}) => call<boolean>("erp_finish_job", {
      p_nonce: nonce, p_id: id, p_state: state, p_master_id: f.masterId ?? null, p_booked_number: f.bookedNumber ?? null,
      p_result: f.result ?? null, p_error: f.error ?? null,
    }),
    myOpenJobs: () => call<ErpJob[]>("erp_my_open_jobs", {}),
  };
}
