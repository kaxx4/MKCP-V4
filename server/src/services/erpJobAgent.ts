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
import { safePush, vouchersOnDateXml, diffStored, numberTakenError, partyMatchesStored, sameVoucherType, type SafePushResult } from "./safePush.js";
import { readTag, escapeXml, tdlString, tallyDateInt } from "./xml.js";
import { testJobRefusal, outcomeOf, type TestOutcome } from "./erpTestQueueAgent.js";
import type { VoucherPayload } from "../types.js";
import { isMasterKind, planMasterJob, settleMasterJob, createMasterJob, readMasterId, masterTestRefusal, type MasterOutcome, type MasterPlan } from "./masterJobs.js";
import { loadMasters, type TallyMasters } from "./tallyMasters.js";
import { takenNumbersOrThrow, takenVouchersOrThrow, assertCollectionReply } from "./voucherNumbering.js";
import { endStateProof, type FoundVoucher } from "./endState.js";
import { seriesDefaultFor, isPartyKeyedType, numberTakenBy, type TakenVoucher } from "./voucherSeries.js";
import { setRecordedFiledThrough } from "./pushGuard.js";
import { resolveTarget, targetOf, loadedProblem, type CompanyYear } from "./companyYears.js";
import { HEALTH_XML } from "../tally.js";
import { primaryModeOn, primaryPinFailure, PinRefused, type PinFailure } from "./primaryMode.js";

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
  /** The Tally company the database stamped when the job was marked sent (migration 0109); null before that. */
  company?: string | null;
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
  /**
   * F6, agent half: the newest day a person recorded as filed (`erp_filed_through()` of migration 0283, through the
   * machine-key door `erp_agent_filed_through`), or null when nothing is recorded. Optional: a queue without it
   * leaves the agent on its own boundary.
   */
  filedThrough?(kind?: "gstr1" | "gstr3b"): Promise<string | null>;
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
  | { kind: "finish-pending"; jobId: string; state: string; error: string; at: string }
  /** D-M.262: the primary runner's once-a-day housekeeping (today only the change-signal prune). Not about any job. */
  | { kind: "housekeeping"; task: "signals-prune"; pruned: number | null; error: string | null; at: string };

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
/** The one case-free type compare lives in safePush.ts; re-exported so existing callers keep their import. */
export { sameVoucherType };

/**
 * The vouchers in Tally that match a payload on type, date, number, party and
 * amount. Tally never returns REMOTEID on a read (file 18 section 2.1), so this
 * is the identity. The day's read is filtered in the request by date, type and number.
 */
const action0 = (job: ErpJob): "Create" | "Alter" | "Cancel" | "Delete" => job.payload.action ?? "Create";

export async function findInTally(post: (xml: string) => Promise<string>, company: string, p: VoucherPayload): Promise<FoundVoucher[]> {
  /* D-M.258: an error-shaped reply is a failed read. Without this an error read as "nothing found", and a Delete would look done. */
  const xml = assertCollectionReply(await post(vouchersOnDateXml(company, p.date, { voucherType: p.voucherType, voucherNumber: p.voucherNumber || undefined })));
  /* A Cancel or a Delete is matched by IDENTITY (type and number; the day, type and number are also in the request). A cancelled voucher keeps its
     number but loses its lines and its party, so matching it field by field would never find it (safePush.ts: a cancel is verified by the flag). */
  const identityOnly = p.action === "Cancel" || p.action === "Delete";
  return [...xml.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => m[0])
    .filter((v) => sameVoucherType(readTag(v, "VOUCHERTYPENAME"), p.voucherType)
      && (!p.voucherNumber || readTag(v, "VOUCHERNUMBER") === p.voucherNumber)
      && (identityOnly ? !!p.voucherNumber
        : (!p.partyLedgerName || partyMatchesStored(p, v)) && diffStored(p, v).length === 0))
    .map((v) => ({ masterId: readTag(v, "MASTERID"), cancelled: /^yes$/i.test(readTag(v, "ISCANCELLED") ?? "") }));
}

/**
 * The read right after a push that gives the A6 baseline (task 1-5 review M3,
 * 6-Nov-2026): the voucher's AlterID as Tally holds it once our push landed.
 * safePush's read-back (MkVerify) returns MASTERID and GUID but not ALTERID
 * unless asked (probed on the dummy 6-Nov-2026: 11 of 11 vouchers with a
 * MASTERID, 0 with an ALTERID, G7), and that request is shared with today's
 * push agent, so the ERP asks in its own request. Filtered inside Tally by
 * date and type (and number when there is one).
 */
export function stampXml(company: string, isoDate: string, voucherType: string, voucherNumber?: string): string {
  const stamp = tallyDateInt(isoDate);
  const extra = [
    ` AND ($VoucherTypeName = ${tdlString(voucherType)})`,
    voucherNumber ? ` AND ($VoucherNumber = ${tdlString(voucherNumber)})` : "",
  ].join("");
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkStamp</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE>
<COLLECTION NAME="MkStamp" ISMODIFY="No">
<TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD><NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD>
<NATIVEMETHOD>MasterId</NATIVEMETHOD><NATIVEMETHOD>AlterID</NATIVEMETHOD><NATIVEMETHOD>Guid</NATIVEMETHOD>
<FILTER>MkStampDate</FILTER>
</COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MkStampDate">(($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${stamp})${extra}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

/**
 * How long the stamp read may take (review 1-5 item 3, D-1-5.39). Shorter than
 * a push's 180 s, so a Tally showing a message is noticed sooner, and above the
 * 5 to 50 s a date-filtered read takes on the dummy (Tally scans every voucher
 * for one, measured 5-Nov-2026).
 */
export const STAMP_TIMEOUT_MS = 60_000;

/** The AlterID of the one voucher with this MASTERID in the stamp read, or null when it is not exactly one. */
export async function alterIdAfterPush(post: (xml: string, timeoutMs: number) => Promise<string>, company: string, p: VoucherPayload, masterId: string): Promise<number | null> {
  const xml = await post(stampXml(company, p.date, p.voucherType, p.voucherNumber || undefined), STAMP_TIMEOUT_MS);
  const hits = [...xml.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => m[0])
    .filter((v) => readTag(v, "MASTERID") === String(masterId));
  if (hits.length !== 1) return null;
  const a = readTag(hits[0], "ALTERID");
  return /^\d{1,18}$/.test(a) && Number(a) > 0 ? Number(a) : null;
}

// ── The agent ─────────────────────────────────────────────────────────────────
export interface AgentStatus {
  red: string[];
  holder: string | null;
  lastHeartbeat: string | null;
  skewMs: number | null;
  tallyMayShowMessage: boolean;
  /** D-M.248: the last company-pin check (single-primary mode); null when the pin is not in use. */
  pin?: { ok: boolean; problem: string | null; at: string } | null;
  /** D-M.258 item 2: claiming is paused until this time because a job was put back (the pinned company could not be checked); null when not paused. */
  claimsPaused?: { until: string; seconds: number; reason: string } | null;
}

export interface ErpJobAgentOpts {
  queue: ErpQueue;
  journal: Journal;
  company: string;
  /** Book one payload; defaults to safePush against tallyUrl. */
  push: (company: string, payload: VoucherPayload) => Promise<SafePushResult>;
  /** Read Tally for a payload; defaults to findInTally. */
  find: (company: string, payload: VoucherPayload) => Promise<FoundVoucher[]>;
  nonce?: string;
  /**
   * F17: the recorded list of {company, financial year, GUID}. A job that names a target other than `company` is sent
   * only to the entry matching its name and GUID. Empty or absent: every job goes to `company`, as before.
   */
  companies?: CompanyYear[];
  /** F17: is this listed company open in Tally under its GUID? Null when yes; the reason when not. `tallySeams` supplies it. */
  companyLoaded?: (entry: CompanyYear) => Promise<string | null>;
  /**
   * D-M.248, the company pin of the single-primary mode (primaryMode.ts): null when the company is open in Tally under the pinned GUID, else
   * the reason. Checked before every claim batch (a failure claims nothing), before a job's first read of Tally, before any read that settles a
   * job, and again right before each job is marked `sent`.
   * D-M.256 item 1: a DEFINITE answer (the company is open under another GUID) ends the job `failed` with the reason on the job row; an answer that
   * may change (the list could not be read, the company is not open) puts the job back in the queue and pauses claiming with a growing delay, so
   * it cannot starve the queue. A plain string counts as "may change".
   * D-M.256 item 2: NOT supplied by `tallySeams`. Only `startPrimaryMode` passes it (`tallyPinSeam`), so every rig that spreads `tallySeams`
   * is unchanged. Absent: no pin check, as before.
   */
  pin?: (company: string) => Promise<string | null | PinFailure>;
  /** How often to read the recorded filing boundary (default 300 s). */
  filedEverySec?: number;
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
  /**
   * Task 1-4: every number Tally already holds for a type. A failed read must
   * THROW, never return an empty list. `tallySeams` supplies it; without it the
   * check is skipped (the offline tests, whose fake Tally has no numbers).
   */
  taken?: (company: string, voucherType: string) => Promise<Array<string | TakenVoucher>>;
  /**
   * Task 1-5 review M3: the voucher's AlterID right after a push that
   * succeeded, sent to erp_finish_job as result.alter_id (the A6 baseline).
   * Null or a failed read leaves the baseline to the mirror's first sighting.
   */
  stamp?: (company: string, payload: VoucherPayload, masterId: string) => Promise<number | null>;
  /**
   * D-M.206: the worker for jobs of kind `new_item` and `new_party` (web task 8-3). `masters` is a FRESH read of the company's masters (never the
   * cache: a name made a minute ago must be seen); `createMaster` makes what a plan says and reads it back; `masterIdOf` reads the id of a master
   * that is in Tally, to settle a lost reply. `tallySeams` supplies all three. Without them a job of those kinds is finished `failed` with a
   * plain reason, never pushed as a voucher.
   */
  masters?: (company: string) => Promise<TallyMasters>;
  createMaster?: (company: string, plan: MasterPlan) => Promise<MasterOutcome>;
  masterIdOf?: (company: string, plan: MasterPlan) => Promise<string | null>;
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
  private o: Required<Omit<ErpJobAgentOpts, "nonce" | "refuse" | "pin" | "probe" | "taken" | "stamp" | "masters" | "createMaster" | "masterIdOf">> & { refuse: NonNullable<ErpJobAgentOpts["refuse"]>; pin?: ErpJobAgentOpts["pin"]; probe?: ErpJobAgentOpts["probe"]; taken?: ErpJobAgentOpts["taken"]; stamp?: ErpJobAgentOpts["stamp"]; masters?: ErpJobAgentOpts["masters"]; createMaster?: ErpJobAgentOpts["createMaster"]; masterIdOf?: ErpJobAgentOpts["masterIdOf"] };
  private timeouts = 0;

  constructor(opts: ErpJobAgentOpts) {
    this.nonce = opts.nonce ?? randomUUID();
    this.o = {
      leaseSeconds: 90, jobLeaseSeconds: 120, renewEveryMs: 30_000, maxSkewMs: 60_000, finishTries: 6, readTries: 3,
      wait: (t: number) => new Promise<void>((r) => setTimeout(r, t)), now: () => Date.now(),
      refuse: (job: ErpJob, company: string) => (job.is_test
        ? (isMasterKind(job.kind)
          ? masterTestRefusal({ company, payload: job.payload, label: String(job.payload.label ?? "") })
          : testJobRefusal({ company, payload: job.payload, label: String(job.payload.label ?? "") }))
        : (primaryModeOn() ? null : "refused: real ERP jobs are claimed only by the office agent after go-live")),
      ...opts,
    } as any;
    this.journalOrStop({ kind: "boot", nonce: this.nonce, at: new Date().toISOString() });
  }

  /** Two Tally requests in a row that time out (a push or the stamp read after it): Tally may be showing a message (D5). */
  private noteTallyError(msg: string): void {
    if (looksLikeTallyMessage(msg) && ++this.timeouts >= 2) this.status.tallyMayShowMessage = true;
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

  /** D-M.248: the company pin. Null when it holds or is not in use; else the reason. A check that cannot run is a refusal, never a pass. */
  private async pinProblem(company: string): Promise<PinFailure | null> {
    if (!this.o.pin) return null;
    let problem: PinFailure | null;
    try {
      const r = await this.o.pin(company);
      problem = r === null ? null : typeof r === "string" ? { reason: r, definite: false } : r;
    } catch (e) {
      problem = { reason: `refused: the company pin could not be checked (${(e as Error).message.slice(0, 120)}). Nothing was sent to Tally.`, definite: false };
    }
    this.status.pin = { ok: problem === null, problem: problem?.reason ?? null, at: new Date(this.o.now()).toISOString() };
    return problem;
  }

  /** D-M.256 item 1: claiming is paused until this time (ms) after a job was put back because the pin could not be read. */
  private claimsPausedUntil = 0;
  private holdSec = 0;
  /** Pause claiming for 15 s, doubling each time in a row up to 5 minutes. The database has no per-job "try again at" setter through `erp_finish_job`, so the delay lives here; the pause is global because an unreadable company list is global, never one job's fault. */
  private holdClaims(reason = "a job was put back because the pinned company could not be checked"): number {
    this.holdSec = this.holdSec === 0 ? 15 : Math.min(300, this.holdSec * 2);
    this.claimsPausedUntil = this.o.now() + this.holdSec * 1000;
    this.status.claimsPaused = { until: new Date(this.claimsPausedUntil).toISOString(), seconds: this.holdSec, reason };
    return this.holdSec;
  }

  /**
   * The pin said no before this job was sent. A DEFINITE answer ends the job `failed` with the reason on the job row (it will not change by
   * waiting, and a job put back would be claimed again first, since the claim is oldest first). An answer that may change puts the job back in the
   * queue untouched and pauses claiming with a growing delay. Nothing was sent to Tally either way.
   */
  private async pinStop(job: ErpJob, key: string, why: PinFailure): Promise<RunReport["results"][number]> {
    this.journalOrStop({ kind: "not-sent", jobId: job.id, reason: why.reason, at: new Date().toISOString() });
    if (why.definite) {
      await this.finishWithRetry(job, "failed", { error: why.reason, result: { stage: "guard", pin: "mismatch" } });
      return { id: job.id, key, outcome: "failed", detail: why.reason };
    }
    await this.finishWithRetry(job, "queued");
    const sec = this.holdClaims(`a job was put back: ${why.reason}`);
    return { id: job.id, key, outcome: "not-sent", detail: `${why.reason} Back in the queue; claiming pauses ${sec} s.` };
  }

  /**
   * A pin refusal came out of the transport AFTER the job was marked `sent` (the company changed in the last instant). Nothing reached Tally. The
   * database does not allow `sent` back to `queued`, so the job ends `failed` with the plain reason and "send it again"; a resend reads Tally
   * first. Never `uncertain`, and it does not count towards "Tally may be showing a message".
   */
  private async pinRefusedAfterSent(job: ErpJob, key: string, e: PinRefused): Promise<RunReport["results"][number]> {
    const unit = e.unitMade ? ` The unit "${e.unitMade}" WAS made in Tally before this; the item was not.` : "";
    const reason = (e.definite ? e.message : `${e.message} Send it again when Tally answers.`) + unit;
    this.journalOrStop({ kind: "reply", jobId: job.id, outcome: "failed", stage: "pin", masterId: null, bookedNumber: null, errors: [reason], differences: [], at: new Date().toISOString() });
    await this.finishWithRetry(job, "failed", { error: reason, result: { stage: "guard", pin: e.definite ? "mismatch" : "unreadable", sent_to_tally: !!e.unitMade, ...(e.unitMade ? { unit_made: true, unit: e.unitMade } : {}) } });
    if (!e.definite) this.holdClaims(`a job failed after the pin could not be confirmed: ${e.message}`);
    return { id: job.id, key, outcome: "failed", detail: reason };
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

  /**
   * The company to read when settling a job an earlier boot sent (F17). The company the database stamped at
   * `erp_mark_job_sent` wins; else the stamped target; else the agent's own. A target that cannot be resolved is not
   * guessed: the read goes to the agent's own company, which cannot match a voucher of another year's books, and the
   * job then ends uncertain for a person to settle (a read never settles on anything but exactly one match).
   */
  private recoveryCompany(job: ErpJob): string {
    const stamped = String(job.company ?? "").trim();
    if (stamped) return stamped;
    const t = resolveTarget(this.o.companies ?? [], targetOf(job.payload), this.o.company);
    return t.ok ? t.company : this.o.company;
  }

  /**
   * D-M.263 item 1: does the job's OWN record prove the voucher was once posted by this system? True when the job carries the voucher's MASTERID,
   * or the journal holds a reply of this job's push that named it. A Delete settled "done" from an empty read needs this (endState.ts).
   */
  private postedBySystem(job: ErpJob): boolean {
    if (String(job.master_id ?? "").trim()) return true;
    /* D-M.266: no origin lookup. The ERP never enqueues a Delete (deletes are done in Tally by a person), so a Delete that reaches this check with no
       MASTERID of its own is settled `uncertain` for a person, the safe direction. A Cancel settles on ISCANCELLED and never needs this. */
    try {
      const r = this.o.journal.lastReply(job.id);
      return !!(r && r.masterId && String(r.masterId).trim());
    } catch { return false; }
  }

  /** A job that was sent with no reply in hand: read Tally, settle only on exactly one match. */
  private async readBack(job: ErpJob): Promise<{ state: JobOutcome; how: string; masterId?: string | null }> {
    let found: { masterId: string }[];
    /* D-M.256 item 6: a read of the wrong company must never settle a job. When the pin cannot be confirmed the job is left as it is (not read,
       not counted as a failed read) for the next run. */
    const pinWhy = await this.pinProblem(this.recoveryCompany(job));
    if (pinWhy) {
      /* Not journalled as a failed read: that count ends in `uncertain`, and a pin that cannot be confirmed says nothing about the job. */
      return { state: "uncertain", how: `not read, because the pinned company could not be confirmed (${pinWhy.reason}); left for the next run` };
    }
    try {
      found = await this.o.find(this.recoveryCompany(job), job.payload);
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
    /* D-M.258 item 1: the same end-state rule as a resend (endState.ts). A voucher that merely EXISTS settles only a Create or an Alter; a Cancel
       settles when the voucher reads back cancelled, a Delete when it is gone. M3 (review, 5-Nov-2026): with no voucher number a match on date,
       type, party and amount may be a different voucher, so a read never settles it. Anything else stays uncertain for a person. */
    const action = action0(job);
    const proof = endStateProof(job.payload, found, { postedBySystem: this.postedBySystem(job) });
    if (proof.done && action === "Delete") {
      /* D-M.263 item 1: "gone" is proved by an EMPTY read, and the pin check before the read is a separate hold of the lane: the company could have
         been swapped or closed in between, and an empty answer from another company says nothing. The pin is asked again AFTER the read, and the Delete
         is settled only if it still holds; otherwise the job stays as it is for the next round. */
      const after = await this.pinProblem(this.recoveryCompany(job));
      if (after) return { state: "uncertain", how: `the voucher read as gone, but the pinned company could not be confirmed afterwards (${after.reason}); left for the next run` };
    }
    if (proof.done) {
      await this.finishWithRetry(job, "succeeded", { masterId: proof.masterId, bookedNumber: job.payload.voucherNumber ?? null,
        result: { settled: "read-back", matches: found.length, end_state: action } });
      return { state: "succeeded", how: proof.how, masterId: proof.masterId };
    }
    const how = !proof.ambiguous && found.length === 0 && (action === "Create" || action === "Alter")
      ? "sent, but not found in Tally; it may not have arrived. Check it before sending again"
      : action === "Create" || action === "Alter" ? proof.how : `${proof.how}; a person must check it before anything is sent again`;
    const lead = action === "Create" || action === "Alter" ? "This may already be in the books: " : `The ${action.toLowerCase()} is not confirmed in Tally: `;
    await this.finishWithRetry(job, "uncertain", { result: { settled: "read-back", matches: found.length, ...(!job.payload.voucherNumber ? { no_number: true } : {}) }, error: lead + how });
    return { state: "uncertain", how };
  }

  private filedAt = 0;
  /** Last read of the recorded filing boundary (state for the report and the tests). */
  filedStatus: { value: string | null; at: string | null; error: string | null } = { value: null, at: null, error: null };

  /**
   * F6, agent half: before claiming, take the later of the agent's own filed boundary and the recorded one. At most
   * once per `filedEverySec` (default 300). A failed read changes nothing and never opens a period; it is noted in
   * `filedStatus` so the report can say so. Nothing here reads or writes Tally.
   */
  private async refreshFiledThrough(): Promise<void> {
    if (!this.o.queue.filedThrough) return;
    const nowMs = (this.o.now ?? Date.now)();
    if (this.filedAt && nowMs - this.filedAt < (this.o.filedEverySec ?? 300) * 1000) return;
    this.filedAt = nowMs;
    try {
      const d = await this.o.queue.filedThrough();
      setRecordedFiledThrough(d);
      this.filedStatus = { value: d, at: new Date(nowMs).toISOString(), error: null };
    } catch (e) {
      this.filedStatus = { ...this.filedStatus, at: new Date(nowMs).toISOString(), error: (e as Error).message.slice(0, 160) };
    }
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
      /* D-M.248: nothing is claimed unless the pinned company is the one open in Tally. D-M.256 item 6: and nothing is settled from a read of
         Tally either (settleOwn decides a job's outcome from what Tally shows), so the pin is checked first. */
      const pinWhy = await this.pinProblem(this.o.company);
      if (pinWhy) { report.held = false; report.stopped = pinWhy.reason; return report; }
      /* D-M.258 item 2: a clean pre-claim check ends the growing pause once the pause is over and has stayed quiet for as long again; a pause that is
         still running, or one that just ended and failed again at once, keeps doubling (a reset at every clean check would make the doubling dead code). */
      if (this.holdSec > 0 && this.o.now() >= this.claimsPausedUntil + this.holdSec * 1000) { this.holdSec = 0; this.status.claimsPaused = null; }
      /* D-M.263 item 3: the status shows a pause only while it runs; the growing delay (holdSec) is kept until a quiet spell ends it. */
      if (this.status.claimsPaused && this.o.now() >= this.claimsPausedUntil) this.status.claimsPaused = null;
      report.settled = await this.settleOwn();
      if (this.o.now() < this.claimsPausedUntil) {
        report.stopped = `claiming is paused for ${Math.ceil((this.claimsPausedUntil - this.o.now()) / 1000)} s more: ${this.status.claimsPaused?.reason ?? "a job was put back because the pinned company could not be checked"}`;
        return report;
      }
      await this.refreshFiledThrough();
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

  /**
   * Why this job's number may not be pushed, or null. Only a Create that
   * carries a number is checked, and only for a type the counter numbers (the
   * series table) or a party-keyed type (Purchase, Debit Note: the same
   * supplier, number and year). Review H1: supplier bill numbers repeat, so a
   * plain number match would refuse a second supplier's genuine bill.
   */
  private async numberTakenInTally(job: ErpJob, company: string): Promise<{ reason: string; taken: boolean } | null> {
    const p = job.payload;
    const number = String(p.voucherNumber ?? "").trim();
    if (!this.o.taken || (p.action ?? "Create") !== "Create" || !number) return null;
    if (!seriesDefaultFor(p.voucherType) && !isPartyKeyedType(p.voucherType)) return null;
    let list: Array<string | TakenVoucher>;
    try {
      list = await this.o.taken(company, p.voucherType);
    } catch (e) {
      return { taken: false, reason: `Not sent: Tally's ${p.voucherType} numbers could not be read to check ${number} is free (${(e as Error).message}). Nothing is in the books; send it again when Tally answers.` };
    }
    const hit = numberTakenBy(p, list);
    if (hit === null) return null;
    return { taken: true, reason: isPartyKeyedType(p.voucherType)
      ? `Not sent: ${p.voucherType} bill ${number} from ${p.partyLedgerName} is already in Tally this year (as ${hit}). Nothing is in the books from this job.`
      : `Not sent: ${p.voucherType} number ${number} is already used in Tally (as ${hit}). Pushing it would overwrite that voucher. Nothing is in the books from this job.` };
  }

  /** The ISO day in India, for judging an item's GST. */
  private today(): string { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(this.o.now())); }

  /**
   * D-M.206: a `new_item` or `new_party` job. Plan from a fresh read of the masters (everything Tally would refuse is refused here, `failed`, nothing
   * sent), write `sent`, make the unit and the item (or the ledger), read it back, and finish `succeeded` only with the master's id in hand.
   * A reply lost after `sent` is settled by reading the masters (`readBackMaster`), never by making it again.
   */
  private async processMasterJob(job: ErpJob, company: string, key: string): Promise<RunReport["results"][number]> {
    const stop = async (reason: string, result: Record<string, unknown>): Promise<RunReport["results"][number]> => {
      this.journalOrStop({ kind: "not-sent", jobId: job.id, reason, at: new Date().toISOString() });
      await this.finishWithRetry(job, "failed", { error: reason, result: { stage: "guard", ...result } });
      return { id: job.id, key, outcome: "failed", detail: reason };
    };
    if (!this.o.masters || !this.o.createMaster) return stop("This machine cannot make new items or parties yet (no master worker is set up). Nothing was sent to Tally.", { master: "no-worker" });
    let m: TallyMasters;
    try { m = await this.o.masters(company); }
    catch (e) { return stop(`Tally's items and ledgers could not be read (${(e as Error).message.slice(0, 120)}), so nothing could be checked. Nothing was sent; send it again when Tally answers.`, { master: "unread" }); }
    const planned = planMasterJob(job.kind, job.payload, m);
    if (!planned.ok) return stop(planned.reason, { master: "refused" });
    const plan = planned.plan;
    const renew = this.open.has(job.id) ? null
      : setInterval(() => { void this.o.queue.renew(this.nonce, job.id, this.o.jobLeaseSeconds).catch(() => {}); }, this.o.renewEveryMs);
    try {
      const pinWhy = await this.pinProblem(company);
      if (pinWhy) return await this.pinStop(job, key, pinWhy);
      this.holdSec = 0; this.status.claimsPaused = null;       // a job got past the last check before `sent`: the growing pause starts over
      const sent = await this.o.queue.markSent(this.nonce, job.id, company);
      if (!sent.ok) {
        this.journalOrStop({ kind: "not-sent", jobId: job.id, reason: sent.reason ?? "refused", at: new Date().toISOString() });
        return { id: job.id, key, outcome: sent.refused ? "failed" : "not-sent", detail: sent.reason ?? "not sent" };
      }
      this.journalOrStop({ kind: "sent", jobId: job.id, key, at: new Date().toISOString() });
      let out: MasterOutcome;
      try { out = await this.o.createMaster(company, plan); this.timeouts = 0; }
      catch (e) {
        if (e instanceof PinRefused) return await this.pinRefusedAfterSent(job, key, e);
        const msg = (e as Error).message;
        this.journalOrStop({ kind: "reply-lost", jobId: job.id, error: msg, at: new Date().toISOString() });
        this.noteTallyError(msg);
        const r = await this.readBackMaster(job);
        return { id: job.id, key, outcome: r.state, detail: `no reply from Tally (${msg}); ${r.how}`, masterId: r.masterId };
      }
      /* Tally refused and nothing was made: failed (safe to send again once fixed). Made but not proven (no id, or the read-back differs): uncertain,
         for a person. */
      const outcome: JobOutcome = out.ok ? "succeeded" : out.madeUnproven ? "uncertain" : "failed";
      this.journalOrStop({ kind: "reply", jobId: job.id, outcome, stage: out.stage, masterId: out.masterId, bookedNumber: null,
        errors: out.ok ? [] : [out.reason], differences: [], at: new Date().toISOString() });
      await this.finishWithRetry(job, outcome, {
        masterId: out.masterId, bookedNumber: null,
        result: { stage: out.stage, master: plan.kind, name: plan.kind === "new_item" ? plan.item.name : plan.ledger.name,
          ...(out.unitMade ? { unit_made: true } : {}), ...(out.readBack ? { read_back: out.readBack } : {}), reason: out.reason },
        error: outcome === "succeeded" ? null : out.reason,
      });
      return { id: job.id, key, outcome, detail: out.reason, masterId: out.masterId };
    } finally {
      if (renew) clearInterval(renew);
    }
  }

  /** A master job sent with no reply in hand: read the masters; settle `succeeded` only when Tally shows exactly what the plan says. */
  private async readBackMaster(job: ErpJob): Promise<{ state: JobOutcome; how: string; masterId?: string | null }> {
    const company = this.recoveryCompany(job);
    const leave = async (how: string): Promise<{ state: JobOutcome; how: string }> => {
      await this.finishWithRetry(job, "uncertain", { result: { settled: "read-back", master: true }, error: `This may already be in Tally: ${how}` });
      return { state: "uncertain", how };
    };
    if (!this.o.masters) return leave("this machine cannot read Tally's masters; a person must check it");
    /* D-M.256 item 6: not settled from a read of a company that is not confirmed as the pinned one; the job is left as it is for the next run. */
    const pinWhy = await this.pinProblem(company);
    if (pinWhy) return { state: "uncertain", how: `not read, because the pinned company could not be confirmed (${pinWhy.reason}); left for the next run` };
    let m: TallyMasters;
    try { m = await this.o.masters(company); }
    catch (e) { return leave(`Tally could not be read (${(e as Error).message.slice(0, 100)}); a person must check it`); }
    // Judged against the masters as they are NOW: a name that exists is what we are looking for, not a clash.
    const shaped = planMasterJob(job.kind, job.payload, m, { allowExisting: true });
    if (!shaped.ok) return leave(`the request could not be read back (${shaped.reason})`);
    const v = settleMasterJob(shaped.plan, m, this.today());
    if (v.state !== "present") return leave(v.state === "absent" ? "sent, but not found in Tally; it may not have arrived. Check it before sending again" : v.detail);
    let masterId: string | null = null;
    try { masterId = this.o.masterIdOf ? await this.o.masterIdOf(company, shaped.plan) : null; } catch { masterId = null; }
    await this.finishWithRetry(job, "succeeded", { masterId, result: { settled: "read-back", master: true } });
    return { state: "succeeded", how: v.detail, masterId };
  }

  async processJob(job: ErpJob): Promise<RunReport["results"][number]> {
    const key = job.idempotency_key;
    /* F17: which company is this job for? No target stamped: the agent's own, as always. A target must match the
       recorded list by name AND GUID, and be open in Tally under that GUID, or the job stops here, before Tally. */
    const target = resolveTarget(this.o.companies ?? [], targetOf(job.payload), this.o.company);
    if (!target.ok) {
      await this.finishWithRetry(job, "failed", { error: target.reason, result: { stage: "guard", target: "refused" } });
      return { id: job.id, key, outcome: "failed", detail: target.reason };
    }
    const company = target.company;
    if (target.viaList && target.entry && this.o.companyLoaded) {
      let problem: string | null;
      try { problem = await this.o.companyLoaded(target.entry); }
      catch (e) { problem = `Tally's company list could not be read to check "${company}" is open (${(e as Error).message}). Nothing was sent; send it again when Tally answers.`; }
      if (problem) {
        await this.finishWithRetry(job, "failed", { error: problem, result: { stage: "guard", target: "not-loaded" } });
        return { id: job.id, key, outcome: "failed", detail: problem };
      }
    }
    const refusal = this.o.refuse(job, company);
    if (refusal) {
      await this.finishWithRetry(job, "failed", { error: refusal, result: { stage: "guard" } });
      return { id: job.id, key, outcome: "failed", detail: refusal };
    }
    /* D-M.256 items 1 and 6: before this job's first read of Tally (the masters, the numbers, a resend's look) the pinned company is confirmed, so
       no read of another company can decide this job's fate. A definite mismatch ends the job failed; an unreadable answer puts it back. */
    const early = await this.pinProblem(company);
    if (early) return await this.pinStop(job, key, early);
    this.journalOrStop({ kind: "claimed", jobId: job.id, key, at: new Date().toISOString() });
    if (isMasterKind(job.kind)) return this.processMasterJob(job, company, key);
    /* D21: a resend keeps its REMOTEID, so a Create would alter in place if the
       old one landed. Read Tally first: exactly that voucher found, it is
       already in the books; more than one, a person decides; none, push. */
    if (job.resend_of) {
      let found: FoundVoucher[] | null = null;
      try { found = await this.o.find(company, job.payload); } catch { found = null; }
      /* D-M.258 item 1: what counts as "already done" depends on the action. A Cancel is done when the voucher reads back cancelled, a Delete when it
         is gone; "the voucher exists" is proof only for a Create or an Alter (endState.ts). The read was made just after the pin check above. */
      const proof = found === null ? null : endStateProof(job.payload, found, { postedBySystem: this.postedBySystem(job) });
      if (proof?.done && action0(job) === "Delete") {
        /* D-M.263 item 1: the same rule as readBack: a Delete settled by an empty read is settled only if the pin still holds AFTER the read. */
        const after = await this.pinProblem(company);
        if (after) return await this.pinStop(job, key, after);
      }
      if (found === null || proof!.done || proof!.ambiguous) {
        const state: JobOutcome = proof?.done ? "succeeded" : "uncertain";
        const detail = proof === null ? "Tally could not be read before the resend; not pushed"
          : proof.done ? (action0(job) === "Create" || action0(job) === "Alter" ? "the earlier attempt is already in the books; settled without pushing again" : `${proof.how}; settled without sending again`)
          : `${proof.how}; not pushed, a person must decide`;
        const masterId = proof?.done ? proof.masterId : null;
        await this.finishWithRetry(job, state, { masterId, result: { resend_check: found?.length ?? null, end_state: action0(job) }, error: state === "succeeded" ? null : detail });
        return { id: job.id, key, outcome: state, detail, masterId };
      }
    }
    /* 1-4: a number Tally already holds blocks a Create. The REMOTEID is built
       from the number, so a Create on a taken number would ALTER the voucher
       already there (the 15-Sep Contra 29 incident). Checked before `sent`, so a
       refusal leaves nothing in the books. A read that fails stops the push too:
       "could not look" is never "free". */
    const blocked = this.o.taken ? await this.numberTakenInTally(job, company) : null;
    if (blocked) {
      this.journalOrStop({ kind: "not-sent", jobId: job.id, reason: blocked.reason, at: new Date().toISOString() });
      /* number_taken tells a resend (migration 0115) to take a fresh number;
         number_unread means nothing was learned, and a resend keeps it. */
      await this.finishWithRetry(job, "failed", { error: blocked.reason,
        result: { stage: "guard", number_check: true, ...(blocked.taken ? { number_taken: true, number: job.payload.voucherNumber } : { number_unread: true }) } });
      return { id: job.id, key, outcome: "failed", detail: blocked.reason };
    }
    // Called on its own (not from runOnce), the job is renewed here; runOnce's timer covers it otherwise.
    const renew = this.open.has(job.id) ? null
      : setInterval(() => { void this.o.queue.renew(this.nonce, job.id, this.o.jobLeaseSeconds).catch(() => {}); }, this.o.renewEveryMs);
    try {
      /* D-M.248: right before `sent`, the pinned company is checked again. A failure puts the job back, with nothing sent. */
      const pinWhy = await this.pinProblem(company);
      if (pinWhy) return await this.pinStop(job, key, pinWhy);
      this.holdSec = 0; this.status.claimsPaused = null;       // a job got past the last check before `sent`: the growing pause starts over
      const m = await this.o.queue.markSent(this.nonce, job.id, company);
      if (!m.ok) {
        this.journalOrStop({ kind: "not-sent", jobId: job.id, reason: m.reason ?? "refused", at: new Date().toISOString() });
        return { id: job.id, key, outcome: m.refused ? "failed" : "not-sent", detail: m.reason ?? "not sent" };
      }
      this.journalOrStop({ kind: "sent", jobId: job.id, key, at: new Date().toISOString() });
      let res: SafePushResult;
      try {
        res = await this.o.push(company, job.payload);
        this.timeouts = 0;
      } catch (e) {
        if (e instanceof PinRefused) return await this.pinRefusedAfterSent(job, key, e);
        const msg = (e as Error).message;
        this.journalOrStop({ kind: "reply-lost", jobId: job.id, error: msg, at: new Date().toISOString() });
        this.noteTallyError(msg);
        const s = await this.readBack(job);
        return { id: job.id, key, outcome: s.state, detail: `no reply from Tally (${msg}); ${s.how}`, masterId: s.masterId };
      }
      const outcome = outcomeOf(res);
      const bookedNumber = bookedNumberOf(res, job.payload);
      this.journalOrStop({ kind: "reply", jobId: job.id, outcome, stage: res.stage, masterId: res.voucherId, bookedNumber,
        errors: res.errors, differences: res.differences, at: new Date().toISOString() });
      /* M3: the A6 baseline, read once the push is in. A failed read is noted and never fails the job. */
      let alterId: number | null = null, stampError: string | null = null;
      if (outcome === "succeeded" && res.voucherId && this.o.stamp) {
        /* Review 1-5 item 3: a stamp read that times out counts towards
           "Tally may be showing a message", the same as a push that does. */
        try { alterId = await this.o.stamp(company, job.payload, res.voucherId); this.timeouts = 0; }
        catch (e) { const msg = (e as Error).message; stampError = msg.slice(0, 200); this.noteTallyError(msg); }
      }
      const detail = outcome === "succeeded" ? (bookedNumber && bookedNumber !== job.payload.voucherNumber
        ? `booked as ${bookedNumber} (renumbered); tell the Checker` : "read back and matched")
        : outcome === "readback_differs" ? `stored differently: ${res.differences.join("; ")}`
        : outcome === "uncertain" ? `This may already be in the books: ${res.errors.join("; ")}`
        : res.errors.join("; ") || "push failed";
      await this.finishWithRetry(job, outcome, {
        masterId: res.voucherId, bookedNumber,
        result: { stage: res.stage, warnings: res.warnings, differences: res.differences, errors: res.errors,
          ...(alterId !== null ? { alter_id: alterId } : {}), ...(stampError ? { alter_id_unread: stampError } : {}),
          /* Tally itself said the number exists (an override push is never renumbered). */
          ...(outcome === "failed" && numberTakenError(res.errors) ? { number_taken: true, number: job.payload.voucherNumber } : {}) },
        error: outcome === "succeeded" ? null : detail,
      });
      return { id: job.id, key, outcome, detail, masterId: res.voucherId };
    } finally {
      if (renew) clearInterval(renew);
    }
  }
}

/**
 * An ERP job's number on a type the counter numbers is pinned (numberOverride)
 * so safePush never renumbers it; every other payload is sent as it is
 * (review H1). Journal is left out: this company's Tally keeps no number on one.
 */
export function withCounterOverride(p: VoucherPayload): VoucherPayload {
  return p.voucherNumber?.trim() && seriesDefaultFor(p.voucherType) && p.voucherType.trim().toLowerCase() !== "journal"
    ? { ...p, numberOverride: true } : p;
}

/** The default Tally seams for a real run. */
export function tallySeams(tallyUrl: string, post: (url: string, xml: string, timeoutMs?: number) => Promise<string>) {
  return {
    /* 1-4: an ERP job's number came from the counter and is tombstoned, and its
       REMOTEID is built from it. safePush must never quietly swap in "the next
       free number" (its recovery for app-suggested numbers): the voucher would
       land under a number the counter never issued. Marked as an override, a
       taken number is refused and reported instead. Only for a type the
       counter numbers (review H1): a Purchase or Debit Note carries the
       supplier's number, which is not ours to pin. Not for a Journal: Tally
       stores no number on one here (numbering "None"), and an override is
       verified by number only, so it could never be confirmed. */
    push: (company: string, p: VoucherPayload) => safePush(tallyUrl, company, withCounterOverride(p)),
    find: (company: string, p: VoucherPayload) => findInTally((xml) => post(tallyUrl, xml), company, p),
    stamp: (company: string, p: VoucherPayload, masterId: string) => alterIdAfterPush((xml, t) => post(tallyUrl, xml, t), company, p, masterId),
    /* Party-keyed types read the party and date too; counter types the numbers only. */
    taken: (company: string, voucherType: string): Promise<Array<string | TakenVoucher>> => isPartyKeyedType(voucherType)
      ? takenVouchersOrThrow(tallyUrl, company, voucherType, (u, x) => post(u, x))
      : takenNumbersOrThrow(tallyUrl, company, voucherType, (u, x) => post(u, x)),
    /* F17: a company other than the agent's own is only sent to when Tally has it open under the recorded GUID. One company-list read. */
    companyLoaded: async (entry: CompanyYear) => loadedProblem(await post(tallyUrl, HEALTH_XML, 10_000), entry),
    /* D-M.206: the master worker. A fresh read of the masters (never the cache), the writes through masterPusher, and the master's id. */
    masters: (company: string) => loadMasters(tallyUrl, company, { force: true }),
    createMaster: (company: string, plan: MasterPlan) => createMasterJob(tallyUrl, company, plan),
    masterIdOf: (company: string, plan: MasterPlan) => readMasterId(tallyUrl, company, plan.kind === "new_item" ? "StockItem" : "Ledger", plan.kind === "new_item" ? plan.item.name : plan.ledger.name),
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
    filedThrough: async (kind) => { const d = await call<string | null>("erp_agent_filed_through", { p_kind: kind ?? null }); return d ? String(d).slice(0, 10) : null; },
  };
}

/**
 * D-M.248 / D-M.256 item 2: the company pin as the agent's `pin` option. One fresh company-list read per check; the verdict says whether it is
 * definite (another GUID) or may change (list unreadable, company not open). Deliberately NOT part of `tallySeams`: only `startPrimaryMode`
 * passes it, so the dummy rigs that spread `tallySeams` are unchanged.
 */
export function tallyPinSeam(tallyUrl: string, post: (url: string, xml: string, timeoutMs?: number) => Promise<string>): (company: string) => Promise<PinFailure | null> {
  return async (company: string) => {
    let listing: string;
    try { listing = await post(tallyUrl, HEALTH_XML, 10_000); }
    catch (e) { return { reason: `refused: Tally's company list could not be read (${(e as Error).message.slice(0, 120)}), so the pinned company cannot be checked. Nothing was sent to Tally.`, definite: false }; }
    return primaryPinFailure(company, listing);
  };
}
